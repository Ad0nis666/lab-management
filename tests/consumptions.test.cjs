const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createFixture } = require('./auth-fixture.cjs');
const sample = { amount: '10', unit: 'mL', used_on: '2026-10-06', purpose: '样品前处理' };
async function setup(t, options = {}) {
  const fixture = createFixture({ now: () => Date.parse('2026-10-06T00:00:00Z'), ...options }); t.after(() => fixture.close());
  const origin = await fixture.initialize();
  const request = (endpoint, cookie, body, extra = {}) => fetch(origin + '/api/v1' + endpoint, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie || '', ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const login = async credentials => (await request('/auth/login', '', credentials)).headers.get('set-cookie').split(';')[0];
  const cookie = await login(fixture.credentials);
  const reagent = (await (await request('/reagents', cookie, { name: '领用试剂', stock_unit: 'mL' })).json()).reagent;
  const addBottle = async (patch = {}) => (await (await request(`/reagents/${reagent.id}/bottles`, cookie, { batch_no: 'A', initial_quantity: '100', unit: 'mL', location: 'A103', received_on: '2026-10-01', expires_on: '2027-10-01', ...patch })).json()).bottle;
  const bottle = await addBottle();
  const consume = (body = sample, actor = cookie, key = randomUUID(), id = bottle.id) => request(`/bottles/${id}/consumptions`, actor, body, { 'Idempotency-Key': key });
  const member = async (account = 'member', role = 'member') => { const credentials = { account, password: 'Test-member-password' }; const user = await fixture.app.store.createUser({ ...credentials, display_name: '成员' + account, role }); return { user, cookie: await login(credentials) }; };
  return { ...fixture, origin, request, cookie, reagent, bottle, addBottle, consume, member, login };
}
test('consumption updates stock and version with trusted identities; history is shared and public fields safe', async t => {
  const { request, consume, cookie, bottle, reagent, app, member } = await setup(t);
  const { user, cookie: memberCookie } = await member();
  const response = await consume({ ...sample, used_by: user.id }, cookie); assert.equal(response.status, 201);
  const result = await response.json(); assert.equal(result.bottle.remaining_quantity, '90.00'); assert.equal(result.bottle.version, 2);
  assert.equal(result.movement.before_quantity, '100.00'); assert.equal(result.movement.after_quantity, '90.00'); assert.equal(result.movement.quantity_delta, '-10.00');
  assert.equal(result.movement.used_by, user.id); assert.notEqual(result.movement.recorded_by, user.id);
  assert.equal(result.movement.recorded_by_name, '测试管理员');
  const history = await (await request('/movements', cookie)).json(); assert.equal(history.total, 2);
  const byBottle = await (await request(`/bottles/${bottle.id}/movements`, memberCookie)).json(); assert.equal(byBottle.total, 2);
  const usages = await (await request('/consumptions', memberCookie)).json(); assert.equal(usages.total, 1);
  assert.deepEqual(usages.items[0], result.movement);
  assert.equal(usages.items[0].request_payload, undefined); assert.equal(usages.items[0].idempotency_key, undefined);
  assert.equal((await (await request('/reagents/' + reagent.id, cookie)).json()).reagent.stock_summary.available_quantity, '90.00');
  assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM stock_movements WHERE type = 'consumption'").get().n, 1);
});
test('two people concurrently consuming 80 from 100 produce one successful movement and remaining 20', async t => {
  const { consume, member, bottle, request, cookie, app } = await setup(t);
  const a = await member('adminA', 'admin'), b = await member('adminB', 'admin');
  const responses = await Promise.all([consume({ ...sample, amount: '80' }, a.cookie), consume({ ...sample, amount: '80' }, b.cookie)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const detail = await (await request('/bottles/' + bottle.id, cookie)).json(); assert.equal(detail.bottle.remaining_quantity, '20.00'); assert.equal(detail.bottle.version, 2);
  assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM stock_movements WHERE type = 'consumption'").get().n, 1);
});
test('idempotent retries survive depletion and changed stock; different payloads and action types conflict', async t => {
  const { consume, request, cookie, bottle, app, reagent } = await setup(t);
  const key = randomUUID(); const body = { ...sample, amount: '100' };
  const responses = await Promise.all(Array.from({ length: 4 }, () => consume(body, cookie, key)));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 200, 200, 201]);
  const results = await Promise.all(responses.map(response => response.json()));
  assert.equal(new Set(results.map(result => result.movement.id)).size, 1); assert.equal(results[0].bottle.lifecycle_status, 'depleted');
  assert.equal((await consume({ ...body, purpose: '不同用途' }, cookie, key)).status, 409);
  assert.equal((await consume(sample)).status, 409);
  assert.equal((await request(`/reagents/${reagent.id}/bottles`, cookie, { batch_no: 'B', initial_quantity: '1', unit: 'mL', location: 'A', received_on: '2026-10-06', expires_on: '2027-10-06' }, { 'Idempotency-Key': key })).status, 409);
  const summary = (await (await request('/reagents/' + reagent.id, cookie)).json()).reagent.stock_summary;
  assert.equal(summary.available_quantity, '0.00'); assert.equal(summary.available_bottle_count, 0);
  assert.equal(app.store.db.prepare('SELECT remaining_minor FROM reagent_bottles WHERE id = ?').get(bottle.id).remaining_minor, 0);
});
test('member is read-only; administrator can record for an active member with separate actor', async t => {
  const { member, consume, app, request, cookie } = await setup(t);
  const a = await member('alice'), b = await member('bob');
  const denied = await consume(sample, a.cookie); assert.equal(denied.status, 403); assert.equal((await denied.json()).error.message, '您没有该权限');
  assert.equal((await consume({ ...sample, used_by: b.user.id }, a.cookie)).status, 403);
  const result = await (await consume({ ...sample, used_by: b.user.id })).json();
  assert.equal(result.movement.used_by, b.user.id); assert.notEqual(result.movement.recorded_by, b.user.id);
  assert.equal(result.movement.used_by_name, b.user.display_name); assert.equal(result.movement.recorded_by_name, '测试管理员');
  const options = await (await request('/users', a.cookie)).json(); assert.deepEqual(options.items.map(user => user.id), [a.user.id]); assert.equal(options.current_user_id, a.user.id); assert.equal(options.can_record_for_others, false);
  assert.ok((await (await request('/users', cookie)).json()).items.some(user => user.id === b.user.id));
  app.store.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(b.user.id);
  assert.equal((await consume({ ...sample, used_by: b.user.id })).status, 422);
  assert.equal((await consume(sample, b.cookie)).status, 401);
  assert.equal((await consume(sample, '')).status, 401);
  assert.equal((await request('/movements')).status, 401);
  assert.equal((await request('/consumptions')).status, 401);
});
test('invalid amounts, dates, units, users and forged fields leave stock and movements unchanged', async t => {
  const { consume, app, bottle, cookie, request } = await setup(t);
  for (const patch of [{ amount: '0' }, { amount: '-1' }, { amount: '0.001' }, { amount: '1e2' }, { amount: 1 }, { amount: null }, { amount: '1000000000' }, { unit: ['mL'] }, { unit: 'g' }, { unit: null }, { used_on: '2026-02-30' }, { used_on: '2026-10-07' }, { used_on: '2026-09-30' }, { used_by: null }, { used_by: 'unknown' }, { purpose: '' }, { purpose: 'x'.repeat(201) }, { purpose: 'a\u0000b' }, { recorded_by: 'fake' }, { role: 'admin' }]) assert.equal((await consume({ ...sample, ...patch })).status, 422, JSON.stringify(patch));
  assert.equal((await consume({ ...sample, amount: '101' })).status, 409);
  assert.equal((await consume(sample, cookie, 'invalid')).status, 422);
  assert.equal((await consume(sample, cookie, randomUUID(), 'unknown')).status, 404);
  assert.equal((await request(`/bottles/${bottle.id}/consumptions`, cookie, sample, { Origin: 'https://other.example' })).status, 403);
  assert.equal(app.store.db.prepare('SELECT remaining_minor FROM reagent_bottles WHERE id = ?').get(bottle.id).remaining_minor, 10000);
  assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM stock_movements WHERE type = 'consumption'").get().n, 0);
});
test('expired, depleted and discarded bottles cannot be consumed; date of expiry is available in Shanghai', async t => {
  const { addBottle, consume, cookie, app } = await setup(t, { now: () => Date.parse('2026-10-05T16:00:00Z') });
  const expired = await addBottle({ expires_on: '2026-10-05' }); assert.equal((await consume(sample, cookie, randomUUID(), expired.id)).status, 409);
  const today = await addBottle({ expires_on: '2026-10-06' }); assert.equal((await consume(sample, cookie, randomUUID(), today.id)).status, 201);
  const discarded = await addBottle(); app.store.db.prepare("UPDATE reagent_bottles SET lifecycle_status = 'discarded' WHERE id = ?").run(discarded.id);
  assert.equal((await consume(sample, cookie, randomUUID(), discarded.id)).status, 409);
});
test('unit conversion is exact and unrepresentable converted amounts are rejected', async t => {
  const { consume, addBottle, cookie } = await setup(t);
  const result = await (await consume({ ...sample, amount: '0.01', unit: 'L' })).json(); assert.equal(result.bottle.remaining_quantity, '90.00'); assert.equal(result.movement.requested_amount, '0.01'); assert.equal(result.movement.unit, 'mL');
  const liters = await addBottle({ unit: 'L', initial_quantity: '1' });
  assert.equal((await consume({ ...sample, amount: '0.01' }, cookie, randomUUID(), liters.id)).status, 422);
  const mass = await consume({ ...sample, unit: 'kg' }); assert.equal(mass.status, 422);
});
test('failed movement write rolls back stock decrement and version increment', async t => {
  const { app, consume, bottle, cookie } = await setup(t);
  app.store.db.exec("CREATE TRIGGER consumption_failure BEFORE INSERT ON stock_movements WHEN NEW.type = 'consumption' BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  const key = randomUUID(); assert.equal((await consume(sample, cookie, key)).status, 500);
  const row = app.store.db.prepare('SELECT remaining_minor, version FROM reagent_bottles WHERE id = ?').get(bottle.id); assert.equal(row.remaining_minor, 10000); assert.equal(row.version, 1);
  app.store.db.exec('DROP TRIGGER consumption_failure'); assert.equal((await consume(sample, cookie, key)).status, 201);
});
test('more than 100 history rows remain accessible, paging is stable, filters and snapshots preserve audit trail', async t => {
  const { consume, request, cookie, bottle, member, app } = await setup(t);
  const actor = await member();
  for (let i = 0; i < 125; i++) assert.equal((await consume({ ...sample, amount: '0.01', used_by: actor.user.id, purpose: i === 0 ? '字面 %_ <img src=x>' : '历史分页' })).status, 201);
  const first = await (await request('/consumptions?page_size=100', cookie)).json(); const second = await (await request('/consumptions?page_size=100&page=2', cookie)).json();
  assert.equal(first.total, 125); assert.equal(first.items.length, 100); assert.equal(second.items.length, 25); assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 125);
  assert.deepEqual(first, await (await request('/consumptions?page_size=100', cookie)).json());
  app.store.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('新姓名', actor.user.id);
  const query = new URLSearchParams({ q: actor.user.display_name, used_by: actor.user.id, recorded_by: first.items[0].recorded_by, bottle_id: bottle.id, date_from: '2026-10-06', date_to: '2026-10-06' });
  assert.equal((await (await request('/consumptions?' + query, cookie)).json()).total, 125);
  assert.equal((await (await request('/consumptions?q=' + encodeURIComponent('%_'), cookie)).json()).total, 1);
  assert.equal((await (await request('/consumptions?q=' + encodeURIComponent("' OR 1=1 --"), cookie)).json()).total, 0);
  assert.throws(() => app.store.db.prepare('DELETE FROM stock_movements WHERE id = ?').run(first.items[0].id), /immutable/);
  assert.throws(() => app.store.db.prepare('UPDATE stock_movements SET purpose = ? WHERE id = ?').run('覆盖', first.items[0].id), /immutable/);
  for (const invalid of ['page=0', 'page_size=101', 'q=' + 'x'.repeat(101), 'date_from=2026-10-07&date_to=2026-10-06', 'date_from=2026-02-30', 'type=receipt', 'page=1&page=2', 'unknown=yes', 'used_by=']) assert.equal((await request('/consumptions?' + invalid, cookie)).status, 422, invalid);
  assert.equal((await request('/bottles/unknown/movements', cookie)).status, 404);
  assert.equal((await request(`/bottles/${bottle.id}/movements?bottle_id=other`, cookie)).status, 422);
});
test('available bottle search excludes expired and exhausted bottles and supports all pages', async t => {
  const { request, cookie, addBottle, consume, bottle } = await setup(t);
  await addBottle({ expires_on: '2026-10-05' }); await consume({ ...sample, amount: '100' });
  const fresh = await addBottle({ bottle_code: 'SEARCHABLE' });
  const list = await (await request('/bottles?available=true&page_size=1', cookie)).json(); assert.equal(list.total, 1); assert.equal(list.items[0].id, fresh.id); assert.notEqual(list.items[0].id, bottle.id);
  assert.equal((await (await request('/bottles?available=true&q=SEARCHABLE', cookie)).json()).total, 1);
  assert.equal((await request('/bottles?available=unknown', cookie)).status, 422);
});

test('DEF-004: actor disabled while the request body is arriving cannot commit a consumption', async t => {
  const http = require('node:http');
  const { app, server, origin, bottle, cookie, member } = await setup(t);
  const target = await member('target_member');
  const admin = app.store.db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
  const body = JSON.stringify({ ...sample, used_by: target.user.id });
  const status = await new Promise((resolve, reject) => {
    const req = http.request(origin + `/api/v1/bottles/${bottle.id}/consumptions`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Idempotency-Key': randomUUID() } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    server.once('request', () => setImmediate(() => {
      app.store.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(admin.id);
      req.end(body.slice(1));
    }));
    req.write(body.slice(0, 1));
  });
  assert.equal(status, 401);
  assert.equal(app.store.db.prepare('SELECT remaining_minor FROM reagent_bottles WHERE id = ?').get(bottle.id).remaining_minor, 10000);
});

test('version-three receipt history migrates safely and consumption history survives database reopen', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { AuthStore } = require('../backend/auth.cjs'), { ReagentStore } = require('../backend/reagents.cjs'), { BottleStore } = require('../backend/bottles.cjs'), { ConsumptionStore } = require('../backend/consumptions.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'consumption-migrate-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'test.sqlite'), now = () => Date.parse('2026-10-06T00:00:00Z');
  let auth = new AuthStore({ dbPath, now });
  const actor = await auth.createUser({ account: 'admin', password: 'Test-password-1', display_name: '历史操作者' }, true);
  let reagents = new ReagentStore(auth), bottles = new BottleStore(auth, reagents);
  const reagent = reagents.create({ name: '历史试剂', stock_unit: 'mL' }, actor);
  const receipt = bottles.create(reagent.id, { batch_no: 'A', initial_quantity: '100', unit: 'mL', location: 'A', received_on: '2026-10-01', expires_on: '2027-10-01' }, actor, randomUUID());
  const oldRow = auth.db.prepare('SELECT * FROM stock_movements').get();
  auth.db.exec('DROP TABLE stock_movements; DELETE FROM schema_migrations WHERE version = 4;');
  const oldSchema = fs.readFileSync(path.join(__dirname, '../backend/migrations/003_bottles.sql'), 'utf8').split('CREATE TABLE stock_movements')[1];
  auth.db.exec('CREATE TABLE stock_movements' + oldSchema);
  const fields = ['id', 'bottle_id', 'type', 'quantity_delta_minor', 'before_minor', 'after_minor', 'unit', 'used_on', 'recorded_by', 'idempotency_key', 'request_payload', 'created_at'];
  auth.db.prepare(`INSERT INTO stock_movements (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...fields.map(field => oldRow[field]));
  await auth.dummyHash; auth.close(); auth = new AuthStore({ dbPath, now });
  let store = new ConsumptionStore(auth, new BottleStore(auth, new ReagentStore(auth)));
  const migrated = store.history(new URLSearchParams()).items[0]; assert.equal(migrated.type, 'receipt'); assert.equal(migrated.recorded_by_name, actor.display_name); assert.equal(migrated.reagent_name, reagent.name);
  const used = store.create(receipt.bottle.id, sample, actor, randomUUID());
  await auth.dummyHash; auth.close(); auth = new AuthStore({ dbPath, now }); store = new ConsumptionStore(auth, new BottleStore(auth, new ReagentStore(auth)));
  assert.equal(store.bottles.get(receipt.bottle.id).remaining_quantity, '90.00');
  const history = store.history(new URLSearchParams()); assert.equal(history.total, 2); assert.ok(history.items.some(row => row.id === used.movement.id));
  assert.throws(() => auth.db.prepare('DELETE FROM stock_movements WHERE id = ?').run(used.movement.id), /immutable/);
  await auth.dummyHash; auth.close();
});

test('DEF-006: history preserves transaction order when movements share one millisecond', async t => {
  const { consume, request, cookie } = await setup(t);
  const ids = [];
  for (let i = 0; i < 30; i++) ids.push((await (await consume({ ...sample, amount: '0.01' })).json()).movement.id);
  const history = await (await request('/consumptions?page_size=100', cookie)).json();
  assert.deepEqual(history.items.map(row => row.id), ids.reverse());
});
