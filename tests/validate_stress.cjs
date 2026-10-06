const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fixture = require('./auth-fixture.cjs').createFixture();
const { seedLab } = require('../backend/seed-lab.cjs');

(async () => {
  let browser;
  try {
    const origin = await fixture.initialize(); seedLab(fixture.app.store, { stock: true });
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await fixture.signIn(context);
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin); await page.waitForFunction(() => document.querySelector('.profile-copy strong').textContent === '测试管理员');
    // Burst clicks exercise the actual navigation handlers while requests overlap.
    await page.evaluate(() => {
      const names = ['overview', 'reagents', 'instruments', 'samples', 'settings', 'history'];
      for (let i = 0; i < 120; i++) document.querySelector(`[data-page="${names[i % names.length]}"]`).click();
      document.querySelector('[data-page="reagents"]').click();
    });
    assert.equal(await page.locator('.page-view.is-active').count(), 1);
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 3);
    // Hold an old search response until the newest result is already rendered.
    let releaseSearch; const searchGate = new Promise(resolve => { releaseSearch = resolve; });
    let startedSearch; const searchStarted = new Promise(resolve => { startedSearch = resolve; });
    await page.route('**/api/v1/reagents?*', async route => {
      if (new URL(route.request().url()).searchParams.get('q') === '过时搜索') {
        startedSearch(); await searchGate;
      }
      await route.continue();
    });
    await page.locator('#reagent-search').fill('过时搜索'); await searchStarted;
    await page.evaluate(() => {
      const search = document.querySelector('#reagent-search');
      for (let i = 0; i < 50; i++) { search.value = `快速搜索${i}`; search.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    await page.locator('#reagent-search').fill('水');
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 1 && document.querySelector('#reagent-catalog').textContent.includes('水'));
    const oldResponse = page.waitForResponse(r => new URL(r.url()).searchParams.get('q') === '过时搜索');
    releaseSearch(); await oldResponse;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.match(await page.locator('#reagent-catalog').innerText(), /水/);
    await page.unroute('**/api/v1/reagents?*');

    const cases = [
      { kind: 'reagent', nav: 'reagents', open: '#page-reagents [data-open-dialog]', api: '/api/v1/reagents', fields: { name: '保存中测试' } },
      { kind: 'instruments', nav: 'instruments', open: '[data-new-collection="instruments"]', api: '/api/v1/instruments', fields: { code: 'LOCK-I', name: '保存中仪器' } },
      { kind: 'samples', nav: 'samples', open: '[data-new-collection="samples"]', api: '/api/v1/samples', fields: { code: 'LOCK-S', name: '保存中样本', quantity: '1', unit: '份', location: '柜1' } },
      { kind: 'password', open: '#change-password-button', api: '/api/v1/auth/change-password', fields: { current_password: fixture.credentials.password, new_password: 'New-password-2026!', confirm_password: 'New-password-2026!' } },
    ];
    for (const item of cases) {
      if (item.nav) await page.locator(`[data-page="${item.nav}"]`).click();
      else await page.locator('.profile-button').click();
      await page.locator(item.open).click();
      for (const [key, value] of Object.entries(item.fields)) await page.locator(`#${item.kind}-form [name="${key}"]`).fill(value);
      let release; const gate = new Promise(resolve => { release = resolve; });
      let started; const ready = new Promise(resolve => { started = resolve; }); let posts = 0;
      const pattern = origin + item.api;
      await page.route(pattern, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        posts++; started(); await gate;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '延迟保存失败' } }) });
      });
      await page.locator(`#${item.kind}-form [type="submit"]`).click(); await ready;
      await page.evaluate(kind => {
        const form = document.querySelector(`#${kind}-form`);
        for (let i = 0; i < 25; i++) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }, item.kind);
      await page.keyboard.press('Escape');
      const stayedOpen = await page.locator(`#${item.kind}-dialog`).evaluate(dialog => dialog.open);
      // Clicking the reagent backdrop is another native dismissal path.
      if (item.kind === 'reagent') await page.mouse.click(10, 10);
      const backdropStayedOpen = await page.locator(`#${item.kind}-dialog`).evaluate(dialog => dialog.open);
      release();
      await page.waitForFunction(kind => !document.querySelector(`#${kind}-form [type="submit"]`).disabled, item.kind);
      assert.equal(stayedOpen, true, `${item.kind}: Escape must not dismiss a pending save`);
      assert.equal(backdropStayedOpen, true, `${item.kind}: backdrop must not dismiss a pending save`);
      assert.equal(posts, 1, `${item.kind}: burst submits must send one request`);
      assert.equal(await page.locator(`#${item.kind}-error`).innerText(), '延迟保存失败');
      for (const [key, value] of Object.entries(item.fields)) assert.equal(await page.locator(`#${item.kind}-form [name="${key}"]`).inputValue(), value);
      await page.unroute(pattern);
      await page.keyboard.press('Escape');
      await page.locator(`#${item.kind}-dialog`).waitFor({ state: 'hidden' });
    }
    assert.deepEqual(errors, []);
    console.log('Stress browser validation passed: 120 navigation clicks, 50 search inputs, stale responses, four pending-save dialogs, 25 repeated submits each, Escape protection and failure recovery.');
  } finally { if (browser) await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
