const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fixture = require('./auth-fixture.cjs').createFixture();
(async () => {
  let browser;
  try {
    const origin = await fixture.initialize();
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE });
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } });
    await fixture.signIn(context);
    await context.request.post(origin + '/api/v1/reagents', { headers: { Origin: origin }, data: { name: '回归乙醇', stock_unit: 'mL' } });
    const page = await context.newPage(); await page.goto(origin);
    await page.locator('#global-search').fill('不存在的试剂');
    await page.locator('#reagent-empty').waitFor({ state: 'visible' });
    await page.locator('#global-search').fill('');
    assert.equal(await page.locator('#reagent-search').inputValue(), '', 'DEF-001: Clearing header search must clear catalog filtering');
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 1);
    await context.close();
  } finally { if (browser) await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
