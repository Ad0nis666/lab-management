#!/bin/sh

set -eu

document="PRODUCT_DESIGN.md"

test -s "$document"

for heading in \
  "## 1. 产品概述" \
  "## 2. 目标用户" \
  "## 3. MVP 功能范围" \
  "## 4. 页面结构" \
  "## 5. 核心使用流程" \
  "## 6. 产品设计原则" \
  "## 7. 暂不纳入 MVP" \
  "## 8. MVP 成功标准"
do
  grep -Fqx "$heading" "$document"
done

python3 - <<'PY'
from pathlib import Path

document = Path("BACKEND_REQUIREMENTS.md").read_text()
expected = [
    "1. 真实登录：已完成 ✅。",
    "2. 试剂档案：已完成真实保存、列表查询和详情展示 ✅。",
    "3. 单瓶入库：已完成瓶号、批次、初始量、位置及有效期保存 ✅。",
    "4. 领用扣库存：已完成按瓶领用、事务扣减及重复提交/超领保护 ✅。",
    "5. 查询历史：已完成完整库存流水查询及使用人/操作者追溯 ✅。",
    "6. 首页提醒：已完成真实库存指标、低库存、临期和过期提醒 ✅。",
]
lines = document.splitlines()
assert lines[:3] == ["# 后端缺口与接入设计", "", "## 推荐实施顺序"], "实施顺序须位于文档顶部"
assert lines[4:10] == expected, "核心功能顺序或完成状态不符合约定"
assert document.index(expected[-1]) < document.index("检查日期："), "实施顺序须在检查说明之前"
print("后端推荐实施顺序校验通过")
PY

if grep -Eq 'TODO|TBD|待补充' "$document"; then
  echo "产品设计文档包含未完成占位符" >&2
  exit 1
fi

echo "产品设计文档校验通过"
python3 tests/validate_settings_plan.py
