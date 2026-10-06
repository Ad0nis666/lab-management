const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fixture = require('./auth-fixture.cjs').createFixture();
(async () => {
  let browser;
  try {
    const origin = await fixture.initialize();
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await fixture.signIn(context);
    const create = await context.request.post(origin + '/api/v1/reagents', { headers: { Origin: origin }, data: { name: '入库验收乙醇', stock_unit: 'mL' } });
    const reagent = (await create.json()).reagent;
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await page.locator('[data-page="reagents"]').click();
    await page.locator('.catalog-card').getByRole('button', { name: '查看详情', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#bottle-list-message').textContent === '暂无单瓶入库记录。');
    await page.locator('#detail-open-bottle').click();
    assert.equal(await page.locator('#bottle-form [name="unit"]').getByRole('option', { name: 'g', exact: true }).evaluate(o => o.disabled), true);
    assert.equal(await page.locator('#bottle-form [name="unit"]').getByRole('option', { name: 'L', exact: true }).evaluate(o => o.disabled), false);
    const receivedOn = await page.locator('#bottle-form [name="received_on"]').inputValue();
    const expiresOn = `${Number(receivedOn.slice(0, 4)) + 1}${receivedOn.slice(4)}`;
    for (const [key, value] of Object.entries({ bottle_code: 'desktop-bottle-001', batch_no: '批次 A', initial_quantity: '0.25', location: '<img src=x onerror=alert(1)> · A103', expires_on: '1900-01-01' })) {
      await page.locator(`#bottle-form [name="${key}"]`).fill(value);
    }
    await page.locator('#bottle-form [name="unit"]').selectOption('L');
    await page.locator('#bottle-form [type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#bottle-error').textContent.includes('有效期不能早于'));
    assert.equal(await page.locator('#bottle-form [name="initial_quantity"]').inputValue(), '0.25');
    await page.locator('#bottle-form [name="expires_on"]').fill(expiresOn);
    // Commit on the server but lose the success response: retry must reuse its key.
    let firstKey, retryKey, lostResponse = false;
    await page.route('**/api/v1/reagents/*/bottles', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      firstKey = route.request().headers()['idempotency-key'];
      const response = await route.fetch(); assert.equal(response.status(), 201); lostResponse = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '测试响应丢失，请重试' } }) });
    });
    await page.locator('#bottle-form [type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#bottle-error').textContent.includes('响应丢失'));
    assert.ok(lostResponse); assert.equal(await page.locator('#bottle-dialog').isVisible(), true);
    assert.equal(fixture.app.store.db.prepare('SELECT count(*) AS n FROM reagent_bottles').get().n, 1);
    await page.unroute('**/api/v1/reagents/*/bottles');
    await page.route('**/api/v1/reagents/*/bottles', async route => { retryKey = route.request().headers()['idempotency-key']; await route.continue(); });
    const replay = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/bottles'));
    await page.locator('#bottle-form [type="submit"]').click();
    assert.equal((await replay).status(), 200); assert.equal(retryKey, firstKey);
    await page.unroute('**/api/v1/reagents/*/bottles');
    await page.locator('#bottle-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelectorAll('.bottle-row').length === 1);
    assert.match(await page.locator('#reagent-detail').innerText(), /1 瓶 \/ 250.00 mL/);
    assert.equal(await page.locator('#bottle-list img').count(), 0);
    assert.equal(fixture.app.store.db.prepare('SELECT count(*) AS n FROM stock_movements').get().n, 1);
    await page.locator('.bottle-row .card-link').filter({ hasText: /^(BT-|DESKTOP-)/ }).click();
    await page.waitForFunction(() => document.querySelector('#bottle-detail').textContent.includes('0.25 L'));
    assert.match(await page.locator('#bottle-detail-title').innerText(), /DESKTOP-BOTTLE-001/);
    assert.match(await page.locator('#bottle-detail').innerText(), /批次 A/);
    assert.equal(await page.locator('#bottle-detail img').count(), 0);
    await page.screenshot({ path: '/tmp/lab-bottle-detail.png' });
    await page.locator('#bottle-detail-dialog .primary-button').click();
    // Duplicate bottle code must leave inputs intact for correction.
    await page.locator('#detail-open-bottle').click();
    for (const [key, value] of Object.entries({ bottle_code: 'DESKTOP-BOTTLE-001', batch_no: '批次 B', initial_quantity: '100', location: '柜 B', expires_on: expiresOn })) await page.locator(`#bottle-form [name="${key}"]`).fill(value);
    await page.locator('#bottle-form [type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#bottle-error').textContent.includes('瓶号已存在'));
    assert.equal(await page.locator('#bottle-form [name="batch_no"]').inputValue(), '批次 B');
    await page.locator('#bottle-form [name="bottle_code"]').fill('');
    let releaseSave, receivedSave;
    const gate = new Promise(resolve => { releaseSave = resolve; }), received = new Promise(resolve => { receivedSave = resolve; });
    let requests = 0;
    await page.route('**/api/v1/reagents/*/bottles', async route => { requests++; receivedSave(); await gate; await route.continue(); });
    await page.locator('#bottle-form [type="submit"]').click(); await received;
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#bottle-dialog').isVisible(), true, 'Saving cannot be dismissed with Escape');
    await page.evaluate(() => document.querySelector('#bottle-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(requests, 1); releaseSave();
    await page.locator('#bottle-dialog').waitFor({ state: 'hidden' }); await page.unroute('**/api/v1/reagents/*/bottles');
    await page.waitForFunction(() => document.querySelectorAll('.bottle-row').length === 2);
    await page.locator('#reagent-detail-dialog .primary-button').click();
    await page.reload(); await page.locator('[data-page="reagents"]').click();
    await page.waitForFunction(() => document.querySelector('#reagent-catalog').textContent.includes('2 瓶 / 350.00 mL'));
    const otherContext = await browser.newContext({ reducedMotion: 'reduce' }); await fixture.signIn(otherContext);
    const other = await otherContext.newPage(); await other.goto(origin); await other.locator('[data-page="reagents"]').click();
    await other.waitForFunction(() => document.querySelector('#reagent-catalog').textContent.includes('2 瓶 / 350.00 mL'));
    await otherContext.close();
    for (let i = 0; i < 5; i++) {
      const response = await context.request.post(`${origin}/api/v1/reagents/${reagent.id}/bottles`, { headers: { Origin: origin, 'Idempotency-Key': `browser-page-${i}` }, data: { batch_no: '分页批次', initial_quantity: '1', unit: 'mL', location: '柜 C', received_on: receivedOn, expires_on: expiresOn } });
      assert.equal(response.status(), 201);
    }
    await page.locator('.catalog-card').getByRole('button', { name: '查看详情', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.bottle-row').length === 5);
    await page.locator('#bottle-next').click(); await page.waitForFunction(() => document.querySelectorAll('.bottle-row').length === 2);
    await page.locator('#bottle-prev').click(); await page.waitForFunction(() => document.querySelectorAll('.bottle-row').length === 5);
    // Verify failure and retry in list and single-bottle detail.
    await page.route('**/api/v1/reagents/*/bottles?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '测试单瓶列表失败' } }) }));
    await page.locator('#bottle-next').click(); await page.locator('#bottle-list-retry').waitFor({ state: 'visible' });
    await page.unroute('**/api/v1/reagents/*/bottles?*'); await page.locator('#bottle-list-retry').click();
    await page.waitForFunction(() => document.querySelectorAll('.bottle-row').length === 2);
    await page.route('**/api/v1/bottles/*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '测试单瓶详情失败' } }) }));
    await page.locator('.bottle-row .card-link').filter({ hasText: /^(BT-|DESKTOP-)/ }).first().click(); await page.locator('#bottle-detail-retry').waitFor({ state: 'visible' });
    await page.unroute('**/api/v1/bottles/*'); await page.locator('#bottle-detail-retry').click();
    await page.waitForFunction(() => document.querySelector('#bottle-detail').children.length > 0);
    await page.locator('#bottle-detail-dialog .primary-button').click();
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 800 });
      await page.locator('#detail-open-bottle').click();
      assert.ok(await page.locator('#bottle-dialog').evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth; }), `Receipt form fits desktop ${width}`);
      await page.locator('#bottle-form .secondary-button').click();
      await page.locator('.bottle-row .card-link').filter({ hasText: /^(BT-|DESKTOP-)/ }).first().click();
      assert.ok(await page.locator('#bottle-detail-dialog').evaluate(el => el.scrollWidth <= el.clientWidth));
      await page.locator('#bottle-detail-dialog .primary-button').click();
    }
    await page.screenshot({ path: '/tmp/lab-bottle-list.png' });
    const member = { account: 'receipt_reader', password: 'Member-reader-password' };
    await fixture.app.store.createUser({ ...member, display_name: '入库只读成员' });
    const memberContext = await browser.newContext({ reducedMotion: 'reduce' });
    await memberContext.request.post(origin + '/api/v1/auth/login', { headers: { Origin: origin }, data: member });
    const memberPage = await memberContext.newPage(); await memberPage.goto(origin);
    await memberPage.waitForFunction(() => document.querySelector('.profile-copy small').textContent === '普通成员');
    await memberPage.locator('[data-page="reagents"]').click();
    await memberPage.locator('.catalog-card').getByRole('button', { name: '查看详情', exact: true }).click();
    await memberPage.waitForFunction(() => document.querySelectorAll('.bottle-row').length === 5);
    assert.equal(await memberPage.locator('#detail-open-bottle').isVisible(), true);
    const denied = memberPage.waitForEvent('dialog').then(async alert => { assert.equal(alert.message(), '您没有该权限'); await alert.accept(); }); await memberPage.locator('#detail-open-bottle').click();
    await denied;
    assert.equal(await memberPage.locator('#bottle-dialog').isVisible(), false);
    assert.equal(await memberPage.locator('[data-open-bottle]').count(), 1);
    await memberContext.close(); assert.deepEqual(errors, []);
    console.log('Bottle desktop validation passed: real receipt, exact conversion, shared persistence, lost-response retry, duplicate codes, submit lock, safe text, paging, failures, three desktop widths and member permissions.');
  } finally { if (browser) await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
