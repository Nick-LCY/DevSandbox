#!/usr/bin/env bash
# run-all.sh —— 顺序执行 00 → 01 → 02 → 03，汇总判定结果
# 用法：
#   ./run-all.sh              # 建用户 → 起守护进程 → 起容器 → 跑判定
#   ./run-all.sh --cleanup    # 跑完判定后自动执行 04 回收
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DO_CLEANUP=0
[ "${1:-}" = "--cleanup" ] && DO_CLEANUP=1

run_step() {
  local name="$1"
  echo
  echo "############################################################"
  echo "# $name"
  echo "############################################################"
  "$SCRIPT_DIR/$name"
}

run_step 00-create-user.sh
run_step 01-start-dockerd.sh
run_step 02-run-containers.sh

echo
echo "############################################################"
echo "# 03-network-check.sh"
echo "############################################################"
set +e
"$SCRIPT_DIR/03-network-check.sh"
CHECK_RC=$?
set -e

if [ "$DO_CLEANUP" -eq 1 ]; then
  run_step 04-cleanup.sh
fi

echo
if [ "$CHECK_RC" -eq 0 ]; then
  echo "全部判定通过。"
else
  echo "存在不通过的判定，见上方输出。"
fi
exit "$CHECK_RC"
