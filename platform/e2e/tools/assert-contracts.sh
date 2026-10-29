#!/usr/bin/env bash
# assert-contracts.sh —— 跑完所有契约断言
#
# 1) 回环地址连接串断言：基建目录里不得出现指向本机自身的连接串；
# 2) data-testid 唯一定位断言：用例代码里不得出现 CSS / XPath 定位。
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

failed=0
bash "$E2E_DIR/tools/assert-no-loopback.sh" || failed=1
echo
bash "$E2E_DIR/tools/assert-testid-only.sh" || failed=1
echo

if [ "$failed" -ne 0 ]; then
  echo "[契约] 判定：不通过"
  exit 1
fi

echo "[契约] 判定：通过"
