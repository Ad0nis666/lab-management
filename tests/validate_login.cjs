const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fixture = require('./auth-fixture.cjs').createFixture();
const { server } = fixture;
(async () => {
  await fixture.initialize();
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}/login.html`;
    await page.goto(url);
    assert.equal(await page.locator('.brand-subtitle').textContent(), '深圳研究生院');
    async function fillCredentials() {
      await page.locator('#account').fill(fixture.credentials.account);
      await page.locator('#password').fill(fixture.credentials.password);
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
    for (const [width, height] of [[1280,800], [1440,900], [1920,1080], [1280,720]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator('.login-content').evaluate(element => { const r = element.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), true, 'Form fits desktop viewport');
      assert.equal(await page.locator('.demo-access, .page-note, #fill-demo').count(), 0, 'Demo credentials and notes must be removed');
      assert.doesNotMatch(await page.locator('.form-panel').textContent(), /demo123|演示账号|前端演示/);
      await checkContrast();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const preview = await context.newPage();
    await preview.goto(url);
    await preview.screenshot({ path: '/tmp/lab-login-demo.png', fullPage: true });
    await preview.close();
    const pattern = await page.locator('.brand-panel').evaluate(element => { const s = getComputedStyle(element, '::before'); return { image: s.backgroundImage, opacity: Number(s.opacity), events: s.pointerEvents }; });
    assert.match(pattern.image, /pku-logo-pattern/); assert.ok(pattern.opacity > 0 && pattern.opacity <= .06); assert.equal(pattern.events, 'none');
    assert.equal(await page.locator('.login-content').evaluate(element => element.getAnimations().length), 0);
    await page.locator('#login-button').click();
    assert.equal(await page.locator('#account').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#password').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#account').evaluate(element => element === document.activeElement), true);
    await fillCredentials();
    assert.equal(await page.locator('#account').inputValue(), fixture.credentials.account); assert.equal(await page.locator('#password').inputValue(), fixture.credentials.password);
    assert.equal(await page.locator('#account').getAttribute('aria-invalid'), null);
    await page.locator('#toggle-password').click();
    assert.equal(await page.locator('#password').getAttribute('type'), 'text'); assert.equal(await page.locator('#toggle-password').getAttribute('aria-pressed'), 'true');
    await page.locator('#toggle-password').click(); assert.equal(await page.locator('#password').getAttribute('type'), 'password');
    await page.locator('#password').fill('wrong'); await page.locator('#login-button').click();
    await page.locator('#login-button[data-state="error"]').waitFor();
    assert.match(await page.locator('#login-message').textContent(), /账号或密码不正确/); assert.equal(await page.locator('#login-button').isDisabled(), false);
    // Pause the request deterministically to verify loading and duplicate-submit protection.
    let releaseLogin;
    const paused = new Promise(resolve => { releaseLogin = resolve; });
    await page.route('**/api/v1/auth/login', async route => { await paused; await route.continue(); });
    await fillCredentials(); await page.locator('#login-button').click();
    assert.equal(await page.locator('#login-button').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#account').isDisabled(), true);
    assert.equal(await page.locator('#password').isDisabled(), true);
    releaseLogin(); await page.waitForURL('**/index.html');
    await page.unroute('**/api/v1/auth/login');
    await page.waitForFunction(() => document.querySelector('.profile-copy strong').textContent === '测试管理员');
    const cookies = await context.cookies();
    const session = cookies.find(cookie => cookie.name === 'lab_session');
    assert.ok(session?.httpOnly); assert.equal(session.sameSite, 'Strict');
    assert.equal(await page.evaluate(() => document.cookie.includes('lab_session')), false);
    assert.equal(await page.evaluate(() => sessionStorage.length), 0);
    assert.equal(await page.locator('#page-overview').isVisible(), true);
    await page.locator('.profile-button').click();
    assert.equal(await page.locator('#profile-panel').isVisible(), true);
    await page.screenshot({ path: '/tmp/lab-account-menu.png', fullPage: true });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#profile-panel').isVisible(), false);
    assert.equal(await page.locator('.profile-button').evaluate(el => el === document.activeElement), true);
    await page.locator('.profile-button').click();
    await page.locator('#logout-button').click(); await page.waitForURL('**/login.html');
    await page.goto(url.replace('login.html', 'index.html'));
    await page.waitForURL('**/login.html');
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Unavailable'); }; });
    await fillCredentials(); await page.locator('#password').press('Enter'); await page.waitForURL('**/index.html');
    assert.equal(await page.locator('#page-overview').isVisible(), true, 'Cookie login does not depend on local storage');
    await page.locator('.profile-button').click(); await page.locator('#logout-button').click(); await page.waitForURL('**/login.html');
    await page.route('**/api/v1/auth/login', route => route.abort('failed'));
    await fillCredentials(); await page.locator('#login-button').click();
    await page.locator('#login-button[data-state="error"]').waitFor();
    assert.match(await page.locator('#login-message').textContent(), /无法连接/);
    assert.equal(await page.locator('#login-button').isDisabled(), false);
    assert.equal(await page.locator('#account').isDisabled(), false);
    await page.unroute('**/api/v1/auth/login');
    await fillCredentials(); await page.locator('#password').press('Enter'); await page.waitForURL('**/index.html');
    await page.locator('.profile-button').click(); await page.locator('#change-password-button').click();
    await page.locator('#password-form [name="current_password"]').fill('wrong');
    await page.locator('#password-form [name="new_password"]').fill('Newpass9!');
    await page.locator('#password-form [name="confirm_password"]').fill('Mismatch-password-2026!');
    await page.locator('#password-form [type="submit"]').click();
    assert.match(await page.locator('#password-error').textContent(), /两次新密码不一致/);
    await page.locator('#password-form [name="confirm_password"]').fill('Newpass9!');
    await page.locator('#password-form [type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#password-error').textContent.includes('原密码不正确'));
    await page.locator('#password-form [name="current_password"]').fill(fixture.credentials.password);
    await page.locator('#password-form [type="submit"]').click(); await page.waitForURL('**/login.html');
    await page.locator('#account').fill(fixture.credentials.account);
    await page.locator('#password').fill('Newpass9!');
    await page.locator('#password').press('Enter'); await page.waitForURL('**/index.html');
    await fixture.app.store.resetPassword(fixture.credentials.account, fixture.credentials.password);
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.waitForURL('**/login.html');
    assert.deepEqual(errors, []); await context.close();
    const moving = await browser.newContext({ reducedMotion: 'no-preference' }); const motionPage = await moving.newPage(); await motionPage.goto(url);
    assert.ok(await motionPage.locator('.login-content').evaluate(element => element.getAnimations().length > 0));
    await motionPage.waitForTimeout(650); assert.equal(await motionPage.locator('.login-content').evaluate(element => getComputedStyle(element).opacity), '1'); await moving.close();
    console.log('Login validation passed: desktop layout, contrast, validation, password visibility, real API login, loading lock, Enter login, HttpOnly session, logout, protected access, password change and revocation, network failure, unavailable local storage, reduced motion.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fixture.close());
