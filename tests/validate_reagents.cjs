const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fixture = require('./auth-fixture.cjs').createFixture();
(async () => {
  let browser;
  try {
    const origin = await fixture.initialize();
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await fixture.signIn(context);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('[data-page="reagents"]').click();
    await page.locator('#reagent-empty').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.catalog-card').count(), 0, 'No seeded demo inventory');
    await page.locator('#page-reagents [data-open-dialog]').click();
    for (const [key, value] of Object.entries({ name: '真实乙醇 <img src=x onerror=alert(1)>', cas: '64-17-5', grade: '分析纯', supplier: '测试厂商', catalog_no: 'ET-100', category: '溶剂', hazard_tags: '易燃', low_stock_threshold: '50.25' })) {
      await page.locator(`#reagent-form [name="${key}"]`).fill(value);
    }
    // Server validation retains the form and announces its error.
    await page.locator('#reagent-form [name="cas"]').fill('64-17-6');
    await page.locator('#reagent-form [type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#reagent-error').textContent.includes('校验位'));
    assert.match(await page.locator('#reagent-form [name="name"]').inputValue(), /真实乙醇/);
    assert.equal(await page.locator('#reagent-dialog').isVisible(), true);
    await page.locator('#reagent-form [name="cas"]').fill('64-17-5');
    // A failed save must never claim success or clear the user's input.
    await page.route('**/api/v1/reagents', route => route.request().method() === 'POST' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: '测试保存失败' } }) }) : route.continue());
    await page.locator('#reagent-form [type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#reagent-error').textContent === '测试保存失败');
    assert.equal(await page.locator('#reagent-form [name="catalog_no"]').inputValue(), 'ET-100');
    await page.unroute('**/api/v1/reagents');
    let releaseSave, receivedSave;
    const saveGate = new Promise(resolve => { releaseSave = resolve; });
    const saveReceived = new Promise(resolve => { receivedSave = resolve; });
    let saveRequests = 0;
    await page.route('**/api/v1/reagents', async route => {
      saveRequests++; receivedSave(); await saveGate; await route.continue();
    });
    const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/v1/reagents'));
    await page.locator('#reagent-form [type="submit"]').click();
    await saveReceived;
    assert.equal(await page.locator('#reagent-form [type="submit"]').isDisabled(), true);
    await page.evaluate(() => document.querySelector('#reagent-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(saveRequests, 1, 'Repeated submit while saving sends no second request');
    releaseSave();
    assert.equal((await saved).status(), 201);
    await page.unroute('**/api/v1/reagents');
    await page.locator('#reagent-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 1);
    assert.match(await page.locator('#toast').innerText(), /已登记/);
    assert.equal(await page.locator('#reagent-catalog img').count(), 0, 'Stored user input stays plain text');
    await page.locator('.catalog-card').getByRole('button', { name: '查看详情', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#reagent-detail').textContent.includes('ET-100'));
    assert.match(await page.locator('#reagent-detail').innerText(), /50.25/);
    await page.locator('#reagent-detail-dialog .primary-button').click();
    await page.reload();
    await page.locator('[data-page="reagents"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 1);
    assert.match(await page.locator('#reagent-catalog').innerText(), /真实乙醇/);
    const isolated = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    await fixture.signIn(isolated);
    const other = await isolated.newPage(); await other.goto(origin);
    await other.locator('[data-page="reagents"]').click();
    await other.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 1);
    assert.match(await other.locator('#reagent-catalog').innerText(), /ET-100/);
    await isolated.close();
    await page.locator('#reagent-search').fill('ET-100');
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 1 && !document.querySelector('#reagent-list-message').textContent);
    await page.locator('#reagent-search').fill('无匹配');
    await page.locator('#reagent-empty').waitFor({ state: 'visible' });
    // Failure and retry paths for list and detail.
    await page.route('**/api/v1/reagents?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '列表暂不可用' } }) }));
    await page.locator('#reagent-search').fill('');
    await page.locator('#reagent-retry').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.catalog-card').count(), 0);
    await page.unroute('**/api/v1/reagents?*');
    await page.locator('#reagent-retry').click();
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 1);
    await page.route('**/api/v1/reagents/*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '详情暂不可用' } }) }));
    await page.locator('.catalog-card').getByRole('button', { name: '查看详情', exact: true }).click();
    await page.locator('#reagent-detail-retry').waitFor({ state: 'visible' });
    await page.unroute('**/api/v1/reagents/*');
    await page.locator('#reagent-detail-retry').click();
    await page.waitForFunction(() => document.querySelector('#reagent-detail').textContent.includes('ET-100'));
    await page.screenshot({ path: '/tmp/lab-reagent-detail.png' });
    await page.locator('#reagent-detail-dialog .primary-button').click();
    // Add profiles via the real API to exercise page navigation.
    for (let index = 0; index < 13; index++) {
      const response = await context.request.post(origin + '/api/v1/reagents', { headers: { Origin: origin }, data: { name: `分页档案 ${index}`, stock_unit: 'g' } });
      assert.equal(response.status(), 201);
    }
    await page.reload(); await page.locator('[data-page="reagents"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 12);
    await page.locator('#reagent-next').click();
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 2);
    await page.locator('#reagent-prev').click();
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 12);
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Desktop list fits ${width}`);
      await page.locator('#page-reagents [data-open-dialog]').click();
      assert.ok(await page.locator('#reagent-dialog').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }));
      await page.locator('#reagent-form .secondary-button').click();
      await page.locator('.catalog-card').getByRole('button', { name: '查看详情', exact: true }).first().click();
      await page.waitForFunction(() => document.querySelector('#reagent-detail').children.length > 0);
      assert.ok(await page.locator('#reagent-detail-dialog').evaluate(el => el.scrollWidth <= el.clientWidth), `Detail fits ${width}`);
      await page.locator('#reagent-detail-dialog .primary-button').click();
    }
    await page.screenshot({ path: '/tmp/lab-reagent-catalog.png', fullPage: true });
    // Ordinary members see the create entry but receive the exact denial message.
    const member = { account: 'member_test', password: 'Member-test-password' };
    await fixture.app.store.createUser({ ...member, display_name: '测试成员' });
    const memberContext = await browser.newContext();
    await memberContext.request.post(origin + '/api/v1/auth/login', { data: member, headers: { Origin: origin } });
    const memberPage = await memberContext.newPage(); await memberPage.goto(origin);
    await memberPage.waitForFunction(() => document.querySelector('.profile-copy small').textContent === '普通成员');
    await memberPage.locator('[data-page="reagents"]').click();
    assert.equal(await memberPage.locator('[data-open-dialog]:visible').count(), 1);
    const denied = memberPage.waitForEvent('dialog').then(async alert => { assert.equal(alert.message(), '您没有该权限'); await alert.accept(); });
    await memberPage.locator('[data-open-dialog]').click();
    await denied;
    assert.equal(await memberPage.locator('#reagent-dialog').isVisible(), false);
    await memberPage.locator('.catalog-card').getByRole('button', { name: '查看详情', exact: true }).first().click();
    await memberPage.waitForFunction(() => document.querySelector('#reagent-detail').children.length > 0);
    assert.equal((await memberContext.request.post(origin + '/api/v1/reagents', { headers: { Origin: origin }, data: { name: '越权', stock_unit: 'g' } })).status(), 403);
    await memberContext.close();
    assert.deepEqual(errors, []);
    console.log('Reagent desktop validation passed: real save, failure retention, shared persistence, safe text, search, paging, detail retry, permissions and three desktop widths.');
  } finally { if (browser) await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
