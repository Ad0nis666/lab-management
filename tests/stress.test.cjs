const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createFixture } = require('./auth-fixture.cjs');

async function setup(t) {
  const fixture = createFixture({ now: () => Date.parse('2026-10-06T00:00:00Z') });
  t.after(() => fixture.close());
  const origin = await fixture.initialize();
  const request = (url, body, key = randomUUID(), cookie = adminCookie) => fetch(origin + url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let adminCookie = '';
  adminCookie = (await request('/api/v1/auth/login', fixture.credentials)).headers.get('set-cookie').split(';')[0];
  return { ...fixture, request };
}

test('60 concurrent withdrawals and 25 retries never overdraw or duplicate stock history', async t => {
  const { request, app } = await setup(t);
  const { reagent } = await (await request('/api/v1/reagents', { name: '压力测试', stock_unit: 'mL' })).json();
  const receipt = { initial_quantity: '21', unit: 'mL', received_on: '2026-10-06' };
  const receipts = await Promise.all(Array.from({ length: 25 }, () => request(`/api/v1/reagents/${reagent.id}/bottles`, receipt, 'stress-receipt-key')));
  assert.equal(receipts.filter(r => r.status === 201).length, 1);
  assert.equal(receipts.filter(r => r.status === 200).length, 24);
  const { bottle } = await receipts[0].json();
  const url = `/api/v1/bottles/${bottle.id}/consumptions`;
  const usage = { amount: '1', unit: 'mL', used_on: '2026-10-06', purpose: '并发实验' };
  const retries = await Promise.all(Array.from({ length: 25 }, () => request(url, usage, 'stress-consume-key')));
  assert.equal(retries.filter(r => r.status === 201).length, 1);
  assert.equal(retries.filter(r => r.status === 200).length, 24);
  const results = await Promise.all(retries.map(r => r.json()));
  assert.equal(new Set(results.map(r => r.movement.id)).size, 1);
  const responses = await Promise.all(Array.from({ length: 60 }, () => request(url, usage)));
  assert.equal(responses.filter(r => r.status === 201).length, 20);
  assert.equal(responses.filter(r => r.status === 409).length, 40);
  const current = await (await request(`/api/v1/bottles/${bottle.id}`)).json();
  assert.equal(current.bottle.remaining_quantity, '0.00');
  assert.equal(current.bottle.lifecycle_status, 'depleted');
  const rows = app.store.db.prepare('SELECT * FROM stock_movements ORDER BY sequence').all();
  assert.equal(rows.length, 22);
  for (let i = 1; i < rows.length; i++) {
    assert.equal(rows[i].before_minor, rows[i - 1].after_minor);
    assert.equal(rows[i].after_minor, rows[i].before_minor + rows[i].quantity_delta_minor);
    assert.ok(rows[i].after_minor >= 0);
  }
  assert.deepEqual(app.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(app.store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('20 simultaneous stale edits preserve exactly one winner', async t => {
  const { request } = await setup(t);
  const data = { code: 'STRESS-SAMPLE', name: '并发样本', quantity: '1', unit: '份', location: '柜1', status: 'stored' };
  const { item } = await (await request('/api/v1/samples', data)).json();
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => request(`/api/v1/samples/${item.id}`, { ...data, name: `编辑${i}`, version: 1 })));
  assert.equal(responses.filter(r => r.status === 200).length, 1);
  assert.equal(responses.filter(r => r.status === 409).length, 19);
  const winner = await responses.find(r => r.status === 200).json();
  assert.deepEqual((await (await request(`/api/v1/samples/${item.id}`)).json()).item, winner.item);
});

test('malformed URL encodings are client errors and do not damage subsequent requests', async t => {
  const { request } = await setup(t);
  for (const path of ['/%', '/%GG', '/%E0%A4%A', '/assets/branding/%FF.png', '/api/v1/reagents/%GG']) {
    const response = await request(path);
    assert.equal(response.status, 400, path);
    assert.equal((await response.json()).error.code, 'INVALID_URL');
  }
  assert.equal((await request('/api/v1/health')).status, 200);
});
