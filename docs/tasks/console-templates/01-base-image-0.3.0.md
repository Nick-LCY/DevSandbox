---
prd: prds/console-templates.md
status: todo
---
# 任务：基础镜像 0.3.0 通用工具层

## 目标
在平台基础镜像上补齐 9 个通用工具包，版本从 0.2.0 升到 0.3.0：git、openssh-client、vim、curl、ca-certificates、unzip、xz-utils、procps、less。构建方式同步从「零网络」改为「联网 apt 拉包」，判定脚本扩到 42 项并把体积、耗时、分层实测留档。

## 完成标准
- [ ] `platform/base-image/Dockerfile` 增加 apt 安装层，装齐 9 个工具包，带 `--no-install-recommends`。
- [ ] 安装与清理（apt 索引清空）在同一层内完成，镜像里不残留 apt 索引。
- [ ] 镜像版本参数改为 `ARG BASE_VERSION=0.3.0`，镜像标签的版本信息随之更新。
- [ ] Dockerfile 头注释的构建口径由「所有 RUN 步骤不触网、构建显式带 `--network=none`」改为联网 apt 拉包，并给出新的构建命令。
- [ ] `docker build --build-arg DOCKER_CLI_VERSION=29.6.2 -t sandbox-platform/base:0.3.0 platform/base-image` 构建成功。
- [ ] `platform/base-image/verify.sh` 默认校验镜像改为 `sandbox-platform/base:0.3.0`。
- [ ] 判定脚本删掉「镜像内无 git」「镜像内无 curl」两条否定断言。
- [ ] 判定脚本新增 9 条「已安装且有版本输出 + 命令在 PATH」判定，命令名与包名的对应关系为：git→git、openssh-client→ssh、vim→vim、curl→curl、ca-certificates→`/etc/ssl/certs/ca-certificates.crt` 存在、unzip→unzip、xz-utils→xz、procps→ps、less→less。
- [ ] 判定总数为 42 项（35 项原有判定 − 2 条被删的否定断言 + 9 条新增判定），全部通过。
- [ ] `platform/base-image/README.md` 更新镜像内容口径与构建命令。
- [ ] `platform/base-image/RESULTS.md` 补 0.3.0 的镜像体积、构建耗时与分层实测数据。
- [ ] `sandbox-platform/base:0.2.0` 镜像本身、`platform/sandbox-image/` 目录、`platform/src/sandbox_platform/config.py` 的 `DEFAULT_IMAGE` 与 `DEFAULT_LOCAL_IMAGE_PREFIXES` 零改动。
- [ ] 留档的体积数字与 `docker image inspect` 的实际输出一致。

## 依赖
- 无前置任务依赖。基础镜像在 [[prds/sandbox-platform.md|一期 PRD]] 里定型、在 [[architecture/decisions/0008-统一镜像代理与离线包废弃.md|ADR 0008]] 里改为不含离线包，本任务沿用现状演进。
- 需求来源见 [[prds/console-templates.md|控制台模板轮 PRD]] 的工作包一。

## 实施要点

### Dockerfile 改动
- 新增一层 `apt-get update` + `apt-get install -y --no-install-recommends` + `rm -rf /var/lib/apt/lists/*`，三层写在同一个 `RUN` 里，保证索引清理与安装同层生效，镜像里不留包索引。
- 9 个包名与后续判定用的命令名不是一一对应：`openssh-client` 提供 `ssh`、`xz-utils` 提供 `xz`、`procps` 提供 `ps`、`ca-certificates` 不提供命令而提供证书文件 `/etc/ssl/certs/ca-certificates.crt`。
- `ARG BASE_VERSION` 从 0.2.0 改 0.3.0，该参数只写入 OCI label 的版本信息与构建口径文档，不参与 apt 内容。
- 底座仍是 `debian:bookworm-slim`，Docker 客户端仍走 `docker:${DOCKER_CLI_VERSION}-cli` 静态二进制复制，两者的既有口径不变。

### 构建口径变更
- 0.2.0 时代的「所有 RUN 步骤不触网、构建命令显式带 `--network=none`」口径作废：apt 拉包必须联网，构建命令不再带 `--network=none`。
- 头注释里的构建示例同步改成新命令，并写明版本号与工具包清单。

### 判定脚本改动
- 「业务运行时缺席」那一段里，git 与 curl 两条否定断言删除（这两个命令现在应当在镜像内），其余缺席断言（node、pnpm、python3、psql、mc 等）保持不变。
- 新增一段「通用工具在场」判定：逐个断言命令在 PATH 且 `--version` 一类命令有版本输出；`ca-certificates` 断言证书文件存在。
- 判定总数从 35 变 42，脚本末尾的汇总行沿用现有格式自动打印总数与不通过数。

## 留档指引
- 镜像内容口径、构建命令与套接字约定：`platform/base-image/README.md`。
- 镜像体积、构建耗时与分层实测：`platform/base-image/RESULTS.md`。
- 镜像两层契约（基础镜像只含客户端与工具层、不含业务运行时）：[[prds/sandbox-platform.md|一期 PRD]]。
