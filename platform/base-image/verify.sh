#!/usr/bin/env bash
#
# 基础镜像静态判定：镜像内业务运行时缺席 + 镜像结构约定 + 入口行为 + 无离线包痕迹
# 依赖命令：bash + docker（宿主守护进程）。
#
# 用法：
#   ./verify.sh                      # 默认校验 sandbox-platform/base:0.2.0
#   BASE_IMAGE=sandbox-platform/base:0.1.0 ./verify.sh

set -uo pipefail

BASE_IMAGE="${BASE_IMAGE:-sandbox-platform/base:0.2.0}"

CHECK_TOTAL=0
CHECK_FAILED=0

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

# 在镜像内执行 bash 命令，返回输出
in_image() {
  docker run --rm --entrypoint /bin/bash "$BASE_IMAGE" -c "$1" 2>&1
}

echo "===== 基础镜像判定：$BASE_IMAGE ====="
echo

# ---------------------------------------------------------------- 0. 镜像存在
if docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  check "镜像存在" 0 "$BASE_IMAGE"
else
  check "镜像存在" 1 "$BASE_IMAGE 未找到，请先构建"
  echo
  echo "判定汇总：共 ${CHECK_TOTAL} 项，不通过 ${CHECK_FAILED} 项"
  exit 1
fi

# ---------------------------------------------------------------- 1. 基础命令存在
out="$(in_image 'command -v bash')"
if [ -n "$out" ]; then check "镜像内有 bash" 0 "$out"; else check "镜像内有 bash" 1 "未找到"; fi

out="$(in_image 'command -v docker')"
if [ -n "$out" ]; then check "镜像内有 docker 客户端" 0 "$out"; else check "镜像内有 docker 客户端" 1 "未找到"; fi

out="$(in_image 'docker --version')"
if echo "$out" | grep -qE '^Docker version [0-9]+\.[0-9]+\.[0-9]+'; then
  check "docker --version 有版本输出" 0 "$out"
else
  check "docker --version 有版本输出" 1 "${out:-<无输出>}"
fi

# ---------------------------------------------------------------- 2. 业务运行时缺席
for cmd in node npm pnpm python3 python psql pg_config mc minio postgres git curl jq; do
  out="$(in_image "command -v $cmd")"
  if [ -z "$out" ]; then
    check "镜像内无 $cmd" 0 "未安装"
  else
    check "镜像内无 $cmd" 1 "存在：$out"
  fi
done

# ---------------------------------------------------------------- 3. 不内置 volume 挂载点
volumes="$(docker image inspect --format '{{json .Config.Volumes}}' "$BASE_IMAGE" 2>/dev/null || true)"
if [ -z "$volumes" ] || [ "$volumes" = "null" ] || [ "$volumes" = "{}" ]; then
  check "镜像无 VOLUME 指令（inspect Volumes 为空）" 0 "${volumes:-字段不存在（等价于空）}"
else
  check "镜像无 VOLUME 指令（inspect Volumes 为空）" 1 "$volumes"
fi

mounts="$(in_image "awk '{print \$2}' /proc/mounts | grep -vE '^(/proc|/sys|/dev)(/|\$)|^/etc/(hostname|hosts|resolv.conf)\$|^/\$' | sort -u")"
if [ -z "$mounts" ]; then
  check "镜像内无预置挂载点" 0 "容器内只有 /proc /sys /dev /etc 三类标准挂载"
else
  check "镜像内无预置挂载点" 1 "存在挂载：$(echo "$mounts" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------- 4. /workspace 便捷空目录
out="$(in_image 'test -d /workspace && echo dir')"
if [ "$out" = "dir" ]; then check "/workspace 是目录" 0 "存在"; else check "/workspace 是目录" 1 "不存在"; fi

out="$(in_image 'ls -A /workspace | wc -l')"
if [ "$out" = "0" ]; then check "/workspace 是空目录" 0 "0 个条目"; else check "/workspace 是空目录" 1 "$out 个条目"; fi

out="$(in_image 'touch /workspace/.probe && rm /workspace/.probe && echo writable')"
if [ "$out" = "writable" ]; then check "/workspace 可写" 0 "可创建并删除文件"; else check "/workspace 可写" 1 "写入失败"; fi

out="$(in_image "grep -c ' /workspace ' /proc/mounts || true")"
if [ "$out" = "0" ]; then check "/workspace 不是挂载点（容器层目录）" 0 "未出现在 /proc/mounts"; else check "/workspace 不是挂载点（容器层目录）" 1 "/proc/mounts 命中 $out 次"; fi

out="$(in_image 'stat -c "%a" /workspace')"
check "/workspace 权限位" 0 "$out（1777 = 任意用户可写）"

# ---------------------------------------------------------------- 5. 入口脚本静态检查
out="$(in_image "test -f /entrypoint.sh && echo yes")"
if [ "$out" = "yes" ]; then check "/entrypoint.sh 存在" 0 "存在"; else check "/entrypoint.sh 存在" 1 "缺失"; fi

out="$(in_image "grep -nE '\\b(python3?|node|npm|pnpm|curl|jq)\\b' /entrypoint.sh || true")"
if [ -z "$out" ]; then
  check "入口脚本只依赖 bash 与 docker" 0 "静态检查无业务运行时调用"
else
  check "入口脚本只依赖 bash 与 docker" 1 "命中：$(echo "$out" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------- 6. 镜像内无离线包痕迹（0.2.0 起废弃离线包机制）
out="$(in_image 'test ! -e /opt/deps && echo clean')"
if [ "$out" = "clean" ]; then check "镜像内无 /opt/deps 目录" 0 "离线包目录已移除"; else check "镜像内无 /opt/deps 目录" 1 "/opt/deps 仍存在"; fi

for f in /opt/deps/load-deps.sh /opt/deps/fetch-deps.sh /opt/deps/images/images.list; do
  out="$(in_image "test ! -e $f && echo clean")"
  if [ "$out" = "clean" ]; then check "镜像内无 $f" 0 "不存在"; else check "镜像内无 $f" 1 "仍存在"; fi
done

out="$(in_image "find / -xdev -name '*.tar' -o -name '*.tar.gz' -o -name '*.tgz' 2>/dev/null | head -5")"
if [ -z "$out" ]; then
  check "镜像内无离线包归档文件" 0 "全盘未命中 tar 类文件"
else
  check "镜像内无离线包归档文件" 1 "命中：$(echo "$out" | tr '\n' ' ')"
fi

out="$(in_image "grep -nE 'load-deps|docker +load|/opt/deps|images\.list' /entrypoint.sh || true")"
if [ -z "$out" ]; then
  check "入口脚本无离线包加载逻辑" 0 "静态检查无加载相关调用"
else
  check "入口脚本无离线包加载逻辑" 1 "命中：$(echo "$out" | tr '\n' ' ')"
fi

out="$(in_image 'ls -A / | tr "\n" " "')"
check "镜像根目录清单" 0 "$out"

# ---------------------------------------------------------------- 7. 入口行为：docker 缺失
tmp_out="$(mktemp)"
docker run --rm -e PATH=/usr/bin:/bin "$BASE_IMAGE" >"$tmp_out" 2>&1
rc=$?
if [ "$rc" -eq 127 ] && grep -q 'docker client missing' "$tmp_out"; then
  check "docker 缺失时报错并以 127 退出" 0 "退出码 $rc，输出含 docker client missing"
else
  check "docker 缺失时报错并以 127 退出" 1 "退出码 $rc，输出：$(tr '\n' ' ' <"$tmp_out")"
fi
rm -f "$tmp_out"

# ---------------------------------------------------------------- 8. 入口行为：docker 存在
tmp_out="$(mktemp)"
docker run --rm -i "$BASE_IMAGE" </dev/null >"$tmp_out" 2>&1
rc=$?
if [ "$rc" -eq 0 ] && ! grep -q 'docker client missing' "$tmp_out"; then
  check "docker 存在时进入交互式 bash" 0 "退出码 $rc（stdin EOF 正常退出）"
else
  check "docker 存在时进入交互式 bash" 1 "退出码 $rc，输出：$(tr '\n' ' ' <"$tmp_out")"
fi
rm -f "$tmp_out"

# ---------------------------------------------------------------- 汇总
echo
echo "判定汇总：共 ${CHECK_TOTAL} 项，不通过 ${CHECK_FAILED} 项"
[ "$CHECK_FAILED" -eq 0 ]
