#!/usr/bin/env bash
# assert-testid-only.sh —— 断言：用例只按 data-testid 定位元素
#
# 扫描范围：apps/web/e2e/tests/、apps/web/e2e/helpers/
#           （用例代码目录 + 用例用到的辅助代码）。
#
# 禁止出现的定位方式：XPath、语义定位器（按文案/角色/标签等）、
#                      CSS 选择器（locator() 传字符串、page.$ / page.$$）、DOM 原生选择器。
# 唯一允许的定位入口：getByTestId()。
#
# 第三方页面豁免：
#   平台约定针对的是「被测应用自己的页面」。当前基建只测自己的静态页，
#   没有第三方页面，豁免名单为空；将来接入第三方页面（控制不了它的 DOM）时，
#   把它的定位集中到一个文件并登记进下面的豁免名单，断言脚本每次运行都会公示名单。
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCOPE=("$E2E_DIR/tests" "$E2E_DIR/helpers")

# 允许使用非 data-testid 定位的文件（相对 e2e 根目录）；当前为空。
THIRD_PARTY_ALLOWLIST=()

PATTERNS=(
  'xpath'
  'getBy(Text|Role|Label|Placeholder|Title|AltText)'
  'locator[[:space:]]*\('
  '\$\$?[[:space:]]*\('
  'querySelector'
  'getElementById'
)

# 豁免文件用 --exclude 按文件名排除。
EXCLUDE_ARGS=()
if [ "${#THIRD_PARTY_ALLOWLIST[@]}" -gt 0 ]; then
  for file in "${THIRD_PARTY_ALLOWLIST[@]}"; do
    EXCLUDE_ARGS+=(--exclude="$(basename "$file")")
  done
  allowlist_text="${THIRD_PARTY_ALLOWLIST[*]}"
else
  allowlist_text="无（当前只测自己的静态页）"
fi

total=0
echo "[契约] data-testid 唯一定位断言"
echo "  扫描范围：tests/、helpers/"
echo "  第三方页面豁免：${allowlist_text}"

for pattern in "${PATTERNS[@]}"; do
  hits="$(grep -rInE "$pattern" "${SCOPE[@]}" --exclude-dir=node_modules "${EXCLUDE_ARGS[@]}" -I 2>/dev/null)"
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

echo "判定：通过 —— 被测应用的元素全部只用 data-testid 定位，匹配数为 0"
