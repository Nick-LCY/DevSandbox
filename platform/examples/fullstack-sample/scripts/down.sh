#!/usr/bin/env bash
# down.sh —— 停掉示例项目拉起来的进程与依赖容器
#
# 只回收示例项目自己创建的东西：应用进程、前置代理进程、依赖容器。
# 沙箱本身（沙箱容器、网络、用户）由 sandboxctl 负责回收。
set -uo pipefail

SAMPLE_MOUNT_DIR="${SAMPLE_MOUNT_DIR:-/workspace/fullstack-sample}"
WORK_DIR="${WORK_DIR:-/opt/sample}"

log() { echo "[down] $*"; }

log "停止应用进程"
pkill -f "uvicorn app.main:app" >/dev/null 2>&1 || true
pkill -f "dual-protocol-proxy.mjs --cert $WORK_DIR/certs" >/dev/null 2>&1 || true

log "移除依赖容器"
for container in postgres minio logto; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$container"; then
    docker rm -f "$container" >/dev/null 2>&1 && log "已移除容器 $container"
  fi
done

log "完成（沙箱自身的资源由 sandboxctl delete 回收）"
