#!/usr/bin/env bash
#
# 默认全栈沙箱镜像的沙箱平台联调判定脚本
#
# 判定范围（用平台自己的 sandboxctl 真实创建沙箱）：
#   1) 用新镜像创建沙箱，容器内交互式 bash 的工具链全部有版本输出
#   2) 容器内 docker 客户端与服务端版本一致（29.6.2）
#   3) 入口脚本自动加载三个依赖离线包：首启 loaded、二启 skip（幂等）
#   4) 沙箱守护进程里能看到 postgres / minio / logto 三个镜像
#   5) 冷启动到 bash 可用的耗时、离线包加载耗时
#   6) sandboxctl 零参数创建是否用上平台默认镜像
#
# 用法：
#   IMAGE=sandbox-platform/sandbox-default:0.1.0 ./verify-sandbox.sh
#
# 注意：脚本会创建并回收真实沙箱（涉及系统用户、子 UID 段、用户级守护进程）。

set -uo pipefail

PLATFORM_DIR="${PLATFORM_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
IMAGE="${IMAGE:-sandbox-platform/sandbox-default:0.1.0}"
SANDBOX_NAME="${SANDBOX_NAME:-sbximg-check}"
DEFAULT_NAME="${DEFAULT_NAME:-sbximg-default}"
KEEP="${KEEP:-0}"

PASSED=0
FAILED=0

ok() {
  printf '  [通过] %s\n' "$1"
  PASSED=$((PASSED + 1))
}

bad() {
  printf '  [失败] %s\n' "$1"
  FAILED=$((FAILED + 1))
}

section() {
  printf '\n== %s ==\n' "$1"
}

sandboxctl() {
  (cd "$PLATFORM_DIR" && uv run python cli/sandboxctl.py "$@")
}

sb_docker() {
  # sb_docker <沙箱名> <docker 参数...>：以沙箱用户身份操作该沙箱的免 root 守护进程
  local name="$1"
  shift
  local user="sandbox-$name"
  local uid
  uid="$(id -u "$user")"
  sudo -u "$user" env \
    XDG_RUNTIME_DIR="/run/user/$uid" \
    DOCKER_HOST="unix:///run/user/$uid/docker.sock" \
    docker "$@"
}

sb_exec() {
  # sb_exec <沙箱名> <容器内命令...>（容器名固定为 sandbox-<沙箱名>）
  local name="$1"
  shift
  sb_docker "$name" exec "sandbox-$name" "$@"
}

cleanup() {
  sandboxctl delete "$SANDBOX_NAME" --yes >/dev/null 2>&1
  sandboxctl delete "$DEFAULT_NAME" --yes >/dev/null 2>&1
}

# 等待容器内离线包加载完成（入口脚本是后台加载，日志是追加写的）
wait_for_deps() {
  local name="$1"
  local timeout="${2:-300}"
  local i
  for i in $(seq 1 $((timeout * 2))); do
    if sb_exec "$name" cat /tmp/load-deps.log 2>/dev/null | grep -q '结束：全部离线包处理完毕'; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# 只取日志里最后一轮（最后一次「开始处理」之后）的内容
last_run_only() {
  awk '/开始处理依赖镜像离线包/ { buf = "" } { buf = buf $0 "\n" } END { printf "%s", buf }'
}

trap 'if [ "$KEEP" != "1" ]; then cleanup; fi' EXIT

# ---------------------------------------------------------------- 0) 准备
section "准备"

sandboxctl delete "$SANDBOX_NAME" --yes >/dev/null 2>&1
sandboxctl delete "$DEFAULT_NAME" --yes >/dev/null 2>&1

CREATE_START="$(date +%s.%N)"
CREATE_OUT="$(sandboxctl create "$SANDBOX_NAME" --image "$IMAGE" 2>&1)"
CREATE_END="$(date +%s.%N)"
if printf '%s' "$CREATE_OUT" | grep -q "创建完成"; then
  ok "沙箱创建成功（$(awk "BEGIN{printf \"%.1f\", $CREATE_END - $CREATE_START}") 秒，含镜像导出注入）"
else
  bad "沙箱创建失败：$CREATE_OUT"
  exit 1
fi
printf '%s\n' "$CREATE_OUT" | sed 's/^/  /'

# ---------------------------------------------------------------- 1) 工具链
section "容器内工具链（交互式 bash）"

TOOL_OUT="$(sb_exec "$SANDBOX_NAME" bash -i -c '
for c in "pi --version" "git --version" "uv --version" "node --version" "pnpm --version" "nvm --version" "npx playwright --version"; do
  out=$(eval "$c" 2>&1 | head -1)
  if [ -n "$out" ]; then printf "%s|OK|%s\n" "$c" "$out"; else printf "%s|FAIL|\n" "$c"; fi
done' 2>/dev/null)"

printf '%s\n' "$TOOL_OUT" | sed 's/^/  /'
while IFS='|' read -r cmd state out; do
  [ -n "$cmd" ] || continue
  if [ "$state" = "OK" ]; then ok "$cmd → $out"; else bad "$cmd 无版本输出"; fi
done <<<"$TOOL_OUT"

# ---------------------------------------------------------------- 2) docker 版本
section "容器内 docker 版本"

DV="$(sb_exec "$SANDBOX_NAME" bash -i -c 'docker version --format "client={{.Client.Version}} server={{.Server.Version}}"' 2>/dev/null | tail -1)"
printf '  %s\n' "$DV"
CLIENT_VER="$(printf '%s' "$DV" | sed -n 's/.*client=\([^ ]*\).*/\1/p')"
SERVER_VER="$(printf '%s' "$DV" | sed -n 's/.*server=\([^ ]*\).*/\1/p')"
if [ -n "$CLIENT_VER" ] && [ "$CLIENT_VER" = "$SERVER_VER" ]; then
  ok "容器内 client=$CLIENT_VER server=$SERVER_VER（一致）"
else
  bad "容器内 docker 版本不一致或缺失：$DV"
fi

# ---------------------------------------------------------------- 3) 离线包加载
section "依赖离线包自动加载"

LOAD_LOG="$(sb_exec "$SANDBOX_NAME" cat /tmp/load-deps.log 2>/dev/null)"
if wait_for_deps "$SANDBOX_NAME" 300; then
  ok "入口脚本后台完成三个离线包加载"
  LOAD_LOG="$(sb_exec "$SANDBOX_NAME" cat /tmp/load-deps.log 2>/dev/null)"
else
  bad "300 秒内离线包未加载完成"
fi
printf '%s\n' "$LOAD_LOG" | sed 's/^/  /'

FIRST_RUN_LOG="$(printf '%s' "$LOAD_LOG" | last_run_only)"
LOADED_COUNT="$(printf '%s' "$FIRST_RUN_LOG" | grep -c '^\[load-deps\] loaded ')"
SKIP_COUNT="$(printf '%s' "$FIRST_RUN_LOG" | grep -c '^\[load-deps\] skip ')"

if [ "$LOADED_COUNT" -eq 3 ]; then
  ok "首次启动加载了 3 个离线包（loaded=$LOADED_COUNT）"
else
  bad "首次启动 loaded 数为 $LOADED_COUNT（期望 3）"
fi

# 加载耗时：容器启动时刻 → 加载日志最后写入时刻
STARTED_AT="$(sb_docker "$SANDBOX_NAME" inspect --format '{{.State.StartedAt}}' "sandbox-$SANDBOX_NAME" 2>/dev/null)"
LOG_MTIME="$(sb_exec "$SANDBOX_NAME" stat -c %Y /tmp/load-deps.log 2>/dev/null | tr -d '[:space:]')"
if [ -n "$STARTED_AT" ] && [ -n "$LOG_MTIME" ]; then
  START_EPOCH="$(date -d "$STARTED_AT" +%s 2>/dev/null)"
  if [ -n "$START_EPOCH" ]; then
    LOAD_SECONDS=$((LOG_MTIME - START_EPOCH))
    printf '  离线包加载耗时：%s 秒\n' "$LOAD_SECONDS"
    LOAD_SECONDS="$LOAD_SECONDS"
  fi
fi

IMAGES="$(sb_docker "$SANDBOX_NAME" images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null)"
printf '  沙箱守护进程镜像列表：\n%s\n' "$(printf '%s' "$IMAGES" | sed 's/^/    /')"
for ref in "postgres:16.15-alpine3.24" "minio/minio:RELEASE.2025-04-22T22-12-26Z" "ghcr.io/logto-io/logto:1.29.0"; do
  if printf '%s' "$IMAGES" | grep -qx "$ref"; then
    ok "沙箱守护进程里有 $ref"
  else
    bad "沙箱守护进程里缺 $ref"
  fi
done

# ---------------------------------------------------------------- 4) 幂等（二启 skip）
section "二次启动幂等"

sb_docker "$SANDBOX_NAME" restart "sandbox-$SANDBOX_NAME" >/dev/null 2>&1
sleep 3
wait_for_deps "$SANDBOX_NAME" 120
RESTART_LOG="$(sb_exec "$SANDBOX_NAME" cat /tmp/load-deps.log 2>/dev/null)"
RESTART_LAST="$(printf '%s' "$RESTART_LOG" | last_run_only)"
RESTART_SKIP="$(printf '%s' "$RESTART_LAST" | grep -c '^\[load-deps\] skip ')"
RESTART_LOADED="$(printf '%s' "$RESTART_LAST" | grep -c '^\[load-deps\] loaded ')"
printf '%s\n' "$RESTART_LAST" | sed 's/^/  /'
if [ "$RESTART_SKIP" -eq 3 ] && [ "$RESTART_LOADED" -eq 0 ]; then
  ok "二次启动 3 个离线包全部 skip，loaded=0（幂等）"
else
  bad "二次启动幂等异常：skip=$RESTART_SKIP loaded=$RESTART_LOADED"
fi

# ---------------------------------------------------------------- 5) 冷启动耗时
section "冷启动到 bash 可用"

NETWORK="$(sb_docker "$SANDBOX_NAME" inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "sandbox-$SANDBOX_NAME" 2>/dev/null)"
SOCKET_SRC="$(sb_docker "$SANDBOX_NAME" inspect --format '{{range .Mounts}}{{if eq .Destination "/var/run/docker.sock"}}{{.Source}}{{end}}{{end}}' "sandbox-$SANDBOX_NAME" 2>/dev/null)"

sb_docker "$SANDBOX_NAME" rm -f "sandbox-$SANDBOX_NAME" >/dev/null 2>&1
COLD_START="$(date +%s.%N)"
sb_docker "$SANDBOX_NAME" run -d -i --name "sandbox-$SANDBOX_NAME" \
  --network "$NETWORK" -v "$SOCKET_SRC:/var/run/docker.sock" "$IMAGE" >/dev/null 2>&1
READY=0
for _ in $(seq 1 300); do
  if sb_docker "$SANDBOX_NAME" exec "sandbox-$SANDBOX_NAME" bash -i -c 'exit 0' >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.1
done
COLD_END="$(date +%s.%N)"
COLD_SECONDS="$(awk "BEGIN{printf \"%.2f\", $COLD_END - $COLD_START}")"
if [ "$READY" -eq 1 ]; then
  ok "容器冷启动到 bash 可用：${COLD_SECONDS} 秒"
else
  bad "容器冷启动 30 秒内未就绪"
fi

# ---------------------------------------------------------------- 6) 零参数默认镜像
section "sandboxctl 零参数创建的默认镜像"

DEFAULT_OUT="$(sandboxctl create "$DEFAULT_NAME" 2>&1)"
if printf '%s' "$DEFAULT_OUT" | grep -q "创建完成"; then
  ok "零参数创建成功"
  printf '%s\n' "$DEFAULT_OUT" | grep -E "沙箱镜像|沙箱容器" | sed 's/^/  /'
  DEFAULT_IMAGE_USED="$(printf '%s' "$DEFAULT_OUT" | sed -n 's/^沙箱镜像：//p')"
  printf '  平台默认镜像引用：%s\n' "$DEFAULT_IMAGE_USED"
  DEFAULT_IMAGES="$(sb_docker "$DEFAULT_NAME" images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null)"
  if printf '%s' "$DEFAULT_IMAGES" | grep -qx 'sandbox-platform/sandbox-default:0.1.0'; then
    ok "零参数创建用上默认镜像 sandbox-platform/sandbox-default:0.1.0"
  else
    bad "零参数创建未用上默认镜像，实际镜像列表：$(printf '%s' "$DEFAULT_IMAGES" | tr '\n' ' ')"
  fi
else
  bad "零参数创建失败：$DEFAULT_OUT"
fi

# ---------------------------------------------------------------- 7) 汇总
section "汇总"
printf '  通过 %s 项，失败 %s 项\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
exit 0
