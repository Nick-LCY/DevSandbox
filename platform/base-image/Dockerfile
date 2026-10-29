# 平台基础镜像 sandbox-platform/base
# （不写 # syntax 指令：BuildKit 内置前端即可满足，无外网构建时不必去仓库拉取前端镜像）
# 内容：bash + docker 客户端 + 纯 bash 入口脚本 + /workspace 便捷空目录
# 约束：
#   1) 所有 RUN 步骤不触网，构建命令显式带 --network=none；
#   2) 镜像内不内置任何 volume 挂载点（无 VOLUME 指令、无预置宿主机挂载目录）；
#   3) docker 客户端版本必须与宿主守护进程一致（ARG 化，改版本只需改构建参数）；
#   4) 镜像内不含任何离线依赖包（0.2.0 起废弃）：依赖镜像统一经宿主统一镜像代理
#      缓存拉取，见 ADR 0008。
#
# 构建：
#   docker build --network=none \
#     --build-arg DOCKER_CLI_VERSION=29.6.2 \
#     -t sandbox-platform/base:0.2.0 platform/base-image

# 客户端版本：与宿主 dockerd 版本保持一致（client/server 版本一致性是验收判据）
ARG DOCKER_CLI_VERSION=29.6.2
# 底座：体积优先的精简发行版
ARG BASE_IMAGE=debian:bookworm-slim
# 镜像版本号，仅用于 OCI label
ARG BASE_VERSION=0.2.0

# ---------------------------------------------------------------- 阶段 1：抠 docker 客户端
# 官方 docker 客户端镜像里的 /usr/local/bin/docker 是静态编译的 Go 二进制，可直接跨发行版使用
FROM docker:${DOCKER_CLI_VERSION}-cli AS dockercli

# ---------------------------------------------------------------- 阶段 2：最终镜像
FROM ${BASE_IMAGE} AS base

# 全局 ARG 在 FROM 之后不可见，需在构建阶段内重新声明
ARG DOCKER_CLI_VERSION
ARG BASE_VERSION

LABEL org.opencontainers.image.title="sandbox-platform/base" \
      org.opencontainers.image.description="平台基础镜像：bash + docker 客户端 + /workspace 便捷空目录" \
      org.opencontainers.image.version="${BASE_VERSION}" \
      io.sandbox-platform.docker-client.version="${DOCKER_CLI_VERSION}"

# docker 客户端（静态二进制，无外部运行库依赖）
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

# 入口脚本（纯 bash）
COPY entrypoint.sh /entrypoint.sh

# 本地文件操作，不触网：脚本可执行位 + /workspace 便捷空目录（容器层目录，非 volume）
RUN set -eux; \
    chmod 0755 /entrypoint.sh; \
    mkdir -p /workspace; \
    chmod 1777 /workspace

WORKDIR /workspace

# 入口固定为纯 bash 脚本：docker 客户端存在则 exec 交互式 bash，不存在则报错并以 127 退出
ENTRYPOINT ["/entrypoint.sh"]
