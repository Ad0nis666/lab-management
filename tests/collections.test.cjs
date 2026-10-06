const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./auth-fixture.cjs');
const { CollectionStore } = require('../backend/collections.cjs');
const { AuthStore } = require('../backend/auth.cjs');
const { seedLab } = require('../backend/seed-lab.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const records = { instruments: { code: 'ARM-1', name: '机械臂', kind: 'robot', status: 'unknown' }, samples: { code: 'SAMPLE-1', name: '水样', project: '测试项目', quantity: '12.5', unit: '份', location: '柜1', status: 'stored' } };
async function setup(t) {
  const fixture = createFixture(); t.after(() => fixture.close()); const origin = await fixture.initialize();
  const request = (url, cookie = '', body, headers = {}, method) => fetch(origin + '/api/v1' + url, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const cookie = (await request('/auth/login', '', fixture.credentials)).headers.get('set-cookie').split(';')[0];
  return { ...fixture, request, cookie };
}
for (const kind of ['instruments', 'samples']) {
  test(`${kind}: authenticated reads, admin writes, Origin, disable and method guards`, async t => {
    const { request, cookie, app } = await setup(t);
    const credentials = { account: 'member', password: 'Member-password-1' };
    const member = await app.store.createUser({ ...credentials, display_name: '读者' });
    const memberCookie = (await request('/auth/login', '', credentials)).headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/' + kind)).status, 401);
    assert.equal((await request('/' + kind, '', records[kind])).status, 401);
    assert.equal((await request('/' + kind, memberCookie)).status, 200);
    const denial = await request('/' + kind, memberCookie, records[kind]); assert.equal(denial.status, 403); assert.equal((await denial.json()).error.message, '您没有该权限');
    assert.equal((await request('/' + kind, cookie, records[kind], { Origin: 'https://other.example' })).status, 403);
    const { item } = await (await request('/' + kind, cookie, records[kind])).json();
    assert.equal((await request(`/${kind}/${item.id}`, memberCookie)).status, 200);
    assert.equal((await request(`/${kind}/${item.id}`, memberCookie, { ...records[kind], version: 1 })).status, 403);
    assert.equal((await request('/' + kind, cookie, undefined, {}, 'DELETE')).status, 405);
    app.store.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(member.id);
    assert.equal((await request('/' + kind, memberCookie)).status, 401);
  });
  test(`${kind}: create/update round trip, unique codes and stale edits cannot overwrite`, async t => {
    const { request, cookie } = await setup(t);
    const response = await request('/' + kind, cookie, records[kind]); assert.equal(response.status, 201);
    const { item } = await response.json(); assert.equal(item.version, 1);
    assert.equal((await request('/' + kind, cookie, { ...records[kind], code: records[kind].code.toLowerCase() })).status, 409);
    const updated = await request(`/${kind}/${item.id}`, cookie, { ...records[kind], name: '已更新', version: 1 }); assert.equal(updated.status, 200);
    assert.equal((await updated.json()).item.version, 2);
    assert.equal((await request(`/${kind}/${item.id}`, cookie, { ...records[kind], name: '覆盖', version: 1 })).status, 409);
    const detail = await (await request(`/${kind}/${item.id}`, cookie)).json(); assert.equal(detail.item.name, '已更新'); assert.equal(detail.item.created_by, item.created_by);
    assert.equal((await request(`/${kind}/unknown`, cookie)).status, 404);
    assert.equal((await request(`/${kind}/${item.id}?q=x`, cookie)).status, 422);
    assert.equal((await request(`/${kind}/${item.id}`, cookie, records[kind])).status, 422);
  });
  test(`${kind}: validation, safe literal search, stable pagination, strict params`, async t => {
    const { request, cookie, app } = await setup(t);
    const patches = [{ code: ' ' }, { code: 'a b' }, { name: null }, { name: 'x'.repeat(101) }, { name: 'a\u0000b' }, { status: 'unknown_status' }, { created_by: 'fake' }, { version: 1 }];
    patches.push(...(kind === 'instruments' ? [{ kind: 'bad' }, { calibration_on: '2026-02-30' }, { calibration_on: '0000-01-01' }, { owner: [] }] : [{ quantity: '-1' }, { quantity: '1e2' }, { quantity: '0.001' }, { quantity: 1 }, { unit: '' }, { location: '' }]));
    for (const patch of patches) assert.equal((await request('/' + kind, cookie, { ...records[kind], ...patch })).status, 422, JSON.stringify(patch));
    assert.equal(app.store.db.prepare(`SELECT count(*) AS n FROM ${kind}`).get().n, 0);
    for (let i = 0; i < 15; i++) await request('/' + kind, cookie, { ...records[kind], code: `TEST-${i}`, name: i === 0 ? 'Literal %_ <img src=x>' : '测试' });
    const one = await (await request(`/${kind}?page_size=7`, cookie)).json(), two = await (await request(`/${kind}?page_size=7&page=2`, cookie)).json();
    assert.equal(one.total, 15); assert.equal(one.items.length, 7); assert.equal(new Set([...one.items, ...two.items].map(x => x.id)).size, 14);
    assert.deepEqual(one, await (await request(`/${kind}?page_size=7`, cookie)).json());
    for (const [q, n] of [['%_', 1], ["' OR 1=1 --", 0], ['test-14', 1]]) assert.equal((await (await request(`/${kind}?q=${encodeURIComponent(q)}`, cookie)).json()).total, n);
    for (const query of ['page=0', 'page_size=101', 'page=1&page=2', 'q=' + 'a'.repeat(101), 'status=stored']) assert.equal((await request(`/${kind}?${query}`, cookie)).status, 422);
  });
}
test('migration is repeatable; seed setup is explicit, idempotent, persists and creates no invented stock', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-collections-')), dbPath = path.join(dir, 'test.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let auth = new AuthStore({ dbPath }); await auth.createUser({ account: 'seed_admin', password: 'Seed-password-2026', display_name: '管理员' }, true);
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM instruments').get().n, 0);
  assert.deepEqual(seedLab(auth), { instruments: 3, reagents: 3 });
  assert.deepEqual(seedLab(auth), { instruments: 0, reagents: 0 });
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM reagent_bottles').get().n, 0);
  const actor = auth.db.prepare('SELECT * FROM users LIMIT 1').get();
  new CollectionStore(auth, 'samples').save(records.samples, actor);
  await auth.dummyHash; auth.close(); auth = new AuthStore({ dbPath });
  try {
    assert.equal(auth.db.prepare('SELECT max(version) AS n FROM schema_migrations').get().n, 6);
    assert.equal(auth.db.prepare('SELECT count(*) AS n FROM instruments').get().n, 3);
    assert.equal(auth.db.prepare('SELECT quantity FROM samples').get().quantity, '12.50');
    assert.deepEqual(auth.db.prepare('SELECT name FROM reagents ORDER BY name').all().map(x => x.name).sort(), ['水','醋酸','碳酸钠'].sort());
    assert.equal(auth.db.prepare("SELECT count(*) AS n FROM instruments WHERE status='unknown'").get().n, 3);
  } finally { await auth.dummyHash; auth.close(); }
});

test('summary is authenticated, uses real counts and updates after edits', async t => {
  const { request, cookie, app } = await setup(t);
  assert.equal((await request('/collections-summary')).status, 401);
  seedLab(app.store);
  let result = await (await request('/collections-summary', cookie)).json();
  assert.deepEqual(result.instruments, { total: 3, available: 0, unconfirmed: 3 }); assert.equal(result.samples.stored, 0); assert.equal(result.pending.length, 3);
  const item = (await (await request('/instruments', cookie)).json()).items[0];
  const data = { ...records.instruments, code: item.code, name: item.name, kind: item.kind, status: 'normal', version: 1 };
  await request('/instruments/' + item.id, cookie, data); await request('/samples', cookie, records.samples);
  result = await (await request('/collections-summary', cookie)).json(); assert.equal(result.instruments.available, 1); assert.equal(result.samples.stored, 1); assert.equal(result.pending.length, 2);
  assert.equal((await request('/collections-summary?x=1', cookie)).status, 422);
});
test('requested 1 L receipts preserve blank location and unknown expiry, allow consumption and replay safely', async t => {
  const { app, request, cookie } = await setup(t), auth = app.store;
  assert.deepEqual(seedLab(auth, { stock: true }), { instruments: 3, reagents: 3, bottles: 3 });
  assert.deepEqual(seedLab(auth, { stock: true }), { instruments: 0, reagents: 0, bottles: 0 });
  const list = await (await request('/bottles?available=true', cookie)).json(); assert.equal(list.total, 3);
  for (const item of list.items) {
    assert.equal(item.initial_quantity, '1.00'); assert.equal(item.unit, 'L'); assert.equal(item.location, ''); assert.equal(item.batch_no, ''); assert.equal(item.expires_on, null); assert.equal(item.expiry_status, 'unknown');
  }
  const dashboard = await (await request('/dashboard', cookie)).json(); assert.equal(dashboard.metrics.stocked_reagent_count, 3); assert.equal(dashboard.metrics.available_bottle_count, 3); assert.equal(dashboard.counts.expiry, 0); assert.equal(dashboard.counts.expired, 0);
  const { today } = require('../backend/bottles.cjs');
  const response = await request('/bottles/' + list.items[0].id + '/consumptions', cookie, { amount: '0.10', unit: 'L', used_on: today(auth.now()), purpose: '测试' }, { 'Idempotency-Key': 'unknown-expiry-use' });
  assert.equal(response.status, 201); assert.equal((await response.json()).bottle.remaining_quantity, '0.90');
  assert.equal(auth.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1); assert.deepEqual(auth.db.prepare('PRAGMA foreign_key_check').all(), []);
});
test('upgrade a populated version-four database without changing bottle IDs, expiry or immutable history', async t => {
  const { DatabaseSync } = require('node:sqlite');
  const { ReagentStore } = require('../backend/reagents.cjs'), { BottleStore } = require('../backend/bottles.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-v4-upgrade-')), dbPath = path.join(dir, 'test.sqlite'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacy = Object.create(AuthStore.prototype); legacy.db = new DatabaseSync(dbPath); legacy.now = () => Date.parse('2026-10-06T00:00:00Z');
  legacy.db.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);');
  for (const [i, file] of ['001_auth.sql','002_reagents.sql','003_bottles.sql','004_consumptions.sql'].entries()) {
    legacy.db.exec(fs.readFileSync(path.join(__dirname, '../backend/migrations', file), 'utf8')); legacy.db.prepare('INSERT INTO schema_migrations VALUES (?)').run(i + 1);
  }
  const user = await legacy.createUser({ account: 'legacy', password: 'Legacy-password-1', display_name: '管理员' }, true);
  const reagents = new ReagentStore(legacy), reagent = reagents.create({ name: '旧试剂', stock_unit: 'L' }, user);
  const saved = new BottleStore(legacy, reagents).create(reagent.id, { initial_quantity: '1', unit: 'L', batch_no: 'OLD', location: 'OLD', received_on: '2026-10-06', expires_on: '2027-10-06' }, user, 'legacy-receipt-key');
  legacy.close(); const auth = new AuthStore({ dbPath, now: legacy.now });
  try {
    assert.deepEqual(new BottleStore(auth, new ReagentStore(auth)).get(saved.bottle.id), saved.bottle);
    assert.equal(auth.db.prepare('SELECT bottle_id FROM stock_movements').get().bottle_id, saved.bottle.id);
    assert.deepEqual(auth.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => auth.db.prepare('DELETE FROM stock_movements').run(), /immutable/);
    assert.throws(() => auth.db.prepare('UPDATE reagent_bottles SET reagent_id=?').run('missing'), /FOREIGN KEY/);
  } finally { await auth.dummyHash; auth.close(); }
});
