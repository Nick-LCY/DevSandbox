#!/usr/bin/env bash
#
# 平台基础镜像入口脚本
# 依赖命令只有两个：bash 与 docker。
# 不引入任何业务运行时，也不使用任何外部下载或文本处理工具。
#
# 行为约定：
#   1) docker 命令存在：exec 交互式 bash；
#   2) docker 命令不存在：打印一行含「docker client missing」的错误，退出码 127。
#
# 0.2.0 起不再有任何离线包加载逻辑：依赖镜像统一经宿主统一镜像代理缓存拉取
# （沙箱守护进程的 HTTPS_PROXY / SSL_CERT_FILE 由平台注入）。

set -uo pipefail

# ---------------------------------------------------------------- 1) docker 客户端缺失则报错退出
if ! command -v docker >/dev/null 2>&1; then
  echo "docker client missing: 基础镜像内未找到 docker 命令，无法访问宿主守护进程" >&2
  exit 127
fi

# ---------------------------------------------------------------- 2) 交互式 bash
exec bash -i
