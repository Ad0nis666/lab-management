const { randomUUID } = require('node:crypto');
const { AuthError } = require('./auth.cjs');
const fields = { name: 100, cas: 20, grade: 80, supplier: 120, catalog_no: 80, category: 80, hazard_tags: 200 };
const columns = [...Object.keys(fields), 'stock_unit', 'low_stock_threshold'];
function invalid(message) { throw new AuthError(422, 'INVALID_REAGENT', message); }
function validate(data) {
  if (Object.keys(data).some(key => !columns.includes(key))) invalid('包含不支持的档案字段。');
  const result = {};
  for (const [key, max] of Object.entries(fields)) {
    const value = data[key] === undefined ? '' : data[key];
    if (typeof value !== 'string' || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${key} 字段格式或长度不正确。`);
    result[key] = value.trim();
  }
  if (!result.name) invalid('请填写试剂名称。');
  if (result.cas) {
    if (!/^\d{2,7}-\d{2}-\d$/.test(result.cas)) invalid('CAS 号格式不正确。');
    const digits = result.cas.replaceAll('-', '');
    const checksum = [...digits.slice(0, -1)].reverse().reduce((sum, digit, index) => sum + Number(digit) * (index + 1), 0) % 10;
    if (checksum !== Number(digits.at(-1))) invalid('CAS 号校验位不正确。');
  }
  result.stock_unit = data.stock_unit;
  if (!['mL', 'L', 'g', 'kg'].includes(result.stock_unit)) invalid('请选择质量或体积计量单位。');
  const amount = data.low_stock_threshold === undefined ? '0' : data.low_stock_threshold;
  if (typeof amount !== 'string' || !/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(amount)) invalid('低库存阈值须为非负十进制字符串，最多两位小数。');
  const [integer, decimals = ''] = amount.split('.');
  result.low_stock_threshold = `${integer}.${decimals.padEnd(2, '0')}`;
  return result;
}
class ReagentStore {
  constructor(auth) { this.auth = auth; this.db = auth.db; }
  create(data, user) {
    if (user.role !== 'admin') throw new AuthError(403, 'FORBIDDEN', '您没有该权限');
    const values = validate(data);
    const timestamp = new Date(this.auth.now()).toISOString();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO reagents (id, ${columns.join(',')}, created_by, created_at, updated_at) VALUES (${Array(columns.length + 4).fill('?').join(',')})`)
      .run(id, ...columns.map(key => values[key]), user.id, timestamp, timestamp);
    return this.get(id);
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM reagents WHERE id = ?').get(id);
    if (!row) throw new AuthError(404, 'REAGENT_NOT_FOUND', '试剂档案不存在。');
    return this.bottles ? { ...row, stock_summary: this.bottles.summary(row) } : row;
  }
  list(params) {
    const allowed = ['q', 'page', 'page_size'];
    for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid('查询参数不受支持。');
    const number = (key, fallback, max) => {
      const value = params.get(key) ?? String(fallback);
      if (!/^[1-9]\d{0,6}$/.test(value) || Number(value) > max) invalid('分页参数不正确。');
      return Number(value);
    };
    const page = number('page', 1, 1000000), page_size = number('page_size', 12, 100);
    const q = (params.get('q') || '').trim();
    if (q.length > 100 || /[\u0000-\u001f\u007f]/.test(q)) invalid('搜索内容过长或格式不正确。');
    const where = "WHERE instr(lower(name), lower(?)) > 0 OR instr(lower(cas), lower(?)) > 0 OR instr(lower(catalog_no), lower(?)) > 0";
    const args = [q, q, q];
    const total = this.db.prepare(`SELECT count(*) AS total FROM reagents ${where}`).get(...args).total;
    const items = this.db.prepare(`SELECT * FROM reagents ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, page_size, (page - 1) * page_size);
    return { items: this.bottles ? items.map(row => ({ ...row, stock_summary: this.bottles.summary(row) })) : items, total, page, page_size };
  }
}
module.exports = { ReagentStore };
