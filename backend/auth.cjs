const { DatabaseSync } = require('node:sqlite');
const { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const derive = promisify(scrypt);
const hashToken = token => createHash('sha256').update(token).digest('hex');
const DEFAULT_DB = path.resolve(__dirname, '../.data/lab.sqlite');

class AuthError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function validateAccount(account) {
  if (typeof account !== 'string' || !/^[a-zA-Z0-9_.@-]{3,80}$/.test(account)) {
    throw new AuthError(422, 'INVALID_ACCOUNT', '账号须为 3–80 位字母、数字或 _ . @ -。');
  }
}
function validatePassword(password, newPassword = false) {
  if (typeof password !== 'string' || password.length > 128 || password.length < (newPassword ? 9 : 1) || !password.trim()) {
    throw new AuthError(422, 'INVALID_PASSWORD', newPassword ? '新密码须为 9–128 位，不能全部为空格。' : '请填写有效的密码。');
  }
}
async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  const key = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$${salt}$${key.toString('hex')}`;
}
async function verifyPassword(password, hash) {
  const parts = hash.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt' || parts[1] !== '32768') return false;
  const actual = Buffer.from((await passwordHash(password, parts[2])).split('$')[3], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function publicUser(row) {
  return { id: row.id, account: row.account, display_name: row.display_name, role: row.role };
}
class AuthStore {
  constructor({ dbPath = DEFAULT_DB, now = Date.now, sessionTTL = 8 * 60 * 60 * 1000 } = {}) {
    this.now = now;
    this.sessionTTL = sessionTTL;
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') fs.chmodSync(dbPath, 0o600);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);');
    for (const [version, file] of [[1, '001_auth.sql'], [2, '002_reagents.sql'], [3, '003_bottles.sql'], [4, '004_consumptions.sql'], [5, '005_instruments_samples.sql'], [6, '006_settings.sql']]) {
      if (!this.db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version)) {
        // SQLite table rebuilds must disable FK enforcement before BEGIN, then verify
        // all existing bottle/movement references inside the migration transaction.
        if (version === 5) this.db.exec('PRAGMA foreign_keys = OFF;');
        try {
          this.transaction(() => {
            this.db.exec(fs.readFileSync(path.join(__dirname, 'migrations', file), 'utf8'));
            if (version === 5 && this.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('数据库引用校验失败。');
            this.db.prepare('INSERT INTO schema_migrations VALUES (?)').run(version);
          });
        } finally { if (version === 5) this.db.exec('PRAGMA foreign_keys = ON;'); }
      }
    }
    // Unknown accounts perform the same expensive comparison as known accounts.
    this.dummyHash = passwordHash(randomBytes(32).toString('hex'));
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async createUser({ account, password, display_name, role = 'member' }, initialAdmin = false) {
    validateAccount(account); validatePassword(password, true);
    if (!['admin', 'member'].includes(role) || typeof display_name !== 'string' || !display_name.trim() || display_name.trim().length > 40) {
      throw new AuthError(422, 'INVALID_USER', '请提供有效姓名（最多 40 字）及角色。');
    }
    const hash = await passwordHash(password);
    return this.transaction(() => {
      if (initialAdmin && this.db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
        throw new AuthError(409, 'ALREADY_INITIALIZED', '已经初始化过账号，请使用账号管理命令。');
      }
      if (this.db.prepare('SELECT 1 FROM users WHERE account = ?').get(account)) {
        throw new AuthError(409, 'ACCOUNT_EXISTS', '账号已存在。');
      }
      const user = { id: randomUUID(), account, display_name: display_name.trim(), role: initialAdmin ? 'admin' : role };
      this.db.prepare('INSERT INTO users (id, account, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(user.id, user.account, user.display_name, hash, user.role, this.now(), this.now());
      return user;
    });
  }
  requireSession(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new AuthError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录。');
    const row = this.db.prepare('SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1 AND s.auth_version = u.auth_version')
      .get(hashToken(token), this.now());
    if (!row) throw new AuthError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录。');
    return row;
  }
  limitLogin(account, ip) {
    return this.limitAttempts([[hashToken(`account:${account}`), 10], [hashToken(`ip:${ip}`), 50]], '登录尝试过于频繁，请稍后重试。');
  }
  limitAttempts(keys, message) {
    const now = this.now();
    this.db.prepare('DELETE FROM login_limits WHERE reset_at <= ?').run(now);
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    for (const [key, limit] of keys) {
      const row = this.db.prepare('SELECT * FROM login_limits WHERE key = ?').get(key);
      if (row && row.attempts >= limit) {
        const error = new AuthError(429, 'RATE_LIMITED', message);
        error.retryAfter = Math.ceil((row.reset_at - now) / 1000);
        throw error;
      }
    }
    for (const [key] of keys) this.db.prepare('INSERT INTO login_limits VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1').run(key, now + 15 * 60 * 1000);
  }
  async register(data, ip) {
    this.limitAttempts([[hashToken(`register:ip:${ip}`), 5]], '注册尝试过于频繁，请稍后重试。');
    if (!this.db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND active = 1 LIMIT 1").get()) {
      throw new AuthError(503, 'SETUP_REQUIRED', '请联系管理员先完成系统初始化。');
    }
    if (typeof data.confirm_password !== 'string' || data.password !== data.confirm_password) {
      throw new AuthError(422, 'PASSWORD_MISMATCH', '两次密码不一致，请重新确认。');
    }
    // Public registration can never choose an administrator role or account state.
    return this.createUser({ account: data.account, password: data.password, display_name: data.display_name, role: 'member' });
  }
  async login(account, password, ip, oldToken) {
    validateAccount(account); validatePassword(password);
    this.limitLogin(account, ip);
    const user = this.db.prepare('SELECT * FROM users WHERE account = ?').get(account);
    const valid = await verifyPassword(password, user ? user.password_hash : await this.dummyHash);
    if (!valid || !user?.active) throw new AuthError(401, 'INVALID_CREDENTIALS', '账号或密码不正确，请核对后重试。');
    // Recheck after async hashing: disabling/resetting during login must win.
    const current = this.db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!current.active || current.auth_version !== user.auth_version) throw new AuthError(401, 'INVALID_CREDENTIALS', '账号或密码不正确，请核对后重试。');
    const token = randomBytes(32).toString('hex');
    this.transaction(() => {
      if (oldToken) this.logout(oldToken);
      this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(hashToken(token), user.id, user.auth_version, this.now() + this.sessionTTL, this.now());
    });
    return { user: publicUser(current), token };
  }
  logout(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)); }
  async changePassword(token, currentPassword, newPassword) {
    const user = this.requireSession(token);
    if (user.role !== 'admin') throw new AuthError(403, 'FORBIDDEN', '您没有该权限');
    validatePassword(currentPassword); validatePassword(newPassword, true);
    if (!await verifyPassword(currentPassword, user.password_hash)) throw new AuthError(422, 'WRONG_PASSWORD', '原密码不正确。');
    const hash = await passwordHash(newPassword);
    this.transaction(() => {
      const current = this.requireSession(token);
      if (current.role !== 'admin') throw new AuthError(403, 'FORBIDDEN', '您没有该权限');
      if (current.auth_version !== user.auth_version) throw new AuthError(409, 'VERSION_CONFLICT', '账号状态已变化，请重新登录。');
      this.db.prepare('UPDATE users SET password_hash = ?, auth_version = auth_version + 1, updated_at = ? WHERE id = ?').run(hash, this.now(), user.id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    });
  }
  setActive(account, active) {
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM users WHERE account = ?').get(account);
      if (!row) throw new AuthError(404, 'USER_NOT_FOUND', '账号不存在。');
      if (!active && row.role === 'admin' && row.active && this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1").get().count <= 1) {
        throw new AuthError(409, 'LAST_ADMIN', '不能禁用最后一位有效管理员。');
      }
      this.db.prepare('UPDATE users SET active = ?, auth_version = auth_version + 1, updated_at = ? WHERE id = ?').run(active ? 1 : 0, this.now(), row.id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    });
  }
  renameAccount(account, newAccount) {
    validateAccount(newAccount);
    return this.transaction(() => {
      const user = this.db.prepare('SELECT * FROM users WHERE account = ?').get(account);
      if (!user) throw new AuthError(404, 'USER_NOT_FOUND', '账号不存在。');
      if (account === newAccount) return publicUser(user);
      if (this.db.prepare('SELECT 1 FROM users WHERE account = ?').get(newAccount)) {
        throw new AuthError(409, 'ACCOUNT_EXISTS', '新账号已存在。');
      }
      this.db.prepare('UPDATE users SET account = ?, auth_version = auth_version + 1, updated_at = ? WHERE id = ?').run(newAccount, this.now(), user.id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      return publicUser({ ...user, account: newAccount });
    });
  }
  async resetPassword(account, password) {
    validatePassword(password, true);
    const hash = await passwordHash(password);
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM users WHERE account = ?').get(account);
      if (!row) throw new AuthError(404, 'USER_NOT_FOUND', '账号不存在。');
      this.db.prepare('UPDATE users SET password_hash = ?, auth_version = auth_version + 1, updated_at = ? WHERE id = ?').run(hash, this.now(), row.id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    });
  }
  close() { this.db.close(); }
}
module.exports = { AuthStore, AuthError, publicUser, DEFAULT_DB };
