#!/usr/bin/env bash
#
# 默认全栈沙箱镜像的镜像级判定脚本
#
# 判定范围（不依赖宿主沙箱平台，只用宿主 root 守护进程）：
#   1) 工具链版本（交互式 bash 内逐个有输出）
#   2) nvm 目录与 node 归属
#   3) Playwright 浏览器：只有 chromium，firefox / webkit 缺席
#   4) 离线判据：--network=none 起容器，chromium 对 data:text/html 截图成功
#   5) 凭证断言：镜像 Env 与镜像内文件清单无密码类内容
#   6) 体积统计（镜像总体积、chromium 体积）
#
# 用法：
#   IMAGE=sandbox-platform/sandbox-default:0.1.0 ./verify.sh

set -uo pipefail

IMAGE="${IMAGE:-sandbox-platform/sandbox-default:0.1.0}"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/playwright-browsers}"

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

check() {
  # check <描述> <判定命令>
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    ok "$desc"
  else
    bad "$desc"
  fi
}

check_in_image() {
  # check_in_image <描述> <容器内脚本>
  local desc="$1"
  local script="$2"
  if [ "$(in_image "$script" 2>/dev/null)" = "0" ]; then
    ok "$desc"
  else
    bad "$desc"
  fi
}

# 在容器里跑一段脚本，输出它的标准输出
in_image() {
  docker run --rm --network=none --entrypoint bash "$IMAGE" -c "$1"
}

# ---------------------------------------------------------------- 0) 镜像存在
section "镜像元信息"

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  ok "镜像存在：$IMAGE"
else
  bad "镜像不存在：$IMAGE"
  printf '\n判定结束：镜像缺失，后续项跳过。\n'
  exit 1
fi

IMAGE_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}')"
IMAGE_SIZE="$(docker image inspect "$IMAGE" --format '{{.Size}}')"
printf '  image id : %s\n' "$IMAGE_ID"
printf '  体积     : %s 字节（%.1f MB）\n' "$IMAGE_SIZE" "$(awk "BEGIN{print $IMAGE_SIZE/1048576}")"

# ---------------------------------------------------------------- 1) 工具链
section "工具链版本（交互式 bash 内）"

TOOL_SCRIPT='
set -u
for cmd in "pi --version" "git --version" "uv --version" "node --version" "pnpm --version" "nvm --version" "npx playwright --version"; do
  out=$(eval "$cmd" 2>&1 | head -1)
  if [ -n "$out" ]; then printf "%-26s OK   %s\n" "$cmd" "$out"; else printf "%-26s FAIL\n" "$cmd"; fi
done
'

TOOL_OUT="$(printf '%s\n' "$TOOL_SCRIPT" | docker run --rm -i --network=none "$IMAGE" 2>/dev/null)"
printf '%s\n' "$TOOL_OUT" | sed 's/^/  /'

while IFS= read -r line; do
  case "$line" in
    *OK*) ok "$(printf '%s' "$line" | awk '{print $1}') 有版本输出" ;;
    *FAIL*) bad "$(printf '%s' "$line" | awk '{print $1}') 无版本输出" ;;
  esac
done <<<"$TOOL_OUT"

# ---------------------------------------------------------------- 2) nvm
section "nvm 与 node 归属"

check_in_image "存在 nvm 目录 /usr/local/nvm" '[ -d /usr/local/nvm ] && echo 0 || echo 1'
NVM_VER="$(in_image 'nvm --version 2>/dev/null' | head -1)"
if [ -n "$NVM_VER" ]; then ok "nvm --version = $NVM_VER"; else bad "nvm --version 无输出"; fi

NODE_PATH_HIT="$(in_image 'command -v node')"
case "$NODE_PATH_HIT" in
  /usr/local/nvm/*) ok "node 由 nvm 管理：$NODE_PATH_HIT" ;;
  *) bad "node 不在 nvm 目录下：$NODE_PATH_HIT" ;;
esac

PNPM_PATH_HIT="$(in_image 'command -v pnpm')"
case "$PNPM_PATH_HIT" in
  /usr/local/nvm/*) ok "pnpm 由 nvm 管理：$PNPM_PATH_HIT" ;;
  *) bad "pnpm 不在 nvm 目录下：$PNPM_PATH_HIT" ;;
esac

# ---------------------------------------------------------------- 3) 浏览器
section "Playwright 浏览器"

BROWSER_ENV="$(docker image inspect "$IMAGE" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^PLAYWRIGHT_BROWSERS_PATH=' || true)"
if [ -n "$BROWSER_ENV" ]; then
  ok "镜像 Env 固定浏览器目录：$BROWSER_ENV"
else
  bad "镜像 Env 未设置 PLAYWRIGHT_BROWSERS_PATH"
fi

BROWSER_LIST="$(in_image "ls -1 '$PLAYWRIGHT_BROWSERS_PATH' 2>/dev/null" || true)"
printf '  浏览器目录内容：%s\n' "$(printf '%s' "$BROWSER_LIST" | tr '\n' ' ')"

case "$BROWSER_LIST" in
  *chromium*) ok "chromium 已安装" ;;
  *) bad "chromium 缺失" ;;
esac

case "$BROWSER_LIST" in
  *firefox*) bad "firefox 不应默认安装" ;;
  *) ok "firefox 未安装" ;;
esac

case "$BROWSER_LIST" in
  *webkit*) bad "webkit 不应默认安装" ;;
  *) ok "webkit 未安装" ;;
esac

BROWSER_SIZE="$(in_image "du -sm '$PLAYWRIGHT_BROWSERS_PATH' 2>/dev/null | cut -f1")"
printf '  浏览器目录体积：%s MB\n' "${BROWSER_SIZE:-?}"

# ---------------------------------------------------------------- 4) 离线判据
section "离线判据（--network=none 截图）"

SHOT_DIR="$(mktemp -d)"
trap 'rm -rf "$SHOT_DIR"' EXIT

OFFLINE_OUT="$(docker run --rm --network=none --entrypoint bash \
  -v "$SHOT_DIR:/out" "$IMAGE" -c '
    cd /workspace
    npx playwright screenshot --browser chromium "data:text/html,<h1>ok</h1>" /workspace/offline-shot.png >/dev/null 2>&1
    rc=$?
    if [ $rc -ne 0 ]; then echo "SHOT_FAILED rc=$rc"; exit $rc; fi
    cp /workspace/offline-shot.png /out/offline-shot.png
    echo "SHOT_OK"
  ' 2>&1)"

case "$OFFLINE_OUT" in
  *SHOT_OK*) ok "chromium 在无网环境下截图成功" ;;
  *) bad "离线截图失败：$OFFLINE_OUT" ;;
esac

if [ -s "$SHOT_DIR/offline-shot.png" ]; then
  ok "截图产物落盘：$SHOT_DIR/offline-shot.png（$(stat -c %s "$SHOT_DIR/offline-shot.png") 字节）"
else
  bad "截图产物缺失"
fi

PNG_MAGIC="$(head -c 8 "$SHOT_DIR/offline-shot.png" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
if [ "$PNG_MAGIC" = "89504e470d0a1a0a" ]; then
  ok "截图产物是合法 PNG"
else
  bad "截图产物不是 PNG（magic=$PNG_MAGIC）"
fi

# ---------------------------------------------------------------- 5) 凭证断言
section "凭证不落镜像"

ENV_JSON="$(docker image inspect "$IMAGE" --format '{{json .Config.Env}}')"
if printf '%s' "$ENV_JSON" | grep -Eqi '(passwd|password|secret|token|credential|api[_-]?key|access[_-]?key|private[_-]?key)'; then
  bad "镜像 Env 含密码类字段：$ENV_JSON"
else
  ok "镜像 Env 无密码类字段"
fi
printf '  Env：%s\n' "$ENV_JSON"

# 文件清单：先找 .env 与凭证类文件名
ENV_FILES="$(in_image '
  find / -xdev \
    \( -path /proc -o -path /sys -o -path /dev \) -prune -o \
    -type f \( -name ".env" -o -name "*.env" \) -print 2>/dev/null
')"
if [ -z "$(printf '%s' "$ENV_FILES" | tr -d '[:space:]')" ]; then
  ok "镜像内无 .env 文件"
else
  bad "镜像内存在 .env 文件：$(printf '%s' "$ENV_FILES" | tr '\n' ' ')"
fi

# 凭证类文件名（只扫镜像与用户会写入的路径；/usr/share、/usr/lib 是发行版自带内容）
CRED_FILES="$(in_image '
  find /root /home /tmp /var /opt /etc /usr/local -xdev -type f \
    ! -path "/opt/deps/*" ! -path "/opt/playwright-browsers/*" ! -path "/usr/local/nvm/*" \
    \( -name "*.pem" -o -name "*.key" -o -name "*.p12" -o -name "*.pfx" \
       -o -name "id_rsa*" -o -name "id_ecdsa*" -o -name "id_ed25519*" \
       -o -name ".netrc" -o -name "_netrc" -o -name ".git-credentials" -o -name ".pgpass" -o -name ".my.cnf" \
       -o -name ".npmrc" -o -name ".htpasswd" -o -iname "*credential*" -o -iname "*secret*" \) -print 2>/dev/null
')"
if [ -z "$(printf '%s' "$CRED_FILES" | tr -d '[:space:]')" ]; then
  ok "镜像内无凭证类文件"
else
  bad "镜像内存在凭证类文件：$(printf '%s' "$CRED_FILES" | tr '\n' ' ')"
fi

# 配置文件内容里不含 password= 这类带真实值的赋值（只看配置类小文本文件，跳过二进制与第三方代码）
CONTENT_HITS="$(in_image '
  find /root /etc /opt /usr/local/bin -xdev -type f -size -128k \
    ! -path "/opt/deps/*" ! -path "/opt/playwright-browsers/*" \
    \( -name "*.conf" -o -name "*.cfg" -o -name "*.ini" -o -name "*.toml" -o -name "*.yaml" -o -name "*.yml" -o -name "*.json" -o -name ".bashrc" -o -name ".profile" -o -name "*rc" \) \
    -print0 2>/dev/null | xargs -0 -r grep -lEi "(passwd|password|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[[:space:]]*[:=][[:space:]]*[\"'"'"']?[A-Za-z0-9!@#$%^&*_+=/-]{8,}" 2>/dev/null
')"
if [ -z "$(printf '%s' "$CONTENT_HITS" | tr -d '[:space:]')" ]; then
  ok "镜像内配置类文件无密码赋值"
else
  bad "镜像内配置类文件含密码赋值：$(printf '%s' "$CONTENT_HITS" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------- 6) 汇总
section "汇总"
printf '  通过 %s 项，失败 %s 项\n' "$PASSED" "$FAILED"
if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
exit 0
