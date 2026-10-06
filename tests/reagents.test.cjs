const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./auth-fixture.cjs');
const { AuthStore } = require('../backend/auth.cjs');
const { ReagentStore } = require('../backend/reagents.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sample = { name: '无水乙醇', cas: '64-17-5', grade: '分析纯 AR', supplier: '测试供应商', catalog_no: 'ETH-001', category: '有机溶剂', hazard_tags: '易燃', stock_unit: 'mL', low_stock_threshold: '50.25' };
async function setup(t) {
  const fixture = createFixture(); t.after(() => fixture.close());
  const origin = await fixture.initialize();
  const request = (endpoint, cookie, body, extra = {}) => fetch(origin + '/api/v1' + endpoint, {
    method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie || '', ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = async credentials => (await request('/auth/login', '', credentials)).headers.get('set-cookie').split(';')[0];
  return { ...fixture, request, cookie: await login(fixture.credentials), login };
}
test('reagent routes require active sessions, enforce administrator writes and strict Origin', async t => {
  const { app, request, cookie, login } = await setup(t);
  assert.equal((await request('/reagents')).status, 401);
  assert.equal((await request('/reagents/unknown')).status, 401);
  assert.equal((await request('/reagents', '', sample)).status, 401);
  const credentials = { account: 'reader', password: 'Reader-password-1' };
  const member = await app.store.createUser({ ...credentials, display_name: '读者' });
  const memberCookie = await login(credentials);
  assert.equal((await request('/reagents', memberCookie, sample)).status, 403);
  assert.equal((await request('/reagents', memberCookie)).status, 200);
  assert.equal((await request('/reagents', cookie, sample, { Origin: 'https://other.example' })).status, 403);
  const saved = await (await request('/reagents', cookie, sample)).json();
  assert.equal((await request('/reagents/' + saved.reagent.id, memberCookie)).status, 200);
  app.store.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(member.id);
  assert.equal((await request('/reagents', memberCookie)).status, 401);
  await request('/auth/logout', cookie, {});
  assert.equal((await request('/reagents', cookie)).status, 401);
});
test('profiles round-trip, share CAS across grades and never create fictitious stock', async t => {
  const { request, cookie, app } = await setup(t);
  const response = await request('/reagents', cookie, sample);
  assert.equal(response.status, 201);
  const { reagent } = await response.json();
  for (const [key, value] of Object.entries(sample)) assert.equal(reagent[key], value);
  assert.ok(reagent.id && reagent.created_by && reagent.created_at);
  assert.equal(reagent.created_at, reagent.updated_at);
  assert.equal(reagent.remaining_quantity, undefined);
  assert.equal(reagent.password_hash, undefined);
  assert.equal((await request('/reagents', cookie, { ...sample, grade: '色谱纯' })).status, 201);
  const detail = await (await request('/reagents/' + reagent.id, cookie)).json();
  assert.deepEqual(detail.reagent, reagent);
  assert.equal((await request('/reagents/unknown', cookie)).status, 404);
  assert.equal(app.store.db.prepare('SELECT count(*) AS count FROM reagents').get().count, 2);
});
test('validation rejects malformed fields, CAS checksum, precision, unknown fields and numeric coercion without writes', async t => {
  const { request, cookie, app } = await setup(t);
  for (const patch of [
    { name: ' ' }, { name: 'x'.repeat(101) }, { name: 7 }, { name: 'a\u0000b' }, { cas: '64-17-6' }, { cas: 'invalid' },
    { stock_unit: '瓶' }, { stock_unit: 'unknown' }, { supplier: 'x'.repeat(121) }, { hazard_tags: [] },
    { low_stock_threshold: null }, { supplier: null }, { cas: null }, { low_stock_threshold: '-1' }, { low_stock_threshold: '0.001' }, { low_stock_threshold: 1 }, { low_stock_threshold: '1e3' },
    { low_stock_threshold: '1000000000' }, { low_stock_threshold: 'NaN' }, { low_stock_threshold: '01' }, { role: 'admin' },
  ]) {
    const response = await request('/reagents', cookie, { ...sample, ...patch });
    assert.equal(response.status, 422, JSON.stringify(patch));
    const error = await response.json(); assert.ok(error.request_id); assert.equal(error.error.code, 'INVALID_REAGENT');
  }
  assert.equal(app.store.db.prepare('SELECT count(*) AS count FROM reagents').get().count, 0);
  const response = await request('/reagents', cookie, { name: '无 CAS 档案', stock_unit: 'g' });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).reagent.low_stock_threshold, '0.00');
});
test('search treats SQL and wildcard input literally, paging is stable and parameters bounded', async t => {
  const { request, cookie } = await setup(t);
  for (let i = 0; i < 15; i++) assert.equal((await request('/reagents', cookie, { ...sample, name: i === 0 ? 'Literal %_ test' : `乙醇${i}`, catalog_no: `ET-${i}` })).status, 201);
  const first = await (await request('/reagents?page_size=7', cookie)).json();
  const again = await (await request('/reagents?page_size=7', cookie)).json();
  const second = await (await request('/reagents?page_size=7&page=2', cookie)).json();
  assert.equal(first.total, 15); assert.equal(first.items.length, 7); assert.deepEqual(first, again);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 14);
  for (const [q, count] of [['%_', 1], ["' OR 1=1 --", 0], ['64-17-5', 15], ['et-14', 1]]) {
    const result = await (await request('/reagents?q=' + encodeURIComponent(q), cookie)).json();
    assert.equal(result.total, count);
  }
  for (const query of ['page=0', 'page=-1', 'page=1.2', 'page_size=101', 'page_size=', 'status=low', 'page=1&page=2', 'q=' + 'a'.repeat(101)]) {
    assert.equal((await request('/reagents?' + query, cookie)).status, 422, query);
  }
});
test('migration upgrades an existing authentication database and profiles survive reopen', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reagent-persist-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'test.sqlite');
  let auth = new AuthStore({ dbPath });
  const user = await auth.createUser({ account: 'admin', password: 'Test-password-1', display_name: '管理员' }, true);
  // Simulate the previous schema without changing existing users.
  auth.db.exec('DROP TABLE reagents; DELETE FROM schema_migrations WHERE version = 2;');
  await auth.dummyHash; auth.close();
  auth = new AuthStore({ dbPath });
  const store = new ReagentStore(auth);
  const saved = store.create(sample, user);
  await auth.dummyHash; auth.close();
  auth = new AuthStore({ dbPath });
  assert.deepEqual(new ReagentStore(auth).get(saved.id), saved);
  assert.equal(auth.db.prepare('SELECT count(*) AS count FROM users').get().count, 1);
  assert.equal(auth.db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 6);
  await auth.dummyHash; auth.close();
});
