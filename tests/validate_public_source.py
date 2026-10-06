"""Check the publishable Git index, never print credential values."""
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[1]
names = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
secret = re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----|\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{15,}|AIza[0-9A-Za-z_-]{30,})')
private_path = re.compile(r'/' + r'Users/[^/\s]+/|[A-Za-z]:\\Users\\[^\\\s]+\\')
for name in filter(None, names):
    path = Path(name)
    assert '.data' not in path.parts and '.git' not in path.parts, f'Private directory tracked: {name}'
    assert not path.name.startswith('.env') or path.name == '.env.example', f'Environment file tracked: {name}'
    assert not re.search(r'\.(?:sqlite(?:-wal|-shm)?|db|pem|key|zip)$', name), f'Private artifact tracked: {name}'
    raw = (root / name).read_bytes()
    if b'\0' in raw[:8192]:
        continue
    content = raw.decode('utf-8', errors='replace')
    assert not secret.search(content), f'Possible credential in: {name}'
    assert not private_path.search(content), f'Personal filesystem path in: {name}'

for name in ['.data/lab.sqlite', '.data/backup.sqlite', '.env', '.env.local', '.env.production', 'source.zip', '.DS_Store']:
    result = subprocess.run(['git', 'check-ignore', '--no-index', '-q', name], cwd=root)
    assert result.returncode == 0, f'Private artifact is not ignored: {name}'
assert (root / 'README.md').is_file()
assert 'MIT License' in (root / 'LICENSE').read_text()
print('Public source validation passed: excluded private artifacts, credential patterns and personal paths.')
