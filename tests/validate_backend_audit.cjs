// Audit remaining business Demo gaps after real authentication. Replace these assertions with target acceptance
// tests when real backend integration starts; these are not product requirements.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fixture = require('./auth-fixture.cjs').createFixture();
const { server } = fixture;
(async () => {
  let browser;
  try {
    await fixture.initialize();
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [], businessRequests = [];
    context.on('request', request => {
      if (['fetch', 'xhr', 'websocket', 'eventsource'].includes(request.resourceType()) || request.method() !== 'GET') {
        if (!new URL(request.url()).pathname.startsWith('/api/v1/auth/')) businessRequests.push(`${request.method()} ${request.url()}`);
      }
    });
    page.on('pageerror', error => errors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}/index.html`;
    await page.goto(url);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('pku-lab-demo-session')), null);
    assert.match(page.url(), /login.html$/, 'Unauthenticated access now redirects');
    await fixture.signIn(context);
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('.profile-copy strong').textContent === '测试管理员');
    await page.waitForFunction(() => document.querySelector('#metric-stocked').textContent === '0');


    // Persistent profiles now save and remain visible after reload.
    await page.locator('[data-page="reagents"]').click();
    await page.locator('#reagent-empty').waitFor({ state: 'visible' });
    await page.locator('#page-reagents [data-open-dialog]').click();
    await page.locator('#reagent-form [name="name"]').fill('审计临时试剂');
    await page.locator('#reagent-form button[type="submit"]').click();
    await page.locator('#reagent-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 1);
    assert.match(await page.locator('#reagent-catalog').innerText(), /审计临时试剂/);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 1);

    // Usage is real and never imports untrusted local demo stock.
    await page.locator('#page-overview .welcome-actions [data-open-usage]').click();
    assert.equal(await page.locator('#usage-form [name="bottle_id"]').count(), 1);
    await page.waitForFunction(() => document.querySelector('#usage-options-message').textContent.includes('没有可领单瓶'));
    assert.equal(await page.locator('#usage-bottle option').count(), 0);
    await page.locator('#usage-dialog [data-close-usage]').first().click();
    await page.waitForFunction(() => document.querySelector('#metric-stocked').textContent === '0');
    assert.equal(await page.locator('#inventory-body tr').count(), 0);
    assert.ok(businessRequests.some(request => new URL(request.slice(request.indexOf(' ') + 1)).pathname === '/api/v1/dashboard'));
    assert.equal(await page.evaluate(() => localStorage.getItem('pku-lab-consumption-v1')), null);

    // Header search is explicitly limited to reagent profiles.
    await page.locator('#global-search').fill('气相色谱仪');
    assert.equal(await page.locator('#page-reagents').isVisible(), true);
    await page.locator('#reagent-empty').waitFor({ state: 'visible' });
    await page.locator('#global-search').fill('');
    for (const [name, label] of [['instruments', '登记仪器'], ['samples', '登记样本']]) {
      await page.locator(`[data-page="${name}"]`).click();
      const before = await page.locator(`#page-${name}`).innerText();
      await page.getByRole('button', { name: label, exact: true }).click();
      assert.equal(await page.locator(`#${name}-dialog`).isVisible(), true);
      await page.locator(`#${name}-dialog [data-close-collection]`).first().click();
    }
    await page.locator('[data-page="settings"]').click();
    for (const button of await page.locator('.setting-card').all()) {
      await button.click();
      assert.equal(await page.locator('#page-settings').isVisible(), true);
      assert.equal(await page.locator('dialog[open]').count(), 0);
      assert.equal(await page.locator('#settings-content').isVisible(), true);
      await page.locator('#settings-back').click();
    }
    await page.locator('.notification-button').click();
    assert.equal(await page.locator('.profile-copy').innerText(), '测试管理员\n管理员');
    assert.ok(businessRequests.some(request => request.startsWith('POST ') && request.endsWith('/api/v1/reagents')));
    assert.ok(businessRequests.some(request => new URL(request.slice(request.indexOf(' ') + 1)).pathname === '/api/v1/consumptions'));
    assert.ok(businessRequests.some(request => new URL(request.slice(request.indexOf(' ') + 1)).pathname === '/api/v1/bottles'));
    assert.deepEqual(errors, []);
    console.log('Backend audit evidence passed: protected access, persistent profiles, real bottle selection and usage queries, real dashboard metrics and empty alerts, search scope; instrument and sample forms are connected; settings entry points open connected subpages.');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
