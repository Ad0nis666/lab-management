const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AuthStore, AuthError, publicUser } = require('./auth.cjs');
const { ReagentStore } = require('./reagents.cjs');
const { BottleStore } = require('./bottles.cjs');
const { ConsumptionStore } = require('./consumptions.cjs');
const { DashboardStore } = require('./dashboard.cjs');
const { SettingsStore } = require('./settings.cjs');
const { CollectionStore } = require('./collections.cjs');
const ROOT = path.resolve(__dirname, '..');
const COOKIE = 'lab_session';
function readCookie(req) {
  return (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}
async function readJSON(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new AuthError(415, 'JSON_REQUIRED', '请使用 JSON 请求。');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new AuthError(413, 'BODY_TOO_LARGE', '请求内容过大。');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
    return data;
  } catch { throw new AuthError(400, 'INVALID_JSON', '请求内容格式不正确。'); }
}
function createApplication({ dbPath, now, sessionTTL, origin, production = false } = {}) {
  const store = new AuthStore({ dbPath, now, sessionTTL });
  const reagents = new ReagentStore(store);
  const bottles = new BottleStore(store, reagents);
  reagents.bottles = bottles;
  const consumptions = new ConsumptionStore(store, bottles);
  const settings = new SettingsStore(store);
  const dashboard = new DashboardStore(store, bottles);
  const collections = { instruments: new CollectionStore(store, 'instruments'), samples: new CollectionStore(store, 'samples') };
  let allowedOrigin = origin;
  if (origin) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol) || (production && parsed.protocol !== 'https:')) {
      store.close(); throw new Error('APP_ORIGIN 必须为完整来源；生产环境必须使用 HTTPS。');
    }
  } else if (production) { store.close(); throw new Error('生产环境必须设置 APP_ORIGIN=https://你的域名。'); }
  function cookie(res, token = '') {
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? Math.floor(store.sessionTTL / 1000) : 0}${production || allowedOrigin?.startsWith('https:') ? '; Secure' : ''}`);
  }
  function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data));
  }
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      if (!allowedOrigin || req.headers.host !== new URL(allowedOrigin).host) throw new AuthError(403, 'INVALID_HOST', '请求来源不受支持。');
      const pathname = new URL(req.url, allowedOrigin).pathname;
      let decodedPath;
      try { decodedPath = decodeURIComponent(pathname); }
      catch { throw new AuthError(400, 'INVALID_URL', '请求地址编码不正确。'); }
      const token = readCookie(req);
      if (pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.headers.origin !== allowedOrigin) throw new AuthError(403, 'INVALID_ORIGIN', '请求来源不受支持，请刷新后重试。');
        if (pathname === '/api/v1/health' && req.method === 'GET') return json(res, 200, { status: 'ok' });
        if (pathname === '/api/v1/auth/register' && req.method === 'POST') {
          const user = await store.register(await readJSON(req), req.socket.remoteAddress);
          return json(res, 201, { user });
        }
        if (pathname === '/api/v1/auth/login' && req.method === 'POST') {
          const data = await readJSON(req);
          const result = await store.login(data.account, data.password, req.socket.remoteAddress, token);
          cookie(res, result.token); return json(res, 200, { user: result.user });
        }
        const user = store.requireSession(token);
        if (req.method !== 'GET' && pathname !== '/api/v1/auth/logout' && user.role !== 'admin') {
          throw new AuthError(403, 'FORBIDDEN', '您没有该权限');
        }
        if (pathname === '/api/v1/auth/me' && req.method === 'GET') return json(res, 200, { user: publicUser(user), expires_at: new Date(user.expires_at).toISOString() });
        if (pathname === '/api/v1/auth/logout' && req.method === 'POST') {
          store.logout(token); cookie(res); return json(res, 200, { ok: true });
        }
        if (pathname === '/api/v1/auth/change-password' && req.method === 'POST') {
          const data = await readJSON(req);
          await store.changePassword(token, data.current_password, data.new_password);
          cookie(res); return json(res, 200, { ok: true });
        }
        const settingsRoute = pathname.match(/^\/api\/v1\/settings\/(members|reminders)(?:\/([^/]+))?$/);
        if (settingsRoute) {
          const [, kind, id] = settingsRoute, params = new URL(req.url, allowedOrigin).searchParams;
          if (kind === 'members' && !id && req.method === 'GET') return json(res, 200, settings.members(params));
          if (params.size) throw new AuthError(422, 'INVALID_SETTINGS', '此操作不支持查询参数。');
          if (kind === 'reminders' && !id && req.method === 'GET') return json(res, 200, { settings: settings.reminders() });
          if (req.method === 'PATCH' && ((kind === 'members' && id) || (kind === 'reminders' && !id))) {
            const data = await readJSON(req);
            return json(res, 200, kind === 'members' ? { member: settings.updateMember(id, data, token) } : { settings: settings.updateReminders(data, token) });
          }
          throw new AuthError(405, 'METHOD_NOT_ALLOWED', '请求方法不受支持。');
        }
        if (['/api/v1/dashboard', '/api/v1/alerts'].includes(pathname)) {
          if (req.method !== 'GET') throw new AuthError(405, 'METHOD_NOT_ALLOWED', '请求方法不受支持。');
          return json(res, 200, dashboard.get(new URL(req.url, allowedOrigin).searchParams));
        }
        if (pathname === '/api/v1/collections-summary') {
          if (req.method !== 'GET') throw new AuthError(405, 'METHOD_NOT_ALLOWED', '请求方法不受支持。');
          if (new URL(req.url, allowedOrigin).search) throw new AuthError(422, 'INVALID_QUERY', '汇总不支持查询参数。');
          const instruments = store.db.prepare("SELECT count(*) AS total, COALESCE(sum(status='normal'),0) AS available, COALESCE(sum(status='unknown'),0) AS unconfirmed FROM instruments").get();
          const samples = store.db.prepare("SELECT count(*) AS stored FROM samples WHERE status='stored'").get();
          const pending = store.db.prepare("SELECT * FROM instruments WHERE status != 'normal' ORDER BY updated_at DESC, id DESC LIMIT 3").all();
          return json(res, 200, { instruments, samples, pending });
        }
        const collectionRoute = pathname.match(/^\/api\/v1\/(instruments|samples)(?:\/([^/]+))?$/);
        if (collectionRoute) {
          const collection = collections[collectionRoute[1]], id = collectionRoute[2];
          const params = new URL(req.url, allowedOrigin).searchParams;
          if (id && params.size) throw new AuthError(422, 'INVALID_QUERY', '详情不支持查询参数。');
          if (req.method === 'GET') return json(res, 200, id ? { item: collection.get(id) } : collection.list(params));
          if (req.method === 'POST') {
            if (params.size) throw new AuthError(422, 'INVALID_QUERY', '保存不支持查询参数。');
            const data = await readJSON(req);
            return json(res, id ? 200 : 201, { item: collection.save(data, store.requireSession(token), id) });
          }
          throw new AuthError(405, 'METHOD_NOT_ALLOWED', '请求方法不受支持。');
        }
        if (pathname === '/api/v1/reagents') {
          if (req.method === 'GET') return json(res, 200, reagents.list(new URL(req.url, allowedOrigin).searchParams));
          if (req.method === 'POST') {
            if (user.role !== 'admin') throw new AuthError(403, 'FORBIDDEN', '您没有该权限');
            const data = await readJSON(req);
            return json(res, 201, { reagent: reagents.create(data, store.requireSession(token)) });
          }
          throw new AuthError(405, 'METHOD_NOT_ALLOWED', '请求方法不受支持。');
        }
        const reagentBottles = pathname.match(/^\/api\/v1\/reagents\/([^/]+)\/bottles$/);
        if (reagentBottles) {
          if (req.method === 'GET') return json(res, 200, bottles.list(reagentBottles[1], new URL(req.url, allowedOrigin).searchParams));
          if (req.method === 'POST') {
            if (user.role !== 'admin') throw new AuthError(403, 'FORBIDDEN', '您没有该权限');
            const data = await readJSON(req);
            const result = bottles.create(reagentBottles[1], data, store.requireSession(token), req.headers['idempotency-key']);
            return json(res, result.replayed ? 200 : 201, result);
          }
          throw new AuthError(405, 'METHOD_NOT_ALLOWED', '请求方法不受支持。');
        }
        if (['/api/v1/users', '/api/v1/bottles', '/api/v1/consumptions', '/api/v1/movements'].includes(pathname)) {
          if (req.method !== 'GET') throw new AuthError(405, 'METHOD_NOT_ALLOWED', '请求方法不受支持。');
          const params = new URL(req.url, allowedOrigin).searchParams;
          if (pathname === '/api/v1/users') {
            if (params.size) throw new AuthError(422, 'INVALID_CONSUMPTION', '成员选项不支持查询参数。');
            return json(res, 200, consumptions.users(user));
          }
          if (pathname === '/api/v1/bottles') return json(res, 200, bottles.search(params));
          return json(res, 200, consumptions.history(params, pathname.endsWith('/consumptions') ? { type: 'consumption' } : {}));
        }
        const bottleAction = pathname.match(/^\/api\/v1\/bottles\/([^/]+)\/(consumptions|movements)$/);
        if (bottleAction) {
          if (bottleAction[2] === 'movements' && req.method === 'GET') return json(res, 200, consumptions.history(new URL(req.url, allowedOrigin).searchParams, { bottleId: bottleAction[1] }));
          if (bottleAction[2] === 'consumptions' && req.method === 'POST') {
            const data = await readJSON(req);
            const result = consumptions.create(bottleAction[1], data, store.requireSession(token), req.headers['idempotency-key']);
            return json(res, result.replayed ? 200 : 201, result);
          }
          throw new AuthError(405, 'METHOD_NOT_ALLOWED', '请求方法不受支持。');
        }
        const bottleDetail = pathname.match(/^\/api\/v1\/bottles\/([^/]+)$/);
        if (bottleDetail) {
          if (req.method !== 'GET') throw new AuthError(405, 'METHOD_NOT_ALLOWED', '请求方法不受支持。');
          if (new URL(req.url, allowedOrigin).search) throw new AuthError(422, 'INVALID_BOTTLE', '详情不支持查询参数。');
          return json(res, 200, { bottle: bottles.get(bottleDetail[1]) });
        }
        const reagentDetail = pathname.match(/^\/api\/v1\/reagents\/([^/]+)$/);
        if (reagentDetail) {
          if (req.method !== 'GET') throw new AuthError(405, 'METHOD_NOT_ALLOWED', '请求方法不受支持。');
          if (new URL(req.url, allowedOrigin).search) throw new AuthError(422, 'INVALID_REAGENT', '详情不支持查询参数。');
          return json(res, 200, { reagent: reagents.get(reagentDetail[1]) });
        }
        throw new AuthError(404, 'NOT_FOUND', '接口尚未实现。');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new AuthError(405, 'METHOD_NOT_ALLOWED', '请求方法不受支持。');
      const fileName = pathname === '/' ? 'index.html' : decodedPath.slice(1);
      const allowedFiles = new Set(['index.html', 'login.html', 'app.js', 'bottles.js', 'usage.js', 'dashboard.js', 'collections.js', 'settings.js', 'permissions.js', 'auth.js', 'login.js', 'styles.css', 'login.css', 'tokens.css']);
      if (!allowedFiles.has(fileName) && !/^assets\/(branding|instruments|reagents)\/[a-zA-Z0-9_.-]+\.(svg|png)$/.test(fileName)) {
        throw new AuthError(404, 'NOT_FOUND', '页面不存在。');
      }
      if (fileName === 'index.html') {
        try { store.requireSession(token); }
        catch (error) {
          if (error.status !== 401) throw error;
          cookie(res); res.writeHead(302, { Location: '/login.html' }); res.end(); return;
        }
      }
      const file = await fs.realpath(path.join(ROOT, fileName)).catch(() => { throw new AuthError(404, 'NOT_FOUND', '页面不存在。'); });
      if (!file.startsWith(ROOT + path.sep)) throw new AuthError(404, 'NOT_FOUND', '页面不存在。');
      const content = await fs.readFile(file);
      const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] }); res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error.status === 401 && error.code === 'UNAUTHENTICATED') cookie(res);
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      if (!(error instanceof AuthError)) console.error(JSON.stringify({ request_id: requestId, code: 'INTERNAL_ERROR' }));
      json(res, error instanceof AuthError ? error.status : 500, { error: { code: error instanceof AuthError ? error.code : 'INTERNAL_ERROR', message: error instanceof AuthError ? error.message : '服务暂时不可用，请稍后重试。' }, request_id: requestId });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    server, store,
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
      if (!allowedOrigin) allowedOrigin = `http://127.0.0.1:${server.address().port}`;
      return allowedOrigin;
    },
    async close() {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await store.dummyHash; store.close();
    }
  };
}
if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const origin = process.env.APP_ORIGIN || (process.env.NODE_ENV !== 'production' ? `http://127.0.0.1:${port}` : undefined);
  const app = createApplication({ dbPath: process.env.LAB_DB_PATH, origin, production: process.env.NODE_ENV === 'production' });
  app.listen(port, process.env.HOST || '127.0.0.1').then(url => console.log(`实验室网站已启动：${url}/login.html`)).catch(error => { console.error(error.message); process.exitCode = 1; app.store.close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
}
module.exports = { createApplication };
