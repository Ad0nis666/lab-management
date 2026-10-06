#!/bin/sh

set -eu

for file in index.html styles.css tokens.css app.js bottles.js usage.js dashboard.js collections.js settings.js permissions.js auth.js login.html login.css login.js; do
  test -s "$file"
done

for asset in \
  assets/reagents/ethanol.svg \
  assets/reagents/silver-nitrate.svg \
  assets/reagents/acetone.svg \
  assets/instruments/robot-arm.svg \
  assets/instruments/bottle-pump.svg \
  assets/instruments/balance.svg \
  assets/instruments/gas-chromatograph.svg \
  assets/instruments/spectrophotometer.svg \
  assets/branding/pku-logo-pattern.svg
do
  test -s "$asset"
  grep -Fq '<title' "$asset"
  grep -Fq '<desc' "$asset"
done

node --check app.js
node --check bottles.js
node --check usage.js
node --check dashboard.js
node --check collections.js
node --check settings.js
node --check backend/settings.cjs
node --check backend/collections.cjs
node --check backend/seed-lab.cjs
node --check permissions.js
node --check backend/dashboard.cjs
node --check backend/consumptions.cjs
node --check backend/bottles.cjs
node --check login.js
node --check auth.js
node --check backend/auth.cjs
node --check backend/server.cjs
node --check backend/reagents.cjs
node --check backend/manage-users.cjs
grep -Fq '/api/v1/auth/login' login.js
grep -Fq '/api/v1/auth/register' login.js
grep -Fq 'id="register-form"' login.html
grep -Fq 'id="logout-button"' index.html
if grep -Eq 'demo123|pku-lab-demo-session' login.js; then
  echo '登录不得再使用演示凭据或本地模拟会话' >&2
  exit 1
fi

for page in overview reagents instruments samples settings; do
  grep -Fq "id=\"page-$page\"" index.html
  grep -Fq "data-page=\"$page\"" index.html
done

grep -Fq '@media (max-width: 640px)' styles.css
grep -Fq '@media (prefers-reduced-motion: reduce)' styles.css
grep -Fq 'aria-label="关闭导航"' index.html
grep -Fq 'aria-live="polite"' index.html
grep -Fq 'id="reagent-detail-dialog"' index.html
grep -Fq 'assets/instruments/balance.svg' collections.js
grep -Fq 'assets/branding/pku-logo.png' index.html
test -s assets/branding/pku-logo.png
test -s assets/branding/pku-official-lockup.png
if grep -Fq '实验室物品管理' index.html; then
  echo '校名下方的小字应已删除' >&2
  exit 1
fi
grep -Fq 'class="pku-wordmark"' index.html
grep -Fq 'id="usage-dialog"' index.html
grep -Fq 'id="usage-records"' index.html
grep -Fq '/consumptions' usage.js
grep -Fq 'id="page-history"' index.html
grep -Fq '@import url("tokens.css")' styles.css
grep -Fq 'overflow-x: clip' styles.css
grep -Fq 'font-variant-numeric: tabular-nums' styles.css
python3 tests/validate_tokens.py

if grep -Eq 'TODO|TBD|javascript:void' index.html styles.css app.js; then
  echo "前端 Demo 包含未完成占位符" >&2
  exit 1
fi

echo "前端 Demo 静态校验通过"
