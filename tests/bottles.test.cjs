const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createFixture } = require('./auth-fixture.cjs');
const { AuthStore } = require('../backend/auth.cjs');
const { ReagentStore } = require('../backend/reagents.cjs');
const { BottleStore } = require('../backend/bottles.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const receipt = { bottle_code: 'BT-TEST-001', batch_no: 'LOT-2026', initial_quantity: '100.25', unit: 'mL', location: 'A103 · 柜 A · 02', received_on: '2026-10-06', expires_on: '2027-10-06' };
async function setup(t, options = {}) {
  const fixture = createFixture({ now: () => Date.parse('2026-10-06T00:00:00Z'), ...options });
  t.after(() => fixture.close()); const origin = await fixture.initialize();
  const request = (endpoint, cookie, body, headers = {}) => fetch(origin + '/api/v1' + endpoint, {
    method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie || '', ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = async credentials => (await request('/auth/login', '', credentials)).headers.get('set-cookie').split(';')[0];
  const cookie = await login(fixture.credentials);
  const { reagent } = await (await request('/reagents', cookie, { name: '入库测试乙醇', stock_unit: 'mL' })).json();
  const save = (body = receipt, key = randomUUID(), actor = cookie) => request(`/reagents/${reagent.id}/bottles`, actor, body, { 'Idempotency-Key': key });
  return { ...fixture, request, cookie, login, reagent, save, origin };
}
test('receipt saves a bottle and trustworthy movement atomically, profile summaries agree', async t => {
  const { app, save, request, cookie, reagent } = await setup(t);
  const response = await save(); assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.bottle.initial_quantity, '100.25'); assert.equal(result.bottle.remaining_quantity, '100.25');
  assert.equal(result.bottle.quantity_mode, 'exact'); assert.equal(result.bottle.expiry_status, 'valid');
  for (const key of ['bottle_code', 'batch_no', 'unit', 'location', 'received_on', 'expires_on']) assert.equal(result.bottle[key], receipt[key]);
  assert.equal(result.bottle.initial_minor, undefined);
  const movement = app.store.db.prepare('SELECT * FROM stock_movements WHERE id = ?').get(result.movement_id);
  assert.equal(movement.type, 'receipt'); assert.equal(movement.before_minor, 0); assert.equal(movement.after_minor, 10025);
  assert.equal(movement.quantity_delta_minor, 10025); assert.equal(movement.recorded_by, result.bottle.created_by);
  const detail = await (await request('/bottles/' + result.bottle.id, cookie)).json(); assert.deepEqual(detail.bottle, result.bottle);
  const bottles = await (await request(`/reagents/${reagent.id}/bottles`, cookie)).json(); assert.equal(bottles.total, 1);
  const profile = await (await request('/reagents/' + reagent.id, cookie)).json();
  assert.deepEqual(profile.reagent.stock_summary, { bottle_count: 1, available_bottle_count: 1, total_quantity: '100.25', available_quantity: '100.25', unit: 'mL' });
  const catalog = await (await request('/reagents', cookie)).json(); assert.deepEqual(catalog.items[0].stock_summary, profile.reagent.stock_summary);
});
test('receipt permissions, unauthenticated, expired and disabled sessions are enforced', async t => {
  let timestamp = Date.parse('2026-10-06T00:00:00Z');
  const { save, request, app, reagent, cookie, login } = await setup(t, { now: () => timestamp });
  const credentials = { account: 'reader', password: 'Test-reader-password' };
  const member = await app.store.createUser({ ...credentials, display_name: '只读成员' });
  const memberCookie = await login(credentials);
  assert.equal((await save(receipt, randomUUID(), '')).status, 401);
  assert.equal((await save(receipt, randomUUID(), memberCookie)).status, 403);
  const result = await (await save()).json();
  assert.equal((await request(`/reagents/${reagent.id}/bottles`, memberCookie)).status, 200);
  assert.equal((await request('/bottles/' + result.bottle.id, memberCookie)).status, 200);
  assert.equal((await request(`/reagents/${reagent.id}/bottles`, cookie, receipt, { Origin: 'https://other.example', 'Idempotency-Key': randomUUID() })).status, 403);
  app.store.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(member.id);
  assert.equal((await request('/bottles/' + result.bottle.id, memberCookie)).status, 401);
  timestamp += 8 * 60 * 60 * 1000 + 1;
  assert.equal((await save()).status, 401);
  assert.equal((await request(`/reagents/${reagent.id}/bottles`, cookie)).status, 401);
});
test('concurrent retries create one bottle and one movement; key reuse conflicts and bottle codes are globally unique', async t => {
  const { save, app, cookie, request } = await setup(t);
  const key = randomUUID();
  const responses = await Promise.all(Array.from({ length: 5 }, () => save({ ...receipt, bottle_code: '' }, key)));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 200, 200, 200, 201]);
  const results = await Promise.all(responses.map(response => response.json()));
  assert.equal(new Set(results.map(result => result.bottle.id)).size, 1); assert.equal(new Set(results.map(result => result.movement_id)).size, 1);
  assert.match(results[0].bottle.bottle_code, /^BT-/);
  assert.equal((await save({ ...receipt, initial_quantity: '1' }, key)).status, 409);
  assert.equal((await save()).status, 201);
  assert.equal((await save({ ...receipt, bottle_code: 'bt-test-001' })).status, 409);
  const { reagent } = await (await request('/reagents', cookie, { name: '另一个档案', stock_unit: 'mL' })).json();
  assert.equal((await request(`/reagents/${reagent.id}/bottles`, cookie, receipt, { 'Idempotency-Key': randomUUID() })).status, 409);
  assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM reagent_bottles').get().n, 2);
  assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM stock_movements').get().n, 2);
});
test('invalid receipt inputs, dates, dimensions, precision and injection create no records', async t => {
  const { save, request, cookie, reagent, app } = await setup(t);
  for (const patch of [
    { initial_quantity: '0' }, { initial_quantity: '-1' }, { initial_quantity: '0.001' }, { initial_quantity: '1e3' }, { initial_quantity: 100 }, { initial_quantity: '1000000000' },
    { unit: ['mL'] }, { unit: { toString: 'mL' } }, { unit: 'g' }, { unit: '瓶' }, { unit: '__proto__' }, { unit: null }, { batch_no: null }, { location: 'x'.repeat(121) },
    { bottle_code: '瓶号' }, { bottle_code: null }, { bottle_code: 'a'.repeat(81) }, { received_on: '2026-02-30' }, { received_on: '2026-10-07' },
    { expires_on: '2026-10-05' }, { expires_on: '2026-02-29' }, { received_on: null }, { remaining_quantity: '999' }, { created_by: 'someone-else' }, { quantity_mode: 'rough' },
  ]) assert.equal((await save({ ...receipt, ...patch })).status, 422, JSON.stringify(patch));
  assert.equal((await request(`/reagents/${reagent.id}/bottles`, cookie, receipt)).status, 422, 'Request key is required');
  assert.equal((await request('/reagents/unknown/bottles', cookie, receipt, { 'Idempotency-Key': randomUUID() })).status, 404);
  assert.equal((await request('/bottles/unknown', cookie)).status, 404);
  assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM reagent_bottles').get().n, 0);
  assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM stock_movements').get().n, 0);
});
test('movement write failure rolls back the bottle; retry after recovery succeeds', async t => {
  const { app, save } = await setup(t);
  app.store.db.exec("CREATE TRIGGER receipt_failure BEFORE INSERT ON stock_movements BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  const key = randomUUID(); assert.equal((await save(receipt, key)).status, 500);
  assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM reagent_bottles').get().n, 0);
  assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM stock_movements').get().n, 0);
  app.store.db.exec('DROP TRIGGER receipt_failure'); assert.equal((await save(receipt, key)).status, 201);
});
test('unit conversion stays exact, expired bottles are excluded and expiry today is available in Shanghai timezone', async t => {
  const { save, request, cookie, reagent } = await setup(t, { now: () => Date.parse('2026-10-05T16:00:00Z') });
  assert.equal((await save({ ...receipt, bottle_code: 'A', initial_quantity: '0.01', unit: 'L', expires_on: '2026-10-06' })).status, 201);
  assert.equal((await save({ ...receipt, bottle_code: 'B', initial_quantity: '0.01', unit: 'mL' })).status, 201);
  const expired = await (await save({ ...receipt, bottle_code: 'C', initial_quantity: '1', unit: 'L', received_on: '2026-10-01', expires_on: '2026-10-05' })).json();
  assert.equal(expired.bottle.expiry_status, 'expired');
  const profile = await (await request('/reagents/' + reagent.id, cookie)).json();
  assert.deepEqual(profile.reagent.stock_summary, { bottle_count: 3, available_bottle_count: 2, total_quantity: '1010.01', available_quantity: '10.01', unit: 'mL' });
  const { reagent: liters } = await (await request('/reagents', cookie, { name: '升单位档案', stock_unit: 'L' })).json();
  assert.equal((await request(`/reagents/${liters.id}/bottles`, cookie, { ...receipt, bottle_code: 'D', initial_quantity: '0.01' }, { 'Idempotency-Key': randomUUID() })).status, 201);
  const result = await (await request('/reagents/' + liters.id, cookie)).json(); assert.equal(result.reagent.stock_summary.total_quantity, '0.00001');
  const { reagent: mass } = await (await request('/reagents', cookie, { name: '质量档案', stock_unit: 'kg' })).json();
  await request(`/reagents/${mass.id}/bottles`, cookie, { ...receipt, bottle_code: 'E', initial_quantity: '1.25', unit: 'g' }, { 'Idempotency-Key': randomUUID() });
  const massProfile = await (await request('/reagents/' + mass.id, cookie)).json(); assert.equal(massProfile.reagent.stock_summary.available_quantity, '0.00125');
});
test('bottle lists paginate stably and reject unsupported queries', async t => {
  const { save, request, cookie, reagent } = await setup(t);
  for (let i = 0; i < 7; i++) await save({ ...receipt, bottle_code: `PAGE-${i}` });
  const first = await (await request(`/reagents/${reagent.id}/bottles?page_size=3`, cookie)).json();
  const second = await (await request(`/reagents/${reagent.id}/bottles?page_size=3&page=2`, cookie)).json();
  assert.equal(first.total, 7); assert.equal(first.items.length, 3); assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 6);
  for (const query of ['page=0', 'page_size=101', 'page=1&page=2', 'state=expired']) assert.equal((await request(`/reagents/${reagent.id}/bottles?${query}`, cookie)).status, 422);
});
test('migration preserves prior profiles and receipt data survives restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bottle-persist-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'test.sqlite'); let auth = new AuthStore({ dbPath });
  const user = await auth.createUser({ account: 'admin', password: 'Test-password-1', display_name: '管理员' }, true);
  const reagent = new ReagentStore(auth).create({ name: '持久化乙醇', stock_unit: 'mL' }, user);
  auth.db.exec('DROP TABLE reminder_settings; DROP TABLE instruments; DROP TABLE samples; DROP TABLE stock_movements; DROP TABLE reagent_bottles; DELETE FROM schema_migrations WHERE version >= 3;');
  await auth.dummyHash; auth.close(); auth = new AuthStore({ dbPath });
  const profiles = new ReagentStore(auth), bottles = new BottleStore(auth, profiles);
  const saved = bottles.create(reagent.id, receipt, user, randomUUID());
  await auth.dummyHash; auth.close(); auth = new AuthStore({ dbPath });
  const reopened = new BottleStore(auth, new ReagentStore(auth));
  assert.equal(reopened.get(saved.bottle.id).initial_quantity, '100.25');
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM stock_movements').get().n, 1);
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 6);
  await auth.dummyHash; auth.close();
});
