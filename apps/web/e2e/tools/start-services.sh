#!/usr/bin/env bash
# start-services.sh —— 在沙箱网内拉起静态页容器
#
# 拉起一个容器（在沙箱网桥网络上，按容器名互访）：
#   app —— 最小静态页，容器名 app，端口 8000
#
# 环境变量：
#   E2E_NETWORK        沙箱网桥网络名（不给就自动从沙箱容器上读）
#   E2E_APP_CONTAINER  应用容器名（默认 app）
#   E2E_APP_IMAGE      应用容器镜像（默认 python:3.12-alpine，docker 直接拉取）
#   E2E_APP_PORT       应用端口（默认 8000）
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

APP_CONTAINER="${E2E_APP_CONTAINER:-app}"
APP_IMAGE="${E2E_APP_IMAGE:-python:3.12-alpine}"
APP_PORT="${E2E_APP_PORT:-8000}"

log() { echo "[services] $*"; }

# 从沙箱容器上读出网桥网络名
detect_network() {
  if [ -n "${E2E_NETWORK:-}" ]; then
    echo "$E2E_NETWORK"
    return
  fi
  local sandbox_container
  sandbox_container="$(docker ps --filter 'label=sandbox.platform/role=sandbox' --format '{{.Names}}' | head -1)"
  if [ -z "$sandbox_container" ]; then
    echo "找不到沙箱容器（标签 sandbox.platform/role=sandbox），请在沙箱容器内执行本脚本" >&2
    exit 1
  fi
  docker inspect "$sandbox_container" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}'
}

NETWORK="$(detect_network)"
log "沙箱网络：${NETWORK}"

# ---------------------------------------------------------------- app
log "拉起静态页容器 ${APP_CONTAINER}（镜像 ${APP_IMAGE}，端口 ${APP_PORT}）"
docker rm -f "$APP_CONTAINER" >/dev/null 2>&1 || true

# 自签证书先在宿主侧生成：证书要与静态页服务放在同一个目录里
CERT_DIR="$(mktemp -d)"
trap 'rm -rf "$CERT_DIR"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -subj "/CN=${APP_CONTAINER}" \
  -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" >/dev/null 2>&1

# 容器先建后拷文件：静态页服务、页面、自签证书都在就位后才启动服务。
# 镜像自带 python 解释器，容器命令直接跑静态页服务（不做任何包装）。
docker create \
  --name "$APP_CONTAINER" \
  --network "$NETWORK" \
  --entrypoint "" \
  -e APP_PORT="$APP_PORT" \
  "$APP_IMAGE" \
  python3 /srv/www/serve.py >/dev/null

# docker cp 不会创建缺失的父目录：整目录拷（/srv/www 由此创建），再拷两张证书
docker cp "$E2E_DIR/fixtures/app" "${APP_CONTAINER}:/srv/www"
docker cp "$CERT_DIR/key.pem" "${APP_CONTAINER}:/srv/www/key.pem"
docker cp "$CERT_DIR/cert.pem" "${APP_CONTAINER}:/srv/www/cert.pem"

docker start "$APP_CONTAINER" >/dev/null

# ---------------------------------------------------------------- 就绪等待
# 探测地址：优先用容器在沙箱网内的地址（容器内外都探得到），
# 拿不到地址时才退回容器名（只有容器内能解析）。
app_probe_addr() {
  local ip
  ip="$(docker inspect "$APP_CONTAINER" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null | awk '{print $1}')"
  if [ -n "$ip" ]; then
    echo "$ip"
  else
    echo "$APP_CONTAINER"
  fi
}

wait_for_app() {
  local deadline=$((SECONDS + 60))
  local addr
  addr="$(app_probe_addr)"
  while [ "$SECONDS" -lt "$deadline" ]; do
    if node -e "fetch('http://${addr}:${APP_PORT}/').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      log "静态页容器 ${APP_CONTAINER} 已就绪：http://${APP_CONTAINER}:${APP_PORT}"
      return 0
    fi
    sleep 1
  done
  echo "静态页容器 ${APP_CONTAINER} 未在 60 秒内就绪" >&2
  return 1
}

wait_for_app

log "静态页容器就绪：${APP_CONTAINER}（网络 ${NETWORK}）"
