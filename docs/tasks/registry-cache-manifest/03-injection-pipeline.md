---
prd: prds/registry-cache-manifest.md
status: todo
---
# 任务：注入管线（SANDBOX_IMAGE_CACHE_URL / TOKEN 平台强制注入）

> 需求见 [[prds/registry-cache-manifest.md|镜像缓存清单与缓存优先拉取引导 PRD]]。
> 依赖 02 的凭据文件与中间件行为。
> 注入口径先例：`SANDBOX_NETWORK` / locale 的**平台强制注入**（`_run_sandbox_container`，创建与重启两条路径共用，平台值优先、不进 metadata）——本轮完全同款。
> 递参先例：模板注入——服务端读自己的状态、以参数递核心包执行，**核心包不知业务存在**。

## 目标

### 一、服务端递参（创建 + 启动两条路径）

- **创建沙箱**时把「可达地址 + 受限令牌」作为**可选创建参数**递给核心包创建接口（按模板注入先例的同一递参位置，`routes/sandboxes.py` 与会话装配逻辑，实现时对齐）；**启动（重启）路径同样递参**——服务端两个值都可随时重推导（URL 由配置 / 探测得出、令牌从自己的凭据文件读出），故**两值不进 metadata**；
- 令牌值来源 = 02 的 `cache-images-token.json`（文件缺失 / 损坏时按 02 口径走——受限读径本就 401，注入跳过或注入空值不阻塞创建，实现时定并写明）。

### 二、可达地址解析

- 新可选配置项 **`SANDBOX_CONSOLE_SANDBOX_URL`** 优先（服务端 `os.environ` 惯例读取处）；
- 未配置 → **宿主 IP 自动探测兜底**：宿主**非回环 IPv4** + 实际监听端口拼 `http://`（沙箱容器 → 宿主后端实测仅宿主 LAN IP 一条路可达）；
- 两者皆不可得 → **跳过注入并打日志**，**创建不失败**（与 CLI 路径同归缺 env 边角）。

### 三、核心包平台强制注入

- `apps/core/src/sandbox_platform/lifecycle.py` 的 **`_run_sandbox_container`**（创建与启动两条路径共用）**平台强制注入**两个 env（命名沿用 `SANDBOX_` 前缀惯例，仿 `SANDBOX_NETWORK_ENV` 注入口径）：
  - `SANDBOX_IMAGE_CACHE_URL`——后端可达地址；
  - `SANDBOX_IMAGE_CACHE_TOKEN`——受限令牌；
- 四口径：**平台值优先**（覆盖用户声明的同名变量）、**不进 metadata**（详情接口 env 只回用户声明键）、创建 / 启动双路径覆盖、常量命名对齐既有 `*_ENV` 惯例。

### 四、已知边角钉行为（非缺陷）

- **CLI 创建路径不传参 → 沙箱缺这对 env**（行为与现状一致）；console 对该沙箱执行一次「停止 → 启动」（重启）即自愈（启动路径重装配容器重新注入）；
- 对称的另一半同样成立：**CLI 直接 start 也不传参、env 缺失**——同一边角，**文档写明随 06 落**（PRD 29），本任务钉行为。

### 五、单测

- 服务端：递参（创建 + 启动两路径）、地址解析优先级（配置优先 → 探测兜底 → 皆不可得跳过且创建不失败）、两值不进 metadata；
- 核心包：两条路径注入在场、平台值优先覆盖用户同名声明、不进 metadata。

## 完成标准

- [ ] （PRD 16）**console 创建沙箱**：容器内 `SANDBOX_IMAGE_CACHE_URL` / `SANDBOX_IMAGE_CACHE_TOKEN` 在场（`docker inspect` 可验，真机记录）；两值**不进**沙箱 metadata（详情接口 env 只回用户声明键，单测 + 真机记录）。
- [ ] （PRD 17）**平台值优先**：创建参数 env 声明同名键 → 容器内取**平台值**（单测；对齐 `SANDBOX_NETWORK` / locale 口径）。
- [ ] （PRD 18）**可达地址解析**：`SANDBOX_CONSOLE_SANDBOX_URL` 配置项优先（单测）；未配置 → 宿主非回环 IPv4 + 实际监听端口自动探测兜底（**真机验证**：沙箱内 curl 可达后端，记录）；两者皆不可得 → 跳过注入打日志、**创建不失败**（单测）。
- [ ] （PRD 19）**自愈口径**：CLI 创建的沙箱缺这对 env（已知边角，行为与现状一致）；console 对该沙箱「停止 → 启动」一次后 env 在场（服务端 start 路径递参 + 核心包重装配注入，真机实测记录）；CLI 直接 start 仍缺 env——行为钉住，文档表述随 06 落。
- [ ] （PRD 20）**令牌轮换**：重写凭据文件后旧令牌立即 401（02 的行为，此处真机复验）；console 重启（停止 → 启动）一次后 `docker inspect` 两 env 为新值（真机记录）；既有沙箱内 cached-images 降级表现随 06 端到端复验（依赖 04 镜像就绪）。
- [ ] 门禁：服务端 + 核心包 pytest 全绿（各 ≥ 基线）+ 两包 ruff rc=0；`apps/cli` 零改动。

## 依赖

- 依赖 [[tasks/registry-cache-manifest/02-server-endpoint-and-token.md|02 服务端端点与受限令牌]]（凭据文件与中间件行为；令牌值来源）。
- 对 01 无直接代码依赖。
- 需求：[[prds/registry-cache-manifest.md|镜像缓存清单与缓存优先拉取引导 PRD]]。
