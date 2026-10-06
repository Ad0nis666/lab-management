const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { randomUUID } = require('node:crypto');
const fixture = require('./auth-fixture.cjs').createFixture();
(async () => {
  let browser;
  try {
    const origin = await fixture.initialize(), auth = fixture.app.store;
    const reader = { account: 'browser_reader', password: 'Reader-password-2026' };
    await auth.createUser({ ...reader, display_name: '只读用户' });
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
    const admin = await browser.newContext(); await fixture.signIn(admin);
    const post = (path, data) => admin.request.post(origin + '/api/v1' + path, { headers: { Origin: origin, 'Idempotency-Key': randomUUID() }, data });
    const reagent = (await (await post('/reagents', { name: '只读验收试剂', stock_unit: 'mL' })).json()).reagent;
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const bottle = (await (await post(`/reagents/${reagent.id}/bottles`, { bottle_code: 'READONLY-BOTTLE', batch_no: 'A', initial_quantity: '100', unit: 'mL', location: '柜 A', received_on: date, expires_on: date })).json()).bottle;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const login = await context.request.post(origin + '/api/v1/auth/login', { headers: { Origin: origin }, data: reader }); assert.equal(login.status(), 200);
    const page = await context.newPage(), errors = [], writes = []; page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
    const deny = async action => {
      const dialog = page.waitForEvent('dialog').then(async popup => { assert.equal(popup.type(), 'alert'); assert.equal(popup.message(), '您没有该权限'); await popup.accept(); });
      await action(); await dialog;
    };
    const ready = () => page.waitForFunction(() => document.querySelector('.profile-copy small').textContent === '普通成员');
    await page.goto(origin); await ready();
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await deny(() => page.locator('.welcome-actions [data-open-usage]').click());
      assert.equal(await page.locator('#usage-dialog').isVisible(), false);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await deny(() => page.locator('#page-overview .usage-panel [data-open-usage]').click());
    for (const button of await page.locator('.task-list button').all()) await deny(() => button.click());
    await page.locator('[data-page="reagents"]').click(); await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 1);
    await deny(() => page.locator('[data-open-dialog]').click()); assert.equal(await page.locator('#reagent-dialog').isVisible(), false);
    await deny(() => page.locator('[data-open-bottle]').click()); assert.equal(await page.locator('#bottle-dialog').isVisible(), false);
    await page.locator('.catalog-card').getByRole('button', { name: '查看详情', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#reagent-detail').textContent.includes('只读验收试剂'));
    await deny(() => page.locator('#detail-open-bottle').click());
    await page.locator('#reagent-detail-dialog button[aria-label="关闭档案详情"]').click();
    await page.evaluate(id => openBottleDetail(id), bottle.id); await page.waitForFunction(() => document.querySelector('#bottle-detail-title').textContent === 'READONLY-BOTTLE');
    await deny(() => page.locator('#bottle-open-usage').click()); assert.equal(await page.locator('#usage-dialog').isVisible(), false);
    await page.locator('#bottle-detail-dialog button[aria-label="关闭单瓶详情"]').click();
    await deny(() => page.evaluate(id => openUsage(id), bottle.id));
    await deny(() => page.evaluate(profile => openBottleForm(profile), reagent));
    for (const [name, label] of [['instruments', '登记仪器'], ['samples', '登记样本']]) {
      await page.locator(`[data-page="${name}"]`).click(); await deny(() => page.getByRole('button', { name: label, exact: true }).click());
    }
    await page.locator('[data-page="settings"]').click();
    await page.locator('[data-settings-view="members"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#members-body tr').length > 0);
    await deny(() => page.locator('#members-body button').first().click());
    await page.locator('#settings-back').click(); await page.locator('[data-settings-view="reminders"]').click();
    await page.waitForFunction(() => !document.querySelector('#reminders-save').disabled);
    await deny(() => page.locator('#reminders-save').click());
    await page.locator('#settings-back').click(); await page.locator('[data-settings-view="help"]').click();
    assert.equal(await page.locator('#settings-help').isVisible(), true);
    await page.locator('.profile-button').click(); await deny(() => page.locator('#change-password-button').click());
    assert.equal(await page.locator('#password-dialog').isVisible(), false); await page.keyboard.press('Escape');
    // Scripted submissions cannot bypass click protection. History search remains allowed.
    for (const id of ['reagent-form', 'bottle-form', 'usage-form', 'password-form']) await deny(() => page.evaluate(id => document.getElementById(id).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })), id));
    assert.deepEqual(writes, [], 'Denied controls must not send mutation requests');
    await page.locator('[data-page="history"]').click(); await page.waitForFunction(() => document.querySelector('#history-records').textContent.includes('READONLY-BOTTLE'));
    await page.locator('#history-filter [name="q"]').fill('只读验收试剂'); await page.locator('#history-filter [type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#history-page-info').textContent.includes('1 条'));
    await page.locator('.notification-button').click(); await page.waitForFunction(() => document.querySelector('#metric-stocked').textContent === '1');
    assert.match(await page.locator('#inventory-body').innerText(), /只读验收试剂/);
    // Even forged client-side permission state cannot bypass server authorization.
    await page.evaluate(() => { permissionRole = 'admin'; });
    let rejected;
    await deny(async () => { rejected = await page.evaluate(() => businessRequest('/api/v1/reagents', { name: '伪造权限', stock_unit: 'g' }).catch(error => error.message)); });
    assert.equal(rejected, '您没有该权限'); assert.equal(auth.db.prepare('SELECT count(*) AS n FROM reagents').get().n, 1);
    assert.equal(auth.db.prepare('SELECT remaining_minor FROM reagent_bottles WHERE id = ?').get(bottle.id).remaining_minor, 10000);
    assert.equal(auth.db.prepare('SELECT count(*) AS n FROM stock_movements').get().n, 1);
    // Failed identity presentation still resolves authoritative permission and denies writes.
    await page.route('**/api/v1/auth/me', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '身份展示测试失败' } }) }));
    await page.reload(); await deny(() => page.locator('.welcome-actions [data-open-usage]').click());
    assert.equal(await page.locator('#usage-dialog').isVisible(), false); assert.deepEqual(errors, []);
    await page.unroute('**/api/v1/auth/me'); await page.reload(); await ready();
    await page.locator('.profile-button').click(); await page.locator('#logout-button').click(); await page.waitForURL('**/login.html');
    await context.close(); await admin.close();
    console.log('Read-only browser validation passed: exact six-character alert, three desktop widths, all mutation entries and submissions, safe reads/search/history, forged-client rejection, failed identity display and logout.');
  } finally { if (browser) await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
