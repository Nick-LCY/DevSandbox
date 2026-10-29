# 默认全栈沙箱镜像 sandbox-platform/sandbox-default
#
# 底座：平台基础镜像 sandbox-platform/base:0.1.0
#       （bash + docker 客户端 + 纯 bash 入口脚本 + 依赖镜像离线包 + /workspace）
# 本层叠加：git、nvm + node LTS、pnpm、uv、pi CLI、Playwright chromium
#
# 构建（构建期需要外网：拉 node 发行包 / npm 包 / uv / chromium）：
#   docker build \
#     -t sandbox-platform/sandbox-default:0.1.0 \
#     platform/sandbox-image
#
# 标签规则、叠加用户层方法见同目录 README.md。
#
# 说明：本镜像不写 # syntax 指令，BuildKit 内置前端即可满足。

ARG BASE_IMAGE=sandbox-platform/base:0.1.0
ARG SANDBOX_VERSION=0.1.0
ARG NVM_VERSION=v0.40.8
# node 版本：nvm 管理的 LTS 线（Jod），与宿主当前 pi 运行环境同版本，
# 换成别的 LTS 线只需改这个构建参数（也可用 lts/* 取当时最新 LTS）。
ARG NODE_VERSION=22.23.1
ARG PNPM_VERSION=10.32.1
# pi CLI 版本：与宿主 /home/<user>/.pi/agent 安装的版本钉死（npm 包 @earendil-works/pi-coding-agent）
ARG PI_VERSION=1.4.0
ARG PLAYWRIGHT_VERSION=1.64.1
ARG UV_VERSION=0.11.29

FROM ${BASE_IMAGE}

# FROM 之后看不到全局 ARG，构建阶段内重新声明
ARG BASE_IMAGE
ARG SANDBOX_VERSION
ARG NVM_VERSION
ARG NODE_VERSION
ARG PNPM_VERSION
ARG PI_VERSION
ARG PLAYWRIGHT_VERSION
ARG UV_VERSION

LABEL org.opencontainers.image.title="sandbox-platform/sandbox-default" \
      org.opencontainers.image.description="默认全栈沙箱镜像：git + nvm/node + pnpm + uv + pi CLI + Playwright chromium" \
      org.opencontainers.image.version="${SANDBOX_VERSION}" \
      io.sandbox-platform.base.image="${BASE_IMAGE}" \
      io.sandbox-platform.node.version="${NODE_VERSION}" \
      io.sandbox-platform.pnpm.version="${PNPM_VERSION}" \
      io.sandbox-platform.pi.version="${PI_VERSION}" \
      io.sandbox-platform.playwright.version="${PLAYWRIGHT_VERSION}" \
      io.sandbox-platform.uv.version="${UV_VERSION}"

# 浏览器固定落在一个绝对路径，运行期不依赖 HOME
# PATH 里带上 nvm 的 node bin 目录：非交互式 shell（docker exec ... bash -c）也能直接用 node 工具链。
# 注意 nvm 的版本目录带 v 前缀（versions/node/v22.23.1）。
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers \
    NVM_DIR=/usr/local/nvm \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NODE_PATH=/usr/local/nvm/versions/node/v${NODE_VERSION}/lib/node_modules \
    PATH=/usr/local/nvm/versions/node/v${NODE_VERSION}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# ---------------------------------------------------------------- 1) 系统依赖
# build-essential / python3-dev：给用户装带原生扩展的 npm / pip 包用；
# 其余是日常排查工具（curl / jq / ip / ping / nc / less / procps / openssh-client）。
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        bash-completion \
        build-essential \
        ca-certificates \
        curl \
        git \
        gnupg \
        iproute2 \
        iputils-ping \
        jq \
        less \
        netcat-openbsd \
        openssh-client \
        procps \
        python3 \
        python3-dev \
        python3-venv \
        unzip \
        xz-utils \
        zip; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------- 2) nvm + node LTS
# nvm 装在 /usr/local/nvm（全局、与用户无关），node 由 nvm 管理。
# PROFILE=/dev/null：不让 nvm 安装脚本去改 profile，初始化由本镜像自己统一写。
RUN set -eux; \
    mkdir -p "$NVM_DIR"; \
    curl -fsSL --retry 3 --retry-delay 2 --retry-connrefused \
        -o /tmp/nvm-install.sh "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh"; \
    PROFILE=/dev/null NVM_DIR="$NVM_DIR" bash /tmp/nvm-install.sh; \
    rm -f /tmp/nvm-install.sh; \
    . "$NVM_DIR/nvm.sh"; \
    nvm install "$NODE_VERSION"; \
    nvm alias default "$NODE_VERSION"; \
    node --version; \
    npm --version

# ---------------------------------------------------------------- 3) pnpm + pi CLI
# 两者都是 npm 全局包，装在 nvm 的 node 目录下，随 nvm 切换版本。
RUN set -eux; \
    . "$NVM_DIR/nvm.sh"; \
    npm install -g "pnpm@${PNPM_VERSION}"; \
    npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}"; \
    pnpm --version; \
    pi --version; \
    rm -rf /root/.npm

# ---------------------------------------------------------------- 4) uv
# 官方安装脚本，UV_INSTALL_DIR 指定落到 /usr/local/bin（系统路径，任何 shell 都能用）。
ENV UV_INSTALL_DIR=/usr/local/bin \
    UV_NO_MODIFY_PATH=1
RUN set -eux; \
    curl -LsSf --retry 3 --retry-delay 2 --retry-connrefused \
        "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh; \
    uv --version; \
    uvx --version

# ---------------------------------------------------------------- 5) Playwright chromium
# 只装 chromium（+ chromium_headless_shell）；firefox / webkit 不装，体积优先。
# --with-deps 会用 apt 装 chromium 的系统依赖库。
RUN set -eux; \
    . "$NVM_DIR/nvm.sh"; \
    npm install -g "playwright@${PLAYWRIGHT_VERSION}"; \
    mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    playwright install --with-deps chromium; \
    rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache; \
    ls -1 "$PLAYWRIGHT_BROWSERS_PATH"

# ---------------------------------------------------------------- 6) 全局可执行入口
# /usr/local/bin 下的软链保证非交互式 shell（docker exec ... bash -c）也能直接用这些命令。
COPY bin/nvm /usr/local/bin/nvm
RUN set -eux; \
    chmod 0755 /usr/local/bin/nvm; \
    NODE_BIN="$NVM_DIR/versions/node/v${NODE_VERSION}/bin"; \
    for cmd in node npm npx corepack pnpm pnpx pi playwright; do \
        if [ -e "$NODE_BIN/$cmd" ]; then ln -sf "$NODE_BIN/$cmd" "/usr/local/bin/$cmd"; fi; \
    done; \
    mkdir -p /usr/local/etc/bash_completion.d; \
    ln -sf "$NVM_DIR/bash_completion" /usr/local/etc/bash_completion.d/nvm

# ---------------------------------------------------------------- 7) 交互式 shell 初始化
# 容器入口执行 `exec bash -i`（交互式非登录 shell），只读 ~/.bashrc，
# 所以 nvm 的初始化必须落到 /root/.bashrc；/etc/profile.d 那份覆盖登录 shell。
COPY bashrc.d/nvm.sh /etc/profile.d/sandbox-platform-nvm.sh
RUN set -eux; \
    printf '\n# --- sandbox-platform: nvm / node toolchain ---\n' >> /root/.bashrc; \
    printf '. /etc/profile.d/sandbox-platform-nvm.sh\n' >> /root/.bashrc

WORKDIR /workspace
