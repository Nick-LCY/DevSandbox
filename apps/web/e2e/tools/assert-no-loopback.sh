#!/usr/bin/env bash
# assert-no-loopback.sh —— 断言：基建目录里不存在指向本机回环地址的连接串
#
# 扫描范围：apps/web/e2e/ 全目录，排除 node_modules/、artifacts/、.git/、
#           .pnpm-store/（pnpm 包缓存，内容来自第三方）以及本脚本自身
#           （脚本里写着匹配用的模式字面量）。
#
# 判定：匹配数必须为 0。
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 匹配本机回环主机名与回环 IP。
PATTERN='localhost|127\.0\.0\.1'

matches="$(grep -rInE "$PATTERN" "$E2E_DIR" \
  --exclude-dir=node_modules \
  --exclude-dir=artifacts \
  --exclude-dir=.git \
  --exclude-dir=.pnpm-store \
  --exclude='assert-no-loopback.sh' \
  -I 2>/dev/null)"

count="$(printf '%s' "$matches" | grep -c . || true)"

echo "[契约] 回环地址连接串断言"
echo "  扫描目录：${E2E_DIR}"
echo "  匹配模式：本机回环主机名、回环 IP"
echo "  匹配数：${count}"

if [ "$count" -ne 0 ]; then
  echo "  命中明细："
  printf '%s\n' "$matches"
  echo "判定：不通过 —— 基建目录里不允许出现指向本机回环地址的连接串"
  exit 1
fi

echo "判定：通过 —— 匹配数为 0，全部连接串走容器名"
