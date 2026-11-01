#!/usr/bin/env bash
# start-services.sh —— 在沙箱网内拉起依赖容器
#
# 拉起两个容器（都在沙箱网桥网络上，按容器名互访）：
#   postgres —— 依赖数据库，容器名 postgres
#   app      —— 最小静态页，容器名 app，端口 8000
#
# 环境变量：
#   E2E_NETWORK        沙箱网桥网络名（不给就自动从沙箱容器上读）
#   E2E_PG_CONTAINER   postgres 容器名（默认 postgres）
#   E2E_PG_IMAGE       postgres 镜像（默认 postgres:16.15-alpine3.24）
#   E2E_PG_PASSWORD    postgres 密码（默认 postgres）
#   E2E_APP_CONTAINER  应用容器名（默认 app）
#   E2E_APP_IMAGE      应用容器镜像（默认 python:3.12-alpine，docker 直接拉取）
#   E2E_APP_PORT       应用端口（默认 8000）
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PG_CONTAINER="${E2E_PG_CONTAINER:-postgres}"
PG_IMAGE="${E2E_PG_IMAGE:-postgres:16.15-alpine3.24}"
PG_PASSWORD="${E2E_PG_PASSWORD:-postgres}"
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

# ---------------------------------------------------------------- postgres
log "拉起 postgres 容器 ${PG_CONTAINER}（镜像 ${PG_IMAGE}）"
docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
docker run -d \
  --name "$PG_CONTAINER" \
  --network "$NETWORK" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -e POSTGRES_DB=postgres \
  "$PG_IMAGE" >/dev/null

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
wait_for_postgres() {
  local deadline=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if docker exec "$PG_CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
      log "postgres 已就绪"
      return 0
    fi
    sleep 1
  done
  echo "postgres 容器 ${PG_CONTAINER} 未在 90 秒内就绪" >&2
  return 1
}

wait_for_app() {
  local deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if node -e "fetch('http://${APP_CONTAINER}:${APP_PORT}/').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      log "应用容器 ${APP_CONTAINER} 已就绪：http://${APP_CONTAINER}:${APP_PORT}"
      return 0
    fi
    sleep 1
  done
  echo "应用容器 ${APP_CONTAINER} 未在 60 秒内就绪" >&2
  return 1
}

wait_for_postgres
wait_for_app

log "依赖容器就绪：${PG_CONTAINER}、${APP_CONTAINER}（同一网络 ${NETWORK}）"
