#!/usr/bin/env bash
# 03-network-check.sh —— 逐条执行任务 01 的判定项，输出 通过 / 不通过
# 幂等：只读检查 + 生成临时探针文件，不改变容器拓扑（网络已在 02 建好）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

log() { echo "[03] $*"; }

UID_NUM="$(probe_uid)"
RUNTIME_DIR="/run/user/${UID_NUM}"
SHARE_DIR="${PROBE_HOME}/share"
SUBID_START="$(sudo awk -F: -v u="$PROBE_USER" '$1==u {print $2; exit}' /etc/subuid)"

echo "===== 判定 1：免 root 守护进程状态 ====="
active="$(probe_exec systemctl --user is-active docker.service 2>/dev/null || echo inactive)"
if [ "$active" = "active" ]; then check "systemctl --user is-active docker" 0 "输出 $active"; else check "systemctl --user is-active docker" 1 "输出 $active"; fi

echo
echo "===== 判定 2：Root Dir 落在探针用户家目录内 ====="
root_dir="$(probe_exec docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo '<读取失败>')"
echo "  Root Dir = $root_dir"
case "$root_dir" in
  "$PROBE_HOME"/*) check "Root Dir 在 $PROBE_HOME 内" 0 "$root_dir" ;;
  *) check "Root Dir 在 $PROBE_HOME 内" 1 "$root_dir" ;;
esac

echo
echo "===== 判定 3：docker ps 只显示本次探针创建的容器 ====="
current="$(probe_exec docker ps -a --format '{{.Names}}' | sort)"
baseline="$(cut -f2 "$STATE_DIR/baseline-containers.txt" | sort)"
expected="$(printf '%s\n%s\n%s\n%s\n' "$baseline" "$C_MAIN" "$C_PEER" "$C_CLI" | grep -v '^$' | sort -u)"
echo "  基线容器：$(echo "$baseline" | grep -v '^$' | tr '\n' ' ')"
echo "  当前容器：$(echo "$current" | tr '\n' ' ')"
if [ "$current" = "$expected" ]; then
  check "容器集合 == 基线 ∪ 探针容器" 0 "共 $(echo "$current" | grep -c .) 个"
else
  check "容器集合 == 基线 ∪ 探针容器" 1 "多出：$(comm -13 <(echo "$expected") <(echo "$current") | tr '\n' ' ')"
fi
root_daemon_names="$(sudo docker ps -a --format '{{.Names}}' | sort | tr '\n' ' ')"
echo "  宿主 root 守护进程的容器（探针内不可见）：$root_daemon_names"

echo
echo "===== 判定 4：容器内 UID 为 0 ====="
id_out="$(probe_exec docker exec "$C_MAIN" id 2>/dev/null || echo '<失败>')"
echo "  容器内 id 输出：$id_out"
id_uid="$(probe_exec docker exec "$C_MAIN" id -u 2>/dev/null || echo '<失败>')"
if [ "$id_uid" = "0" ]; then check "容器内 id -u == 0" 0 "$id_out"; else check "容器内 id -u == 0" 1 "id -u = $id_uid"; fi

echo
echo "===== 判定 5：宿主侧文件属主为映射后的高位 UID ====="
probe_exec docker exec --user 1000:1000 "$C_MAIN" sh -c 'echo probe > /share/owned-by-1000' >/dev/null 2>&1 || true
probe_exec docker exec "$C_MAIN" sh -c 'echo probe > /share/owned-by-root' >/dev/null 2>&1 || true
echo "  宿主侧 ls -n："
sudo ls -n "$SHARE_DIR" | sed 's/^/    /'
high_uid="$(sudo stat -c %u "$SHARE_DIR/owned-by-1000" 2>/dev/null || echo 0)"
root_uid="$(sudo stat -c %u "$SHARE_DIR/owned-by-root" 2>/dev/null || echo 0)"
echo "  容器内 uid 1000 建的文件，宿主属主 = $high_uid；容器内 root 建的文件，宿主属主 = $root_uid；子 ID 段起点 = $SUBID_START"
if [ "$high_uid" -ge "$SUBID_START" ] && [ "$high_uid" -lt $((SUBID_START + 65536)) ]; then
  check "非 root 容器用户在宿主侧映射为高位 UID" 0 "$high_uid ∈ [$SUBID_START, $((SUBID_START + 65535))]"
else
  check "非 root 容器用户在宿主侧映射为高位 UID" 1 "$high_uid 不在子 ID 段内"
fi
if [ "$root_uid" = "$UID_NUM" ]; then
  check "容器内 root 在宿主侧映射为守护进程用户" 0 "$root_uid（= $PROBE_USER 的 uid）"
else
  check "容器内 root 在宿主侧映射为守护进程用户" 1 "$root_uid"
fi

echo
echo "===== 判定 6：/proc/<pid>/uid_map 映射规模 ====="
cpid="$(probe_exec docker inspect -f '{{.State.Pid}}' "$C_MAIN" 2>/dev/null || echo 0)"
if [ "$cpid" != "0" ]; then
  echo "  容器主进程 pid = $cpid"
  echo "  uid_map 内容："
  sudo cat "/proc/$cpid/uid_map" | sed 's/^/    /'
  map_lines="$(sudo wc -l < "/proc/$cpid/uid_map")"
  map_size="$(sudo awk '{s+=$3} END {print s+0}' "/proc/$cpid/uid_map")"
  echo "  uid_map 行数 = $map_lines；映射覆盖的 UID 总数 = $map_size"
  if [ "$map_size" -ge 65536 ]; then
    check "uid_map 覆盖 ≥ 65536 个 UID" 0 "实际覆盖 $map_size（文件为 $map_lines 行区间映射，非 65536 行）"
  else
    check "uid_map 覆盖 ≥ 65536 个 UID" 1 "实际覆盖 $map_size"
  fi
else
  check "uid_map 覆盖 ≥ 65536 个 UID" 1 "取不到容器主进程 pid"
fi

echo
echo "===== 判定 7：套接字挂载后容器内 docker ps ====="
cli_ps="$(probe_exec docker exec "$C_CLI" docker ps -a --format '{{.Names}}' 2>&1 | sort | tr '\n' ' ' || true)"
echo "  容器内 docker ps：$cli_ps"
if echo "$cli_ps" | grep -q "$C_MAIN" && echo "$cli_ps" | grep -q "$C_PEER"; then
  check "容器内 docker ps 看到守护进程管理的容器" 0 "$cli_ps"
else
  check "容器内 docker ps 看到守护进程管理的容器" 1 "$cli_ps"
fi

echo
echo "===== 判定 8：容器内 docker version 客户端/服务端版本一致 ====="
client_ver="$(probe_exec docker exec "$C_CLI" docker version --format '{{.Client.Version}}' 2>/dev/null || echo '<失败>')"
server_ver="$(probe_exec docker exec "$C_CLI" docker version --format '{{.Server.Version}}' 2>/dev/null || echo '<失败>')"
echo "  client = $client_ver；server = $server_ver"
if [ -n "$client_ver" ] && [ "$client_ver" = "$server_ver" ]; then
  check "client 版本 == server 版本" 0 "$client_ver"
else
  check "client 版本 == server 版本" 1 "client=$client_ver server=$server_ver"
fi

echo
echo "===== 判定 9：同网桥按容器名解析 ====="
getent_out="$(probe_exec docker exec "$C_CLI" getent hosts "$C_PEER" 2>&1 || echo '<失败>')"
echo "  getent hosts $C_PEER：$getent_out"
if echo "$getent_out" | grep -q "$C_PEER"; then
  check "getent hosts $C_PEER 解析成功" 0 "$getent_out"
else
  check "getent hosts $C_PEER 解析成功" 1 "$getent_out"
fi
ns_out="$(probe_exec docker exec "$C_MAIN" nslookup "$C_PEER" 2>&1 | tail -3 | tr '\n' ' ' || true)"
echo "  busybox 侧 nslookup：$ns_out"

echo
echo "===== 判定 10：连通对端暴露的端口 ====="
if probe_exec docker exec "$C_MAIN" nc -z "$C_PEER" "$PEER_PORT" >/dev/null 2>&1; then
  check "nc -z $C_PEER $PEER_PORT 连通" 0 "端口 $PEER_PORT 可达"
else
  check "nc -z $C_PEER $PEER_PORT 连通" 1 "端口 $PEER_PORT 不可达"
fi
http_out="$(probe_exec docker exec "$C_MAIN" wget -qO- "http://$C_PEER:$PEER_PORT/" 2>&1 | tr -d '\n' || true)"
echo "  HTTP 取回内容：$http_out"

echo
echo "===== 判定 11：宿主无新增监听端口 ====="
sudo ss -ltnH | awk '{print $4}' | sort > "$STATE_DIR/ss-after.txt"
new_listeners="$(comm -13 "$STATE_DIR/ss-before.txt" "$STATE_DIR/ss-after.txt" | grep -v '^$' | tr '\n' ' ' || true)"
echo "  基线监听端口数：$(wc -l < "$STATE_DIR/ss-before.txt")；当前：$(wc -l < "$STATE_DIR/ss-after.txt")"
echo "  新增监听：${new_listeners:-（无）}"
if [ -z "$new_listeners" ]; then
  check "宿主 ss -ltn 无新增监听端口" 0 "无新增"
else
  check "宿主 ss -ltn 无新增监听端口" 1 "新增：$new_listeners"
fi

echo
echo "===== 判定 12：cgroup 委托 ====="
delegate="$(probe_exec systemctl --user show docker --property=Delegate --value 2>/dev/null || echo '<读取失败>')"
echo "  systemctl --user show docker --property=Delegate = $delegate"
if [ "$delegate" = "yes" ]; then check "Delegate=yes" 0 "$delegate"; else check "Delegate=yes" 1 "$delegate"; fi

echo
echo "===== 判定 13：容器 cgroup 路径位于用户 cgroup 之下 ====="
if [ "$cpid" != "0" ]; then
  cgroup_path="$(sudo cat "/proc/$cpid/cgroup")"
  echo "  容器 cgroup：$cgroup_path"
  if echo "$cgroup_path" | grep -q "user-${UID_NUM}.slice\|user@${UID_NUM}.service"; then
    check "容器 cgroup 在探针用户 cgroup 之下" 0 "$cgroup_path"
  else
    check "容器 cgroup 在探针用户 cgroup 之下" 1 "$cgroup_path"
  fi
else
  check "容器 cgroup 在探针用户 cgroup 之下" 1 "取不到容器主进程 pid"
fi

check_summary
