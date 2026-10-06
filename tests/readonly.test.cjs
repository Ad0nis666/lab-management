const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createFixture } = require('./auth-fixture.cjs');
const { ReagentStore } = require('../backend/reagents.cjs');
const { BottleStore } = require('../backend/bottles.cjs');
const { ConsumptionStore } = require('../backend/consumptions.cjs');
async function setup(t) {
  const fixture = createFixture({ now: () => Date.parse('2026-10-06T00:00:00Z') }); t.after(() => fixture.close());
  const origin = await fixture.initialize(), auth = fixture.app.store;
  const actor = auth.db.prepare("SELECT * FROM users WHERE role = 'admin'").get();
  const reader = { account: 'readonly', password: 'Reader-password-2026' };
  const member = await auth.createUser({ ...reader, display_name: '只读成员' });
  const request = (url, cookie, method = 'GET', data) => fetch(origin + '/api/v1' + url, { method, headers: { Cookie: cookie || '', Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const login = async credentials => (await request('/auth/login', '', 'POST', credentials)).headers.get('set-cookie').split(';')[0];
  const cookie = await login(reader), adminCookie = await login(fixture.credentials);
  const reagents = new ReagentStore(auth), bottles = new BottleStore(auth, reagents), usages = new ConsumptionStore(auth, bottles);
  reagents.bottles = bottles;
  const reagent = reagents.create({ name: '权限测试试剂', stock_unit: 'mL' }, actor);
  const bottleData = { bottle_code: '', batch_no: 'A', initial_quantity: '100', unit: 'mL', location: '柜 A', received_on: '2026-10-01', expires_on: '2027-10-01' };
  const bottle = bottles.create(reagent.id, bottleData, actor, randomUUID()).bottle;
  return { ...fixture, origin, auth, actor, member, reader, request, cookie, adminCookie, reagent, bottle, bottleData, usages, login };
}
test('member can query shared information and log out, but every authenticated mutation returns exact denial without writes', async t => {
  const { auth, member, cookie, request, reagent, bottle, reader, login } = await setup(t);
  const before = auth.db.prepare('SELECT password_hash, auth_version FROM users WHERE id = ?').get(member.id);
  for (const path of ['/dashboard', '/alerts', '/reagents', '/reagents/' + reagent.id, `/reagents/${reagent.id}/bottles`, '/bottles', '/bottles/' + bottle.id, '/movements', '/consumptions', `/bottles/${bottle.id}/movements`, '/users', '/auth/me']) assert.equal((await request(path, cookie)).status, 200, path);
  const targets = ['/reagents', `/reagents/${reagent.id}/bottles`, `/bottles/${bottle.id}/consumptions`, '/auth/change-password', '/instruments', '/samples', '/settings/reminders', '/users/' + member.id];
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) for (const path of targets) {
    const response = await request(path, cookie, method, { name: '越权', role: 'admin', used_by: member.id, amount: '10', unit: 'mL', current_password: reader.password, new_password: 'Changed-password-2026' });
    assert.equal(response.status, 403, method + path); const data = await response.json(); assert.equal(data.error.code, 'FORBIDDEN'); assert.equal(data.error.message, '您没有该权限');
  }
  assert.deepEqual(auth.db.prepare('SELECT password_hash, auth_version FROM users WHERE id = ?').get(member.id), before);
  assert.equal(auth.db.prepare('SELECT remaining_minor FROM reagent_bottles WHERE id = ?').get(bottle.id).remaining_minor, 10000);
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM reagents').get().n, 1);
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM stock_movements').get().n, 1);
  const options = await (await request('/users', cookie)).json(); assert.equal(options.can_modify_information, false);
  assert.equal((await request('/auth/logout', cookie, 'POST', {})).status, 200);
  assert.equal((await request('/reagents', cookie)).status, 401); assert.ok(await login(reader));
});
test('service layer rejects member consumption and password changes; administrator can still record member usage', async t => {
  const { auth, member, actor, usages, bottle, request, adminCookie, cookie, reader } = await setup(t);
  const usage = { amount: '10', unit: 'mL', used_on: '2026-10-06', used_by: member.id, purpose: '管理员代录' };
  assert.throws(() => usages.create(bottle.id, usage, member, randomUUID()), error => error.status === 403 && error.message === '您没有该权限');
  await assert.rejects(auth.changePassword(cookie.split('=')[1], reader.password, 'Changed-password-2026'), error => error.status === 403 && error.message === '您没有该权限');
  const saved = usages.create(bottle.id, usage, actor, randomUUID()); assert.equal(saved.bottle.remaining_quantity, '90.00');
  assert.equal(saved.movement.used_by, member.id); assert.equal(saved.movement.recorded_by, actor.id);
  assert.equal((await (await request('/users', adminCookie)).json()).can_modify_information, true);
});
test('administrator demoted while mutation body arrives is denied before receipt, consumption or password changes', async t => {
  const http = require('node:http');
  const { origin, auth, actor, adminCookie, reagent, bottle, bottleData, credentials, server } = await setup(t);
  const initialHash = auth.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(actor.id).password_hash;
  const targets = [
    [`/reagents/${reagent.id}/bottles`, bottleData],
    [`/bottles/${bottle.id}/consumptions`, { amount: '1', unit: 'mL', used_on: '2026-10-06', purpose: '在途降级' }],
    ['/auth/change-password', { current_password: credentials.password, new_password: 'Changed-password-2026' }],
  ];
  for (const [path, data] of targets) {
    auth.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(actor.id);
    const body = JSON.stringify(data);
    const response = await new Promise((resolve, reject) => {
      const req = http.request(origin + '/api/v1' + path, { method: 'POST', headers: { Cookie: adminCookie, Origin: origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Idempotency-Key': randomUUID() } }, res => { let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) })); });
      req.on('error', reject);
      server.once('request', () => setImmediate(() => { auth.db.prepare("UPDATE users SET role = 'member' WHERE id = ?").run(actor.id); req.end(body.slice(1)); }));
      req.write(body.slice(0, 1));
    });
    assert.equal(response.status, 403, path); assert.equal(response.data.error.message, '您没有该权限');
  }
  assert.equal(auth.db.prepare('SELECT remaining_minor FROM reagent_bottles WHERE id = ?').get(bottle.id).remaining_minor, 10000);
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM stock_movements').get().n, 1);
  assert.equal(auth.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(actor.id).password_hash, initialHash);
});
