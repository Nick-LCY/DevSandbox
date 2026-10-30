#!/usr/bin/env bash
# ============================================================================
# 自托管字体构建：源字体 → 字符集 → 按字重实例化 → 子集化 → public/fonts/*.woff2
#
# 用法（任意目录都可执行）：
#   bash platform/console/scripts/build-fonts.sh
#
# 四步：
#   1. 取源字体。优先 google/fonts 仓库里的可变字体 TTF（一份文件含全部字重）；
#      拿不到时退到 fonts.gstatic.com 的 CSS API，按我们自己的字符集向 Google
#      要一份子集（text= 参数）；再拿不到就整个字体步骤失败。
#      **本脚本不改 fonts.css**：字体文件缺失时浏览器自动回退到系统字体栈，
#      产物已入库，正常构建不依赖外网。
#   2. 生成字符集 scripts/fonts/charset.txt：从控制台前端、控制台测试、后端
#      沙箱平台三处源码里抽出实际用到的中文 / 全角 / 常用符号（后端中文错误
#      文案必须进字符集），再补 ASCII 可打印区与一组界面常用符号。
#   3. 用 fonttools 实例化各字重（Noto 400/500/600/700，Geist Mono 400/500），
#      再用 pyftsubset 按字符集子集化并转 woff2。
#   4. 产物先落暂存目录，全部字重都成功后再整体替换 public/fonts/（任一字重
#      失败则丢弃暂存产物，原有 public/fonts/ 原封不动），与
#      src/styles/fonts.css 里的 @font-face 一一对应。
#
# 依赖：curl、python3、uv（字体工具用 `uv run --with` 临时装，不污染项目依赖）。
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONSOLE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CONSOLE_DIR/../.." && pwd)"

CHARSET_DIR="$SCRIPT_DIR/fonts"
CHARSET_FILE="$CHARSET_DIR/charset.txt"
FONT_OUT_DIR="$CONSOLE_DIR/public/fonts"
# 暂存目录与备份目录都放在 public/ 下：与目标目录同分区，最后一步是改名
# 而不是拷贝，不会出现「换了一半」的中间态。
STAGE_DIR="$CONSOLE_DIR/public/.fonts-staging"
BACKUP_DIR="$CONSOLE_DIR/public/.fonts-previous"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

NOTO_TTF_URL="https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf"
GEIST_TTF_URL="https://raw.githubusercontent.com/google/fonts/main/ofl/geistmono/GeistMono%5Bwght%5D.ttf"

# 字重表：<族名> <可变字体 URL> <权重列表>
FAMILIES=(
  "NotoSansSC|$NOTO_TTF_URL|400 500 600 700"
  "GeistMono|$GEIST_TTF_URL|400 500"
)

log() { printf '[build-fonts] %s\n' "$*"; }
die() { printf '[build-fonts][错误] %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 第 2 步：字符集
# ---------------------------------------------------------------------------
build_charset() {
  log "生成字符集 $CHARSET_FILE"
  mkdir -p "$CHARSET_DIR"

  # 三处源码：控制台前端、控制台测试、后端沙箱平台（后端中文错误文案必须覆盖）。
  local sources=(
    "$CONSOLE_DIR/src"
    "$CONSOLE_DIR/tests"
    "$REPO_ROOT/platform/src/sandbox_platform"
  )

  python3 - "$CHARSET_FILE" "${sources[@]}" <<'PY'
import os
import sys

out_path = sys.argv[1]
sources = sys.argv[2:]

# 保留的非 ASCII 码位区间：通用标点 / 箭头 / 数学 / 几何图形 / 杂项符号 /
# 装饰符号 / 中日韩符号与标点 / 假名 / CJK 扩展 A / CJK 统一表意文字 /
# 兼容表意文字 / CJK 兼容形式 / 全角形式。
RANGES = [
    (0x2000, 0x206F), (0x2190, 0x21FF), (0x2200, 0x22FF),
    (0x25A0, 0x25FF), (0x2600, 0x26FF), (0x2700, 0x27BF),
    (0x3000, 0x303F), (0x3040, 0x30FF), (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF), (0xF900, 0xFAFF), (0xFE30, 0xFE4F),
    (0xFF00, 0xFFEF),
]

# 界面里一定会用到的符号，显式补齐（源码里不一定出现）。
EXTRA = "×·→←↑↓✓✗●○◆★☆⚠"

def keep(ch: str) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in RANGES)

chars = set()

# ASCII 可打印区
chars.update(chr(c) for c in range(0x20, 0x7F))

# 三处源码里的非 ASCII 字符
for root in sources:
    if not os.path.isdir(root):
        continue
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in {'.git', 'node_modules', 'dist', 'artifacts'}]
        for name in filenames:
            if not name.endswith(('.ts', '.tsx', '.js', '.jsx', '.py', '.json', '.md', '.html', '.css')):
                continue
            path = os.path.join(dirpath, name)
            try:
                with open(path, encoding='utf-8') as fh:
                    text = fh.read()
            except (UnicodeDecodeError, OSError):
                continue
            for ch in text:
                if ord(ch) > 0x7F and keep(ch):
                    chars.add(ch)

chars.update(EXTRA)

ordered = sorted(chars)
# 每行 40 个字符，纯数据文件：pyftsubset 的 --text-file 直接吃它（换行会被忽略）。
with open(out_path, 'w', encoding='utf-8') as fh:
    for i in range(0, len(ordered), 40):
        fh.write(''.join(ordered[i:i + 40]))
        fh.write('\n')

print(f'[build-fonts] 字符集共 {len(ordered)} 个字符（其中非 ASCII {sum(1 for c in ordered if ord(c) > 0x7F)} 个）')
PY
}

# ---------------------------------------------------------------------------
# 第 1 步：取源字体
# ---------------------------------------------------------------------------
fetch_variable_ttf() {
  # $1=url  $2=输出路径；成功返回 0，失败返回 1。
  local url="$1" out="$2"
  log "下载可变字体 $url"
  if curl -fsSL --retry 3 --retry-delay 2 --max-time 300 "$url" -o "$out"; then
    return 0
  fi
  return 1
}

fetch_gstatic_subset() {
  # 备用路径：向 Google Fonts CSS API 索要按我们字符集切好的 woff2。
  # $1=族名(如 Noto Sans SC)  $2=权重(400)  $3=字符集文件  $4=输出路径
  local family="$1" weight="$2" charset="$3" out="$4"
  local text css url
  text="$(python3 - "$charset" <<'PY'
import sys, urllib.parse
with open(sys.argv[1], encoding='utf-8') as fh:
    text = fh.read().strip()
print(urllib.parse.quote(text, safe=''))
PY
)"
  css="$(curl -fsSL --max-time 120 \
    -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' \
    "https://fonts.googleapis.com/css2?family=${family}:wght@${weight}&text=${text}" || true)"
  [ -n "$css" ] || return 1
  url="$(printf '%s' "$css" | grep -o 'https://[^)]*\.woff2' | head -n 1)"
  [ -n "$url" ] || return 1
  log "改用 fonts.gstatic.com 分片：$url"
  curl -fsSL --max-time 180 "$url" -o "$out"
}

# ---------------------------------------------------------------------------
# 第 3/4 步：实例化 + 子集化
# ---------------------------------------------------------------------------
build_weight() {
  # $1=可变字体 ttf  $2=字重  $3=字符集  $4=输出 woff2
  local src="$1" weight="$2" charset="$3" out="$4"
  local inst="$WORK_DIR/inst-$weight.ttf"

  # --update-name-table 让 name 表跟着字重走（否则 400 也会被标成 "Thin"）。
  uv run --quiet --with "fonttools[woff]" fonttools varLib.instancer \
    "$src" "wght=$weight" --update-name-table --output "$inst" >/dev/null

  uv run --quiet --with "fonttools[woff]" pyftsubset "$inst" \
    --text-file="$charset" \
    --flavor=woff2 \
    --output-file="$out" \
    --layout-features='*' \
    --no-hinting \
    --ignore-missing-glyphs \
    --drop-tables+=DSIG \
    >/dev/null
}

main() {
  command -v curl >/dev/null || die "缺少 curl"
  command -v python3 >/dev/null || die "缺少 python3"
  command -v uv >/dev/null || die "缺少 uv"

  build_charset

  rm -rf "$STAGE_DIR" "$BACKUP_DIR"
  mkdir -p "$STAGE_DIR"

  local ok=1
  local entry family url weights weight src_ttf family_name
  for entry in "${FAMILIES[@]}"; do
    IFS='|' read -r family url weights <<<"$entry"
    src_ttf="$WORK_DIR/$family.ttf"

    if ! fetch_variable_ttf "$url" "$src_ttf"; then
      log "可变字体下载失败，改走 fonts.gstatic.com 分片路径"
      src_ttf=""
    fi

    for weight in $weights; do
      local out="$STAGE_DIR/$family-$weight.woff2"
      if [ -n "$src_ttf" ]; then
        if build_weight "$src_ttf" "$weight" "$CHARSET_FILE" "$out"; then
          log "生成 $family-$weight.woff2（$(du -h "$out" | cut -f1)）"
          continue
        fi
        log "fonttools 处理 $family $weight 失败"
      fi

      # 备用路径：Google Fonts 按字符集切好的 woff2。
      family_name="$family"
      [ "$family" = "NotoSansSC" ] && family_name="Noto Sans SC"
      [ "$family" = "GeistMono" ] && family_name="Geist Mono"
      if fetch_gstatic_subset "$family_name" "$weight" "$CHARSET_FILE" "$out"; then
        log "生成 $family-$weight.woff2（gstatic 分片，$(du -h "$out" | cut -f1)）"
      else
        log "字体 $family $weight 全部来源都失败"
        ok=0
      fi
    done
  done

  if [ "$ok" -ne 1 ]; then
    # 有字重失败：暂存产物整个丢掉，public/fonts/ 保持原样，不留半成品。
    rm -rf "$STAGE_DIR"
    cat >&2 <<EOF
[build-fonts][错误] 有字重没能生成，本次产物已丢弃，public/fonts/ 未被改动。
  请检查网络后重试；若离线环境可用，仓库里已入库的字体产物照常可用——
  字体文件缺失时浏览器自动回退 --app-font-sans 的系统字体栈。
EOF
    exit 1
  fi

  # 全部字重都成功：先备份旧目录，再把暂存目录改名上去，最后删备份。
  # 三步都是同分区的改名操作，不会出现只换了一半的 public/fonts/。
  if [ -d "$FONT_OUT_DIR" ]; then
    mv "$FONT_OUT_DIR" "$BACKUP_DIR"
  fi
  mv "$STAGE_DIR" "$FONT_OUT_DIR"
  rm -rf "$BACKUP_DIR"

  log "完成，产物目录：$FONT_OUT_DIR"
  ls -l "$FONT_OUT_DIR"
}

main "$@"
