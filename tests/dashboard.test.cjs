const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createFixture } = require('./auth-fixture.cjs');
const { ReagentStore } = require('../backend/reagents.cjs');
const { BottleStore } = require('../backend/bottles.cjs');
const { DashboardStore } = require('../backend/dashboard.cjs');
async function setup(t, options = {}) {
  const fixture = createFixture({ now: () => Date.parse('2026-10-06T00:00:00Z'), ...options }); t.after(() => fixture.close());
  const origin = await fixture.initialize(), auth = fixture.app.store;
  const actor = auth.db.prepare('SELECT * FROM users LIMIT 1').get();
  const reagents = new ReagentStore(auth), bottles = new BottleStore(auth, reagents); reagents.bottles = bottles;
  const dashboard = new DashboardStore(auth, bottles);
  const request = (url, cookie = '', method = 'GET') => fetch(origin + '/api/v1' + url, { method, headers: { Cookie: cookie, Origin: origin } });
  const response = await fetch(origin + '/api/v1/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(fixture.credentials) });
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const profile = (threshold = '0', unit = 'mL') => reagents.create({ name: randomUUID(), stock_unit: unit, low_stock_threshold: threshold }, actor);
  const bottle = (reagent, expires_on, amount = '1', unit = reagent.stock_unit) => bottles.create(reagent.id, { bottle_code: '', batch_no: 'LOT', location: '柜 A', initial_quantity: amount, unit, received_on: '2026-01-01', expires_on }, actor, randomUUID()).bottle;
  const get = query => dashboard.get(new URLSearchParams(query));
  return { ...fixture, auth, actor, profile, bottle, get, request, cookie, dashboard };
}
test('empty database has zero metrics and no fabricated alerts', async t => {
  const { request, cookie } = await setup(t);
  const data = await (await request('/dashboard', cookie)).json();
  assert.ok(Object.values(data.metrics).every(value => value === 0)); assert.deepEqual(data.items, []); assert.equal(data.total, 0);
  assert.equal(data.today, '2026-10-06'); assert.equal(data.timezone, 'Asia/Shanghai'); assert.equal(data.expiry_days, 60);
});
test('expiry includes today and day 60, excludes day 61 and ended bottles', async t => {
  const { profile, bottle, get, auth } = await setup(t), reagent = profile();
  for (const date of ['2026-10-05', '2026-10-06', '2026-12-05', '2026-12-06']) bottle(reagent, date);
  const ended = bottle(reagent, '2026-10-05'), depleted = bottle(reagent, '2026-10-06');
  auth.db.prepare("UPDATE reagent_bottles SET lifecycle_status = 'discarded' WHERE id = ?").run(ended.id);
  auth.db.prepare("UPDATE reagent_bottles SET lifecycle_status = 'depleted', remaining_minor = 0 WHERE id = ?").run(depleted.id);
  const data = get(); assert.equal(data.metrics.expiring_bottle_count, 2); assert.equal(data.metrics.expired_bottle_count, 1);
  assert.equal(data.metrics.available_bottle_count, 3); assert.equal(data.metrics.stocked_reagent_count, 1);
  assert.deepEqual(data.items.map(item => item.days_until_expiry), [-1, 0, 60]);
});
test('low stock uses strict threshold and exact volume/mass conversion, excludes expired stock', async t => {
  const { profile, bottle, get } = await setup(t);
  const equal = profile('1000'); bottle(equal, '2027-01-01', '1', 'L');
  const low = profile('1000.01'); bottle(low, '2027-01-01', '1', 'L');
  const expired = profile('1'); bottle(expired, '2026-10-05', '100');
  profile('0'); const missing = profile('1');
  const mass = profile('0.01', 'kg'); bottle(mass, '2027-01-01', '0.01', 'g');
  const data = get('type=low'); assert.equal(data.total, 4);
  assert.ok(!data.items.some(item => item.reagent_id === equal.id));
  assert.equal(data.items.find(item => item.reagent_id === low.id).quantity, '1000.00');
  assert.equal(data.items.find(item => item.reagent_id === expired.id).quantity, '0.00');
  assert.equal(data.items.find(item => item.reagent_id === missing.id).quantity, '0.00');
  assert.equal(data.items.find(item => item.reagent_id === mass.id).quantity, '0.00001');
  assert.deepEqual(get('type=expired').items[0].tags, ['expired', 'low']);
});
test('alerts are stable, complete and paginated beyond 100; filters retain global counts', async t => {
  const { profile, bottle, get, request, cookie } = await setup(t), reagent = profile('200');
  for (let i = 0; i < 125; i++) bottle(reagent, '2026-11-01');
  const first = get('type=expiry&page_size=100'), second = get('type=expiry&page_size=100&page=2');
  assert.equal(first.total, 125); assert.equal(first.items.length, 100); assert.equal(second.items.length, 25);
  assert.equal(first.counts.all, 126); assert.equal(new Set([...first.items, ...second.items].map(item => item.key)).size, 125);
  assert.deepEqual(first, get('type=expiry&page_size=100'));
  assert.deepEqual(await (await request('/alerts?type=expiry&page_size=100&page=2', cookie)).json(), second);
  assert.equal(get('page=999').items.length, 0);
});
test('dashboard enforces sessions, methods and strict query validation for both endpoints', async t => {
  const { request, cookie, auth } = await setup(t);
  for (const endpoint of ['/dashboard', '/alerts']) {
    assert.equal((await request(endpoint)).status, 401);
    assert.equal((await request(endpoint, cookie, 'POST')).status, 405);
    for (const query of ['page=0', 'page_size=101', 'type=unknown', 'type=', 'page=1&page=2', 'q=x', 'page=1.5']) assert.equal((await request(endpoint + '?' + query, cookie)).status, 422, query);
  }
  const credentials = { account: 'dashboard-reader', password: 'Reader-password-2026' };
  const member = await auth.createUser({ ...credentials, display_name: '成员' });
  const login = await fetch((await request('/dashboard', cookie)).url.replace('/dashboard', '/auth/login'), { method: 'POST', headers: { Origin: new URL((await request('/dashboard', cookie)).url).origin, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  const memberCookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/dashboard', memberCookie)).status, 200); auth.setActive(credentials.account, false);
  assert.equal((await request('/dashboard', memberCookie)).status, 401);
});
test('receipt and consumption immediately change the same dashboard inventory', async t => {
  const { request, cookie, profile, bottle } = await setup(t), reagent = profile('50'), saved = bottle(reagent, '2026-10-06', '100');
  assert.equal((await (await request('/dashboard', cookie)).json()).metrics.low_stock_count, 0);
  const origin = new URL((await request('/dashboard', cookie)).url).origin;
  const consumed = await fetch(origin + '/api/v1/bottles/' + saved.id + '/consumptions', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ amount: '100', unit: 'mL', used_on: '2026-10-06', purpose: '测试' }) });
  assert.equal(consumed.status, 201);
  const data = await (await request('/dashboard', cookie)).json();
  assert.equal(data.metrics.low_stock_count, 1); assert.equal(data.metrics.expiring_bottle_count, 0); assert.equal(data.metrics.stocked_reagent_count, 0);
});
test('DEF-008: a midnight request uses one Beijing date for expiry and available inventory', async t => {
  let rollover = false, calls = 0;
  const { profile, bottle, get } = await setup(t, { now: () => !rollover || calls++ === 0 ? Date.parse('2026-10-06T15:59:59.999Z') : Date.parse('2026-10-06T16:00:00Z') });
  const reagent = profile('1'); bottle(reagent, '2026-10-06'); rollover = true;
  const data = get(); assert.equal(data.today, '2026-10-06'); assert.equal(data.metrics.low_stock_count, 0); assert.equal(data.metrics.available_bottle_count, 1); assert.equal(data.metrics.expiring_bottle_count, 1);
});
