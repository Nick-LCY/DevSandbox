---
prd: prds/registry-cache-manifest.md
status: todo
---
# 任务：基础镜像 base:0.4.0 与 cached-images 命令

> 需求见 [[prds/registry-cache-manifest.md|镜像缓存清单与缓存优先拉取引导 PRD]]。
> **硬约束**：纯 bash、**不解析 JSON、不依赖 jq**（基础镜像只有 curl）；对后端调用显式 `--noproxy`——沙箱 env 里有代理变量，平台后端调用不走镜像代理。
> **现有沙箱重建由用户完成**（外部依赖，登记为验收前置——同上一轮口径：平台自建镜像只存宿主 root 守护进程、沙箱守护进程经核心包注入，存量沙箱不会自动拿到新镜像）。

## 目标

### 一、`cached-images` 命令（纯 bash，镜像内 PATH，如 `/usr/local/bin/cached-images`）

- `curl` 拉 `$SANDBOX_IMAGE_CACHE_URL/api/proxy/cache/images?format=text` **直接输出**（文本格式原样吐，零解析）；显式 **`--noproxy '*'`** 绕过 HTTP(S)_PROXY；curl **连接 5s / 总 10s 封顶**，不挂 shell；
- **三态**：
  - ① 正常——输出清单文本，退出 **0**；
  - ② 缺凭据 / 缺 URL（env 缺失）——一行明确中文提示 + **固定非零退出码**（与 ③ 不同，两个退出码**写进帮助文本**）；
  - ③ 不可达 / 超时——明确中文提示 + **固定非零退出码**；
  - 任何失败态**不阻塞**：提示 agent 回退正常拉取（不阻塞后续 `docker pull`）；
- **引导约定承载**：命令输出尾部 / 帮助文本提示「拉依赖镜像前先查清单、可接受版本集合中优先选已缓存版本」——**模板无指令字段，不塞模板**。

### 二、版本 bump 与文档

- `base-image/Dockerfile`：`ARG BASE_VERSION` **0.3.1 → 0.4.0**（新增命令，minor bump，按仓库惯例）、LABEL 同步、命令 COPY 进镜像（PATH 内）；
- `base-image/README.md`：命令用法、三态与两个退出码、`--noproxy` 说明、引导约定、**存量沙箱口径**（升级前创建的沙箱不带命令，重建至 `base:0.4.0` 后在场——PRD 26）。

### 三、构建与判定

- 宿主构建 `sandbox-platform/base:0.4.0`（**平台自建镜像不经统一镜像代理分发**——由宿主构建注入沙箱守护进程，ADR 0008 既有口径）；
- `base-image/verify.sh` 判定新增项（≥3 项：命令在 PATH、缺凭据态退出码、帮助文本含两个退出码）并全量通过（正常态 / 不可达态需活后端，真机验证见完成标准）。

## 完成标准

- [ ] （PRD 22）`base:0.4.0`（0.3.1 → minor bump）构建成功：Dockerfile ARG / LABEL 同步 bump；`cached-images` 在镜像 PATH 内；纯 bash、**不解析 JSON、不依赖 jq**（脚本内零 jq、零 JSON 解析构造）；对后端调用显式 **`--noproxy`**。
- [ ] （PRD 23）**三态·正常**：env 在场且端点可达 → 输出清单文本（含仓库 / 标签 / 摘要 / 大小 / 时间）+ 退出 0（真机实测记录；与端点 text 内容的一致性另由 06 的 PRD 21 端到端钉）。
- [ ] （PRD 24）**三态·缺凭据**：env 缺失 → 一行明确中文提示 + 固定非零退出码（与不可达的退出码**不同**、写进帮助文本），提示直接正常拉取（verify.sh 判定 + 真机实测记录）。
- [ ] （PRD 25）**三态·不可达**：连不上或超时（curl 连接 5s / 总 10s 封顶，不挂 shell）→ 明确中文提示 + 固定非零退出码，不阻塞后续 `docker pull`（真机实测记录，含耗时上限观察）。
- [ ] （PRD 26）**存量沙箱口径**写进 `base-image/README.md`（升级前创建的沙箱不带命令，重建至 `base:0.4.0` 后在场）；**现有沙箱重建由用户执行**（本任务不代劳），登记为验收前置（06 的端到端 21、26、30 硬前置）。
- [ ] `verify.sh` 全量判定通过（含新增判定项）。
- [ ] 门禁：`apps/core`、`apps/web/backend`、`apps/cli`、前端**零改动**（本轮只动 `base-image/`）。

## 依赖

- 依赖 [[tasks/registry-cache-manifest/02-server-endpoint-and-token.md|02 服务端端点与受限令牌]]（正常态 / 不可达态真机验证需端点与受限令牌在场；**脚本编写、Dockerfile 与镜像构建本身不被阻塞，可先行**）。
- 需求：[[prds/registry-cache-manifest.md|镜像缓存清单与缓存优先拉取引导 PRD]]。
