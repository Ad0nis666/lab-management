const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApplication } = require('../backend/server.cjs');
// Test-only credentials. Production initialization never creates these accounts.
const credentials = { account: 'test_admin', password: 'Test-password-2026!' };
function createFixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-auth-test-'));
  const app = createApplication({ dbPath: path.join(directory, 'test.sqlite'), ...options });
  let origin;
  return {
    app, server: app.server, credentials,
    async initialize() {
      await app.store.createUser({ ...credentials, display_name: '测试管理员', role: 'admin' }, true);
      origin = await app.listen(); return origin;
    },
    async signIn(context) {
      const response = await context.request.post(`${origin}/api/v1/auth/login`, { data: credentials, headers: { Origin: origin } });
      if (!response.ok()) throw new Error(`Fixture sign-in failed: ${response.status()}`);
    },
    async close() { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  };
}
module.exports = { createFixture };
