#!/usr/bin/env bash
# assert-testid-only.sh —— 断言：用例只按 data-testid 定位元素
#
# 扫描范围：platform/e2e/tests/、platform/e2e/explore/、platform/e2e/helpers/
#           （用例代码目录 + 用例用到的辅助代码）。
#
# 禁止出现的定位方式：XPath、语义定位器（按文案/角色/标签等）、
#                      CSS 选择器（locator() 传字符串、page.$ / page.$$）、DOM 原生选择器。
# 唯一允许的定位入口：getByTestId()。
#
# 第三方页面豁免：
#   平台约定针对的是「被测应用自己的页面」。第三方页面（Logto 登录页）我们控制不了
#   它的 DOM，没法加 data-testid，它的定位集中在一个文件里，并在下面公示。
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCOPE=("$E2E_DIR/tests" "$E2E_DIR/explore" "$E2E_DIR/helpers")

# 允许使用非 data-testid 定位的文件（相对 e2e 根目录）。
THIRD_PARTY_ALLOWLIST=(
  "helpers/logto-signin.ts"
)

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
for file in "${THIRD_PARTY_ALLOWLIST[@]}"; do
  EXCLUDE_ARGS+=(--exclude="$(basename "$file")")
done

total=0
echo "[契约] data-testid 唯一定位断言"
echo "  扫描范围：tests/、explore/、helpers/"
echo "  第三方页面豁免：${THIRD_PARTY_ALLOWLIST[*]}（Logto 登录页，第三方 DOM，无法加 data-testid）"

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
