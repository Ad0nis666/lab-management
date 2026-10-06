const { randomUUID } = require('node:crypto');
const { AuthError } = require('./auth.cjs');
const definitions = {
  instruments: { fields: { code: 80, name: 100, kind: 20, model: 100, location: 120, owner: 80, status: 20, calibration_on: 10, notes: 500 }, required: ['code', 'name', 'kind', 'status'], status: ['unknown', 'normal', 'fault', 'calibration', 'maintenance'], search: ['code', 'name', 'model', 'location', 'owner'] },
  samples: { fields: { code: 80, name: 100, project: 120, quantity: 12, unit: 20, location: 120, status: 20, notes: 500 }, required: ['code', 'name', 'quantity', 'unit', 'location', 'status'], status: ['stored', 'in_use', 'exhausted', 'discarded'], search: ['code', 'name', 'project', 'location'] },
};
class CollectionStore {
  constructor(auth, table) {
    if (!definitions[table]) throw new Error('Unknown collection');
    this.auth = auth; this.db = auth.db; this.table = table; this.definition = definitions[table];
  }
  invalid(message) { throw new AuthError(422, 'INVALID_' + this.table.toUpperCase(), message); }
  validate(data, update = false) {
    const { fields, required, status } = this.definition;
    if (Object.keys(data).some(key => !Object.hasOwn(fields, key) && !(update && key === 'version'))) this.invalid('包含不支持的字段。');
    const values = {};
    for (const [key, max] of Object.entries(fields)) {
      const value = data[key] === undefined ? '' : data[key];
      if (typeof value !== 'string' || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) this.invalid(`${key} 字段格式或长度不正确。`);
      values[key] = value.trim();
    }
    if (required.some(key => !values[key])) this.invalid('请填写所有必填字段。');
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(values.code)) this.invalid('编号只支持字母、数字、点、下划线和连字符。');
    values.code = values.code.toUpperCase();
    if (!status.includes(values.status)) this.invalid('状态不受支持。');
    if (this.table === 'instruments') {
      if (!['robot', 'balance', 'pump', 'other'].includes(values.kind)) this.invalid('仪器类型不受支持。');
      const date = values.calibration_on;
      if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '1900-01-01' || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date)) this.invalid('校准日期须为有效日期。');
    } else {
      if (!/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(values.quantity)) this.invalid('数量须为非负十进制数，最多两位小数。');
      const [integer, decimals = ''] = values.quantity.split('.');
      values.quantity = `${integer}.${decimals.padEnd(2, '0')}`;
    }
    if (update && (!Number.isSafeInteger(data.version) || data.version < 1)) this.invalid('请提供有效版本号。');
    return values;
  }
  get(id) {
    const item = this.db.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).get(id);
    if (!item) throw new AuthError(404, 'RECORD_NOT_FOUND', '记录不存在。');
    return item;
  }
  save(data, user, id) {
    if (user.role !== 'admin') throw new AuthError(403, 'FORBIDDEN', '您没有该权限');
    const values = this.validate(data, !!id), keys = Object.keys(values);
    return this.auth.transaction(() => {
      if (id && this.get(id).version !== data.version) throw new AuthError(409, 'VERSION_CONFLICT', '记录已被更新，请关闭后重新打开再编辑。');
      if (this.db.prepare(`SELECT id FROM ${this.table} WHERE code = ? AND id != ?`).get(values.code, id || '')) throw new AuthError(409, 'CODE_EXISTS', '编号已存在，请使用其他编号。');
      const timestamp = new Date(this.auth.now()).toISOString();
      if (id) {
        this.db.prepare(`UPDATE ${this.table} SET ${keys.map(key => `${key} = ?`).join(',')}, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?`)
          .run(...keys.map(key => values[key]), user.id, timestamp, id);
      } else {
        id = randomUUID();
        this.db.prepare(`INSERT INTO ${this.table} (id,${keys.join(',')},created_by,updated_by,created_at,updated_at) VALUES (${Array(keys.length + 5).fill('?').join(',')})`)
          .run(id, ...keys.map(key => values[key]), user.id, user.id, timestamp, timestamp);
      }
      return this.get(id);
    });
  }
  list(params) {
    for (const key of params.keys()) if (!['q', 'page', 'page_size'].includes(key) || params.getAll(key).length !== 1) this.invalid('查询参数不受支持。');
    const number = (key, fallback, max) => {
      const value = params.get(key) ?? String(fallback);
      if (!/^[1-9]\d{0,6}$/.test(value) || Number(value) > max) this.invalid('分页参数不正确。');
      return Number(value);
    };
    const page = number('page', 1, 1000000), page_size = number('page_size', 12, 100);
    const q = (params.get('q') || '').trim();
    if (q.length > 100 || /[\u0000-\u001f\u007f]/.test(q)) this.invalid('搜索内容格式不正确。');
    const where = 'WHERE ' + this.definition.search.map(key => `instr(lower(${key}), lower(?)) > 0`).join(' OR ');
    const args = this.definition.search.map(() => q);
    const total = this.db.prepare(`SELECT count(*) AS total FROM ${this.table} ${where}`).get(...args).total;
    const items = this.db.prepare(`SELECT * FROM ${this.table} ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, page_size, (page - 1) * page_size);
    return { items, total, page, page_size };
  }
}
module.exports = { CollectionStore };
