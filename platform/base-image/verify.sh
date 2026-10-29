#!/usr/bin/env bash
#
# 基础镜像静态判定：镜像内业务运行时缺席 + 镜像结构约定 + 入口行为
# 依赖命令：bash + docker（宿主守护进程）。
#
# 用法：
#   ./verify.sh                      # 默认校验 sandbox-platform/base:0.1.0
#   BASE_IMAGE=sandbox-platform/base:0.2.0 ./verify.sh

set -uo pipefail

BASE_IMAGE="${BASE_IMAGE:-sandbox-platform/base:0.1.0}"

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
for f in /entrypoint.sh /opt/deps/load-deps.sh; do
  out="$(in_image "test -f $f && echo yes")"
  if [ "$out" = "yes" ]; then check "$f 存在" 0 "存在"; else check "$f 存在" 1 "缺失"; fi
done

out="$(in_image "grep -nE '\\b(python3?|node|npm|pnpm|curl|jq)\\b' /entrypoint.sh /opt/deps/load-deps.sh || true")"
if [ -z "$out" ]; then
  check "入口与加载脚本只依赖 bash 与 docker" 0 "静态检查无业务运行时调用"
else
  check "入口与加载脚本只依赖 bash 与 docker" 1 "命中：$(echo "$out" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------- 6. 依赖镜像离线包
for t in postgres-16.15-alpine3.24.tar minio-minio-RELEASE.2025-04-22T22-12-26Z.tar logto-1.29.0.tar; do
  out="$(in_image "test -f /opt/deps/images/$t && echo yes")"
  if [ "$out" = "yes" ]; then check "离线包 $t 在镜像内" 0 "存在"; else check "离线包 $t 在镜像内" 1 "缺失"; fi
done

out="$(in_image 'test -f /opt/deps/images/images.list && echo yes')"
if [ "$out" = "yes" ]; then check "离线包清单 images.list 在镜像内" 0 "存在"; else check "离线包清单 images.list 在镜像内" 1 "缺失"; fi

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
