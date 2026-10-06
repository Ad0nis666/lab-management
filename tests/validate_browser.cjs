const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fixture = require('./auth-fixture.cjs').createFixture();
const { server } = fixture;
(async () => {
  await fixture.initialize();
  const { ReagentStore } = require('../backend/reagents.cjs');
  const profiles = new ReagentStore(fixture.app.store);
  const actor = fixture.app.store.db.prepare('SELECT * FROM users LIMIT 1').get();
  for (const [name, cas, stock_unit] of [['无水乙醇', '64-17-5', 'mL'], ['硝酸银', '7761-88-8', 'g'], ['丙酮', '67-64-1', 'mL']]) profiles.create({ name, cas, stock_unit }, actor);
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await fixture.signIn(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    assert.equal(await page.locator('.sidebar-note').count(), 0, 'Static duty card must be removed');
    assert.deepEqual(await page.locator('.app-footer > span').allTextContents(), ['北京大学 · 深圳研究生院', '试剂、仪器、样本及使用记录保存在数据库中']);
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      const masthead = page.locator('.institutional-header');
      assert.equal(await masthead.locator('.demo-label').count(), 0, 'Masthead must omit the former demo badge');
      assert.doesNotMatch(await masthead.innerText(), /演示环境/);
      const headerLayout = await masthead.evaluate(header => {
        const bounds = header.getBoundingClientRect();
        return [...header.children].every(child => {
          const box = child.getBoundingClientRect();
          return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
        });
      });
      assert.ok(headerLayout, 'Brand and platform title must remain inside the desktop masthead');
      const footer = await page.locator('.app-footer').evaluate(element => ({ edge: element.getBoundingClientRect().right, copy: element.lastElementChild.getBoundingClientRect().right, alignment: getComputedStyle(element.lastElementChild).textAlign }));
      assert.equal(footer.alignment, 'right');
      assert.ok(Math.abs(footer.edge - footer.copy) <= 1, 'Database note must align to the right content edge');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    assert.doesNotMatch(await page.locator('#sidebar').innerText(), /今日值班|林晓|A103/);
    const wordmark = page.locator('.pku-wordmark');
    assert.equal(await wordmark.getAttribute('alt'), '北京大学');
    assert.equal(await wordmark.evaluate(image => image.complete && image.naturalWidth === 852), true, 'Official wordmark asset must load');
    assert.doesNotMatch(await page.locator('.brand-copy').textContent(), /实验室物品管理/);
    assert.equal(await page.locator('.brand-subtitle').textContent(), '深圳研究生院');
    assert.equal(await page.locator('.brand-subtitle').evaluate(element => parseFloat(getComputedStyle(element).fontSize)), 12, 'Brand subtitle must use the existing small text style');
    const subtitleStyle = await page.locator('.brand-subtitle').evaluate(element => {
      const style = getComputedStyle(element);
      const wordmark = element.previousElementSibling.getBoundingClientRect();
      const probe = document.createElement('span');
      probe.style.color = 'var(--ink-muted)';
      element.parentElement.append(probe);
      const expectedColor = getComputedStyle(probe).color;
      probe.remove();
      const range = document.createRange();
      range.setStart(element.firstChild, 0);
      range.setEnd(element.firstChild, 1);
      const first = range.getBoundingClientRect();
      range.setStart(element.firstChild, element.textContent.length - 1);
      range.setEnd(element.firstChild, element.textContent.length);
      const last = range.getBoundingClientRect();
      return { color: style.color, expectedColor, weight: style.fontWeight, firstLeft: first.left - wordmark.left, lastRight: last.right - wordmark.right, gap: element.getBoundingClientRect().top - wordmark.bottom, left: element.getBoundingClientRect().left - wordmark.left };

    });
    assert.equal(subtitleStyle.color, subtitleStyle.expectedColor, 'Subtitle must retain its original muted grey');
    assert.equal(subtitleStyle.weight, '400');
    assert.ok(Math.abs(subtitleStyle.firstLeft) < .1 && Math.abs(subtitleStyle.lastRight) < .1, 'First and last subtitle characters must align with both ends of the university wordmark');
    assert.ok(Math.abs(subtitleStyle.gap - 3) < .1 && Math.abs(subtitleStyle.left) < .1, 'Subtitle must sit 3px below and align with the wordmark');

    assert.equal(await page.locator('.institutional-title strong').textContent(), '实验室台账管理平台');
    assert.equal(await page.locator('.institutional-title span').count(), 0, 'Masthead subtitle must be removed');
    const masthead = await page.locator('.institutional-header').evaluate(element => ({ height: element.getBoundingClientRect().height, titleSize: parseFloat(getComputedStyle(element.querySelector('.institutional-title strong')).fontSize) }));
    assert.ok(masthead.height >= 124, 'Masthead must retain its previous whitespace');
    assert.equal(masthead.titleSize, 24, 'System title must retain its existing size');
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0, 'Reduced motion must show content immediately');
    assert.equal(await page.locator('.welcome-panel h2').textContent(), '试剂使用，请及时登记。');
    assert.equal(await page.locator('.welcome-panel p').count(), 0, 'Welcome subtitle must be removed');
    // Full-screen desktop sizes: sidebar follows the masthead, then fills the viewport.
    for (const height of [800, 900, 1080]) {
      await page.setViewportSize({ width: 1440, height });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      for (const top of [0, 60, 300, 600]) {
        await page.evaluate(top => window.scrollTo({ top, behavior: 'instant' }), top);
        const geometry = await page.evaluate(() => {
          const rail = document.querySelector('.sidebar').getBoundingClientRect();
          const header = document.querySelector('.institutional-header').getBoundingClientRect();
          return { top: rail.top, bottom: rail.bottom, headerBottom: header.bottom, height: innerHeight };
        });
        assert.ok(Math.abs(geometry.top - Math.max(0, geometry.headerBottom)) <= 1, 'Sidebar must not leave a masthead-sized gap when scrolling');
        assert.ok(geometry.bottom >= geometry.height - 1, 'Sidebar must reach the viewport bottom');
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    const pattern = await page.locator('.main-content').evaluate(element => {
      const style = getComputedStyle(element, '::before');
      return { display: style.display, image: style.backgroundImage, opacity: Number(style.opacity), pointerEvents: style.pointerEvents, transform: style.transform };
    });
    assert.notEqual(pattern.display, 'none', 'University-logo background must be visible');
    assert.match(pattern.image, /pku-logo-pattern\.svg/);
    assert.ok(pattern.opacity > 0 && pattern.opacity <= .06, 'Print should remain subtle');
    assert.equal(pattern.pointerEvents, 'none', 'Print must not block interaction');
    assert.equal(pattern.transform, 'none', 'Print must have no independent parallax transform');
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const scroll of [0, 300, 700]) {
        await page.evaluate(top => window.scrollTo({ top, behavior: 'instant' }), scroll);
        const print = await page.locator('.main-content').evaluate(element => {
          const style = getComputedStyle(element, '::before'), overlay = getComputedStyle(element, '::after');
          const header = getComputedStyle(document.querySelector('.institutional-header'));
          return { position: style.position, top: parseFloat(style.top), left: parseFloat(style.left), bottom: parseFloat(style.bottom), right: parseFloat(style.right), height: parseFloat(style.height), width: parseFloat(style.width), windowHeight: innerHeight, windowWidth: innerWidth, backgroundPosition: style.backgroundPosition, overlayPosition: overlay.position, overlayTop: parseFloat(overlay.top), headerZ: Number(header.zIndex), headerPosition: header.position, transform: style.transform };
        });
        assert.equal(print.position, 'fixed', 'Logo print must remain fixed when content scrolls');
        assert.equal(print.top, 0); assert.equal(print.bottom, 0); assert.equal(print.right, 0);
        assert.equal(print.left, 232); assert.equal(print.height, print.windowHeight); assert.equal(print.width, print.windowWidth - print.left);
        assert.equal(print.backgroundPosition, '0% 0%'); assert.equal(print.transform, 'none');
        assert.equal(print.overlayPosition, 'fixed'); assert.equal(print.overlayTop, 0);
        assert.ok(print.headerZ > 0 && print.headerPosition === 'relative', 'Opaque masthead must cover the full-height print without imposing a viewport gap');
        if (width === 1440) await page.screenshot({ path: `/tmp/lab-fixed-background-${scroll}.png` });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    const controls = await page.locator('.welcome-actions button, .icon-button:visible, .global-search').evaluateAll(elements => elements.map(element => ({ radius: parseFloat(getComputedStyle(element).borderTopLeftRadius), height: element.getBoundingClientRect().height })));
    assert.ok(controls.every(control => control.radius >= 8 && control.radius <= 10 && control.height >= 44), 'Visible controls need soft corners and usable height');
    const selectedNav = await page.locator('.nav-item.is-active').evaluate(element => ({ radius: parseFloat(getComputedStyle(element).borderTopLeftRadius), shadow: getComputedStyle(element).boxShadow, background: getComputedStyle(element).backgroundColor }));
    assert.equal(selectedNav.radius, 8);
    assert.equal(selectedNav.shadow, 'none', 'Selected navigation should use a soft fill without a frame');
    await page.locator('[data-page="reagents"]').focus();
    assert.equal(await page.locator('[data-page="reagents"]').evaluate(element => getComputedStyle(element).outlineStyle), 'solid', 'Keyboard focus must remain visible');
    for (const action of ['click', 'shortcut']) {
      if (action === 'click') await page.locator('#global-search').click();
      else { await page.keyboard.press('Tab'); await page.keyboard.press('Meta+k'); }
      const searchFocus = await page.locator('#global-search').evaluate(input => ({ active: document.activeElement === input, innerOutline: getComputedStyle(input).outlineStyle, innerShadow: getComputedStyle(input).boxShadow, outerShadow: getComputedStyle(input.parentElement).boxShadow, outerRadius: parseFloat(getComputedStyle(input.parentElement).borderRadius), focusWithin: input.parentElement.matches(':focus-within') }));
      assert.equal(searchFocus.active, true);
      assert.equal(searchFocus.innerOutline, 'none', 'Global search must not display a second square blue focus outline');
      assert.equal(searchFocus.innerShadow, 'none');
      assert.equal(searchFocus.focusWithin, true);
      assert.notEqual(searchFocus.outerShadow, 'none', 'Rounded outer search focus must remain visible for mouse and keyboard');
      assert.ok(searchFocus.outerRadius >= 8);
    }
    await page.locator('[data-page="reagents"]').focus();

    await page.screenshot({ path: '/tmp/lab-desktop.png' , fullPage: true });
    async function navigate(name) {
      if (await page.locator('#menu-button').isVisible()) await page.locator('#menu-button').click();
      await page.locator(`[data-page="${name}"]`).click();
      assert.equal(await page.locator(`#page-${name}`).isVisible(), true);
    }
    async function checkContrast() {
      const failures = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        function rgb(value) { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; }
        function luminance(values) { return values.slice(0, 3).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i], 0); }
        function background(element) {
          const layers = []; for (let node = element; node; node = node.parentElement) layers.unshift(rgb(getComputedStyle(node).backgroundColor));
          return layers.reduce((under, over) => over.slice(0, 3).map((x, i) => x * over[3] / 255 + under[i] * (1 - over[3] / 255)), [255, 255, 255]);
        }
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const failures = [];
        while (walker.nextNode()) {
          const node = walker.currentNode, element = node.parentElement;
          if (!node.textContent.trim() || ['SCRIPT','STYLE','OPTION'].includes(element.tagName) || element.closest('.sr-only, [hidden], [aria-hidden="true"]') || !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
          const style = getComputedStyle(element), fg = luminance(rgb(style.color)), bg = luminance(background(element));
          const ratio = (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
          const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18 && parseFloat(style.fontWeight) >= 700);
          if (ratio < (large ? 3 : 4.5)) failures.push({ text: node.textContent.trim().slice(0, 40), ratio: +ratio.toFixed(2), color: style.color });
        }
        return failures;
      });
      assert.deepEqual(failures, [], 'Rendered text contrast must meet WCAG AA');
    }
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: width === 1280 ? 800 : 1000 });
      for (const name of ['overview', 'reagents', 'instruments', 'samples', 'settings']) {
        await navigate(name);
        if (width === 1440) await checkContrast();
        const radii = await page.locator('.panel:visible, .catalog-card:visible, .instrument-card:visible, .setting-card:visible').evaluateAll(elements => elements.map(element => parseFloat(getComputedStyle(element).borderTopLeftRadius)));
        assert.ok(radii.every(radius => radius === 10), `${name} panels should use consistent soft corners`);
        const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
        assert.ok(layout.scroll <= layout.width, `${name} overflows at ${width}: ${layout.scroll}`);
        const wraps = await page.locator('.primary-button:visible, .secondary-button:visible, .text-button:visible, .card-link:visible').evaluateAll(elements => elements.filter(element => {
          const range = document.createRange();
          const text = [...element.childNodes].find(node => node.nodeType === 3 && node.textContent.trim());
          if (!text) return false;
          range.selectNode(text);
          return range.getClientRects().length > 1;
        }).map(element => element.textContent));
        assert.deepEqual(wraps, [], `Clickable text wraps at ${width}`);
      }
      await navigate('overview');
      const actions = await page.locator('.usage-panel .panel-header').evaluate(header => {
        const bounds = header.getBoundingClientRect(), buttons = [...header.querySelectorAll('.panel-actions button')].map(button => { const r = button.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
        return { inside: buttons.length === 2 && buttons.every(r => r.left >= bounds.left && r.right <= bounds.right && r.top >= bounds.top && r.bottom <= bounds.bottom), aligned: Math.abs(buttons[0].top - buttons[1].top) < 1 };
      });
      assert.equal(actions.inside, true, `Recent usage actions must stay inside the header at ${width}`);
      assert.equal(actions.aligned, true, `Recent usage actions must align at ${width}`);
      assert.equal(await page.locator('.usage-panel > [data-go-page="history"]').count(), 0);
      await page.locator('.usage-panel .panel-actions [data-go-page="history"]').click();
      assert.equal(await page.locator('#page-history').isVisible(), true);
      await navigate('overview');
      await page.waitForFunction(() => document.querySelector('#usage-records').textContent.includes('尚无真实领用'));
      assert.equal(await page.locator('#usage-feedback').isVisible(), false);
      await page.locator('.welcome-actions [data-open-usage]').click();
      const dialogFits = await page.locator('#usage-dialog').evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && element.scrollWidth <= element.clientWidth; });
      assert.ok(dialogFits, `Usage form overflows at ${width}`);
      await page.locator('#usage-dialog [data-close-usage]').first().click();
      if (width === 1280) await page.screenshot({ path: '/tmp/lab-laptop.png', fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await navigate('overview');
    await page.locator('[data-filter="low"]').click();
    await page.waitForFunction(() => document.querySelector('#dashboard-message').textContent.includes('暂无库存提醒'));
    assert.equal(await page.locator('#inventory-body tr:visible').count(), 0);
    await page.locator('[data-filter="expiry"]').click();
    await page.waitForFunction(() => document.querySelector('#dashboard-message').textContent.includes('暂无库存提醒'));
    assert.equal(await page.locator('#inventory-body tr:visible').count(), 0);
    await page.locator('.welcome-actions [data-open-usage]').click();
    await page.waitForFunction(() => document.querySelector('#usage-options-message').textContent.includes('没有可领单瓶'));
    await page.locator('#usage-form [type="submit"]').click();
    assert.match(await page.locator('#usage-error').textContent(), /选择/);
    await page.locator('#usage-dialog [data-close-usage]').first().click();
    await navigate('reagents');
    await page.locator('#reagent-search').fill('7761-88-8');
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 1 && document.querySelector('.catalog-card h3').textContent === '硝酸银');
    await page.locator('[data-open-dialog="reagent-dialog"]').first().click();
    await page.locator('#reagent-form .secondary-button').click();
    assert.equal(await page.locator('#reagent-dialog').isVisible(), false);
    await page.evaluate(() => localStorage.setItem('pku-lab-consumption-v1', '{broken'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#usage-records').textContent.includes('尚无真实领用'));
    assert.deepEqual(errors, []);
    await context.close();
    const moving = await browser.newContext({ viewport: { width: 1440, height: 800 }, reducedMotion: 'no-preference' });
    await fixture.signIn(moving);
    const flowPage = await moving.newPage();
    flowPage.on('pageerror', error => errors.push(error.message));
    await flowPage.goto(url);
    await flowPage.waitForTimeout(580);
    for (const name of ['reagents', 'instruments', 'samples', 'settings', 'overview']) {
      const animated = await flowPage.evaluate(name => {
        showPage(name);
        return document.querySelector(`#page-${name}`).getAnimations().some(animation => animation.effect.getTiming().duration === 520);
      }, name);
      assert.equal(animated, true, `${name} should enter with a short transition`);
      if (name === 'reagents') {
        // Sample mid-flight: assert real rendered movement, not just an animation object.
        const middle = await flowPage.locator('#page-reagents').evaluate(element => {
          const animation = element.getAnimations()[0];
          animation.pause();
          animation.currentTime = 180;
          const style = getComputedStyle(element);
          return { opacity: Number(style.opacity), y: new DOMMatrix(style.transform).m42 };
        });
        assert.ok(middle.y >= 3 && middle.opacity < .95, 'Movement should still be visible after 180ms');
        await flowPage.screenshot({ path: '/tmp/lab-motion-midpoint.png' });
        await flowPage.locator('#page-reagents').evaluate(element => element.getAnimations()[0].play());
      }

      await flowPage.waitForTimeout(580);
      assert.equal(await flowPage.locator(`#page-${name}`).evaluate(element => getComputedStyle(element).opacity), '1');
    }
    // Scroll a real block into view from both directions and watch its entry animation.
    const scrollTarget = flowPage.locator('.equipment-panel');
    await flowPage.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await flowPage.waitForTimeout(80);
    await scrollTarget.evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'center' }));
    await flowPage.waitForFunction(() => document.querySelector('.equipment-panel').getAnimations().length > 0);
    await flowPage.waitForTimeout(580);
    const metric = flowPage.locator('.metric-grid');
    await metric.evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'center' }));
    await flowPage.waitForFunction(() => document.querySelector('.metric-grid').getAnimations().length > 0);
    await flowPage.evaluate(() => { showPage('reagents'); showPage('instruments'); showPage('samples'); });
    await flowPage.waitForTimeout(580);
    assert.equal(await flowPage.locator('.page-view:visible').count(), 1, 'Rapid navigation must leave one readable view');
    assert.equal(await flowPage.locator('#page-samples').evaluate(element => getComputedStyle(element).opacity), '1');
    await flowPage.evaluate(() => { showPage('settings'); document.querySelector('#page-settings').getAnimations()[0].pause(); });
    await flowPage.waitForTimeout(700);
    assert.equal(await flowPage.locator('#page-settings').evaluate(element => getComputedStyle(element).opacity), '1', 'Suspended browser animations must not leave content translucent');
    await flowPage.evaluate(() => showPage('instruments'));

    await flowPage.emulateMedia({ reducedMotion: 'reduce' });
    await flowPage.waitForFunction(() => document.getAnimations().filter(animation => animation.effect.target.closest('.page-view')).length === 0);
    await flowPage.evaluate(() => showPage('overview'));
    assert.equal(await flowPage.evaluate(() => document.getAnimations().filter(animation => animation.effect.target.closest('.page-view')).length), 0, 'Reduced motion must suppress subsequent transitions');
    assert.deepEqual(errors, []);
    await moving.close();
    console.log('Browser validation passed: official wordmark, 3 desktop widths × 5 views, text contrast, usage regression, view transitions, bidirectional scroll entry, rapid navigation, reduced motion.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fixture.close());
