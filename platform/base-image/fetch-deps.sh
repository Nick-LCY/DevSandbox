#!/usr/bin/env bash
#
# 拉取并重新生成依赖镜像离线包（更新离线包时执行）
# 依赖命令：bash + docker（宿主 root 守护进程）。
#
# 规则：
#   1) 镜像引用固定在 deps/images/images.list，改版本 = 改清单 + 重跑本脚本；
#   2) 拉取失败直接报错退出，绝不用其它镜像顶替（离线包必须与清单一致）；
#   3) 生成的 tar 与 SHA256SUMS 一起更新。
#
# 用法：./fetch-deps.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPS_DIR="$SCRIPT_DIR/deps/images"
LIST_FILE="$DEPS_DIR/images.list"

log() { echo "[fetch-deps] $*"; }

[ -f "$LIST_FILE" ] || { echo "清单缺失：$LIST_FILE" >&2; exit 1; }

while read -r ref file || [ -n "${ref:-}" ]; do
  [ -n "${ref:-}" ] || continue
  case "$ref" in \#*) continue ;; esac
  [ -n "${file:-}" ] || { echo "清单行缺少文件名：$ref" >&2; exit 1; }

  log "拉取 $ref"
  docker pull "$ref" >/dev/null

  log "导出 $file"
  rm -f "$DEPS_DIR/$file"
  docker save -o "$DEPS_DIR/$file" "$ref"
done <"$LIST_FILE"

log "重算校验和"
( cd "$DEPS_DIR" && sha256sum ./*.tar >SHA256SUMS )

log "完成，当前离线包："
ls -la "$DEPS_DIR"/*.tar
