#!/usr/bin/env bash
# 探针公共常量与辅助函数（被 00~04 各脚本 source，不单独执行）
# shellcheck disable=SC2034

PROBE_USER="${PROBE_USER:-sandboxprobe}"
PROBE_HOME="${PROBE_HOME:-/home/${PROBE_USER}}"
PROBE_NET="${PROBE_NET:-probe-net}"
STATE_DIR="${PROBE_STATE_DIR:-/tmp/rootless-probe}"

# 探针容器名
C_MAIN="${C_MAIN:-probe-main}"      # 客户端容器：解析对端名字、连对端端口
C_PEER="${C_PEER:-probe-peer}"      # 服务端容器：busybox httpd 监听 8080
C_CLI="${C_CLI:-probe-client}"      # 套接字挂载验证容器：docker:cli

# 镜像
IMG_BUSYBOX="${IMG_BUSYBOX:-busybox:latest}"

# 套接字验证用的 CLI 镜像默认与宿主守护进程同版本，保证 client/server 版本一致
detect_cli_image() {
  local ver=""
  ver="$(sudo docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
  [ -n "$ver" ] || ver="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
  if [ -n "$ver" ]; then echo "docker:${ver}-cli"; else echo "docker:cli"; fi
}
IMG_CLI="${IMG_DOCKER_CLI:-$(detect_cli_image)}"
IMG_CLI_FALLBACK="docker:cli"

# 端口
PEER_PORT="${PEER_PORT:-8080}"

# 判定结果累计
CHECK_TOTAL=0
CHECK_FAILED=0

probe_uid() {
  id -u "$PROBE_USER" 2>/dev/null || true
}

# 以探针用户身份执行命令，补齐免 root Docker 需要的环境变量
probe_exec() {
  local uid; uid="$(probe_uid)"
  [ -n "$uid" ] || { echo "探针用户 $PROBE_USER 不存在" >&2; return 1; }
  sudo -u "$PROBE_USER" env \
    HOME="$PROBE_HOME" \
    USER="$PROBE_USER" \
    LOGNAME="$PROBE_USER" \
    XDG_RUNTIME_DIR="/run/user/$uid" \
    DOCKER_HOST="unix:///run/user/$uid/docker.sock" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$@"
}

# 记录一条判定结果
check() {
  # check <名称> <0=通过/1=失败> <说明>
  local name="$1" rc="$2" note="${3:-}"
  CHECK_TOTAL=$((CHECK_TOTAL + 1))
  if [ "$rc" -eq 0 ]; then
    printf '  [通过] %s%s\n' "$name" "${note:+ — $note}"
  else
    CHECK_FAILED=$((CHECK_FAILED + 1))
    printf '  [不通过] %s%s\n' "$name" "${note:+ — $note}"
  fi
}

check_summary() {
  echo
  echo "判定汇总：共 ${CHECK_TOTAL} 项，不通过 ${CHECK_FAILED} 项"
  [ "$CHECK_FAILED" -eq 0 ]
}
