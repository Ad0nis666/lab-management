const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { randomUUID } = require('node:crypto');
const { ReagentStore } = require('../backend/reagents.cjs');
const { BottleStore } = require('../backend/bottles.cjs');
const { ConsumptionStore } = require('../backend/consumptions.cjs');
const fixture = require('./auth-fixture.cjs').createFixture({ now: () => Date.parse('2026-10-06T00:00:00Z') });
(async () => {
  let browser;
  try {
    const origin = await fixture.initialize(), auth = fixture.app.store;
    const actor = auth.db.prepare('SELECT * FROM users LIMIT 1').get(), reagents = new ReagentStore(auth), bottles = new BottleStore(auth, reagents), consumption = new ConsumptionStore(auth, bottles);
    reagents.bottles = bottles;
    const reagent = reagents.create({ name: '真实临期试剂', stock_unit: 'mL', low_stock_threshold: '100' }, actor);
    const empty = reagents.create({ name: '<img src=x onerror=window.dashboardXss=1>', stock_unit: 'g', low_stock_threshold: '1' }, actor);
    const expired = reagents.create({ name: '真实过期试剂', stock_unit: 'mL' }, actor), saved = [];
    const receipt = { bottle_code: '', batch_no: 'BATCH', location: '柜 A', received_on: '2026-10-01', expires_on: '2026-12-05', initial_quantity: '1', unit: 'mL' };
    for (let i = 0; i < 15; i++) saved.push(bottles.create(reagent.id, receipt, actor, randomUUID()).bottle);
    bottles.create(expired.id, { ...receipt, expires_on: '2026-10-05' }, actor, randomUUID());
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => { Date.now = () => Date.parse('2026-10-06T00:00:00Z'); }); await fixture.signIn(context); const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); const ready = () => page.waitForFunction(() => document.querySelector('#inventory-body').getAttribute('aria-busy') === 'false');
    await ready();
    async function checkMessageSpacing() {
      const spacing = await page.locator('#dashboard-message').evaluate(message => {
        const range = document.createRange(); range.selectNodeContents(message);
        const text = range.getBoundingClientRect(), box = message.getBoundingClientRect();
        const table = document.querySelector('.inventory-table thead').getBoundingClientRect();
        return { topGap: text.top - box.top, bottomGap: table.top - text.bottom };
      });
      assert.ok(spacing.topGap >= 15 && spacing.bottomGap >= 15, 'Inventory status text needs at least 16px visual space above and before table headings');
    }

    assert.equal(await page.locator('#metric-stocked').textContent(), '2'); assert.equal(await page.locator('#metric-low').textContent(), '2');
    assert.equal(await page.locator('#metric-expiry').textContent(), '15'); assert.equal(await page.locator('#metric-expired').textContent(), '1');
    assert.equal(await page.locator('.notification-dot').textContent(), '18'); assert.equal(await page.locator('#inventory-body tr').count(), 12);
    assert.equal(await page.locator('#inventory-body img').count(), 0); assert.equal(await page.evaluate(() => window.dashboardXss), undefined);
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await checkMessageSpacing();
      assert.ok(await page.locator('.inventory-panel .table-wrap').evaluate(element => element.scrollWidth <= element.clientWidth), 'DEF-010: long real bottle codes must not hide the details column');
      assert.equal(await page.locator('#metric-stocked').evaluate(element => getComputedStyle(element).fontSize), '32px', 'Real counts retain metric typography');
      const pagination = await page.locator('#page-overview .dashboard-pagination').evaluate(group => {
        const rect = group.getBoundingClientRect(), prev = group.querySelector('#dashboard-prev').getBoundingClientRect(), next = group.querySelector('#dashboard-next').getBoundingClientRect(), info = group.querySelector('#dashboard-page').getBoundingClientRect();
        return { groupCenter: (rect.left + rect.right) / 2, controlsCenter: (prev.left + next.right) / 2, left: rect.left, right: rect.right, previousLeft: prev.left, nextRight: next.right, previousCenterY: (prev.top + prev.bottom) / 2, nextCenterY: (next.top + next.bottom) / 2, infoCenterY: (info.top + info.bottom) / 2 };
      });
      assert.ok(Math.abs(pagination.groupCenter - pagination.controlsCenter) <= 1, 'Inventory pagination must be centered within its own panel');
      assert.ok(pagination.previousLeft > pagination.left && pagination.nextRight < pagination.right, 'Pagination must have panel padding on both sides');
      assert.ok(Math.abs(pagination.previousCenterY - pagination.nextCenterY) <= 1 && Math.abs(pagination.infoCenterY - pagination.nextCenterY) <= 1);

      assert.ok(await page.locator('[data-filter="expired"]').evaluate(element => element.getBoundingClientRect().right <= innerWidth));
      await page.screenshot({ path: `/tmp/lab-dashboard-${width}.png`, fullPage: true });
    }
    await page.locator('[data-filter="low"]').click(); await ready(); assert.equal(await page.locator('#inventory-body tr').count(), 2);
    assert.match(await page.locator('#inventory-body').innerText(), /<img src=x/);
    await page.getByRole('button', { name: `查看${empty.name}详情`, exact: true }).click(); await page.locator('#reagent-detail').waitFor({ state: 'visible' });
    await page.locator('#reagent-detail-dialog button').first().click();
    await page.locator('[data-filter="expired"]').click(); await ready(); assert.equal(await page.locator('#inventory-body tr').count(), 1);
    assert.match(await page.locator('#inventory-body').innerText(), /已过期 1 天/);
    await page.locator('#inventory-body button').click(); await page.waitForFunction(() => document.querySelector('#bottle-detail').textContent.includes('已过期'));
    await page.locator('#bottle-detail-dialog button[aria-label="关闭单瓶详情"]').click();
    await page.locator('[data-filter="expiry"]').click(); await ready(); assert.equal(await page.locator('#inventory-body tr').count(), 12);
    assert.match(await page.locator('#inventory-body').innerText(), /60 天后到期/); assert.match(await page.locator('#inventory-body').innerText(), /档案库存不足/);
    await page.locator('#dashboard-next').click(); await ready(); assert.equal(await page.locator('#inventory-body tr').count(), 3);
    // DEF-009: another browser depletes the last page while this tab retains page 2.
    for (const bottle of saved) consumption.create(bottle.id, { amount: '1', unit: 'mL', used_on: '2026-10-06', purpose: '第二个浏览器领完' }, actor, randomUUID());
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await ready();
    assert.match(await page.locator('#dashboard-page').textContent(), /第 1 \/ 1 页/);
    assert.equal(await page.locator('#metric-expiry').textContent(), '0'); assert.equal(await page.locator('#inventory-body tr').count(), 0);
    assert.match(await page.locator('#dashboard-message').innerText(), /当前筛选下暂无库存提醒/);
    await checkMessageSpacing();
    // Backend failure must remove stale metrics and support a real retry.
    await page.route('**/api/v1/dashboard?**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '测试服务失败' } }) }));
    await page.locator('[data-filter="all"]').click(); await page.locator('#dashboard-retry').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#metric-low').textContent(), '—'); assert.equal(await page.locator('#inventory-body tr').count(), 0);
    assert.equal(await page.locator('.notification-dot').isVisible(), false);
    await page.unroute('**/api/v1/dashboard?**'); await page.locator('#dashboard-retry').click(); await ready();
    assert.equal(await page.locator('#inventory-body tr').count(), 3); assert.equal(await page.locator('#dashboard-retry').isVisible(), false);
    // An older all-filter response cannot overwrite a more recent expired-filter result.
    let release, intercepted = false, done;
    const blocked = new Promise(resolve => { release = resolve; }); const completed = new Promise(resolve => { done = resolve; });
    await page.route('**/api/v1/dashboard?**', async route => {
      if (new URL(route.request().url()).searchParams.get('type') === 'all') { intercepted = true; const response = await route.fetch(); await blocked; await route.fulfill({ response }); done(); }
      else await route.continue();
    });
    await page.locator('[data-filter="all"]').click();
    for (let i = 0; !intercepted && i < 100; i++) await page.waitForTimeout(20);
    assert.equal(intercepted, true);
    await page.locator('[data-filter="expired"]').click(); await ready(); assert.equal(await page.locator('#inventory-body tr').count(), 1);
    release(); await completed; await page.waitForTimeout(100); assert.equal(await page.locator('#inventory-body tr').count(), 1);
    await page.unroute('**/api/v1/dashboard?**');
    await page.locator('[data-page="reagents"]').click(); await page.locator('.notification-button').click(); await ready();
    assert.equal(await page.locator('#page-overview').isVisible(), true); assert.equal(await page.locator('[data-filter="all"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#inventory-body tr').count(), 3);
    await page.reload(); await ready(); assert.equal(await page.locator('#metric-expiry').textContent(), '0');
    const second = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); await second.addInitScript(() => { Date.now = () => Date.parse('2026-10-06T00:00:00Z'); }); await fixture.signIn(second);
    const otherPage = await second.newPage(); await otherPage.goto(origin); await otherPage.waitForFunction(() => document.querySelector('#metric-low').textContent === '2');
    assert.equal(await otherPage.locator('#metric-expiry').textContent(), '0'); await second.close();
    // Save through the real usage form and verify automatic refresh without navigation.
    const latest = bottles.create(reagent.id, { ...receipt, expires_on: '2026-10-06' }, actor, randomUUID()).bottle;
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await ready();
    assert.equal(await page.locator('#metric-expiry').textContent(), '1');
    await page.evaluate(id => openUsage(id), latest.id);
    await page.waitForFunction(id => document.querySelector('#usage-bottle').value === id, latest.id);
    await page.locator('#usage-form [name="amount"]').fill('1');
    await page.locator('#usage-form [name="purpose"]').fill('首页刷新验收');
    await page.locator('#usage-form [type="submit"]').click();
    await page.locator('#usage-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('#metric-expiry').textContent === '0');
    assert.equal(await page.locator('#metric-stocked').textContent(), '1');
    assert.match(await page.locator('#usage-records').innerText(), /首页刷新验收/);
    assert.deepEqual(errors, []); await context.close();
    console.log('Dashboard browser validation passed: three desktop widths, real counts/filters/pagination, details, XSS, midnight service regression, cross-tab depletion/page reset, retry, stale-response protection, notification navigation and shared persistence.');
  } finally { if (browser) await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
