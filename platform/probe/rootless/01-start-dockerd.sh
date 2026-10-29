#!/usr/bin/env bash
# 01-start-dockerd.sh —— 以 systemd 用户单元启动免 root dockerd
# 幂等：单元已存在且内容一致时只做 daemon-reload + enable --now，不重建守护进程。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

log() { echo "[01] $*"; }

id -u "$PROBE_USER" >/dev/null 2>&1 || { echo "探针用户 $PROBE_USER 不存在，请先执行 00-create-user.sh" >&2; exit 1; }
UID_NUM="$(probe_uid)"
RUNTIME_DIR="/run/user/${UID_NUM}"
UNIT_DIR="${PROBE_HOME}/.config/systemd/user"
UNIT_FILE="${UNIT_DIR}/docker.service"

# ---------------------------------------------------------------- linger 保活
if ! sudo loginctl show-user "$PROBE_USER" 2>/dev/null | grep -q '^Linger=yes'; then
  sudo loginctl enable-linger "$PROBE_USER"
  log "已执行 loginctl enable-linger $PROBE_USER"
else
  log "linger 已开启"
fi

for _ in $(seq 1 30); do
  [ -d "$RUNTIME_DIR" ] && break
  sleep 1
done
[ -d "$RUNTIME_DIR" ] || { echo "未生成 $RUNTIME_DIR，用户级 systemd 未就绪" >&2; exit 1; }
log "运行时目录就绪：$RUNTIME_DIR"

# ---------------------------------------------------------------- 单元文件
sudo install -d -o "$PROBE_USER" -g "$PROBE_USER" -m 0755 \
  "$PROBE_HOME/.config" "$PROBE_HOME/.config/systemd" "$UNIT_DIR"
sudo chown -R "$PROBE_USER:$PROBE_USER" "$PROBE_HOME/.config"
TMP_UNIT="$(mktemp)"
cat > "$TMP_UNIT" <<EOF
[Unit]
Description=Docker daemon (rootless) for $PROBE_USER
After=network.target

[Service]
Type=notify
NotifyAccess=all
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=HOME=$PROBE_HOME
Environment=DOCKER_HOST=unix://$RUNTIME_DIR/docker.sock
ExecStart=/usr/bin/dockerd-rootless.sh --rootless
ExecReload=/bin/kill -s HUP \$MAINPID
TimeoutSec=0
Restart=always
RestartSec=2
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
TasksMax=infinity
Delegate=yes
KillMode=mixed

[Install]
WantedBy=default.target
EOF

CHANGED=1
if [ -f "$UNIT_FILE" ] && cmp -s "$TMP_UNIT" "$UNIT_FILE"; then
  CHANGED=0
fi
sudo install -o "$PROBE_USER" -g "$PROBE_USER" -m 0644 "$TMP_UNIT" "$UNIT_FILE"
rm -f "$TMP_UNIT"
if [ "$CHANGED" -eq 1 ]; then
  log "已写入单元文件（内容有变化）：$UNIT_FILE"
else
  log "单元文件内容未变化：$UNIT_FILE"
fi

# ---------------------------------------------------------------- 启动
probe_exec systemctl --user daemon-reload
probe_exec systemctl --user enable docker.service >/dev/null

if probe_exec systemctl --user is-active --quiet docker.service; then
  log "守护进程已在运行，仅做单元同步"
  if [ "$CHANGED" -eq 1 ]; then
    log "单元内容变化，重启守护进程"
    probe_exec systemctl --user restart docker.service
  fi
else
  log "启动守护进程"
  probe_exec systemctl --user start docker.service
fi

# ---------------------------------------------------------------- 等待套接字
for _ in $(seq 1 60); do
  probe_exec test -S "$RUNTIME_DIR/docker.sock" && break
  sleep 1
done
probe_exec test -S "$RUNTIME_DIR/docker.sock" || { echo "套接字 $RUNTIME_DIR/docker.sock 未出现，守护进程启动失败" >&2; probe_exec systemctl --user status docker.service --no-pager || true; exit 1; }

echo
echo "systemctl --user is-active docker => $(probe_exec systemctl --user is-active docker.service)"
echo "套接字：$RUNTIME_DIR/docker.sock"
echo "Root Dir：$(probe_exec docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo '<读取失败>')"
echo "存储驱动：$(probe_exec docker info --format '{{.Driver}}' 2>/dev/null || echo '<读取失败>')"
echo "cgroup 驱动：$(probe_exec docker info --format '{{.CgroupDriver}}' 2>/dev/null || echo '<读取失败>')"
echo "cgroup 版本：$(probe_exec docker info --format '{{.CgroupVersion}}' 2>/dev/null || echo '<读取失败>')"
