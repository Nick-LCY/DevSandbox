#!/usr/bin/env bash
#
# 依赖镜像离线包自动加载（幂等）
# 依赖命令只有两个：bash 与 docker。
# 不引入任何业务运行时，也不使用任何外部下载或文本处理工具。
#
# 幂等规则：逐个检查目标镜像是否已存在（docker images），存在则跳过（skip），
# 不存在才执行 docker load（loaded）。重复执行不会重复导入。
#
# 清单文件默认 /opt/deps/images/images.list，每行两个字段：<镜像引用> <离线包文件名>
# 日志示例：
#   [load-deps] skip  postgres:16.15-alpine3.24（已存在，跳过加载）

set -uo pipefail

DEPS_DIR="${DEPS_DIR:-/opt/deps/images}"
LIST_FILE="${LIST_FILE:-$DEPS_DIR/images.list}"

FAILED=0

log() { printf '[load-deps] %s\n' "$*"; }

log "开始处理依赖镜像离线包（目录：$DEPS_DIR）"

# ---------------------------------------------------------------- 前置检查
if ! command -v docker >/dev/null 2>&1; then
  log "错误：docker client missing，无法加载离线包"
  exit 127
fi

if [ ! -f "$LIST_FILE" ]; then
  log "错误：离线包清单缺失（$LIST_FILE）"
  exit 1
fi

# ---------------------------------------------------------------- 加载前镜像列表
log "加载前镜像列表："
if ! docker images --format '  {{.Repository}}:{{.Tag}} ({{.Size}})'; then
  log "  <读取失败：无法连接 docker 守护进程>"
fi

# ---------------------------------------------------------------- 逐个处理
while read -r ref file || [ -n "${ref:-}" ]; do
  [ -n "${ref:-}" ] || continue
  case "$ref" in \#*) continue ;; esac
  [ -n "${file:-}" ] || { log "错误：清单行缺少文件名（$ref）"; FAILED=1; continue; }

  tar_path="$DEPS_DIR/$file"

  # 已存在则跳过（幂等）
  existing="$(docker images -q "$ref" 2>/dev/null | head -n 1)"
  if [ -n "$existing" ]; then
    log "skip  $ref（已存在，跳过加载）"
    continue
  fi

  if [ ! -f "$tar_path" ]; then
    log "error $ref 离线包缺失：$tar_path"
    FAILED=1
    continue
  fi

  log "load  $ref <- $file"
  if docker load -i "$tar_path" >/dev/null 2>&1; then
    log "loaded $ref"
  else
    log "error $ref 加载失败：$file"
    FAILED=1
  fi
done <"$LIST_FILE"

# ---------------------------------------------------------------- 加载后镜像列表
log "加载后镜像列表："
if ! docker images --format '  {{.Repository}}:{{.Tag}} ({{.Size}})'; then
  log "  <读取失败：无法连接 docker 守护进程>"
fi

if [ "$FAILED" -ne 0 ]; then
  log "结束：存在处理失败的条目"
  exit 1
fi

log "结束：全部离线包处理完毕"
