#!/usr/bin/env bash
# install-deps.sh —— 安装 node 依赖
#
# 网络慢时可以走国内镜像源：
#   E2E_NPM_REGISTRY=https://registry.npmmirror.com bash tools/install-deps.sh
# 等价于 npm_config_registry 环境变量。
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$E2E_DIR"

if [ -n "${E2E_NPM_REGISTRY:-}" ]; then
  export npm_config_registry="$E2E_NPM_REGISTRY"
  echo "[install] 使用镜像源：${E2E_NPM_REGISTRY}"
fi

# 包缓存默认会落在工作目录里的 .pnpm-store/，会把工作目录弄脏；
# 改到容器内的家目录，缓存不跟着代码目录走。
STORE_DIR="${E2E_PNPM_STORE_DIR:-${HOME:-/root}/.local/share/pnpm/store}"
echo "[install] 包缓存目录：${STORE_DIR}"

pnpm install --store-dir "$STORE_DIR" "$@"

echo "[install] 依赖安装完成"
pnpm exec playwright --version
