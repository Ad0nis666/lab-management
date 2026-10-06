const { randomUUID } = require('node:crypto');
const { AuthError } = require('./auth.cjs');
const { UNITS, date, today } = require('./bottles.cjs');
function invalid(message) { throw new AuthError(422, 'INVALID_CONSUMPTION', message); }
function signedDecimal(minor) { const amount = Math.abs(minor); return `${minor < 0 ? '-' : ''}${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`; }
class ConsumptionStore {
  constructor(auth, bottles) { this.auth = auth; this.db = auth.db; this.bottles = bottles; }
  publicMovement(row) {
    return { id: row.id, sequence: row.sequence, bottle_id: row.bottle_id, bottle_code: row.bottle_code, reagent_name: row.reagent_name, type: row.type,
      quantity_delta: signedDecimal(row.quantity_delta_minor), before_quantity: signedDecimal(row.before_minor), after_quantity: signedDecimal(row.after_minor), unit: row.unit,
      used_on: row.used_on, used_by: row.used_by, used_by_name: row.used_by_name, recorded_by: row.recorded_by, recorded_by_name: row.recorded_by_name,
      purpose: row.purpose, requested_amount: row.requested_amount, requested_unit: row.requested_unit, created_at: row.created_at };
  }
  create(id, data, user, key) {
    if (user.role !== 'admin') throw new AuthError(403, 'FORBIDDEN', '您没有该权限');
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_.-]{8,128}$/.test(key)) invalid('请提供有效的 Idempotency-Key，重试时使用同一个键。');
    if (Object.keys(data).some(field => !['amount', 'unit', 'used_on', 'used_by', 'purpose'].includes(field))) invalid('包含不支持的领用字段。');
    const bottle = this.bottles.get(id);
    if (typeof data.amount !== 'string' || !/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(data.amount)) invalid('领用量须为正十进制字符串，最多两位小数。');
    const [integer, fraction = ''] = data.amount.split('.');
    const inputMinor = Number(integer) * 100 + Number(fraction.padEnd(2, '0'));
    if (inputMinor <= 0) invalid('领用量须大于零。');
    if (typeof data.unit !== 'string' || !Object.hasOwn(UNITS, data.unit) || UNITS[data.unit].dimension !== UNITS[bottle.unit].dimension) invalid('领用单位与单瓶单位维度不一致。');
    const baseMinor = inputMinor * UNITS[data.unit].factor;
    if (baseMinor % UNITS[bottle.unit].factor !== 0) invalid('换算后的领用量须能以单瓶单位的两位小数准确记录，请使用单瓶单位。');
    const amount = baseMinor / UNITS[bottle.unit].factor;
    const usedOn = date(data.used_on, '使用日期');
    const usedBy = data.used_by === undefined ? user.id : data.used_by;
    if (typeof usedBy !== 'string' || !usedBy || usedBy.length > 80) invalid('请提供有效的使用人。');
    if (typeof data.purpose !== 'string' || !data.purpose.trim() || data.purpose.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(data.purpose)) invalid('请填写实验用途（最多 200 字）。');
    const payload = JSON.stringify({ bottle_id: id, amount, unit: data.unit, requested_amount: signedDecimal(inputMinor), used_on: usedOn, used_by: usedBy, purpose: data.purpose.trim() });
    return this.auth.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM stock_movements WHERE recorded_by = ? AND idempotency_key = ?').get(user.id, key);
      if (existing) {
        if (existing.type !== 'consumption' || existing.request_payload !== payload) throw new AuthError(409, 'IDEMPOTENCY_CONFLICT', '同一请求键不能用于不同的领用内容。');
        return { movement: this.publicMovement(existing), bottle: this.bottles.get(id), replayed: true };
      }
      const actualUser = this.db.prepare('SELECT id, display_name FROM users WHERE id = ? AND active = 1').get(usedBy);
      if (!actualUser) invalid('使用人不存在或已停用。');
      const currentDate = today(this.auth.now());
      if (usedOn > currentDate || usedOn < bottle.received_on) invalid('使用日期不能晚于今天或早于入库日期。');
      const current = this.db.prepare('SELECT * FROM reagent_bottles WHERE id = ?').get(id);
      if (current.lifecycle_status !== 'in_stock' || (current.expires_on !== null && current.expires_on < currentDate) || current.remaining_minor <= 0) throw new AuthError(409, 'BOTTLE_UNAVAILABLE', '单瓶已过期、用完或报废，无法领用。');
      if (amount > current.remaining_minor) throw new AuthError(409, 'INSUFFICIENT_STOCK', '使用量超过当前余量，请刷新后核对用量。');
      const after = current.remaining_minor - amount, timestamp = new Date(this.auth.now()).toISOString();
      const result = this.db.prepare("UPDATE reagent_bottles SET remaining_minor = ?, lifecycle_status = ?, version = version + 1, updated_at = ? WHERE id = ? AND remaining_minor >= ? AND lifecycle_status = 'in_stock' AND version = ?")
        .run(after, after === 0 ? 'depleted' : 'in_stock', timestamp, id, amount, current.version);
      if (result.changes !== 1) throw new AuthError(409, 'STOCK_CONFLICT', '库存已变化，请刷新后重试。');
      const movementId = randomUUID();
      this.db.prepare("INSERT INTO stock_movements (id, bottle_id, type, quantity_delta_minor, before_minor, after_minor, unit, used_on, recorded_by, idempotency_key, request_payload, created_at, used_by, purpose, used_by_name, recorded_by_name, reagent_name, bottle_code, requested_amount, requested_unit, sequence) VALUES (?,?,'consumption',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sequence),0)+1 FROM stock_movements))")
        .run(movementId, id, -amount, current.remaining_minor, after, current.unit, usedOn, user.id, key, payload, timestamp, usedBy, data.purpose.trim(), actualUser.display_name, user.display_name, bottle.reagent_name, current.bottle_code, signedDecimal(inputMinor), data.unit);
      return { movement: this.publicMovement(this.db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(movementId)), bottle: this.bottles.get(id), replayed: false };
    });
  }
  users(user) {
    return { current_user_id: user.id, can_modify_information: user.role === 'admin', can_record_for_others: user.role === 'admin', items: this.db.prepare(`SELECT id, display_name FROM users WHERE active = 1 ${user.role === 'admin' ? '' : 'AND id = ?'} ORDER BY display_name, id`).all(...(user.role === 'admin' ? [] : [user.id])) };
  }
  history(params, { type, bottleId } = {}) {
    if (bottleId) this.bottles.get(bottleId);
    const allowed = ['page', 'page_size', 'q', 'date_from', 'date_to', 'used_by', 'recorded_by', 'reagent_id', 'bottle_id', 'type'];
    for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid('历史查询参数不受支持。');
    const number = (key, fallback, max) => {
      const value = params.get(key) ?? String(fallback);
      if (!/^[1-9]\d{0,6}$/.test(value) || Number(value) > max) invalid('分页参数不正确。');
      return Number(value);
    };
    const page = number('page', 1, 1000000), page_size = number('page_size', 20, 100);
    const conditions = [], args = [];
    const add = (clause, value) => { conditions.push(clause); args.push(value); };
    if (type) add('m.type = ?', type);
    if (params.has('type')) {
      const value = params.get('type');
      if (!['receipt', 'consumption', 'adjustment', 'disposal', 'reversal'].includes(value) || (type && value !== type)) invalid('流水类型不正确。');
      add('m.type = ?', value);
    }
    if (bottleId) {
      if (params.has('bottle_id') && params.get('bottle_id') !== bottleId) invalid('瓶号筛选与路径不一致。');
      add('m.bottle_id = ?', bottleId);
    }
    for (const field of ['used_by', 'recorded_by', 'reagent_id', 'bottle_id']) if (params.has(field)) {
      const value = params.get(field); if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) invalid('历史筛选 ID 格式不正确。');
      add(`${field === 'reagent_id' ? 'b' : 'm'}.${field} = ?`, value);
    }
    const start = params.has('date_from') ? date(params.get('date_from'), '起始日期') : undefined;
    const end = params.has('date_to') ? date(params.get('date_to'), '结束日期') : undefined;
    if (start && end && start > end) invalid('起始日期不能晚于结束日期。');
    if (start) add('m.used_on >= ?', start); if (end) add('m.used_on <= ?', end);
    const q = (params.get('q') || '').trim();
    if (q.length > 100 || /[\u0000-\u001f\u007f]/.test(q)) invalid('搜索内容不正确。');
    if (q) {
      conditions.push('(instr(lower(m.reagent_name), lower(?)) > 0 OR instr(lower(m.bottle_code), lower(?)) > 0 OR instr(lower(m.used_by_name), lower(?)) > 0 OR instr(lower(m.recorded_by_name), lower(?)) > 0 OR instr(lower(m.purpose), lower(?)) > 0)');
      args.push(q, q, q, q, q);
    }
    const from = `FROM stock_movements m JOIN reagent_bottles b ON b.id = m.bottle_id ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}`;
    const total = this.db.prepare(`SELECT count(*) AS total ${from}`).get(...args).total;
    const items = this.db.prepare(`SELECT m.* ${from} ORDER BY m.sequence DESC LIMIT ? OFFSET ?`).all(...args, page_size, (page - 1) * page_size).map(row => this.publicMovement(row));
    return { items, total, page, page_size };
  }
}
module.exports = { ConsumptionStore };
