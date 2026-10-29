#!/usr/bin/env bash
# up.sh —— 按序拉起依赖并做健康门禁
#
# 全部依赖都跑在沙箱网内（与沙箱容器同一网桥网络，按容器名互访）：
#   postgres —— 业务库与端到端用例库
#   minio    —— 对象存储（真实 S3 协议端点）
#   logto    —— 身份认证（OIDC 授权码登录）
# 应用进程跑在沙箱容器内（沙箱就是开发环境），并在该网络上以别名 app 暴露。
#
# 关键约定：
#   1) 挂载进来的代码目录只读使用：源码会复制到容器内的 /opt/sample 再安装依赖，
#      避免把 .venv / node_modules / dist 写进用户的代码目录；
#   2) 浏览器会把 http:// 导航升级成 https://，所以应用与 Logto 都用「双协议前置代理」
#      （同一端口同时接受明文与 TLS，见 scripts/dual-protocol-proxy.mjs）；
#   3) 每一步都有健康门禁，任何一步不通过立即退出。
#
# 环境变量（都有默认值）：
#   SAMPLE_MOUNT_DIR  样例项目在沙箱容器内的挂载点（默认 /workspace/fullstack-sample）
#   WORK_DIR          容器内工作目录（默认 /opt/sample）
#   NETWORK           沙箱网桥网络名（不给就自动从沙箱容器上读）
#   APP_ALIAS         应用在网络上的别名（默认 app）
set -euo pipefail

SAMPLE_MOUNT_DIR="${SAMPLE_MOUNT_DIR:-/workspace/fullstack-sample}"
WORK_DIR="${WORK_DIR:-/opt/sample}"
APP_ALIAS="${APP_ALIAS:-app}"

PG_CONTAINER="${PG_CONTAINER:-postgres}"
PG_IMAGE="${PG_IMAGE:-postgres:16.15-alpine3.24}"
PG_USER="${PG_USER:-postgres}"
PG_PASSWORD="${PG_PASSWORD:-postgres}"
PG_DB="${PG_DB:-postgres}"

MINIO_CONTAINER="${MINIO_CONTAINER:-minio}"
MINIO_IMAGE="${MINIO_IMAGE:-minio/minio:RELEASE.2025-04-22T22-12-26Z}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-sampleaccess}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-samplesecret123}"
MINIO_BUCKET="${MINIO_BUCKET:-sample-records}"

LOGTO_CONTAINER="${LOGTO_CONTAINER:-logto}"
LOGTO_IMAGE="${LOGTO_IMAGE:-ghcr.io/logto-io/logto:1.29.0}"
LOGTO_DB="${LOGTO_DB:-logto}"
LOGTO_USERNAME="${LOGTO_USERNAME:-sampleuser}"
LOGTO_PASSWORD="${LOGTO_PASSWORD:-SamplePass123!}"
LOGTO_EMAIL="${LOGTO_EMAIL:-sample@example.com}"
LOGTO_USER_NAME="${LOGTO_USER_NAME:-示例用户}"
LOGTO_APP_NAME="${LOGTO_APP_NAME:-全栈示例应用}"

APP_PORT="${APP_PORT:-8000}"
APP_INTERNAL_PORT="${APP_INTERNAL_PORT:-8001}"
APP_BASE_URL="${APP_BASE_URL:-https://app:8000}"
LOGTO_ENDPOINT="${LOGTO_ENDPOINT:-http://logto:3001}"
LOGTO_ADMIN_ENDPOINT="${LOGTO_ADMIN_ENDPOINT:-http://logto:3002}"
LOGTO_REDIRECT_URI="${LOGTO_REDIRECT_URI:-${APP_BASE_URL}/auth/callback}"
DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@postgres:5432/sample_app}"
PNPM_STORE_DIR="${PNPM_STORE_DIR:-/opt/sample/pnpm-store}"

STEP=0
STEP_START="$(date +%s)"
UP_START="$(date +%s)"
step() {
  STEP=$((STEP + 1))
  local now elapsed
  now="$(date +%s)"
  elapsed=$((now - STEP_START))
  if [ "$STEP" -gt 1 ]; then
    echo "[up] 上一步耗时 ${elapsed} 秒"
  fi
  STEP_START="$now"
  echo ""
  echo "[up] ===== 第 ${STEP} 步：$* ====="
}
log() { echo "[up] $*"; }
fail() { echo "[up] 失败：$*" >&2; exit 1; }

# ---------------------------------------------------------------- 0. 基础检查
step "基础环境检查"
for cmd in docker uv node pnpm openssl curl; do
  command -v "$cmd" >/dev/null 2>&1 || fail "缺少命令：$cmd"
done
[ -d "$SAMPLE_MOUNT_DIR/backend" ] || fail "挂载目录里没有 backend：$SAMPLE_MOUNT_DIR"
[ -d "$SAMPLE_MOUNT_DIR/frontend" ] || fail "挂载目录里没有 frontend：$SAMPLE_MOUNT_DIR"
log "挂载目录：$SAMPLE_MOUNT_DIR"
log "工作目录：$WORK_DIR"

# ---------------------------------------------------------------- 1. 网络与别名
step "确定沙箱网络并注册应用别名"
sandbox_container="$(docker ps --filter 'label=sandbox.platform/role=sandbox' --format '{{.Names}}' | head -1)"
[ -n "$sandbox_container" ] || fail "找不到沙箱容器（标签 sandbox.platform/role=sandbox）"
if [ -n "${NETWORK:-}" ]; then
  NET="$NETWORK"
else
  NET="$(docker inspect "$sandbox_container" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')"
fi
[ -n "$NET" ] || fail "读不出沙箱网络名"
log "沙箱容器：$sandbox_container"
log "沙箱网络：$NET"

# 应用跑在沙箱容器内，需要在网络上以 app 这个名字被别的容器访问。
# 先清掉可能残留的同名容器，避免 DNS 上出现两个 app 记录。
if docker ps -a --format '{{.Names}}' | grep -qx "$APP_ALIAS"; then
  log "移除残留容器 ${APP_ALIAS}"
  docker rm -f "$APP_ALIAS" >/dev/null 2>&1 || true
fi
current_aliases="$(docker inspect "$sandbox_container" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$v.Aliases}} {{end}}')"
if printf '%s' "$current_aliases" | grep -qw "$APP_ALIAS"; then
  log "别名 ${APP_ALIAS} 已就位"
else
  log "注册别名 ${APP_ALIAS}：断开后带别名重连 ${NET}"
  docker network disconnect "$NET" "$sandbox_container"
  docker network connect --alias "$APP_ALIAS" "$NET" "$sandbox_container"
fi

# ---------------------------------------------------------------- 2. 准备容器内工作目录
step "复制源码到容器内工作目录（不污染挂载目录）"
mkdir -p "$WORK_DIR/backend" "$WORK_DIR/frontend" "$WORK_DIR/scripts" "$WORK_DIR/certs" "$WORK_DIR/logs" "$WORK_DIR/config"
cp -a "$SAMPLE_MOUNT_DIR/backend/." "$WORK_DIR/backend/"
cp -a "$SAMPLE_MOUNT_DIR/frontend/." "$WORK_DIR/frontend/"
cp -a "$SAMPLE_MOUNT_DIR/scripts/." "$WORK_DIR/scripts/"
log "源码已复制到 $WORK_DIR"

# ---------------------------------------------------------------- 3. 安装依赖
step "安装后端依赖（uv sync）与前端依赖（pnpm install）"
(
  cd "$WORK_DIR/backend"
  UV_PROJECT_ENVIRONMENT="$WORK_DIR/backend/.venv" uv sync
) || fail "uv sync 失败"
(
  cd "$WORK_DIR/frontend"
  pnpm install --store-dir "$PNPM_STORE_DIR"
  pnpm run build
) || fail "前端依赖安装或构建失败"
[ -f "$WORK_DIR/frontend/dist/index.html" ] || fail "前端构建产物缺失：$WORK_DIR/frontend/dist/index.html"
log "后端虚拟环境：$WORK_DIR/backend/.venv"
log "前端构建产物：$WORK_DIR/frontend/dist"

# ---------------------------------------------------------------- 4. 自签证书
step "生成双协议前置代理用的自签证书"
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -subj "/CN=${APP_ALIAS}" \
  -addext "subjectAltName=DNS:${APP_ALIAS},DNS:logto,DNS:localhost,IP:127.0.0.1" \
  -keyout "$WORK_DIR/certs/key.pem" -out "$WORK_DIR/certs/cert.pem" >/dev/null 2>&1 \
  || fail "生成自签证书失败"
log "证书：$WORK_DIR/certs/cert.pem"

# ---------------------------------------------------------------- 5. postgres
step "拉起 postgres 并做健康门禁"
docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$PG_CONTAINER" --network "$NET" \
  -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB="$PG_DB" \
  "$PG_IMAGE" >/dev/null || fail "postgres 容器启动失败"
for _ in $(seq 1 90); do
  if docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1 \
  || fail "postgres 90 秒内未就绪"
log "postgres 已就绪：${PG_CONTAINER}:5432"

# 应用自己的业务库（默认库）：建库 + 执行示例项目自带的迁移。
APP_DB_NAME="${APP_DB_NAME:-sample_app}"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -t -A -c \
  "SELECT 1 FROM pg_database WHERE datname='${APP_DB_NAME}';" | grep -q 1 \
  || docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "CREATE DATABASE ${APP_DB_NAME};" >/dev/null
for sql_file in "$WORK_DIR"/backend/migrations/*.sql; do
  [ -f "$sql_file" ] || continue
  docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$APP_DB_NAME" \
    <"$sql_file" >/dev/null || fail "执行迁移失败：$sql_file"
  log "已执行迁移：$(basename "$sql_file")"
done

# ---------------------------------------------------------------- 6. minio
step "拉起 minio 并做健康门禁"
docker rm -f "$MINIO_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$MINIO_CONTAINER" --network "$NET" \
  -e MINIO_ROOT_USER="$MINIO_ROOT_USER" -e MINIO_ROOT_PASSWORD="$MINIO_ROOT_PASSWORD" \
  "$MINIO_IMAGE" server /data --console-address ":9001" >/dev/null || fail "minio 容器启动失败"
for _ in $(seq 1 90); do
  if curl -sf --max-time 3 "http://${MINIO_CONTAINER}:9000/minio/health/live" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -sf --max-time 3 "http://${MINIO_CONTAINER}:9000/minio/health/live" >/dev/null 2>&1 \
  || fail "minio 90 秒内未就绪"
log "minio 已就绪：${MINIO_CONTAINER}:9000"

# ---------------------------------------------------------------- 7. logto
step "初始化 logto 数据库并拉起 logto 容器"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -t -A -c \
  "SELECT 1 FROM pg_database WHERE datname='${LOGTO_DB}';" | grep -q 1 \
  || docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "CREATE DATABASE ${LOGTO_DB};" >/dev/null

LOGTO_DB_URL="postgres://${PG_USER}:${PG_PASSWORD}@${PG_CONTAINER}:5432/${LOGTO_DB}"
log "执行 logto db seed（建表 + 种子数据）与 alteration deploy"
docker run --rm --network "$NET" --entrypoint "" -e DB_URL="$LOGTO_DB_URL" "$LOGTO_IMAGE" \
  sh -c 'cd /etc/logto && npm run cli -- db seed && npm run cli -- db alteration deploy' \
  >"$WORK_DIR/logs/logto-seed.log" 2>&1 || fail "logto 数据库初始化失败（详见 $WORK_DIR/logs/logto-seed.log）"
log "logto 数据库已就绪"

docker rm -f "$LOGTO_CONTAINER" >/dev/null 2>&1 || true
# Logto 自身监听 3003/3004（默认租户 / 管理租户），
# 前置双协议代理对外占用 3001/3002，浏览器与机器客户端都走这两个端口。
docker create --name "$LOGTO_CONTAINER" --network "$NET" --entrypoint "" \
  -e DB_URL="$LOGTO_DB_URL" \
  -e ENDPOINT="${LOGTO_ENDPOINT}" \
  -e ADMIN_ENDPOINT="${LOGTO_ADMIN_ENDPOINT}" \
  -e PORT=3003 -e ADMIN_PORT=3004 \
  "$LOGTO_IMAGE" \
  sh -c 'cd /etc/logto && npm run start & exec node /tmp/dual-protocol-proxy.mjs --cert /tmp/proxy-cert.pem --key /tmp/proxy-key.pem --map 3001:127.0.0.1:3003 --map 3002:127.0.0.1:3004' \
  >/dev/null || fail "logto 容器创建失败"
# docker cp 不会创建缺失的父目录，所以落到镜像里一定存在的 /tmp 下。
docker cp "$WORK_DIR/scripts/dual-protocol-proxy.mjs" "${LOGTO_CONTAINER}:/tmp/dual-protocol-proxy.mjs" || fail "拷贝代理脚本失败"
docker cp "$WORK_DIR/certs/cert.pem" "${LOGTO_CONTAINER}:/tmp/proxy-cert.pem" || fail "拷贝证书失败"
docker cp "$WORK_DIR/certs/key.pem" "${LOGTO_CONTAINER}:/tmp/proxy-key.pem" || fail "拷贝私钥失败"
docker start "$LOGTO_CONTAINER" >/dev/null || fail "logto 容器启动失败"

for _ in $(seq 1 120); do
  if curl -sf --max-time 3 "${LOGTO_ENDPOINT}/oidc/.well-known/openid-configuration" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -sf --max-time 3 "${LOGTO_ENDPOINT}/oidc/.well-known/openid-configuration" >/dev/null 2>&1 \
  || fail "logto 120 秒内未就绪（详见 docker logs $LOGTO_CONTAINER）"
log "logto 已就绪：${LOGTO_ENDPOINT}（管理租户 ${LOGTO_ADMIN_ENDPOINT}）"

# ---------------------------------------------------------------- 8. 供应 Logto
step "供应 Logto：预置授权码应用与测试用户"
LOGTO_OUTPUT="$WORK_DIR/config/logto-provision.json" \
PG_CONTAINER="$PG_CONTAINER" PG_USER="$PG_USER" PG_DB="$LOGTO_DB" \
LOGTO_ADMIN_ENDPOINT="$LOGTO_ADMIN_ENDPOINT" LOGTO_ENDPOINT="$LOGTO_ENDPOINT" \
LOGTO_APP_NAME="$LOGTO_APP_NAME" LOGTO_REDIRECT_URI="$LOGTO_REDIRECT_URI" \
LOGTO_POST_LOGOUT_URI="${APP_BASE_URL}/" \
LOGTO_USERNAME="$LOGTO_USERNAME" LOGTO_PASSWORD="$LOGTO_PASSWORD" \
LOGTO_EMAIL="$LOGTO_EMAIL" LOGTO_USER_NAME="$LOGTO_USER_NAME" \
  node "$WORK_DIR/scripts/provision-logto.mjs" || fail "Logto 供应失败"
log "应用与用户已就绪：用户 ${LOGTO_USERNAME} / 口令 ${LOGTO_PASSWORD}"

# ---------------------------------------------------------------- 9. MinIO 桶
step "创建 MinIO 桶"
(
  cd "$WORK_DIR/backend"
  MINIO_ENDPOINT="${MINIO_CONTAINER}:9000" \
  MINIO_ACCESS_KEY="$MINIO_ROOT_USER" MINIO_SECRET_KEY="$MINIO_ROOT_PASSWORD" \
  MINIO_BUCKET="$MINIO_BUCKET" MINIO_SECURE=false \
  UV_PROJECT_ENVIRONMENT="$WORK_DIR/backend/.venv" \
    uv run python -c 'from app.storage import ensure_bucket; print("[up] 桶已就绪：", ensure_bucket())'
) || fail "创建 MinIO 桶失败"

# ---------------------------------------------------------------- 10. 启动应用
step "启动应用进程（uvicorn + 双协议前置代理）"
pkill -f "uvicorn app.main:app" >/dev/null 2>&1 || true
pkill -f "dual-protocol-proxy.mjs --cert $WORK_DIR/certs" >/dev/null 2>&1 || true
sleep 1

LOGTO_CLIENT_ID="$(node -e 'const d=require(process.argv[1]);process.stdout.write(d.clientId)' "$WORK_DIR/config/logto-provision.json")"
LOGTO_CLIENT_SECRET="$(node -e 'const d=require(process.argv[1]);process.stdout.write(d.clientSecret)' "$WORK_DIR/config/logto-provision.json")"

cat >"$WORK_DIR/config/app.env" <<EOF
DATABASE_URL=${DATABASE_URL}
SAMPLE_DB_HEADER_ENABLED=1
MINIO_ENDPOINT=${MINIO_CONTAINER}:9000
MINIO_ACCESS_KEY=${MINIO_ROOT_USER}
MINIO_SECRET_KEY=${MINIO_ROOT_PASSWORD}
MINIO_BUCKET=${MINIO_BUCKET}
MINIO_SECURE=false
LOGTO_ENDPOINT=${LOGTO_ENDPOINT}
LOGTO_CLIENT_ID=${LOGTO_CLIENT_ID}
LOGTO_CLIENT_SECRET=${LOGTO_CLIENT_SECRET}
APP_BASE_URL=${APP_BASE_URL}
LOGTO_REDIRECT_URI=${LOGTO_REDIRECT_URI}
SESSION_SECRET=${SESSION_SECRET:-sample-session-secret-2026}
FRONTEND_DIST=${WORK_DIR}/frontend/dist
EOF

(
  cd "$WORK_DIR/backend"
  set -a
  # shellcheck disable=SC1091
  . "$WORK_DIR/config/app.env"
  set +a
  nohup uv run uvicorn app.main:app --host 127.0.0.1 --port "$APP_INTERNAL_PORT" \
    >"$WORK_DIR/logs/backend.log" 2>&1 &
  echo $! >"$WORK_DIR/logs/backend.pid"
)
sleep 2
nohup node "$WORK_DIR/scripts/dual-protocol-proxy.mjs" \
  --cert "$WORK_DIR/certs/cert.pem" --key "$WORK_DIR/certs/key.pem" \
  --map "${APP_PORT}:127.0.0.1:${APP_INTERNAL_PORT}" \
  >"$WORK_DIR/logs/proxy.log" 2>&1 &
echo $! >"$WORK_DIR/logs/proxy.pid"

# ---------------------------------------------------------------- 11. 应用健康门禁
step "应用健康门禁"
for _ in $(seq 1 90); do
  if curl -sf --max-time 3 "http://${APP_ALIAS}:${APP_PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -sf --max-time 3 "http://${APP_ALIAS}:${APP_PORT}/healthz" >/dev/null 2>&1 \
  || fail "应用 90 秒内未就绪（详见 $WORK_DIR/logs/backend.log）"
curl -sf --max-time 3 "http://${APP_ALIAS}:${APP_PORT}/" | grep -q 'data-testid="page-home-title"' \
  || fail "应用首页没有 data-testid=\"page-home-title\""
curl -sfk --max-time 3 "https://${APP_ALIAS}:${APP_PORT}/healthz" >/dev/null 2>&1 \
  || fail "应用的 TLS 分支不通"
log "应用已就绪：http://${APP_ALIAS}:${APP_PORT}（明文与 TLS 同时可用）"

echo ""
echo "[up] ===== 全部就绪（总耗时 $(( $(date +%s) - UP_START )) 秒） ====="
cat <<EOF
  应用      http://${APP_ALIAS}:${APP_PORT}   （浏览器侧会升级到 https，同端口 TLS 也通）
  postgres  postgres://postgres:postgres@${PG_CONTAINER}:5432/${PG_DB}
  minio     http://${MINIO_CONTAINER}:9000    （S3 协议，桶 ${MINIO_BUCKET}）
  logto     ${LOGTO_ENDPOINT}                （管理租户 ${LOGTO_ADMIN_ENDPOINT}）
  测试用户  ${LOGTO_USERNAME} / ${LOGTO_PASSWORD}
  应用配置  ${WORK_DIR}/config/app.env
  运行日志  ${WORK_DIR}/logs/
EOF
