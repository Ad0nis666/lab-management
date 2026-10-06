const { AuthError, publicUser } = require('./auth.cjs');
const MAX_DAYS = 365;
function publicMember(row) {
  return { ...publicUser(row), active: !!row.active, version: row.auth_version, created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString() };
}
class SettingsStore {
  constructor(auth) { this.auth = auth; this.db = auth.db; }
  invalid(message) { throw new AuthError(422, 'INVALID_SETTINGS', message); }
  administrator(token) {
    const user = this.auth.requireSession(token);
    if (user.role !== 'admin') throw new AuthError(403, 'FORBIDDEN', '您没有该权限');
    return user;
  }
  members(params) {
    for (const key of params.keys()) if (!['q', 'role', 'active', 'page', 'page_size'].includes(key) || params.getAll(key).length !== 1) this.invalid('查询参数不受支持。');
    const number = (key, fallback, max) => {
      const value = params.get(key) ?? String(fallback);
      if (!/^[1-9]\d{0,6}$/.test(value) || Number(value) > max) this.invalid('分页参数不正确。');
      return Number(value);
    };
    const page = number('page', 1, 1000000), page_size = number('page_size', 12, 100);
    const q = (params.get('q') ?? '').trim(), role = params.get('role') ?? '', active = params.get('active') ?? '';
    if (q.length > 100 || /[\u0000-\u001f\u007f]/.test(q) || !['', 'admin', 'member'].includes(role) || !['', '0', '1'].includes(active)) this.invalid('搜索或筛选条件不正确。');
    return this.auth.transaction(() => {
      const where = "WHERE (instr(lower(display_name), lower(?)) > 0 OR instr(lower(account), lower(?)) > 0) AND (? = '' OR role = ?) AND (? = '' OR active = CAST(? AS INTEGER))";
      const args = [q, q, role, role, active, active];
      const total = this.db.prepare(`SELECT count(*) AS total FROM users ${where}`).get(...args).total;
      const items = this.db.prepare(`SELECT id, account, display_name, role, active, auth_version, created_at, updated_at FROM users ${where} ORDER BY created_at, id LIMIT ? OFFSET ?`).all(...args, page_size, (page - 1) * page_size).map(publicMember);
      const summary = this.db.prepare("SELECT count(*) AS total, COALESCE(sum(role='admin' AND active=1),0) AS active_admins FROM users").get();
      return { items, total, page, page_size, summary };
    });
  }
  updateMember(id, data, token) {
    this.administrator(token);
    if (Object.keys(data).some(key => !['role', 'active', 'version'].includes(key)) || (!Object.hasOwn(data, 'role') && !Object.hasOwn(data, 'active')) || !Number.isSafeInteger(data.version) || data.version < 1 || (Object.hasOwn(data, 'role') && !['admin', 'member'].includes(data.role)) || (Object.hasOwn(data, 'active') && typeof data.active !== 'boolean')) this.invalid('请提供有效角色、账号状态和版本号。');
    return this.auth.transaction(() => {
      this.administrator(token);
      const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!row) throw new AuthError(404, 'USER_NOT_FOUND', '账号不存在。');
      if (row.auth_version !== data.version) throw new AuthError(409, 'VERSION_CONFLICT', '成员已被更新，请重新加载后再操作。');
      const role = data.role ?? row.role, active = data.active === undefined ? row.active : Number(data.active);
      if (row.role === 'admin' && row.active && (role !== 'admin' || !active) && this.db.prepare("SELECT count(*) AS count FROM users WHERE role='admin' AND active=1").get().count <= 1) throw new AuthError(409, 'LAST_ADMIN', '不能降级或停用最后一位有效管理员。');
      if (role !== row.role || active !== row.active) {
        this.db.prepare('UPDATE users SET role=?, active=?, auth_version=auth_version+1, updated_at=? WHERE id=?').run(role, active, this.auth.now(), id);
        this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      }
      return publicMember(this.db.prepare('SELECT * FROM users WHERE id=?').get(id));
    });
  }
  reminders() {
    const row = this.db.prepare('SELECT * FROM reminder_settings WHERE id=1').get();
    return { low_enabled: !!row.low_enabled, expiry_enabled: !!row.expiry_enabled, expiry_days: row.expiry_days, calibration_enabled: !!row.calibration_enabled, calibration_days: row.calibration_days, version: row.version, updated_at: row.updated_at, max_days: MAX_DAYS };
  }
  updateReminders(data, token) {
    this.administrator(token);
    const switches = ['low_enabled', 'expiry_enabled', 'calibration_enabled'], days = ['expiry_days', 'calibration_days'];
    if (Object.keys(data).some(key => ![...switches, ...days, 'version'].includes(key)) || !Number.isSafeInteger(data.version) || data.version < 1 || switches.some(key => typeof data[key] !== 'boolean') || days.some(key => !Number.isInteger(data[key]) || data[key] < 0 || data[key] > MAX_DAYS)) this.invalid(`提前天数须为 0–${MAX_DAYS} 的整数，请完整提交提醒规则。`);
    return this.auth.transaction(() => {
      this.administrator(token);
      if (this.reminders().version !== data.version) throw new AuthError(409, 'VERSION_CONFLICT', '提醒规则已被更新，请重新加载后再保存。');
      this.db.prepare('UPDATE reminder_settings SET low_enabled=?, expiry_enabled=?, expiry_days=?, calibration_enabled=?, calibration_days=?, version=version+1, updated_at=? WHERE id=1').run(Number(data.low_enabled), Number(data.expiry_enabled), data.expiry_days, Number(data.calibration_enabled), data.calibration_days, new Date(this.auth.now()).toISOString());
      return this.reminders();
    });
  }
}
module.exports = { SettingsStore, MAX_DAYS };
