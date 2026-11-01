#!/usr/bin/env bash
#
# 基础镜像在「真实免 root 守护进程」下的联调验证
# 复用同目录 rootless/ 的 00（建用户）/ 01（起守护进程）/ 04（回收）三个脚本。
#
# 验证内容：
#   1) 基础镜像可注入免 root 守护进程；
#   2) 入口脚本行为：docker 客户端存在时进入交互式 shell；
#   3) 容器内 docker 客户端版本 == 免 root 守护进程服务端版本；
#   4) 镜像内无离线包痕迹（0.2.0 起废弃离线包机制，依赖镜像统一经镜像代理拉取）。
#
# 用法：
#   ./verify-rootless.sh              # 测完自动回收
#   ./verify-rootless.sh --keep       # 测完保留用户与守护进程（调试用）

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_DIR="$SCRIPT_DIR/rootless"

BASE_IMAGE="${BASE_IMAGE:-sandbox-platform/base:0.3.0}"
CONTAINER_NAME="${CONTAINER_NAME:-base-image-test}"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

# shellcheck source=rootless/common.sh
source "$PROBE_DIR/common.sh"

CHECK_TOTAL=0
CHECK_FAILED=0

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

log() { echo "[base-image] $*"; }

HOST_SERVER_VERSION="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '')"
log "宿主 root 守护进程版本：${HOST_SERVER_VERSION:-<读取失败>}"

# ---------------------------------------------------------------- 0. 起免 root 守护进程
log "执行探针 00（建用户）与 01（起守护进程）"
"$PROBE_DIR/00-create-user.sh" >/dev/null || { echo "00-create-user.sh 失败" >&2; exit 1; }
"$PROBE_DIR/01-start-dockerd.sh" | sed 's/^/  /' || { echo "01-start-dockerd.sh 失败" >&2; exit 1; }

UID_NUM="$(probe_uid)"
RUNTIME_DIR="/run/user/${UID_NUM}"
SOCK="$RUNTIME_DIR/docker.sock"

if ! probe_exec test -S "$SOCK"; then
  echo "免 root 套接字不可用：$SOCK" >&2
  exit 1
fi
log "免 root 套接字就绪：$SOCK"

# ---------------------------------------------------------------- 1. 把基础镜像注入免 root 守护进程
log "注入基础镜像 $BASE_IMAGE 到免 root 守护进程"
if ! sudo docker save "$BASE_IMAGE" | probe_exec docker load >/dev/null; then
  echo "基础镜像注入免 root 守护进程失败" >&2
  exit 1
fi
probe_exec docker image inspect "$BASE_IMAGE" >/dev/null 2>&1 \
  && log "基础镜像已在免 root 守护进程中就绪" \
  || { echo "免 root 守护进程中未找到基础镜像" >&2; exit 1; }

# ---------------------------------------------------------------- 2. 入口脚本行为
log "启动容器（挂载套接字到 /var/run/docker.sock），验证入口脚本进入交互式 shell"
probe_exec docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

# 用 FIFO 给容器保持一个永不结束的 stdin，让入口脚本里的交互式 bash 不立即退出
FIFO="$(mktemp -u /tmp/base-image-stdin.XXXXXX)"
mkfifo "$FIFO"
tail -f /dev/null >"$FIFO" 2>/dev/null &
TAIL_PID=$!
probe_exec docker run -d -i \
  --name "$CONTAINER_NAME" \
  -v "$SOCK:/var/run/docker.sock" \
  "$BASE_IMAGE" <"$FIFO" >/dev/null

sleep 2
if probe_exec docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q true; then
  check "入口脚本进入交互式 bash（容器保持运行）" 0 "容器在跑"
else
  check "入口脚本进入交互式 bash（容器保持运行）" 1 "容器未运行"
fi

# 容器内能通过套接字看到守护进程（说明 docker 客户端与守护进程连通）
INSIDE_PS="$(probe_exec docker exec "$CONTAINER_NAME" docker ps --format '{{.Names}}' 2>&1 || true)"
if echo "$INSIDE_PS" | grep -q "$CONTAINER_NAME"; then
  check "容器内 docker 客户端可访问守护进程" 0 "$CONTAINER_NAME"
else
  check "容器内 docker 客户端可访问守护进程" 1 "实际输出：$(echo "$INSIDE_PS" | tr '\n' ' ')"
fi

# 镜像内无离线包痕迹
DEPS_PROBE="$(probe_exec docker exec "$CONTAINER_NAME" sh -c 'test ! -e /opt/deps && echo clean' 2>&1 || true)"
if echo "$DEPS_PROBE" | grep -q clean; then
  check "镜像内无 /opt/deps 离线包目录" 0 "不存在"
else
  check "镜像内无 /opt/deps 离线包目录" 1 "实际输出：$(echo "$DEPS_PROBE" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------- 3. 客户端 / 服务端版本一致性
VER_OUT="$(probe_exec docker exec "$CONTAINER_NAME" docker version --format "{{.Client.Version}} {{.Server.Version}}" 2>&1)"
CLIENT_VER="$(printf '%s' "$VER_OUT" | awk '{print $1}')"
SERVER_VER="$(printf '%s' "$VER_OUT" | awk '{print $2}')"
log "容器内 client=$CLIENT_VER server=$SERVER_VER"

if [ -n "$CLIENT_VER" ] && [ "$CLIENT_VER" = "$SERVER_VER" ]; then
  check "容器内客户端与服务端版本一致" 0 "$CLIENT_VER"
else
  check "容器内客户端与服务端版本一致" 1 "client=$CLIENT_VER server=$SERVER_VER"
fi

if [ -n "$HOST_SERVER_VERSION" ] && [ "$CLIENT_VER" = "$HOST_SERVER_VERSION" ]; then
  check "客户端版本与宿主守护进程版本一致" 0 "$CLIENT_VER"
else
  check "客户端版本与宿主守护进程版本一致" 1 "client=$CLIENT_VER host=$HOST_SERVER_VERSION"
fi

# ---------------------------------------------------------------- 4. 回收
kill "$TAIL_PID" 2>/dev/null || true
rm -f "$FIFO"

if [ "$KEEP" -eq 0 ]; then
  log "回收容器与免 root 守护进程"
  probe_exec docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  "$PROBE_DIR/04-cleanup.sh" | sed 's/^/  /'
else
  log "按 --keep 保留容器与守护进程（用户 $PROBE_USER）"
fi

echo
echo "判定汇总：共 ${CHECK_TOTAL} 项，不通过 ${CHECK_FAILED} 项"
[ "$CHECK_FAILED" -eq 0 ]
