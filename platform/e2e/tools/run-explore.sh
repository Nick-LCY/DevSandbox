#!/usr/bin/env bash
# run-explore.sh —— 探索模式入口
#
# 探索会话不参与判定：即使 playwright 自身报错，本脚本也统一返回 0。
# 产物（截图与 trace）照常落在 artifacts/ 下。
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$E2E_DIR"

pnpm exec playwright test --project=explore "$@"
code=$?

echo "[explore] playwright 原始退出码 ${code}；探索模式不参与判定，统一返回 0"
exit 0
