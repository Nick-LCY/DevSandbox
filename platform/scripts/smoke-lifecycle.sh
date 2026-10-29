#!/usr/bin/env bash
# smoke-lifecycle.sh —— 沙箱生命周期端到端冒烟
#
# 流程：创建（带一个指向 /tmp 的用户挂载）→ 验证容器内 docker ps 只见自己
#       → 关闭 → 启动 → 删除 → 校验平台资源全部回收、外部挂载目录原样保留。
#
# 可重复执行：脚本开头会清理同名残留沙箱，结束时清理临时目录。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SANDBOX_NAME="${SANDBOX_NAME:-smoke-lifecycle}"
MOUNT_CONTAINER_PATH="${MOUNT_CONTAINER_PATH:-/data}"

CHECK_TOTAL=0
CHECK_FAILED=0

log() { echo "[smoke] $*"; }

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

# ---------------------------------------------------------------- 命令入口
if command -v uv >/dev/null 2>&1; then
  CLI=(uv run --project "$PLATFORM_DIR" python "$PLATFORM_DIR/cli/sandboxctl.py")
else
  CLI=(env PYTHONPATH="$PLATFORM_DIR/src" python3 "$PLATFORM_DIR/cli/sandboxctl.py")
fi

# 沙箱用户身份执行命令（免 root 守护进程需要 XDG_RUNTIME_DIR 与 DOCKER_HOST）
sandbox_exec() {
  local user="$1"; shift
  local uid
  uid="$(id -u "$user" 2>/dev/null || true)"
  [ -n "$uid" ] || return 1
  sudo -u "$user" env \
    HOME="/home/${user}" \
    USER="$user" \
    LOGNAME="$user" \
    XDG_RUNTIME_DIR="/run/user/${uid}" \
    DOCKER_HOST="unix:///run/user/${uid}/docker.sock" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$@"
}

# 读取沙箱元数据里的某个字段
meta_field() {
  local name="$1" field="$2"
  "${CLI[@]}" list --json 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
for item in data:
    if item['name'] == '$name':
        print(item.get('$field', ''))
        break
"
}

# 与宿主守护进程同版本的 docker 客户端镜像（容器内需要 docker 命令）
detect_cli_image() {
  local ver
  ver="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
  if [ -n "$ver" ]; then echo "docker:${ver}-cli"; else echo "docker:cli"; fi
}

# ---------------------------------------------------------------- 前置检查
log "宿主：$(uname -srm)"
command -v sudo >/dev/null 2>&1 || { echo "缺少 sudo" >&2; exit 1; }
sudo -n true || { echo "sudo 需要免密" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "缺少 docker" >&2; exit 1; }
[ -x /usr/bin/dockerd-rootless.sh ] || { echo "缺少 /usr/bin/dockerd-rootless.sh" >&2; exit 1; }

IMAGE="$(detect_cli_image)"
log "沙箱镜像：$IMAGE"

# 清理上一轮残留，保证可重复执行
if [ -n "$("${CLI[@]}" list --json 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    data = []
print('yes' if any(i['name'] == '$SANDBOX_NAME' for i in data) else '')
")" ]; then
  log "清理上一轮残留沙箱 $SANDBOX_NAME"
  "${CLI[@]}" delete "$SANDBOX_NAME" --yes >/dev/null 2>&1 || true
fi

MOUNT_DIR="$(mktemp -d /tmp/sandbox-platform-smoke-XXXXXX)"
chmod 0755 "$MOUNT_DIR"
MARKER_FILE="$MOUNT_DIR/marker.txt"
echo "冒烟数据-请勿修改" > "$MARKER_FILE"
chmod 0666 "$MARKER_FILE"
cleanup_tmp() { rm -rf "$MOUNT_DIR"; }
trap cleanup_tmp EXIT

# ---------------------------------------------------------------- 创建
log "创建沙箱 $SANDBOX_NAME（挂载 $MOUNT_DIR → $MOUNT_CONTAINER_PATH）"
"${CLI[@]}" create "$SANDBOX_NAME" \
  --image "$IMAGE" \
  --command "sleep infinity" \
  --mount "$MOUNT_DIR:$MOUNT_CONTAINER_PATH:ro"

SYSTEM_USER="$(meta_field "$SANDBOX_NAME" system_user)"
SOCKET_PATH="$(meta_field "$SANDBOX_NAME" socket_path)"
CONTAINER_NAME="$(meta_field "$SANDBOX_NAME" container_name)"
HOME_DIR="$(meta_field "$SANDBOX_NAME" home)"
SUBID_LINE="$(meta_field "$SANDBOX_NAME" subid_start)"

[ -n "$SYSTEM_USER" ] || { echo "取不到沙箱元数据" >&2; exit 1; }
log "系统用户 $SYSTEM_USER，容器 $CONTAINER_NAME，套接字 $SOCKET_PATH"

# ① 用户、子 ID 段、守护进程就位
if id -u "$SYSTEM_USER" >/dev/null 2>&1; then check "系统用户已创建" 0 "$SYSTEM_USER"; else check "系统用户已创建" 1 "$SYSTEM_USER 不存在"; fi
if sudo grep -q "^${SYSTEM_USER}:" /etc/subuid 2>/dev/null; then check "子 UID 段已登记" 0 ""; else check "子 UID 段已登记" 1 "/etc/subuid 无条目"; fi
if sudo grep -q "^${SYSTEM_USER}:" /etc/subgid 2>/dev/null; then check "子 GID 段已登记" 0 ""; else check "子 GID 段已登记" 1 "/etc/subgid 无条目"; fi
if sandbox_exec "$SYSTEM_USER" systemctl --user is-active --quiet docker.service; then check "用户级守护进程 active" 0 ""; else check "用户级守护进程 active" 1 "守护进程未运行"; fi
if sandbox_exec "$SYSTEM_USER" test -S "$SOCKET_PATH"; then check "套接字就位" 0 "$SOCKET_PATH"; else check "套接字就位" 1 "套接字不存在"; fi

# ② 容器内 docker ps 只见自己
INSIDE_LIST="$(sandbox_exec "$SYSTEM_USER" docker exec "$CONTAINER_NAME" docker ps -a --format '{{.Names}}' 2>&1 || true)"
if [ "$(echo "$INSIDE_LIST" | tr -d '\r' | grep -c .)" = "1" ] && [ "$(echo "$INSIDE_LIST" | tr -d '\r' | head -1)" = "$CONTAINER_NAME" ]; then
  check "容器内 docker ps 只见本沙箱容器" 0 "$INSIDE_LIST"
else
  check "容器内 docker ps 只见本沙箱容器" 1 "实际输出：$(echo "$INSIDE_LIST" | tr '\n' ' ')"
fi

# ③ 容器内挂载点：套接字 + 用户声明挂载
MOUNTS_JSON="$(sandbox_exec "$SYSTEM_USER" docker inspect --format '{{json .Mounts}}' "$CONTAINER_NAME" 2>&1 || true)"
if echo "$MOUNTS_JSON" | grep -q "$MOUNT_CONTAINER_PATH" && echo "$MOUNTS_JSON" | grep -q "/var/run/docker.sock"; then
  check "容器挂载点为套接字 + 用户声明挂载" 0 ""
else
  check "容器挂载点为套接字 + 用户声明挂载" 1 "实际：$MOUNTS_JSON"
fi

# ④ 外部挂载目录内容可读
if [ "$(cat "$MARKER_FILE")" = "冒烟数据-请勿修改" ]; then check "外部挂载目录内容未变" 0 ""; else check "外部挂载目录内容未变" 1 "内容异常"; fi

# ⑤ 依赖容器：模拟 agent 事后自己起的依赖容器
#    删除前的回收清单必须把它列进去（删除前实时扫描守护进程网络上的容器）
DEP_CONTAINER="${SANDBOX_NAME}-dep"
sandbox_exec "$SYSTEM_USER" docker run -d --name "$DEP_CONTAINER" \
  --network "${SANDBOX_NAME}-net" --entrypoint sleep "$IMAGE" infinity >/dev/null 2>&1 \
  || echo "[smoke] 依赖容器启动失败（后续清单断言会不通过）"

# ---------------------------------------------------------------- 关闭
log "关闭沙箱"
"${CLI[@]}" stop "$SANDBOX_NAME"
if sandbox_exec "$SYSTEM_USER" docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q false; then
  check "沙箱容器已停止" 0 ""
else
  check "沙箱容器已停止" 1 "容器仍在运行"
fi
if id -u "$SYSTEM_USER" >/dev/null 2>&1; then check "关闭后用户保留" 0 ""; else check "关闭后用户保留" 1 "用户被删了"; fi
if sandbox_exec "$SYSTEM_USER" systemctl --user is-active --quiet docker.service; then check "关闭后守护进程保留" 0 ""; else check "关闭后守护进程保留" 1 "守护进程被停了"; fi
if sudo grep -q "^${SYSTEM_USER}:" /etc/subuid 2>/dev/null; then check "关闭后子 ID 段保留" 0 ""; else check "关闭后子 ID 段保留" 1 "子 ID 段被回收了"; fi

# ---------------------------------------------------------------- 启动
log "启动沙箱"
"${CLI[@]}" start "$SANDBOX_NAME"
if sandbox_exec "$SYSTEM_USER" docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q true; then
  check "沙箱容器已恢复运行" 0 ""
else
  check "沙箱容器已恢复运行" 1 "容器未运行"
fi
NEW_SUBID="$(meta_field "$SANDBOX_NAME" subid_start)"
if [ "$NEW_SUBID" = "$SUBID_LINE" ]; then check "重启后子 ID 段不变" 0 "$NEW_SUBID"; else check "重启后子 ID 段不变" 1 "$SUBID_LINE → $NEW_SUBID"; fi
if [ "$(cat "$MARKER_FILE")" = "冒烟数据-请勿修改" ]; then check "重启后外部挂载目录内容未变" 0 ""; else check "重启后外部挂载目录内容未变" 1 "内容异常"; fi

# ---------------------------------------------------------------- 删除
log "删除沙箱"

# 删除前先看提示清单：依赖容器必须在清单里（实时扫描 + 元数据旧列表取并集）
# 标准输入接 /dev/null：非交互环境直接打印清单后退出，不会卡在确认提示上
PLAN_OUTPUT="$("${CLI[@]}" delete "$SANDBOX_NAME" </dev/null 2>&1 || true)"
if echo "$PLAN_OUTPUT" | grep -q "$DEP_CONTAINER"; then
  check "删除提示清单含依赖容器" 0 "$DEP_CONTAINER"
else
  check "删除提示清单含依赖容器" 1 "清单里没有 $DEP_CONTAINER"
fi

"${CLI[@]}" delete "$SANDBOX_NAME" --yes

if ! id -u "$SYSTEM_USER" >/dev/null 2>&1; then check "系统用户已回收" 0 ""; else check "系统用户已回收" 1 "用户仍在"; fi
if [ ! -d "$HOME_DIR" ]; then check "家目录已回收" 0 ""; else check "家目录已回收" 1 "家目录仍在"; fi
if ! sudo grep -q "^${SYSTEM_USER}:" /etc/subuid 2>/dev/null; then check "/etc/subuid 条目已回收" 0 ""; else check "/etc/subuid 条目已回收" 1 "条目仍在"; fi
if ! sudo grep -q "^${SYSTEM_USER}:" /etc/subgid 2>/dev/null; then check "/etc/subgid 条目已回收" 0 ""; else check "/etc/subgid 条目已回收" 1 "条目仍在"; fi
if ! sudo -u "$SYSTEM_USER" env XDG_RUNTIME_DIR="/run/user/$(id -u "$SYSTEM_USER" 2>/dev/null || echo 0)" systemctl --user is-active --quiet docker.service 2>/dev/null; then
  check "守护进程已停止" 0 ""
else
  check "守护进程已停止" 1 "守护进程仍在运行"
fi
if [ -z "$(meta_field "$SANDBOX_NAME" container_id)" ]; then check "平台元数据已回收" 0 ""; else check "平台元数据已回收" 1 "元数据仍在"; fi
if [ -d "$MOUNT_DIR" ] && [ "$(cat "$MARKER_FILE")" = "冒烟数据-请勿修改" ]; then
  check "用户挂载的宿主机目录仍存在且内容未变" 0 "$MOUNT_DIR"
else
  check "用户挂载的宿主机目录仍存在且内容未变" 1 "目录或内容异常"
fi

# ---------------------------------------------------------------- 幂等
log "重复删除同一沙箱（应返回不存在且不报错）"
if "${CLI[@]}" delete "$SANDBOX_NAME" --yes; then
  check "重复删除幂等" 0 ""
else
  check "重复删除幂等" 1 "重复删除报错"
fi

# ---------------------------------------------------------------- 汇总
echo
echo "判定汇总：共 ${CHECK_TOTAL} 项，不通过 ${CHECK_FAILED} 项"
[ "$CHECK_FAILED" -eq 0 ]
