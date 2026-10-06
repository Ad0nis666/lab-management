"""Run the guide's SQLite commands against a disposable database."""
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlparse

root = Path(__file__).resolve().parents[1]
guide = (root / 'SQLITE使用说明.md').read_text()

# Audit current project paths, including every tracked Markdown and hidden config.
# The repository can be cloned into any directory name.
former_name = '\u7f51\u7ad9'
former_encoded = '%E7%BD%91%E7%AB%99'
old_path = re.compile(r'[/\\](?:' + re.escape(former_name) + '|' + former_encoded + r')(?![\w])|(?:' + re.escape(former_name) + '|' + former_encoded + r')[/\\]', re.I)
assert old_path.search('/Desktop/' + former_name + '/guide.md')
assert old_path.search('/Desktop/' + former_encoded + '/guide.md')
assert old_path.search('C:' + chr(92) + former_name + chr(92) + 'guide.md')
assert not old_path.search('/Desktop/' + former_name + '1.1/guide.md')
tracked = subprocess.run(['git', 'ls-files', '-z'], cwd=root, check=True, capture_output=True).stdout.decode().split('\0')
for name in filter(None, tracked):
    path = root / name
    assert former_name not in Path(name).parts, f'Old directory name remains in filename: {name}'
    try:
        content = path.read_text()
    except UnicodeDecodeError:
        continue
    assert not old_path.search(content), f'Old project path remains in: {name}'
assert '/path/to/website/.data/lab.sqlite' in guide, 'Database guide must use a portable example path'
sql_blocks = re.findall(r'```sql\n(.*?)\n```', guide, re.S)
assert len(sql_blocks) == 1, 'Expected one executable SQLite example'
assert 'sqlite3 -readonly .data/lab.sqlite' in guide
assert 'npm run init-admin' in guide

# Documented startup must enter the actual project, and page links must map to
# existing entry pages whose HTTP behavior is covered by the authentication tests.
startup = guide.split('## 5. 网站路径与启动方式', 1)[1]
assert 'cd /path/to/website\nnpm start' in startup, 'Startup example must enter the example project directory'
page_urls = re.findall(r'\]\((http://127\.0\.0\.1:3000/[^)]+)\)', startup)
assert {urlparse(url).path for url in page_urls} == {'/login.html', '/index.html'}
for url in page_urls:
    assert (root / urlparse(url).path.lstrip('/')).is_file(), f'Missing documented page: {url}'

with tempfile.TemporaryDirectory(prefix='lab-sqlite-guide-') as directory:
    database = Path(directory) / 'guide.sqlite'
    process = subprocess.Popen(['node', '-e', '''
const { AuthStore } = require('./backend/auth.cjs');
(async () => {
  const store = new AuthStore({ dbPath: process.argv[1] });
  await store.createUser({ account: 'guide_admin', display_name: '说明测试账号', password: 'Guide-test-password-2026!', role: 'admin' }, true);
  await store.dummyHash;
  console.log('READY');
  setInterval(() => {}, 1000);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
''', str(database)], cwd=root, stdout=subprocess.PIPE, text=True)
    try:
        assert process.stdout.readline().strip() == 'READY', 'Database initialization failed'
        result = subprocess.run(['sqlite3', '-readonly', str(database)], input=sql_blocks[0], text=True, capture_output=True)
        assert result.returncode == 0, result.stderr
        for expected in ['users', 'sessions', 'login_limits', 'schema_migrations', 'CREATE TABLE users', 'guide_admin', '说明测试账号', 'admin', 'active']:
            assert expected in result.stdout, f'Missing expected query result: {expected}'
        missing = Path(directory) / 'missing.sqlite'
        result = subprocess.run(['sqlite3', '-readonly', str(missing), '.tables'], text=True, capture_output=True)
        assert result.returncode != 0 and not missing.exists(), 'Read-only opening must not create an empty database'
    finally:
        process.terminate()
        process.wait(timeout=5)

print('SQLite guide validation passed: website paths/startup, table/schema/user queries and safe read-only opening.')
