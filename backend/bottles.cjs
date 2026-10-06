const { randomUUID } = require('node:crypto');
const { AuthError } = require('./auth.cjs');
const UNITS = { mL: { dimension: 'volume', factor: 1 }, L: { dimension: 'volume', factor: 1000 }, g: { dimension: 'mass', factor: 1 }, kg: { dimension: 'mass', factor: 1000 } };
const fields = { bottle_code: 80, batch_no: 80, location: 120 };
const allowed = [...Object.keys(fields), 'initial_quantity', 'unit', 'received_on', 'expires_on'];
function invalid(message) { throw new AuthError(422, 'INVALID_BOTTLE', message); }
function today(now) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)); }
function date(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '9999-12-31') invalid(`${label}须为有效日期。`);
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid(`${label}须为有效日期。`);
  return value;
}
function decimal(minor) { return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`; }
function formatTotal(minor, unit) {
  const divisor = BigInt(UNITS[unit].factor * 100);
  const remainder = (minor % divisor).toString().padStart(divisor.toString().length - 1, '0').replace(/0+$/, '');
  return `${minor / divisor}.${remainder.padEnd(2, '0')}`;
}
class BottleStore {
  constructor(auth, reagents) { this.auth = auth; this.db = auth.db; this.reagents = reagents; }
  validate(data, reagent) {
    if (Object.keys(data).some(key => !allowed.includes(key))) invalid('包含不支持的入库字段。');
    const result = {};
    for (const [key, max] of Object.entries(fields)) {
      const value = data[key] === undefined ? '' : data[key];
      if (typeof value !== 'string' || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${key} 字段格式或长度不正确。`);
      result[key] = value.trim();
    }
    if (result.bottle_code && !/^[a-zA-Z0-9_.-]{1,80}$/.test(result.bottle_code)) invalid('瓶号仅支持字母、数字、下划线、点和连字符。');
    result.bottle_code = result.bottle_code.toUpperCase();
    if (typeof data.initial_quantity !== 'string' || !/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(data.initial_quantity)) invalid('初始量须为正十进制字符串，最多两位小数。');
    const [integer, fraction = ''] = data.initial_quantity.split('.');
    result.initial_minor = Number(integer) * 100 + Number(fraction.padEnd(2, '0'));
    if (result.initial_minor <= 0) invalid('初始量须大于零。');
    if (typeof data.unit !== 'string' || !Object.hasOwn(UNITS, data.unit) || UNITS[data.unit].dimension !== UNITS[reagent.stock_unit].dimension) invalid('单位须与档案同属质量或体积，不能混用。');
    result.unit = data.unit;
    result.received_on = date(data.received_on, '入库日期');
    result.expires_on = data.expires_on === undefined || data.expires_on === '' ? null : date(data.expires_on, '有效期');
    if (result.received_on > today(this.auth.now())) invalid('入库日期不能晚于今天（北京时间）。');
    if (result.expires_on && result.expires_on < result.received_on) invalid('有效期不能早于入库日期。');
    return result;
  }
  publicBottle(row) {
    const { initial_minor, remaining_minor, ...data } = row;
    return { ...data, initial_quantity: decimal(initial_minor), remaining_quantity: decimal(remaining_minor), quantity_mode: 'exact', expiry_status: row.expires_on === null ? 'unknown' : row.expires_on < today(this.auth.now()) ? 'expired' : 'valid' };
  }
  get(id) {
    const row = this.db.prepare('SELECT b.*, r.name AS reagent_name FROM reagent_bottles b JOIN reagents r ON r.id = b.reagent_id WHERE b.id = ?').get(id);
    if (!row) throw new AuthError(404, 'BOTTLE_NOT_FOUND', '单瓶记录不存在。');
    return this.publicBottle(row);
  }
  create(reagentId, data, user, key) {
    if (user.role !== 'admin') throw new AuthError(403, 'FORBIDDEN', '您没有该权限');
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_.-]{8,128}$/.test(key)) invalid('请提供有效的 Idempotency-Key，重试时使用同一个键。');
    const reagent = this.reagents.get(reagentId);
    const values = this.validate(data, reagent);
    const payload = JSON.stringify({ reagent_id: reagentId, ...values });
    return this.auth.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM stock_movements WHERE recorded_by = ? AND idempotency_key = ?').get(user.id, key);
      if (existing) {
        if (existing.request_payload !== payload || existing.type !== 'receipt') throw new AuthError(409, 'IDEMPOTENCY_CONFLICT', '同一请求键不能用于不同的入库内容。');
        return { bottle: this.get(existing.bottle_id), movement_id: existing.id, replayed: true };
      }
      const code = values.bottle_code || `BT-${randomUUID().toUpperCase()}`;
      if (this.db.prepare('SELECT 1 FROM reagent_bottles WHERE bottle_code = ?').get(code)) throw new AuthError(409, 'BOTTLE_CODE_EXISTS', '瓶号已存在，请使用其他瓶号。');
      const timestamp = new Date(this.auth.now()).toISOString(), id = randomUUID(), movementId = randomUUID();
      this.db.prepare('INSERT INTO reagent_bottles (id, reagent_id, bottle_code, batch_no, initial_minor, remaining_minor, unit, location, received_on, expires_on, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, reagentId, code, values.batch_no, values.initial_minor, values.initial_minor, values.unit, values.location, values.received_on, values.expires_on, user.id, timestamp, timestamp);
      this.db.prepare("INSERT INTO stock_movements (id, bottle_id, type, quantity_delta_minor, before_minor, after_minor, unit, used_on, recorded_by, idempotency_key, request_payload, created_at, recorded_by_name, reagent_name, bottle_code, sequence) VALUES (?,?,'receipt',?,0,?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sequence),0)+1 FROM stock_movements))")
        .run(movementId, id, values.initial_minor, values.initial_minor, values.unit, values.received_on, user.id, key, payload, timestamp, user.display_name, reagent.name, code);
      return { bottle: this.get(id), movement_id: movementId, replayed: false };
    });
  }
  list(reagentId, params) {
    this.reagents.get(reagentId);
    for (const key of params.keys()) if (!['page', 'page_size'].includes(key) || params.getAll(key).length !== 1) invalid('查询参数不受支持。');
    const number = (key, fallback, max) => {
      const value = params.get(key) ?? String(fallback);
      if (!/^[1-9]\d{0,6}$/.test(value) || Number(value) > max) invalid('分页参数不正确。');
      return Number(value);
    };
    const page = number('page', 1, 1000000), page_size = number('page_size', 12, 100);
    const total = this.db.prepare('SELECT count(*) AS count FROM reagent_bottles WHERE reagent_id = ?').get(reagentId).count;
    const items = this.db.prepare('SELECT * FROM reagent_bottles WHERE reagent_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(reagentId, page_size, (page - 1) * page_size).map(row => this.publicBottle(row));
    return { items, total, page, page_size };
  }
  search(params) {
    for (const key of params.keys()) if (!['page', 'page_size', 'q', 'available'].includes(key) || params.getAll(key).length !== 1) invalid('查询参数不受支持。');
    const number = (key, fallback, max) => {
      const value = params.get(key) ?? String(fallback);
      if (!/^[1-9]\d{0,6}$/.test(value) || Number(value) > max) invalid('分页参数不正确。');
      return Number(value);
    };
    const page = number('page', 1, 1000000), page_size = number('page_size', 20, 100);
    const q = (params.get('q') || '').trim();
    if (q.length > 100 || /[\u0000-\u001f\u007f]/.test(q)) invalid('搜索内容不正确。');
    if (params.has('available') && !['true', 'false'].includes(params.get('available'))) invalid('可领筛选不正确。');
    const args = [q, q, q, q];
    let where = '(instr(lower(r.name), lower(?)) > 0 OR instr(lower(b.bottle_code), lower(?)) > 0 OR instr(lower(b.batch_no), lower(?)) > 0 OR instr(lower(b.location), lower(?)) > 0)';
    if (params.get('available') === 'true') { where += " AND b.lifecycle_status = 'in_stock' AND b.remaining_minor > 0 AND (b.expires_on IS NULL OR b.expires_on >= ?)"; args.push(today(this.auth.now())); }
    const from = `FROM reagent_bottles b JOIN reagents r ON r.id = b.reagent_id WHERE ${where}`;
    const total = this.db.prepare(`SELECT count(*) AS total ${from}`).get(...args).total;
    const items = this.db.prepare(`SELECT b.*, r.name AS reagent_name ${from} ORDER BY b.created_at DESC, b.id DESC LIMIT ? OFFSET ?`).all(...args, page_size, (page - 1) * page_size).map(row => this.publicBottle(row));
    return { items, total, page, page_size };
  }
  summary(reagent, currentDate = today(this.auth.now())) {
    const rows = this.db.prepare("SELECT remaining_minor, unit, expires_on FROM reagent_bottles WHERE reagent_id = ? AND lifecycle_status = 'in_stock'").all(reagent.id);
    let total = 0n, available = 0n, availableCount = 0;
    for (const row of rows) {
      const quantity = BigInt(row.remaining_minor) * BigInt(UNITS[row.unit].factor);
      total += quantity;
      if ((row.expires_on === null || row.expires_on >= currentDate) && row.remaining_minor > 0) { available += quantity; availableCount++; }
    }
    return { bottle_count: rows.length, available_bottle_count: availableCount, total_quantity: formatTotal(total, reagent.stock_unit), available_quantity: formatTotal(available, reagent.stock_unit), unit: reagent.stock_unit };
  }
}
module.exports = { BottleStore, today, date, UNITS };
