#!/usr/bin/env bash
# 02-run-containers.sh —— 在免 root 守护进程下准备探针容器与探针网络
# 幂等：先清掉同名探针容器再重建，镜像已存在则跳过拉取。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

log() { echo "[02] $*"; }

mkdir -p "$STATE_DIR"
UID_NUM="$(probe_uid)"
RUNTIME_DIR="/run/user/${UID_NUM}"
SHARE_DIR="${PROBE_HOME}/share"

# ---------------------------------------------------------------- 镜像
ensure_image() {
  local image="$1" tar
  if probe_exec docker image inspect "$image" >/dev/null 2>&1; then
    log "镜像 $image 已存在，跳过拉取"
    return 0
  fi
  log "由免 root 守护进程直拉镜像 $image"
  if probe_exec docker pull "$image"; then
    return 0
  fi
  log "直拉失败，改用宿主 root 守护进程拉取后离线注入"
  tar="$STATE_DIR/$(echo "$image" | tr '/:' '__').tar"
  if ! sudo docker image inspect "$image" >/dev/null 2>&1; then
    if ! sudo docker pull "$image"; then
      log "宿主 root 守护进程拉取 $image 也失败"
      return 1
    fi
  fi
  if ! sudo docker save -o "$tar" "$image"; then
    log "导出镜像 $image 失败"
    return 1
  fi
  sudo chown "$PROBE_USER" "$tar"; sudo chmod 0644 "$tar"
  if ! probe_exec docker load -i "$tar"; then
    log "离线注入镜像 $image 失败"
    rm -f "$tar"
    return 1
  fi
  rm -f "$tar"
  log "镜像 $image 已离线注入"
  return 0
}

ensure_image "$IMG_BUSYBOX"

# CLI 镜像优先取与宿主守护进程同版本的标签；取不到时退回 docker:cli
if ! ensure_image "$IMG_CLI" && [ "$IMG_CLI" != "$IMG_CLI_FALLBACK" ]; then
  log "版本锁定镜像 $IMG_CLI 不可用，退回 $IMG_CLI_FALLBACK（client/server 版本可能不一致）"
  ensure_image "$IMG_CLI_FALLBACK"
fi

# ---------------------------------------------------------------- 基线
# 先删掉上一轮同名探针容器，保证基线里不含探针自己的容器
for c in "$C_MAIN" "$C_PEER" "$C_CLI"; do
  probe_exec docker rm -f "$c" >/dev/null 2>&1 || true
done
probe_exec docker ps -a --format '{{.ID}}\t{{.Names}}' | sort > "$STATE_DIR/baseline-containers.txt"
log "基线容器数（不含探针容器）：$(wc -l < "$STATE_DIR/baseline-containers.txt")"

# 宿主监听端口基线
sudo ss -ltnH | awk '{print $4}' | sort > "$STATE_DIR/ss-before.txt"
log "宿主监听端口基线行数：$(wc -l < "$STATE_DIR/ss-before.txt")"

# ---------------------------------------------------------------- 网络
if probe_exec docker network inspect "$PROBE_NET" >/dev/null 2>&1; then
  log "网络 $PROBE_NET 已存在，复用"
else
  probe_exec docker network create "$PROBE_NET" >/dev/null
  log "已创建网络 $PROBE_NET"
fi

# ---------------------------------------------------------------- 共享目录（用于验证 UID 映射）
sudo install -d -o "$PROBE_USER" -g "$PROBE_USER" -m 0777 "$SHARE_DIR"

# ---------------------------------------------------------------- 容器
log "启动服务端容器 $C_PEER（busybox httpd 监听 $PEER_PORT）"
probe_exec docker run -d --name "$C_PEER" --network "$PROBE_NET" \
  "$IMG_BUSYBOX" sh -c "mkdir -p /www && echo '<h1>probe-peer ok</h1>' > /www/index.html && httpd -f -p $PEER_PORT -h /www" >/dev/null

log "启动客户端容器 $C_MAIN（busybox）"
probe_exec docker run -d --name "$C_MAIN" --network "$PROBE_NET" \
  -v "$SHARE_DIR:/share" \
  "$IMG_BUSYBOX" sh -c 'while true; do sleep 3600; done' >/dev/null

log "启动套接字验证容器 $C_CLI（docker:cli，挂载宿主套接字）"
probe_exec docker run -d --name "$C_CLI" --network "$PROBE_NET" \
  -v "$RUNTIME_DIR/docker.sock:/var/run/docker.sock" \
  "$IMG_CLI" sh -c 'while true; do sleep 3600; done' >/dev/null

# ---------------------------------------------------------------- 状态
echo
probe_exec docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
echo
probe_exec docker network inspect "$PROBE_NET" --format '网络 {{.Name}} 子网 {{range .IPAM.Config}}{{.Subnet}}{{end}}'
