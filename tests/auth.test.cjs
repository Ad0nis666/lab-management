const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { AuthStore, AuthError } = require('../backend/auth.cjs');
const { createApplication } = require('../backend/server.cjs');
const { createFixture } = require('./auth-fixture.cjs');

// Node fetch normalizes Host; use the HTTP client to test raw Host handling.
function rawRequest(url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: body ? 'POST' : 'GET', headers }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject); req.end(body);
  });
}

async function setup(t, options) {
  const fixture = createFixture(options);
  t.after(() => fixture.close());
  const origin = await fixture.initialize();
  const request = (endpoint, { body, cookie, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) => fetch(`${origin}${endpoint}`, {
    method, redirect: 'manual', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = async (credentials = fixture.credentials, cookie) => {
    const response = await request('/api/v1/auth/login', { body: credentials, cookie });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  return { ...fixture, origin, request, login };
}
test('login uses hashed persistent users, HttpOnly session and safe public fields', async t => {
  const { app, request, credentials, login } = await setup(t);
  assert.equal((await request('/api/v1/auth/me')).status, 401);
  assert.equal((await request('/api/v1/dashboard')).status, 401);
  const redirect = await request('/index.html');
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), '/login.html');
  const bad = await request('/api/v1/auth/login', { body: { ...credentials, password: 'wrong' } });
  const unknown = await request('/api/v1/auth/login', { body: { ...credentials, account: 'nonexistent' } });
  assert.equal(bad.status, 401); assert.equal(unknown.status, 401);
  assert.equal((await bad.json()).error.message, (await unknown.json()).error.message);
  const response = await request('/api/v1/auth/login', { body: credentials });
  const header = response.headers.get('set-cookie');
  assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Strict/); assert.match(header, /Max-Age=28800/);
  const cookie = header.split(';')[0];
  const me = await request('/api/v1/auth/me', { cookie });
  const data = await me.json();
  assert.deepEqual(Object.keys(data.user).sort(), ['account', 'display_name', 'id', 'role']);
  assert.equal(data.user.role, 'admin');
  const user = app.store.db.prepare('SELECT * FROM users').get();
  assert.match(user.password_hash, /^scrypt\$32768\$/);
  assert.notEqual(user.password_hash, credentials.password);
  assert.notEqual(app.store.db.prepare('SELECT token_hash FROM sessions').get().token_hash, cookie.split('=')[1]);
  assert.equal((await request('/index.html', { cookie })).status, 200);
  const rotated = await login(credentials, cookie);
  assert.notEqual(rotated, cookie); assert.equal((await request('/api/v1/auth/me', { cookie })).status, 401);
});
test('logout revokes the token, not only the browser cookie', async t => {
  const { request, login } = await setup(t);
  const cookie = await login();
  const logout = await request('/api/v1/auth/logout', { body: {}, cookie });
  assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('/api/v1/auth/me', { cookie })).status, 401);
  assert.equal((await request('/index.html', { cookie })).status, 302);
});
test('password change verifies old password, validates new and revokes every session', async t => {
  const { request, login, credentials } = await setup(t);
  const first = await login(), second = await login();
  assert.equal((await request('/api/v1/auth/change-password', { body: { current_password: 'wrong', new_password: 'Changed-password-2026!' }, cookie: first })).status, 422);
  assert.equal((await request('/api/v1/auth/change-password', { body: { current_password: credentials.password, new_password: 'short' }, cookie: first })).status, 422);
  assert.equal((await request('/api/v1/auth/me', { cookie: first })).status, 200);
  const changed = await request('/api/v1/auth/change-password', { body: { current_password: credentials.password, new_password: 'Changed-password-2026!' }, cookie: first });
  assert.equal(changed.status, 200);
  for (const cookie of [first, second]) assert.equal((await request('/api/v1/auth/me', { cookie })).status, 401);
  assert.equal((await request('/api/v1/auth/login', { body: credentials })).status, 401);
  await login({ ...credentials, password: 'Changed-password-2026!' });
});
test('disabled users cannot login or reuse tokens, member role comes from DB', async t => {
  const { app, request, login } = await setup(t);
  const credentials = { account: 'test_member', password: 'Member-password-2026!' };
  await app.store.createUser({ ...credentials, display_name: '普通成员' });
  const cookie = await login(credentials);
  assert.equal((await (await request('/api/v1/auth/me', { cookie })).json()).user.role, 'member');
  app.store.setActive(credentials.account, false);
  assert.equal((await request('/api/v1/auth/me', { cookie })).status, 401);
  assert.equal((await request('/api/v1/auth/login', { body: credentials })).status, 401);
  app.store.setActive(credentials.account, true);
  assert.equal((await request('/api/v1/auth/me', { cookie })).status, 401);
  await login(credentials);
  assert.throws(() => app.store.setActive('test_admin', false), error => error.code === 'LAST_ADMIN');
});
test('sessions expire by server clock and forged local state cannot authenticate', async t => {
  let clock = Date.now();
  const { request, login } = await setup(t, { now: () => clock, sessionTTL: 1000 });
  const cookie = await login();
  clock += 1001;
  assert.equal((await request('/api/v1/auth/me', { cookie })).status, 401);
  assert.equal((await request('/api/v1/auth/me', { cookie: `lab_session=${'a'.repeat(64)}` })).status, 401);
  assert.equal((await request('/api/v1/auth/me', { cookie: 'pku-lab-demo-session=demo' })).status, 401);
});
test('strict origin rejects login/logout/change-password CSRF and wrong Host', async t => {
  const { request, login, credentials, origin } = await setup(t);
  const cookie = await login();
  for (const headers of [{ Origin: 'https://attacker.example' }, { Origin: 'null' }, { Origin: '' }]) {
    for (const endpoint of ['/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/auth/logout', '/api/v1/auth/change-password']) {
      assert.equal((await request(endpoint, { body: credentials, cookie, headers })).status, 403);
    }
  }
  assert.equal((await rawRequest(`${origin}/api/v1/auth/me`, { headers: { Cookie: cookie, Host: 'attacker.example' } })).status, 403);
  assert.equal((await request('/api/v1/auth/me', { cookie })).status, 200);
  const noOrigin = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  assert.equal(noOrigin.status, 403);
});
test('registration persists hashed member accounts, refuses duplicates and ignores privilege injection', async t => {
  const { app, request, login } = await setup(t);
  const data = { account: 'new_member', display_name: '新成员', password: 'Newpass9!', confirm_password: 'Newpass9!', role: 'admin', active: 0 };
  const response = await request('/api/v1/auth/register', { body: data });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('set-cookie'), null, 'Register then sign in explicitly');
  const { user } = await response.json();
  assert.equal(user.role, 'member'); assert.equal(user.password_hash, undefined);
  const stored = app.store.db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(stored.active, 1); assert.match(stored.password_hash, /^scrypt\$/);
  const duplicate = await request('/api/v1/auth/register', { body: data });
  assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).error.code, 'ACCOUNT_EXISTS');
  const cookie = await login({ account: data.account, password: data.password });
  assert.equal((await (await request('/api/v1/auth/me', { cookie })).json()).user.display_name, '新成员');
  const concurrent = { ...data, account: 'concurrent_member' };
  const responses = await Promise.all([request('/api/v1/auth/register', { body: concurrent }), request('/api/v1/auth/register', { body: concurrent })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM users WHERE account = ?').get(concurrent.account).n, 1);
});
test('registration validates name, account, nine-character password and matching confirmation', async t => {
  const { app, request } = await setup(t);
  const valid = { account: 'new_member', display_name: 'New', password: 'Newpass9!', confirm_password: 'Newpass9!' };
  for (const body of [{ ...valid, display_name: '' }, { ...valid, account: '中文账号' }, { ...valid, password: 'Pass123!', confirm_password: 'Pass123!' }, { ...valid, confirm_password: 'different' }, { ...valid, confirm_password: undefined }]) {
    assert.equal((await request('/api/v1/auth/register', { body })).status, 422);
  }
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
});
test('registration rate limit survives database storage and recovers independently of login', async t => {
  let clock = Date.now();
  const { request, login } = await setup(t, { now: () => clock });
  const body = { account: 'new_member', display_name: 'New', password: 'Newpass9!', confirm_password: 'different' };
  for (let i = 0; i < 5; i++) assert.equal((await request('/api/v1/auth/register', { body })).status, 422);
  const limited = await request('/api/v1/auth/register', { body });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '900');
  await login();
  clock += 900001;
  assert.equal((await request('/api/v1/auth/register', { body: { ...body, confirm_password: body.password } })).status, 201);
});
test('public registration never replaces first administrator initialization', async t => {
  const app = createApplication({ dbPath: ':memory:' });
  t.after(() => app.close());
  const origin = await app.listen();
  const body = { account: 'new_member', display_name: 'New', password: 'Newpass9!', confirm_password: 'Newpass9!' };
  const response = await fetch(`${origin}/api/v1/auth/register`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'SETUP_REQUIRED');
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  await app.store.createUser({ account: 'first_admin', display_name: 'Admin', password: 'Admin123!' }, true);
});
test('rate limits persist and recover after the window', async t => {
  let clock = Date.now();
  const { request, credentials, login } = await setup(t, { now: () => clock });
  for (let i = 0; i < 10; i++) assert.equal((await request('/api/v1/auth/login', { body: { ...credentials, password: 'wrong' } })).status, 401);
  const limited = await request('/api/v1/auth/login', { body: credentials });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '900');
  clock += 900001; await login();
});
test('malformed/oversized requests fail safely; source and databases stay private', async t => {
  const { request, origin, login } = await setup(t);
  for (const body of [{ account: null, password: 'a' }, { account: 'test_admin', password: null }, { account: 'x'.repeat(81), password: 'a' }]) {
    assert.equal((await request('/api/v1/auth/login', { body })).status, 422);
  }
  const malformed = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const oversized = await request('/api/v1/auth/login', { body: { payload: 'x'.repeat(9000) } });
  assert.equal(oversized.status, 413);
  assert.equal((await request('/api/v1/auth/login', { body: {}, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const cookie = await login();
  for (const endpoint of ['/backend/server.cjs', '/backend/migrations/001_auth.sql', '/.data/lab.sqlite', '/.git/config', '/BACKEND_REQUIREMENTS.md', '/assets/branding/README.md']) {
    assert.equal((await request(endpoint, { cookie })).status, 404, endpoint);
  }
  assert.equal((await request('/api/v1/health')).status, 200);
});
test('password reset revokes sessions; initial admin cannot be initialized twice', async t => {
  const { app, request, login, credentials } = await setup(t);
  const cookie = await login();
  await app.store.resetPassword(credentials.account, 'Reset-password-2026!');
  assert.equal((await request('/api/v1/auth/me', { cookie })).status, 401);
  assert.equal((await request('/api/v1/auth/login', { body: credentials })).status, 401);
  await login({ ...credentials, password: 'Reset-password-2026!' });
  await assert.rejects(app.store.createUser({ account: 'other_admin', password: 'Other-password-2026!', display_name: 'Other' }, true), error => error.code === 'ALREADY_INITIALIZED');
});
test('nine-character passwords work for creation, reset and change; eight are rejected', async t => {
  const { app, request, login } = await setup(t);
  const account = 'nine_member';
  await assert.rejects(app.store.createUser({ account, display_name: 'Nine', password: 'Pass123!' }), error => error.code === 'INVALID_PASSWORD');
  await app.store.createUser({ account, display_name: 'Nine', password: 'Pass1234!', role: 'admin' });
  let cookie = await login({ account, password: 'Pass1234!' });
  await assert.rejects(app.store.resetPassword(account, 'Reset12!'), error => error.code === 'INVALID_PASSWORD');
  assert.equal((await request('/api/v1/auth/me', { cookie })).status, 200);
  await app.store.resetPassword(account, 'Reset123!');
  assert.equal((await request('/api/v1/auth/me', { cookie })).status, 401);
  cookie = await login({ account, password: 'Reset123!' });
  const change = body => request('/api/v1/auth/change-password', { cookie, body: { current_password: 'Reset123!', ...body } });
  assert.equal((await change({ new_password: 'Newpass!' })).status, 422);
  assert.equal((await change({ new_password: ' '.repeat(9) })).status, 422);
  assert.equal((await change({ new_password: 'x'.repeat(129) })).status, 422);
  assert.equal((await change({ new_password: 'Newpass9!' })).status, 200);
  await login({ account, password: 'Newpass9!' });
});
test('accounts, sessions, limits and migrations survive service restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-auth-persist-'));
  const dbPath = path.join(directory, 'auth.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AuthStore({ dbPath });
  await store.createUser({ account: 'persistent', password: 'Persistent-password-2026!', display_name: 'Persistent' }, true);
  const { token } = await store.login('persistent', 'Persistent-password-2026!', '127.0.0.1');
  await store.dummyHash; store.close();
  const reopened = new AuthStore({ dbPath });
  try {
    assert.equal(reopened.requireSession(token).account, 'persistent');
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 6);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM login_limits').get().n, 2);
    assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
  } finally { await reopened.dummyHash; reopened.close(); }
});
test('account rename preserves identity, password and role, rejects conflicts and revokes sessions', async t => {
  const { app, request, login, credentials } = await setup(t);
  const cookie = await login();
  const before = app.store.db.prepare('SELECT * FROM users WHERE account = ?').get(credentials.account);
  await app.store.createUser({ account: 'existing_member', display_name: 'Member', password: 'Member123!' });
  assert.throws(() => app.store.renameAccount(credentials.account, 'existing_member'), error => error.code === 'ACCOUNT_EXISTS');
  assert.throws(() => app.store.renameAccount(credentials.account, '中文账号'), error => error.code === 'INVALID_ACCOUNT');
  assert.throws(() => app.store.renameAccount('missing_user', 'new_name'), error => error.code === 'USER_NOT_FOUND');
  assert.equal((await request('/api/v1/auth/me', { cookie })).status, 200, 'Failed rename must not revoke sessions');
  app.store.renameAccount(credentials.account, 'renamed_admin');
  const after = app.store.db.prepare('SELECT * FROM users WHERE account = ?').get('renamed_admin');
  for (const field of ['id', 'password_hash', 'display_name', 'role', 'active', 'created_at']) assert.equal(after[field], before[field], field);
  assert.equal((await request('/api/v1/auth/me', { cookie })).status, 401);
  assert.equal((await request('/api/v1/auth/login', { body: credentials })).status, 401);
  const nextCookie = await login({ ...credentials, account: 'renamed_admin' });
  app.store.renameAccount('renamed_admin', 'renamed_admin');
  assert.equal((await request('/api/v1/auth/me', { cookie: nextCookie })).status, 200, 'No-op rename preserves the session');
});
test('production requires HTTPS origin and sets Secure cookies', async t => {
  assert.throws(() => createApplication({ dbPath: ':memory:', production: true }), /APP_ORIGIN/);
  assert.throws(() => createApplication({ dbPath: ':memory:', production: true, origin: 'http://example.test' }), /HTTPS/);
  const app = createApplication({ dbPath: ':memory:', production: true, origin: 'https://lab.example.test' });
  t.after(() => app.close());
  await app.store.createUser({ account: 'secure_admin', password: 'Secure-password-2026!', display_name: 'Admin' }, true);
  await app.listen();
  const response = await rawRequest(`http://127.0.0.1:${app.server.address().port}/api/v1/auth/login`, { headers: { Host: 'lab.example.test', Origin: 'https://lab.example.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'secure_admin', password: 'Secure-password-2026!' }) });
  assert.equal(response.status, 200); assert.match(response.headers['set-cookie'][0], /; Secure/);
});

test('workspace serves every referenced browser script, including usage and permission guards', async t => {
  const { request, login } = await setup(t), cookie = await login();
  const page = await request('/index.html', { cookie }); assert.equal(page.status, 200);
  const html = await page.text();
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.includes('usage.js')); assert.ok(scripts.includes('dashboard.js')); assert.ok(scripts.includes('permissions.js'));
  for (const script of scripts) {
    const response = await request('/' + script); assert.equal(response.status, 200, script);
    assert.match(response.headers.get('content-type'), /javascript/, script); assert.ok((await response.text()).length > 0);
  }
});
