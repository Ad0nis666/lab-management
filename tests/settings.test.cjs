const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createFixture } = require('./auth-fixture.cjs');
const { SettingsStore } = require('../backend/settings.cjs');
const { AuthStore } = require('../backend/auth.cjs');
const { ReagentStore } = require('../backend/reagents.cjs');
const { BottleStore } = require('../backend/bottles.cjs');
const { ConsumptionStore } = require('../backend/consumptions.cjs');
const { CollectionStore } = require('../backend/collections.cjs');
async function setup(t) {
  const fixture = createFixture({ now: () => Date.parse('2026-10-05T16:00:00Z') }); t.after(() => fixture.close());
  const origin = await fixture.initialize(), auth = fixture.app.store, settings = new SettingsStore(auth);
  async function login(credentials) {
    const res = await fetch(origin + '/api/v1/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
    return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0], body: await res.json() };
  }
  const admin = await login(fixture.credentials);
  const credentials = { account: 'settings-reader', password: 'Reader-password-2026' };
  const member = await auth.createUser({ ...credentials, display_name: '<img onerror=alert(1)>成员' });
  const reader = await login(credentials);
  async function request(path, method = 'GET', data, cookie = admin.cookie, extra = {}) {
    const res = await fetch(origin + '/api/v1' + path, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: res.status, body: await res.json() };
  }
  return { ...fixture, origin, auth, settings, login, request, admin, reader, member, credentials };
}
test('members: real pagination, literal search, role/status filters and credential exclusion', async t => {
  const { request, auth, reader } = await setup(t);
  for (let i = 0; i < 13; i++) await auth.createUser({ account: `page-${i}`, password: 'Pagination-password', display_name: `分页 ${i}` });
  const page = await request('/settings/members?page_size=12', 'GET', undefined, reader.cookie);
  assert.equal(page.status, 200); assert.equal(page.body.total, 15); assert.equal(page.body.items.length, 12);
  assert.deepEqual(page.body.summary, { total: 15, active_admins: 1 });
  assert.equal((await request('/settings/members?page=2&page_size=12')).body.items.length, 3);
  assert.equal((await request('/settings/members?q=PAGE-1')).body.total, 4);
  assert.equal((await request('/settings/members?q=%25')).body.total, 0);
  assert.equal((await request('/settings/members?role=admin&active=1')).body.total, 1);
  assert.equal((await request('/settings/members?active=0')).body.total, 0);
  for (const item of page.body.items) assert.deepEqual(Object.keys(item).sort(), ['id', 'account', 'display_name', 'role', 'active', 'version', 'created_at', 'updated_at'].sort());
  for (const query of ['page=0', 'page_size=101', 'q=a&q=b', 'role=owner', 'active=true', 'password=x', 'page=1.2']) assert.equal((await request('/settings/members?' + query)).status, 422);
  assert.equal((await request('/settings/members', 'GET', undefined, '')).status, 401);
});
test('member changes revoke sessions, retain historical identity and require new login after activation', async t => {
  const { request, member, reader, login, credentials, auth } = await setup(t);
  assert.equal((await request(`/settings/members/${member.id}`, 'PATCH', { role: 'admin', version: 1 })).status, 200);
  assert.equal((await request('/auth/me', 'GET', undefined, reader.cookie)).status, 401);
  let newLogin = await login(credentials); assert.equal(newLogin.body.user.role, 'admin');
  assert.equal((await request(`/settings/members/${member.id}`, 'PATCH', { role: 'member', version: 2 })).status, 200);
  assert.equal((await request('/auth/me', 'GET', undefined, newLogin.cookie)).status, 401);
  newLogin = await login(credentials); assert.equal(newLogin.body.user.role, 'member');
  const reagents = new ReagentStore(auth), bottles = new BottleStore(auth, reagents);
  const actor = auth.requireSession(newLogin.cookie.split('=')[1]);
  const adminActor = auth.db.prepare("SELECT * FROM users WHERE account='test_admin'").get();
  const reagent = reagents.create({ name: '历史保留', stock_unit: 'mL' }, adminActor);
  const saved = bottles.create(reagent.id, { bottle_code: 'HISTORY', initial_quantity: '1', unit: 'mL', received_on: '2026-01-01', expires_on: '2027-01-01', location: '柜', batch_no: 'A' }, adminActor, randomUUID());
  new ConsumptionStore(auth, bottles).create(saved.bottle.id, { amount: '0.01', unit: 'mL', used_on: '2026-10-06', used_by: actor.id, purpose: '停用历史验收' }, adminActor, randomUUID());
  const before = auth.db.prepare('SELECT * FROM stock_movements').all();
  assert.equal((await request(`/settings/members/${member.id}`, 'PATCH', { active: false, version: 3 })).status, 200);
  assert.equal((await login(credentials)).status, 401);
  assert.equal((await request(`/settings/members/${member.id}`, 'PATCH', { active: true, version: 4 })).status, 200);
  assert.equal((await request('/auth/me', 'GET', undefined, newLogin.cookie)).status, 401);
  assert.equal((await login(credentials)).status, 200);
  assert.deepEqual(auth.db.prepare('SELECT * FROM stock_movements').all(), before);
});
test('last active administrator protected, including simultaneous self-management requests', async t => {
  const { request, admin, member, login, credentials } = await setup(t);
  const id = admin.body.user.id;
  for (const data of [{ role: 'member' }, { active: false }]) assert.equal((await request(`/settings/members/${id}`, 'PATCH', { ...data, version: 1 })).body.error.code, 'LAST_ADMIN');
  await request(`/settings/members/${member.id}`, 'PATCH', { role: 'admin', version: 1 });
  const other = await login(credentials);
  const results = await Promise.all([
    request(`/settings/members/${id}`, 'PATCH', { role: 'member', version: 1 }),
    request(`/settings/members/${member.id}`, 'PATCH', { active: false, version: 2 }, other.cookie)
  ]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
  assert.equal((await request('/auth/me', 'GET', undefined, results[0].status === 200 ? admin.cookie : other.cookie)).status, 401);
});
test('inactive admins are excluded; stale versions and invalid changes fail without writes', async t => {
  const { request, member, admin, auth } = await setup(t);
  await request(`/settings/members/${member.id}`, 'PATCH', { role: 'admin', active: false, version: 1 });
  assert.equal((await request(`/settings/members/${admin.body.user.id}`, 'PATCH', { active: false, version: 1 })).body.error.code, 'LAST_ADMIN');
  assert.equal((await request(`/settings/members/${member.id}`, 'PATCH', { active: true, version: 1 })).body.error.code, 'VERSION_CONFLICT');
  for (const data of [{ role: 'owner', version: 2 }, { active: 1, version: 2 }, { version: 2 }, { role: 'member', version: '2' }, { role: 'member', version: 2, account: 'overwrite' }]) assert.equal((await request(`/settings/members/${member.id}`, 'PATCH', data)).status, 422);
  assert.equal(auth.db.prepare('SELECT active FROM users WHERE id=?').get(member.id).active, 0);
  assert.equal((await request('/settings/members/missing', 'PATCH', { active: true, version: 1 })).status, 404);
});
test('members cannot mutate settings, origins and methods enforced; existing user options unchanged', async t => {
  const { request, member, reader, settings } = await setup(t);
  for (const [path, data] of [[`/settings/members/${member.id}`, { role: 'admin', version: 1 }], ['/settings/reminders', settings.reminders()]]) {
    const denied = await request(path, 'PATCH', data, reader.cookie); assert.equal(denied.status, 403); assert.equal(denied.body.error.message, '您没有该权限');
    assert.equal((await request(path, 'PATCH', data, undefined, { Origin: 'https://invalid.example' })).status, 403);
  }
  assert.equal((await request('/settings/reminders', 'POST', {})).status, 405);
  assert.equal((await request('/settings/reminders?q=x')).status, 422);
  assert.equal((await request('/users', 'GET', undefined, reader.cookie)).status, 200);
  assert.equal((await request('/users?q=x')).status, 422);
});
test('reminder validation, competing updates and SQLite restart persistence', async t => {
  const { request, settings, auth } = await setup(t);
  const { max_days, updated_at, ...data } = settings.reminders();
  assert.equal(data.expiry_days, 60); assert.equal(data.calibration_days, 30); assert.equal(max_days, 365);
  for (const value of [-1, 366, 1.5, '30', null]) assert.equal((await request('/settings/reminders', 'PATCH', { ...data, expiry_days: value })).status, 422);
  assert.equal((await request('/settings/reminders', 'PATCH', { ...data, low_enabled: 0 })).status, 422);
  const changes = { ...data, low_enabled: false, expiry_enabled: false, expiry_days: 0, calibration_days: 365 };
  const results = await Promise.all([request('/settings/reminders', 'PATCH', changes), request('/settings/reminders', 'PATCH', { ...changes, expiry_days: 5 })]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
  const databasePath = auth.db.prepare('PRAGMA database_list').get().file;
  const reopened = new AuthStore({ dbPath: databasePath });
  try { assert.deepEqual(new SettingsStore(reopened).reminders(), results.find(item => item.status === 200).body.settings); }
  finally { await reopened.dummyHash; reopened.close(); }
});
test('shared rules control dashboard and alerts, Beijing boundaries, expiry exclusion and calibration dates', async t => {
  const { request, settings, auth } = await setup(t);
  const actor = auth.db.prepare('SELECT * FROM users LIMIT 1').get();
  const reagents = new ReagentStore(auth), bottles = new BottleStore(auth, reagents); reagents.bottles = bottles;
  const reagent = reagents.create({ name: '边界试剂', stock_unit: 'mL', low_stock_threshold: '100' }, actor);
  for (const expires_on of ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '']) bottles.create(reagent.id, { bottle_code: '', initial_quantity: '1', unit: 'mL', location: '柜', batch_no: 'A', received_on: '2026-01-01', expires_on }, actor, randomUUID());
  const instruments = new CollectionStore(auth, 'instruments');
  for (const [i, calibration_on] of ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', ''].entries()) instruments.save({ code: `CAL-${i}`, name: `校准 ${i}`, kind: 'other', status: i === 0 ? 'fault' : 'normal', calibration_on }, actor);
  let { max_days, updated_at, ...rules } = settings.reminders();
  await request('/settings/reminders', 'PATCH', { ...rules, expiry_days: 2, calibration_days: 2 });
  let data = (await request('/dashboard')).body;
  assert.equal(data.today, '2026-10-06'); assert.equal(data.metrics.low_stock_count, 1); assert.equal(data.metrics.expiring_bottle_count, 2); assert.equal(data.metrics.expired_bottle_count, 1); assert.equal(data.metrics.calibration_count, 3);
  assert.deepEqual(data, (await request('/alerts')).body);
  assert.deepEqual((await request('/alerts?type=calibration')).body.items.map(item => item.days_until_calibration), [-1, 0, 2]);
  ({ max_days, updated_at, ...rules } = settings.reminders());
  await request('/settings/reminders', 'PATCH', { ...rules, low_enabled: false, expiry_enabled: false, calibration_enabled: false });
  data = (await request('/dashboard')).body;
  assert.equal(data.counts.all, 1); assert.equal(data.counts.expired, 1); assert.equal(data.counts.expiry, 0); assert.equal(data.counts.calibration, 0); assert.equal(data.counts.low, 0);
  assert.equal(data.metrics.stocked_reagent_count, 1); assert.equal(data.metrics.available_bottle_count, 4);
  const expiredBottle = auth.db.prepare('SELECT id FROM reagent_bottles WHERE expires_on= ?').get('2026-10-05');
  assert.throws(() => new ConsumptionStore(auth, bottles).create(expiredBottle.id, { amount: '0.01', unit: 'mL', used_on: '2026-10-06', purpose: '关闭提醒仍不可领过期瓶' }, actor, randomUUID()), error => error.code === 'BOTTLE_UNAVAILABLE');
  assert.equal((await request('/collections-summary')).body.pending[0].status, 'fault');
  ({ max_days, updated_at, ...rules } = settings.reminders());
  await request('/settings/reminders', 'PATCH', { ...rules, expiry_enabled: true, expiry_days: 0, calibration_enabled: true, calibration_days: 0 });
  data = (await request('/dashboard')).body; assert.equal(data.counts.expiry, 1); assert.equal(data.counts.calibration, 2);
});
