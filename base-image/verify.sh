#!/usr/bin/env bash
#
# 基础镜像静态判定：镜像内业务运行时缺席 + 通用工具层在场 + 镜像结构约定 + 入口行为 + 无离线包痕迹
# + cached-images 命令硬约束（0.4.0：PATH / 纯 bash / --noproxy / 封顶 / 缺凭据态 / 帮助退出码 / 拒连态）
# 依赖命令：bash + docker（宿主守护进程）。
#
# 用法：
#   ./verify.sh                      # 默认校验 sandbox-platform/base:0.4.0
#   BASE_IMAGE=sandbox-platform/base:0.1.0 ./verify.sh

set -uo pipefail

BASE_IMAGE="${BASE_IMAGE:-sandbox-platform/base:0.4.0}"

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

# 在镜像内执行 bash 命令，并注入一个环境变量
# in_image_with_env <变量名> <变量值> <命令>
# 模式串走 env 传递而不是拼进命令行：模式里的 $PS1 / $(pwd) 之类内容
# 不会被外层 shell 或容器内 shell 求值（求值了就不是「逐字节等于原文」了）。
in_image_with_env() {
  docker run --rm --entrypoint /bin/bash -e "$1=$2" "$BASE_IMAGE" -c "$3" 2>&1
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
for cmd in node npm pnpm python3 python psql pg_config mc minio postgres jq; do
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

# ---------------------------------------------------------------- 9. 通用工具层在场（0.3.0 新增）
# 9 个通用工具包：dpkg-query 查得到版本 + 对应命令在 PATH
probe_tool() {
  # probe_tool <包名> <命令名>：输出 "<版本>|<命令路径>"
  in_image "pkg=$1; cmd=$2; ver=\$(dpkg-query -W -f='\${Version}' \"\$pkg\" 2>/dev/null); path=\$(command -v \"\$cmd\" 2>/dev/null); printf '%s|%s' \"\$ver\" \"\$path\""
}

check_tool() {
  # check_tool <包名> <命令名>
  local pkg="$1" cmd="$2" out ver path
  out="$(probe_tool "$pkg" "$cmd")"
  ver="${out%%|*}"
  path="${out#*|}"
  if [ -n "$ver" ] && [ -n "$path" ]; then
    check "通用工具层：$pkg 已安装且 $cmd 在 PATH" 0 "$pkg $ver，$path"
  else
    check "通用工具层：$pkg 已安装且 $cmd 在 PATH" 1 "版本=${ver:-<无>}，路径=${path:-<无>}"
  fi
}

check_tool git git
check_tool openssh-client ssh
check_tool vim vim
check_tool curl curl
check_tool unzip unzip
check_tool xz-utils xz
check_tool procps ps
check_tool less less

# ca-certificates 不提供命令，断言包版本与证书文件同时在位
out="$(in_image "ver=\$(dpkg-query -W -f='\${Version}' ca-certificates 2>/dev/null); test -f /etc/ssl/certs/ca-certificates.crt && printf '%s|cert-ok' \"\$ver\" || printf '%s|cert-missing' \"\$ver\"")"
ver="${out%%|*}"
cert="${out#*|}"
if [ -n "$ver" ] && [ "$cert" = "cert-ok" ]; then
  check "通用工具层：ca-certificates 已安装且证书文件存在" 0 "$ver，/etc/ssl/certs/ca-certificates.crt"
else
  check "通用工具层：ca-certificates 已安装且证书文件存在" 1 "版本=${ver:-<无>}，证书=${cert}"
fi

# ---------------------------------------------------------------- 10. OSC 1337 pwd 上报注入 + UTF-8 locale（0.3.1 新增）
# 10.1 注入行逐字节等于定稿写法（01 轮真沙箱实测定稿，逐字照抄）
#     判据拆成两个**各自独立**的判定：
#       ①「存在该行」——grep -Fx（定长串 + 整行匹配）；不用 tail -n 1 猜末行；
#       ②「该行是最后一个非空行」——awk 取最后一个非空行（只含空白的行按空行算）
#          再与定稿原文逐字节比对。
expected_osc="export PS1=\"\$PS1\"'\\[\\e]1337;CurrentDir=\$(pwd)\\a\\]'"
in_image_with_env OSC_EXPECTED "$expected_osc" 'grep -Fxq "$OSC_EXPECTED" /etc/bash.bashrc' >/dev/null 2>&1
osc_line_rc=$?
last_nonempty="$(in_image "awk 'NF{last=\$0} END{print last}' /etc/bash.bashrc")"
if [ "$osc_line_rc" -eq 0 ] && [ "$last_nonempty" = "$expected_osc" ]; then
  check "OSC 1337 注入段在 /etc/bash.bashrc 末尾" 0 "定稿行存在（grep -Fx）且是最后一个非空行（逐字节一致）"
else
  if [ "$osc_line_rc" -eq 0 ]; then
    osc_note="定稿行存在=是"
  else
    osc_note="定稿行存在=否"
  fi
  check "OSC 1337 注入段在 /etc/bash.bashrc 末尾" 1 "${osc_note}；最后非空行=${last_nonempty}"
fi

# 10.2 原有内容保留：注入是「追加」，不是覆盖
#     判据改为「Debian 原生 PS1 定义行逐字节仍在」（/etc/bash.bashrc 的原生那一行）。
#     原判据是「数 PS1= 的行数」——注入行自身也是 PS1= ⇒ 计数法证明不了「原 PS1 保留」。
native_ps1='  PS1='"'"'${debian_chroot:+($debian_chroot)}\u@\h:\w\$ '"'"''
if in_image_with_env NATIVE_PS1 "$native_ps1" 'grep -Fxq "$NATIVE_PS1" /etc/bash.bashrc' >/dev/null 2>&1; then
  check "OSC 1337 注入为追加（原有 PS1 保留）" 0 "Debian 原生 PS1 定义行逐字节仍在"
else
  check "OSC 1337 注入为追加（原有 PS1 保留）" 1 "Debian 原生 PS1 定义行未命中"
fi

# 10.3 功能判定：交互式非登录 shell 实测发出 OSC 1337
#     （bash 的提示符与 OSC 走 stderr，捕获必须带 2>&1）
out="$(in_image "printf 'exit\n' | bash -i 2>&1")"
if printf '%s' "$out" | grep -q '1337;CurrentDir=/workspace'; then
  check "bash -i 实测上报 OSC 1337 CurrentDir" 0 "载荷 CurrentDir=/workspace"
else
  check "bash -i 实测上报 OSC 1337 CurrentDir" 1 "未捕获到 OSC：$(printf '%s' "$out" | tr '\n' ' ')"
fi

# 10.4 降级判定：dash / sh 不读 bashrc，不产生 OSC，输出不被污染
#     匹配 OSC 的**起始形态**（ESC ] 1337;）而不是裸 '1337'：
#     将来 WORKDIR 之类的路径含 1337 时，裸串匹配会误判成「出现了 OSC」。
out="$(in_image "printf 'exit\n' | sh -i 2>&1")"
if printf '%s' "$out" | grep -q $'\033]1337;'; then
  check "sh -i 自然降级：不产生 OSC 序列" 1 "sh 会话里出现了 OSC"
else
  check "sh -i 自然降级：不产生 OSC 序列" 0 "0 条 OSC，输出无污染"
fi

# 10.5 / 10.6 UTF-8 locale（容器内 locale 原本处于未定义态）
for key in LANG LC_ALL; do
  out="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$BASE_IMAGE" 2>/dev/null | grep -E "^${key}=" || true)"
  if [ "$out" = "${key}=C.UTF-8" ]; then
    check "ENV ${key}=C.UTF-8" 0 "$out"
  else
    check "ENV ${key}=C.UTF-8" 1 "${out:-未设置}"
  fi
done

# ---------------------------------------------------------------- 11. cached-images 命令（0.4.0 新增）
# 硬约束三判（PRD 22）：在 PATH、纯 bash 零 jq 零 JSON 解析、显式 --noproxy + 超时封顶；
# 三态中的缺凭据态与帮助文本可离线判（不需活后端）；不可达态的「拒连」形态同样零依赖
# （指向本机必死端口）——「活后端」的不可达/正常态属真机验证，不塞本脚本。

# 11.1 命令在 PATH
out="$(in_image 'command -v cached-images')"
if [ "$out" = "/usr/local/bin/cached-images" ]; then
  check "cached-images 在 PATH（/usr/local/bin）" 0 "$out"
else
  check "cached-images 在 PATH（/usr/local/bin）" 1 "command -v 输出：${out:-<无>}"
fi

# 11.2 可执行位
out="$(in_image 'test -x /usr/local/bin/cached-images && echo exec-ok')"
if [ "$out" = "exec-ok" ]; then
  check "cached-images 可执行位 0755" 0 "可执行"
else
  check "cached-images 可执行位 0755" 1 "不可执行"
fi

# 11.3 纯 bash 硬约束：零 jq / 零 python / 零 node 等解释器调用（静态 grep）
#     模式限定「行首或管道/分号后紧跟命令名」：头注释里的「零 jq」等说明文字不误伤。
out="$(in_image "grep -cE '(^|[|;&]) *(jq|python3?|node|perl|ruby)( |$)' /usr/local/bin/cached-images || true")"
if [ "$out" = "0" ]; then
  check "cached-images 纯 bash（零 jq / 零脚本解释器调用）" 0 "静态 grep 0 命中"
else
  check "cached-images 纯 bash（零 jq / 零脚本解释器调用）" 1 "命中 $out 处"
fi

# 11.4 语法合法（bash -n）
out="$(in_image 'bash -n /usr/local/bin/cached-images && echo syntax-ok')"
if [ "$out" = "syntax-ok" ]; then
  check "cached-images 语法合法（bash -n）" 0 "通过"
else
  check "cached-images 语法合法（bash -n）" 1 "bash -n 失败：$out"
fi

# 11.5 / 11.6 的公共锚：curl 调用块（^curl 行 + 其后 3 行续行）。
#     此前两者都是全文件 grep——cached-images 头注释与帮助文本里就有同款字面量
#     （--noproxy '*'、--connect-timeout 5 --max-time 10），只删 curl 行实参判定
#     依然绿，回归钉死失效。锚定 ^curl 行后命中范围只剩真调用块：删实参必红，
#     注释在不在都不影响判定。
curl_block="$(in_image "grep -A3 '^curl ' /usr/local/bin/cached-images || true")"

# 11.5 关键 curl 形态静态钉死：显式 --noproxy（PRD 22 硬约束，curl 调用块内命中）
if echo "$curl_block" | grep -qF -- "--noproxy '*'"; then
  check "cached-images 显式 --noproxy '*'（绕过 HTTP(S)_PROXY）" 0 "curl 调用块内命中"
else
  check "cached-images 显式 --noproxy '*'（绕过 HTTP(S)_PROXY）" 1 "curl 调用块内未命中"
fi

# 11.6 超时封顶静态钉死：连接 5s / 总 10s——真·相邻断言：两个封顶参数在 curl 调用
#     块内同一行连写、顺序固定；不再是「各 grep 一次」的全文件假相邻。
if echo "$curl_block" | grep -qF -- '--connect-timeout 5 --max-time 10'; then
  check "cached-images 超时封顶（连接 5s / 总 10s）" 0 "curl 调用块内相邻连写命中"
else
  check "cached-images 超时封顶（连接 5s / 总 10s）" 1 "curl 调用块内未命中相邻连写的两个封顶参数"
fi

# 11.7 端点与凭据形态静态钉死：format=text + Bearer 受限令牌头
out="$(in_image "grep -Fq -- 'format=text' /usr/local/bin/cached-images && grep -Fq -- 'Authorization: Bearer' /usr/local/bin/cached-images && echo form-ok")"
if [ "$out" = "form-ok" ]; then
  check "cached-images 端点 ?format=text + Bearer 受限令牌头" 0 "脚本内命中"
else
  check "cached-images 端点 ?format=text + Bearer 受限令牌头" 1 "未同时命中端点与凭据形态"
fi

# 11.8 三态·缺凭据：两 env 全缺 → 固定退出码 2 + 一行中文提示 + 回退引导（真跑，零依赖）
#     容器 env 天然不含这两个变量（镜像不预置；docker run 也不透传宿主 env）。
run_cached_images() {
  # run_cached_images <docker -e 参数…> -- <容器内前置命令（可为空）>
  # 输出「<容器内输出>|rc=<退出码>」；前置命令用于注入部分 env（空串按缺失也走 -e）。
  local envs=() pre=""
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs+=("-e" "$1"); shift; done
  [ "${1:-}" = "--" ] && shift
  [ "$#" -gt 0 ] && pre="$1"
  docker run --rm --entrypoint /bin/bash "${envs[@]}" "$BASE_IMAGE" -c "$pre"'cached-images; printf "rc=%s" "$?"' 2>&1 | tr '\n' '|'
}

out="$(run_cached_images -- "")"
if echo "$out" | grep -q 'rc=2$' && echo "$out" | grep -q '凭据' && echo "$out" | grep -q '回退正常拉取'; then
  check "缺凭据态：两 env 全缺 → 退出码 2 + 中文提示 + 回退引导" 0 "$(echo "$out" | sed 's/|/ /g')"
else
  check "缺凭据态：两 env 全缺 → 退出码 2 + 中文提示 + 回退引导" 1 "输出：$(echo "$out" | sed 's/|/ /g')"
fi

# 11.9 缺凭据态·缺一：仅 URL 在场（token 缺失）→ 仍退出码 2（任一缺失即缺凭据）
out="$(run_cached_images "SANDBOX_IMAGE_CACHE_URL=http://127.0.0.1:9" -- "")"
if echo "$out" | grep -q 'rc=2$' && echo "$out" | grep -q '凭据'; then
  check "缺凭据态：仅 URL 在场（token 缺失）→ 退出码 2" 0 "任一缺失即缺凭据"
else
  check "缺凭据态：仅 URL 在场（token 缺失）→ 退出码 2" 1 "输出：$(echo "$out" | sed 's/|/ /g')"
fi

# 11.10 缺凭据态·空串按缺失：token 为空串 → 退出码 2（与「未设置」同口径）
out="$(run_cached_images "SANDBOX_IMAGE_CACHE_URL=http://127.0.0.1:9" "SANDBOX_IMAGE_CACHE_TOKEN=" -- "")"
if echo "$out" | grep -q 'rc=2$' && echo "$out" | grep -q '凭据'; then
  check "缺凭据态：token 空串 → 退出码 2（空串按缺失）" 0 "空串与未设置同口径"
else
  check "缺凭据态：token 空串 → 退出码 2（空串按缺失）" 1 "输出：$(echo "$out" | sed 's/|/ /g')"
fi

# 11.11 帮助文本含两个失败态退出码（PRD 24 判据：写进帮助文本）
out="$(in_image 'cached-images --help')"
if echo "$out" | grep -q '退出码' \
  && echo "$out" | grep -Eq '^  2 ' \
  && echo "$out" | grep -Eq '^  3 '; then
  check "帮助文本含三态退出码（0 正常 / 2 缺凭据 / 3 不可达）" 0 "--help 命中「退出码」与 2、3 两行"
else
  check "帮助文本含三态退出码（0 正常 / 2 缺凭据 / 3 不可达）" 1 "--help 未命中退出码表"
fi

# 11.12 引导约定写进帮助文本（模板无指令字段，约定由本命令承载）
if echo "$out" | grep -q '优先选已缓存'; then
  check "引导约定写进帮助文本（先查清单、优先已缓存）" 0 "--help 命中引导语"
else
  check "引导约定写进帮助文本（先查清单、优先已缓存）" 1 "--help 未命中引导语"
fi

# 11.13 三态·不可达（拒连形态，零依赖）：URL 指向本机必死端口 → 退出码 3 + 中文提示，
#     且耗时在 curl 封顶（10s）内。容器内 127.0.0.1:9 无监听 → 立即拒连。
t_start=$SECONDS
out="$(run_cached_images "SANDBOX_IMAGE_CACHE_URL=http://127.0.0.1:9" "SANDBOX_IMAGE_CACHE_TOKEN=sbxr_verify_probe" -- "")"
elapsed=$((SECONDS - t_start))
if echo "$out" | grep -q 'rc=3$' && echo "$out" | grep -q '不可达' && [ "$elapsed" -lt 10 ]; then
  check "不可达态（拒连）：死端口 → 退出码 3 + 中文提示 + 耗时封顶内" 0 "耗时 ${elapsed}s（<10s 封顶）"
else
  check "不可达态（拒连）：死端口 → 退出码 3 + 中文提示 + 耗时封顶内" 1 "耗时 ${elapsed}s，输出：$(echo "$out" | sed 's/|/ /g')"
fi

# ---------------------------------------------------------------- 汇总
echo
echo "判定汇总：共 ${CHECK_TOTAL} 项，不通过 ${CHECK_FAILED} 项"
[ "$CHECK_FAILED" -eq 0 ]
