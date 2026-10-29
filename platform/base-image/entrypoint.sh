#!/usr/bin/env bash
#
# 平台基础镜像入口脚本
# 依赖命令只有两个：bash 与 docker。
# 不引入任何业务运行时，也不使用任何外部下载或文本处理工具。
#
# 行为约定：
#   1) docker 命令存在：后台加载依赖镜像离线包（不阻塞），随后 exec 交互式 bash；
#   2) docker 命令不存在：打印一行含「docker client missing」的错误，退出码 127。

set -uo pipefail

DEPS_LOADER="${DEPS_LOADER:-/opt/deps/load-deps.sh}"
DEPS_LOG="${DEPS_LOG:-/tmp/load-deps.log}"

# ---------------------------------------------------------------- 1) docker 客户端缺失则报错退出
if ! command -v docker >/dev/null 2>&1; then
  echo "docker client missing: 基础镜像内未找到 docker 命令，无法访问宿主守护进程" >&2
  exit 127
fi

# ---------------------------------------------------------------- 2) 后台加载依赖镜像离线包
# 日志落 /tmp/load-deps.log；加载失败不影响交互式 shell 启动
if [ -x "$DEPS_LOADER" ]; then
  ( "$DEPS_LOADER" >>"$DEPS_LOG" 2>&1 || true ) &
  disown 2>/dev/null || true
fi

# ---------------------------------------------------------------- 3) 交互式 bash
exec bash -i
