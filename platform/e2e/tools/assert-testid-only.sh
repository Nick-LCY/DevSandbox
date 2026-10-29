#!/usr/bin/env bash
# assert-testid-only.sh —— 断言：用例只按 data-testid 定位元素
#
# 扫描范围：platform/e2e/tests/ 与 platform/e2e/explore/（用例代码目录）。
#
# 禁止出现的定位方式：XPath、语义定位器（按文案/角色/标签等）、
#                      CSS 选择器（locator() 传字符串、page.$ / page.$$）、DOM 原生选择器。
# 唯一允许的定位入口：getByTestId()。
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCOPE=("$E2E_DIR/tests" "$E2E_DIR/explore")

PATTERNS=(
  'xpath'
  'getBy(Text|Role|Label|Placeholder|Title|AltText)'
  'locator[[:space:]]*\('
  '\$\$?[[:space:]]*\('
  'querySelector'
  'getElementById'
)

total=0
echo "[契约] data-testid 唯一定位断言"
echo "  扫描范围：tests/、explore/"

for pattern in "${PATTERNS[@]}"; do
  hits="$(grep -rInE "$pattern" "${SCOPE[@]}" --exclude-dir=node_modules -I 2>/dev/null)"
  count="$(printf '%s' "$hits" | grep -c . || true)"
  echo "  模式 ${pattern} 命中 ${count} 处"
  if [ "$count" -ne 0 ]; then
    printf '%s\n' "$hits"
  fi
  total=$((total + count))
done

echo "  合计命中：${total}"

if [ "$total" -ne 0 ]; then
  echo "判定：不通过 —— 用例只允许用 getByTestId() 定位元素"
  exit 1
fi

echo "判定：通过 —— 全部用例只用 data-testid 定位，匹配数为 0"
