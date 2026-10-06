"""Catch missing tokens and accidental colour/font values outside the palette."""
from pathlib import Path
import re
css = Path('styles.css').read_text() + Path('login.css').read_text()
tokens = Path('tokens.css').read_text()
defined = set(re.findall(r'(--[\w-]+)\s*:', css + tokens + Path('index.html').read_text()))
defined.update(re.findall(r'var\((--[\w-]+)\s*,', css))
used = set(re.findall(r'var\((--[\w-]+)', css))
assert not used - defined, f'Undefined CSS tokens: {used - defined}'
assert not re.search(r'#[0-9a-fA-F]{3,8}\b|\brgba?\(|\boklch\(', css), 'Colours must come from tokens.css'
for family in re.findall(r'font-family:\s*([^;]+)', css):
    assert family == 'inherit' or family.startswith('var(--font-'), family
assert css.startswith('/* Hallmark · macrostructure:'), 'Missing design stamp'
assert 'var(--color-accent-ink)-space' not in css, 'Invalid white-space property'
assert css.count('{') == css.count('}'), 'Unbalanced CSS blocks'
print('CSS token validation passed')
