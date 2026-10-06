"""Check plan scope, referenced entry points, and current registration claims."""
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
plan = (root / 'backend/基础设置实施计划.md').read_text()
scope = plan.split('## 一、建设目标', 1)[1].split('## 二、范围约定', 1)[0]
assert re.findall(r'^\d+\. (.+)。$', scope, re.M) == ['成员与角色', '提醒规则', '使用帮助']
assert '状态：已实施' in plan
assert '默认提前 30 天' in plan and '0–365' in plan
assert '本次不包含存放位置管理、分类管理、单位管理、密码管理、数据导出、数据库备份' in plan
assert '不支持 kg 与 L 换算' in plan
assert '网页注册只能创建普通成员，已有管理员可在成员与角色页面授权管理员' in plan
assert '基础设置 → 成员与角色' in plan and '不能降级或停用最后一位有效管理员' in plan

# Verify the documented present behavior against the actual registration method.
auth = (root / 'backend/auth.cjs').read_text()
register = auth.split('async register(', 1)[1].split('async login(', 1)[0]
assert "role: 'member'" in register
assert "role: data.role" not in register
assert "'SETUP_REQUIRED'" in register
page = (root / 'login.html').read_text()
assert 'id="show-register"' in page and 'id="register-form"' in page
assert 'name="role"' not in page

# Every documented npm command must exist, with its initialization restriction.
import json
scripts = json.loads((root / 'package.json').read_text())['scripts']
assert 'init-admin' in scripts and 'user' in scripts
cli = (root / 'backend/manage-users.cjs').read_text()
assert "command === 'init-admin' && store.db.prepare('SELECT 1 FROM users LIMIT 1').get()" in cli
assert '创建首位管理员' in plan and '已有账号时不重复初始化' in plan
assert 'tests/validate_settings_plan.py' in (root / 'tests/validate_product_design.sh').read_text()
print('基础设置计划校验通过：三个入口、排除范围、网页授权流程及当前注册说明。')
