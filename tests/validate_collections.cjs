const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fixture = require('./auth-fixture.cjs').createFixture();
const { seedLab } = require('../backend/seed-lab.cjs');
(async () => {
  let browser;
  try {
    const origin = await fixture.initialize(); seedLab(fixture.app.store, { stock: true });
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); await fixture.signIn(context);
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); await page.goto(origin);
    await page.waitForFunction(() => document.querySelectorAll('#equipment-summary .equipment-item').length === 3);
    assert.doesNotMatch(await page.locator('#equipment-summary').innerText(), /色谱|光度/);
    assert.equal(await page.locator('#metric-instruments').innerText(), '0 / 3');
    assert.equal(await page.locator('#metric-samples').innerText(), '0');
    for (const width of [1280,1440,1920]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.locator('#equipment-pending li').count(), 3);
      for (const row of await page.locator('#equipment-pending li').all()) {
        const layout = await row.evaluate(li => {
          const text = li.querySelector('div').getBoundingClientRect(), action = li.querySelector('button').getBoundingClientRect(), bounds = li.getBoundingClientRect();
          return { textWidth: text.width, textRight: text.right, buttonLeft: action.left, buttonRight: action.right, right: bounds.right, labelHeight: li.querySelector('button').scrollHeight, buttonHeight: action.height };
        });
        assert.ok(layout.textWidth >= 120, 'Pending instrument name/code must not be squeezed into the old 28px icon column');
        assert.ok(layout.textRight <= layout.buttonLeft && layout.buttonRight <= layout.right + 1);
        assert.ok(layout.labelHeight <= layout.buttonHeight, 'View details action must remain a single readable line');
      }
      await page.screenshot({ path: `/tmp/lab-home-pending-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.locator('[data-page="instruments"]').click(); await page.waitForFunction(() => document.querySelectorAll('#instruments-list .instrument-card').length === 3);
    for (const name of ['机械臂','天平','药瓶泵']) assert.match(await page.locator('#instruments-list').innerText(), new RegExp(name));
    for (const image of await page.locator('#instruments-list img').all()) assert.equal(await image.evaluate(img => img.complete && img.naturalWidth > 0), true);
    await page.locator('#instruments-list .instrument-card').filter({ hasText: '天平' }).getByRole('button', { name: '编辑', exact: true }).click();
    await page.locator('#instruments-form [name="owner"]').fill('管理员'); await page.locator('#instruments-form [name="status"]').selectOption('normal');
    await page.locator('#instruments-form [type="submit"]').click(); await page.locator('#instruments-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('#equipment-summary').textContent.includes('运行正常'));
    assert.equal(await page.locator('#metric-instruments').innerText(), '1 / 3');
    await page.locator('[data-page="samples"]').click(); await page.waitForFunction(() => document.querySelector('#samples-message').textContent.includes('暂无'));
    await page.getByRole('button', { name: '登记样本', exact: true }).click();
    const sample = { code: 'S-1', name: '测试样本 <img src=x>', project: '试验', quantity: '12.50', unit: '份', location: '柜1' };
    for (const [key, value] of Object.entries(sample)) await page.locator(`#samples-form [name="${key}"]`).fill(value);
    await page.route('**/api/v1/samples', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '保存失败测试' } }) }));
    await page.locator('#samples-form [type="submit"]').click(); await page.waitForFunction(() => document.querySelector('#samples-error').textContent === '保存失败测试');
    assert.equal(await page.locator('#samples-form [name="name"]').inputValue(), sample.name); await page.unroute('**/api/v1/samples');
    await page.locator('#samples-form [type="submit"]').click(); await page.locator('#samples-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('#samples-list').textContent.includes('S-1')); assert.equal(await page.locator('#samples-list img').count(), 0);
    await page.locator('#samples-list').getByRole('button', { name: '查看详情', exact: true }).click(); await page.waitForFunction(() => document.querySelector('#collection-detail').textContent.includes('12.50'));
    await page.locator('#collection-detail-edit').click(); await page.locator('#samples-form [name="quantity"]').fill('10'); await page.locator('#samples-form [name="status"]').selectOption('in_use');
    await page.locator('#samples-form [type="submit"]').click(); await page.locator('#samples-dialog').waitFor({ state: 'hidden' }); await page.waitForFunction(() => document.querySelector('#samples-list').textContent.includes('10.00'));
    await page.reload(); await page.locator('[data-page="samples"]').click(); await page.waitForFunction(() => document.querySelector('#samples-list').textContent.includes('10.00'));
    await page.locator('#samples-search').fill('nothing'); await page.waitForFunction(() => document.querySelector('#samples-message').textContent.includes('暂无')); assert.equal(await page.locator('#samples-list article').count(), 0);
    await page.route('**/api/v1/samples?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '列表失败测试' } }) }));
    await page.locator('#samples-search').fill(''); await page.waitForFunction(() => document.querySelector('#samples-message').textContent === '列表失败测试'); await page.unroute('**/api/v1/samples?*');
    await page.locator('#samples-retry').click(); await page.waitForFunction(() => document.querySelector('#samples-list').textContent.includes('S-1'));
    assert.equal(await page.locator('#metric-samples').innerText(), '0');
    await page.locator('[data-page="reagents"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 3);
    await page.locator('.catalog-card').filter({ hasText: '水' }).getByRole('button', { name: '查看详情', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#bottle-list').textContent.includes('INITIAL-WATER'));
    assert.match(await page.locator('#bottle-list').innerText(), /有效期未填写/);
    assert.doesNotMatch(await page.locator('#bottle-list').innerText(), /null|未过期/);
    await page.locator('#reagent-detail-dialog button[aria-label="关闭档案详情"]').click();
    for (const width of [1280,1440,1920]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const kind of ['instruments','samples']) {
        await page.locator(`[data-page="${kind}"]`).click(); await page.waitForFunction(kind => document.querySelector(`#${kind}-list`).children.length > 0, kind);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const searchLayout = await page.locator(`#${kind}-search`).evaluate(input => {
          const style = getComputedStyle(input), placeholderStyle = getComputedStyle(input, '::placeholder');
          const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
          ctx.font = `${placeholderStyle.fontWeight} ${placeholderStyle.fontSize} ${placeholderStyle.fontFamily}`;
          const rect = input.getBoundingClientRect();
          return { width: rect.width, required: ctx.measureText(input.placeholder).width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 40, height: rect.height, right: rect.right, parentRight: input.closest('.toolbar-panel').getBoundingClientRect().right };
        });
        assert.ok(searchLayout.width >= searchLayout.required, `${kind}: entire placeholder plus search clear control must fit at ${width}px`);
        assert.ok(searchLayout.width >= 320 && searchLayout.height >= 44);
        assert.ok(searchLayout.right <= searchLayout.parentRight);

      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.locator('[data-page="instruments"]').click(); await page.screenshot({ path: '/tmp/lab-instruments.png', fullPage: true });
    await page.locator('[data-page="samples"]').click(); await page.screenshot({ path: '/tmp/lab-samples.png', fullPage: true });
    const credentials = { account: 'readonly_collection', password: 'Reader-password-1' }; await fixture.app.store.createUser({ ...credentials, display_name: '读者' });
    const reader = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); await reader.request.post(origin + '/api/v1/auth/login', { data: credentials, headers: { Origin: origin } });
    const readPage = await reader.newPage(); await readPage.goto(origin); await readPage.waitForFunction(() => document.querySelector('.profile-copy').textContent.includes('读者'));
    let alerts = 0, writes = 0; readPage.on('dialog', async dialog => { assert.equal(dialog.message(), '您没有该权限'); alerts++; await dialog.accept(); });
    readPage.on('request', request => { if (request.method() === 'POST') writes++; });
    for (const kind of ['instruments','samples']) {
      await readPage.locator(`[data-page="${kind}"]`).click(); await readPage.waitForFunction(kind => document.querySelector(`#${kind}-list`).children.length > 0, kind);
      await readPage.locator(`[data-new-collection="${kind}"]`).click();
      await readPage.locator(`#${kind}-list`).getByRole('button', { name: '编辑', exact: true }).first().click();
      await readPage.locator(`#${kind}-list`).getByRole('button', { name: '查看详情', exact: true }).first().click(); await readPage.locator('#collection-detail-edit').waitFor({ state: 'visible' });
      await readPage.locator('#collection-detail-edit').click(); await readPage.locator('#collection-detail-dialog .primary-button').click();
      assert.equal(await readPage.locator(`#${kind}-dialog`).isVisible(), false);
    }
    assert.equal(alerts, 6); assert.equal(writes, 0); assert.deepEqual(errors, []);
    console.log('Instrument/sample browser validation passed: seeded SVGs, admin edit/create, member read-only, reload persistence, search, failure/retry, 1280/1440/1920 layout.');
  } finally { if (browser) await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
