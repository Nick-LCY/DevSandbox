#!/usr/bin/env bash
# 00-create-user.sh —— 创建探针用户 sandboxprobe，并登记子 UID/GID 段
# 幂等：重复执行不报错、不重复登记；用户已存在且子 ID 段合规时直接沿用。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

SUBID_LEN="${SUBID_LEN:-65536}"     # 段长度，要求 ≥ 65536
MIN_START="${MIN_START:-100000}"    # 起点，要求 ≥ 100000

log() { echo "[00] $*"; }

# ---------------------------------------------------------------- 用户
if id -u "$PROBE_USER" >/dev/null 2>&1; then
  log "用户 $PROBE_USER 已存在（uid=$(id -u "$PROBE_USER")），跳过创建"
else
  sudo useradd --create-home --shell /bin/bash "$PROBE_USER"
  log "已创建用户 $PROBE_USER（uid=$(id -u "$PROBE_USER")），家目录 $PROBE_HOME"
fi

# ---------------------------------------------------------------- 子 ID 段
read_user_entry() {  # $1=文件 -> "start len"
  sudo awk -F: -v u="$PROBE_USER" '$1==u && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ {print $2" "$3; exit}' "$1" 2>/dev/null || true
}

all_ranges() {  # 所有已登记的段（subuid + subgid 合并）
  sudo awk -F: 'NF==3 && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ {print $2" "$3}' /etc/subuid /etc/subgid 2>/dev/null || true
}

pick_free_start() {  # 找一段不与任何已有段重叠的起点
  local len="$1" candidate="$MIN_START"
  while : ; do
    local conflict=0 cs=0 cl=0
    while read -r s l; do
      [ -z "${s:-}" ] && continue
      if [ "$candidate" -lt $((s + l)) ] && [ "$s" -lt $((candidate + len)) ]; then
        conflict=1; cs="$s"; cl="$l"; break
      fi
    done < <(all_ranges)
    [ "$conflict" -eq 0 ] && { echo "$candidate"; return 0; }
    candidate=$((cs + cl))
  done
}

write_entry() {  # $1=文件 $2=start $3=len
  local file="$1" start="$2" len="$3"
  sudo touch "$file"
  sudo sed -i "/^${PROBE_USER}:/d" "$file"
  printf '%s:%s:%s\n' "$PROBE_USER" "$start" "$len" | sudo tee -a "$file" >/dev/null
}

entry="$(read_user_entry /etc/subuid)"
start="${entry%% *}"; len="${entry##* }"
if [ -n "$start" ] && [ "$start" -ge "$MIN_START" ] && [ "$len" -ge 65536 ]; then
  log "沿用已有子 UID 段：$start-$((start + len - 1))（长度 $len）"
  UID_START="$start"; UID_LEN="$len"
else
  UID_START="$(pick_free_start "$SUBID_LEN")"
  UID_LEN="$SUBID_LEN"
  write_entry /etc/subuid "$UID_START" "$UID_LEN"
  write_entry /etc/subgid "$UID_START" "$UID_LEN"
  log "已登记子 ID 段：$UID_START-$((UID_START + UID_LEN - 1))（长度 $UID_LEN）"
fi

# 保证 subuid / subgid 两边都有该用户的条目
for f in /etc/subuid /etc/subgid; do
  e="$(read_user_entry "$f")"
  if [ "${e%% *}" != "$UID_START" ]; then
    write_entry "$f" "$UID_START" "$UID_LEN"
    log "已同步写入 $f"
  fi
done

# ---------------------------------------------------------------- 依赖检查
for t in newuidmap newgidmap; do
  if [ ! -u "/usr/bin/$t" ]; then
    log "警告：/usr/bin/$t 缺失或未设置 setuid 位，免 root 容器无法映射多个 UID"
    log "  修复命令：sudo apt-get install -y uidmap"
  else
    log "依赖 OK：/usr/bin/$t（setuid）"
  fi
done

echo
echo "子 UID/GID 段起点：$UID_START"
echo "子 UID/GID 段终点：$((UID_START + UID_LEN - 1))"
echo "子 UID/GID 段长度：$UID_LEN"
echo "/etc/subuid：$(sudo grep "^${PROBE_USER}:" /etc/subuid || echo '<无>')"
echo "/etc/subgid：$(sudo grep "^${PROBE_USER}:" /etc/subgid || echo '<无>')"
