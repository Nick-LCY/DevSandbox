#!/usr/bin/env bash
# 04-cleanup.sh —— 回收探针创建的全部宿主资源
# 幂等：资源不存在时跳过，重复执行不报错。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

log() { echo "[04] $*"; }
HAS_USER=0
[ -n "$(probe_uid)" ] && HAS_USER=1
UID_NUM="$(probe_uid)"
RUNTIME_DIR="/run/user/${UID_NUM:-0}"

# ---------------------------------------------------------------- 容器与网络
if [ "$HAS_USER" -eq 1 ] && [ -d "$RUNTIME_DIR" ]; then
  for c in "$C_MAIN" "$C_PEER" "$C_CLI"; do
    if probe_exec docker inspect "$c" >/dev/null 2>&1; then
      probe_exec docker rm -f "$c" >/dev/null && log "已删除容器 $c"
    else
      log "容器 $c 不存在，跳过"
    fi
  done
  if probe_exec docker network inspect "$PROBE_NET" >/dev/null 2>&1; then
    probe_exec docker network rm "$PROBE_NET" >/dev/null && log "已删除网络 $PROBE_NET"
  else
    log "网络 $PROBE_NET 不存在，跳过"
  fi
else
  log "探针用户或运行时目录不存在，跳过容器与网络回收"
fi

# ---------------------------------------------------------------- 用户级 systemd 单元
if [ "$HAS_USER" -eq 1 ]; then
  UNIT_FILE="${PROBE_HOME}/.config/systemd/user/docker.service"
  if probe_exec systemctl --user is-enabled docker.service >/dev/null 2>&1; then
    probe_exec systemctl --user disable docker.service >/dev/null 2>&1 || true
    log "已禁用用户级单元 docker.service"
  fi
  if probe_exec systemctl --user is-active --quiet docker.service 2>/dev/null; then
    probe_exec systemctl --user stop docker.service >/dev/null 2>&1 || true
    log "已停止用户级守护进程"
  fi
  if [ -f "$UNIT_FILE" ]; then
    sudo rm -f "$UNIT_FILE"
    log "已删除单元文件 $UNIT_FILE"
  fi
  sudo rm -f "${PROBE_HOME}/.config/systemd/user/default.target.wants/docker.service"
  probe_exec systemctl --user daemon-reload >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------- linger
if sudo loginctl show-user "$PROBE_USER" 2>/dev/null | grep -q '^Linger=yes'; then
  sudo loginctl disable-linger "$PROBE_USER" && log "已关闭 linger 保活"
else
  log "linger 本就未开启"
fi

# ---------------------------------------------------------------- 用户与子 ID 段
if [ "$HAS_USER" -eq 1 ]; then
  # 先终止该用户的 systemd 用户管理器，否则 userdel 会因进程占用失败
  if sudo loginctl terminate-user "$PROBE_USER" >/dev/null 2>&1; then
    log "已终止用户 $PROBE_USER 的登录会话与用户级管理器"
  fi
  for _ in $(seq 1 15); do
    pgrep -u "$PROBE_USER" >/dev/null 2>&1 || break
    sleep 1
  done
  if sudo userdel -r "$PROBE_USER" 2>/dev/null || sudo userdel "$PROBE_USER"; then
    log "已删除用户 $PROBE_USER（含家目录）"
  else
    log "删除用户 $PROBE_USER 失败"
  fi
else
  log "用户 $PROBE_USER 不存在，跳过"
fi
for f in /etc/subuid /etc/subgid; do
  if sudo grep -q "^${PROBE_USER}:" "$f" 2>/dev/null; then
    sudo sed -i "/^${PROBE_USER}:/d" "$f"
    log "已清除 $f 中的 $PROBE_USER 条目"
  fi
done

# ---------------------------------------------------------------- 状态目录
rm -rf "$STATE_DIR"
log "已清理状态目录 $STATE_DIR"

# ---------------------------------------------------------------- 校验
echo
echo "===== 清理结果校验 ====="
if ! id -u "$PROBE_USER" >/dev/null 2>&1; then check "用户 $PROBE_USER 不存在" 0 "已删除"; else check "用户 $PROBE_USER 不存在" 1 "仍存在"; fi
if ! sudo grep -q "^${PROBE_USER}:" /etc/subuid 2>/dev/null; then check "/etc/subuid 无该用户条目" 0 "已清除"; else check "/etc/subuid 无该用户条目" 1 "仍存在"; fi
if ! sudo grep -q "^${PROBE_USER}:" /etc/subgid 2>/dev/null; then check "/etc/subgid 无该用户条目" 0 "已清除"; else check "/etc/subgid 无该用户条目" 1 "仍存在"; fi
if [ ! -f "${PROBE_HOME}/.config/systemd/user/docker.service" ]; then check "用户级 systemd 单元已删除" 0 "已删除"; else check "用户级 systemd 单元已删除" 1 "仍存在"; fi
if [ ! -d "$PROBE_HOME" ]; then check "探针家目录已删除" 0 "已删除"; else check "探针家目录已删除" 1 "仍存在"; fi
if [ ! -d "/run/user/${UID_NUM:-0}" ]; then check "运行时目录已回收" 0 "已回收"; else check "运行时目录已回收" 1 "仍存在"; fi

check_summary
