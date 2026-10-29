#!/usr/bin/env bash
# run-all.sh —— 两种模式依次跑一遍
#
# 脚本模式退出码即判定结果；探索模式退出码恒 0，不参与判定。
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$E2E_DIR"

echo "=== 脚本模式（判定依据） ==="
pnpm exec playwright test --project=scripted
scripted_code=$?

echo
echo "=== 探索模式（不参与判定） ==="
pnpm exec playwright test --project=explore
explore_code=$?

echo
echo "脚本模式退出码：${scripted_code}"
echo "探索模式退出码：${explore_code}"
echo "判定依据是脚本模式退出码（0 = 通过）"
exit "$scripted_code"
