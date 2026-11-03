---
prd: prds/phase3-desktop.md
status: done
---
# 任务：端口转发核心包能力（转发容器编排 / 生命周期与清理）

> **修订注（2026-11-03，用户拍板 · 决策 C）**：本任务按 [[architecture/decisions/0014-端口转发机制选型.md|ADR 0014]] 第二次修订（链路两点化、**后端宿主机零端口**）**重写**。相对原口径的变化：
> ① **删除宿主端口分配与端口区间**（原 `SANDBOX_FORWARD_PORT_RANGE` / 默认 `18000-18999`、端口占位、绑定失败换端口重试）；
> ② **删除 `-p` 端口发布步骤**——转发容器**无端口发布**，只接沙箱网络、常驻不监听；
> ③ **转发记录去掉 `host_port` 字段**（改为 id / sandbox / container_port / state / created_at / updated_at）；
> ④ **不再依赖任务 01 的 P1 裁决**（P1 已实测 `-p` 可用，但路径不采用；本期唯一通道是 `docker exec -i` 字节泵，见 [[tasks/phase3-desktop/05-port-forward-server-api.md|05 端口转发服务端接口]]）；
> ⑤ **生命周期语义保留**（幂等建立、停止即删容器删记录、沙箱删除纳入回收、服务重启清理遗留）。
> 原口径中被删除的条目在上文逐条列出（留档），**其余条款照旧**。

## 目标

在控制面核心包 `sandbox_platform` 里落一条可复用的端口转发编排能力：转发容器起停、平台标签枚举、以及删除沙箱 / 服务重启时的清理钩子。**后端宿主不持有任何转发端口**——本期链路只有「沙箱 ⇄ 用户机」两点，后端宿主是纯中继（隧道服务与字节泵），既不发布端口也不监听端口。命令行与服务端本期都不接（命令行零改动是 ADR 0009 的既有口径；**CLI 接转发需先服务化，本期不做**，架构上不排除后续）。

## 涉及文件

- 新增 `apps/core/src/sandbox_platform/forwarding.py` — 转发编排核心
- 改 `apps/core/src/sandbox_platform/__init__.py` — 导出公开符号
- 改 `apps/core/src/sandbox_platform/config.py` — 转发相关配置（转发镜像 digest、转发容器名模板）
- 改 `apps/core/src/sandbox_platform/lifecycle.py` — 删除沙箱时回收转发容器；`reclaim_plan` 增列
- 改 `apps/core/src/sandbox_platform/errors.py` — `ForwardError` 归位到错误模块（审查修复轮补）
- 新增 `apps/core/tests/test_forwarding.py` — 单元测试
- 改 `apps/core/tests/` 下与回收清单相关的既有用例（回收清单结构变了）
- 改 `apps/web/backend/API.md` — 新增核心包转发模块章节

## 实施步骤

1. **配置**：`SANDBOX_FORWARD_IMAGE`（钉 digest）、转发容器名模板。**不设端口区间配置**（宿主侧无端口）。
   > **落地口径（2026-11-03）**：两个环境变量最终为 **`SANDBOX_PLATFORM_FORWARD_IMAGE`** / **`SANDBOX_PLATFORM_FORWARD_CONTAINER_TEMPLATE`**（前缀与核心包既有 `SANDBOX_PLATFORM_*` 口径一致），与本条初稿的 `SANDBOX_FORWARD_IMAGE` 不同——详见文末「进展」。
2. **容器编排**（`PortForwardManager`）：
   - 容器名 `<沙箱名>-fwd-<端口>`；标签 `sandbox-platform.role=forward`、`sandbox-platform.forward.id=<id>`、`sandbox-platform.forward.sandbox=<沙箱名>`；
   - 镜像经统一镜像代理在沙箱守护进程内拉取；
   - **无端口发布**：不传 `-p`，不发布任何端口；容器主进程**常驻不监听**（空转即可，如 `tail -f /dev/null`）；`socat` 二进制由镜像提供，专供 exec 字节泵使用；`--restart=no`（**镜像的 ENTRYPOINT 是 `socat`，必须显式覆盖 entrypoint 与命令**，见 [[tasks/phase3-desktop/RESULTS.md|三期留档]] 第 6.1 节）；
   - **由沙箱的免 root 守护进程启动**（`daemon_for(sandbox)`），与沙箱容器同网络；
   - **不发布端口 ⇒ 无「绑定失败换端口重试」这一分支**（原口径随 `-p` 一并废除）。
3. **转发记录**：落 `<平台数据根>/forwards/<id>.json`（`0600`，原子替换），字段：**id / sandbox / container_port / state / created_at / updated_at**（**无 `host_port`**——宿主侧不再有端口，本机端口由桌面端持有、不进平台记录）。
   > **落地口径（2026-11-03）**：记录另增 **`host_pid`**（建这条记录的服务进程号），**跨实例清理保护必需**；仍然**没有 `host_port`**——详见文末「进展」。
4. **生命周期**：
   - 建立：幂等（同名同端口容器已存在则复用）；
   - 停止：停并删容器 + 删记录；
   - 沙箱停止 → 该沙箱转发容器一并停止（记录保留）；
   - 沙箱启动 → 不自动重建，隧道建立时幂等重建；
   - **沙箱删除 → 转发容器与记录纳入回收**（`reclaim_plan` 增列、删除流程增回收）；
   - **服务重启 → 全部转发会话丢失**，启动时清理遗留转发容器与记录（对齐 `purge_leftover_sessions` 的做法）。
5. **测试**：容器名 / 标签 / 命令构造、**无 `-p` 参数**的断言、记录读写与原子性、幂等建立、沙箱停止 / 删除的收敛、遗留清理。

## 完成标准

- [x] 新增 `apps/core/src/sandbox_platform/forwarding.py`，公开转发编排、记录读写、清理三类能力（**不含端口分配**）。
- [x] 转发容器由**沙箱自己的免 root 守护进程**启动、接入沙箱网络、带平台标签；**不发布任何端口**（无 `-p`、无监听）；沙箱容器与依赖容器零改动。
- [x] 转发记录落 `<平台数据根>/forwards/<id>.json`（`0600`），字段为 id / sandbox / container_port / state / created_at / updated_at（**无 `host_port`**；落地另增 `host_pid`，见文末「进展」），写入走原子替换。
- [x] 删除沙箱时转发容器与转发记录被回收，且出现在 `reclaim_plan` 的回收清单里（既有回收清单断言的用例已同步更新）。
- [x] 提供「清理上次遗留转发容器与记录」的入口，供服务端启动时调用（与终端会话的遗留清理同款语义）。
- [x] 核心包 pytest 全绿且新增转发用例；ruff（`E4/E7/E9/F`）退出码 0；分层契约测试红线不触发。
- [x] 命令行 `apps/cli/` 零改动（**CLI 接转发需先服务化，ADR 0009 口径，本期不做**）。
- [x] `apps/web/backend/API.md` 新增核心包转发模块章节，写清接口签名、容器命名与标签、**无端口发布**的容器规格、生命周期语义（**不写端口分配口径**）。

## 依赖

- 机制依据：[[architecture/decisions/0014-端口转发机制选型.md|ADR 0014]]（第二次修订，决策 C）。
- **不再依赖任务 01 的 P1 裁决**：P1 已实测 `-p` 在本平台可用（[[tasks/phase3-desktop/RESULTS.md|三期留档]]），但按决策 C **不采用**该路径；本期唯一通道是 `docker exec -i` 字节泵（由 [[tasks/phase3-desktop/05-port-forward-server-api.md|05 端口转发服务端接口]] 使用）。
- 后续任务：[[tasks/phase3-desktop/05-port-forward-server-api.md|05 端口转发服务端接口]] 依赖本任务。

## 进展（2026-11-03）

**状态：done。** 已实现并通过「审查 + 修复轮」，命令行零改动。

### 实现摘要

- 新增 `apps/core/src/sandbox_platform/forwarding.py`：`PortForwardManager`（转发容器编排、标签枚举、exec 字节泵、清理钩子）+ `ForwardStore`（转发记录原子读写）+ `ForwardRecord` / `ForwardOpResult` / `BytePump` 三个数据类。
- **转发容器**：由**沙箱自己的免 root 守护进程**起、接沙箱网络、带三个平台标签（`sandbox-platform.role=forward`、`sandbox-platform.forward.id`、`sandbox-platform.forward.sandbox`）；**无 `-p`、不发布任何端口**，主进程 `tail -f /dev/null` **常驻空转**（不监听任何端口），镜像 ENTRYPOINT 被显式覆盖为 `/bin/sh`（镜像默认是 `socat`，不覆盖就会把 socat 当监听命令跑起来）。
- **字节通道**：`docker exec -i <转发容器> socat - TCP:<沙箱容器>:<端口>`；`BytePump` 按**进程组**回收 exec 进程，不留僵尸与孤儿孙进程，且是上下文管理器（异常路径也回收）。
- **转发记录**：落 `<平台数据根>/forwards/<id>.json`（`0600`，目录 `0700`，临时文件 + `os.replace` 原子替换）；标识取 `uuid4().hex` 前 12 位，非法标识一律拒收（校验在载入侧也做一遍）。
- **生命周期**：建立幂等（同一沙箱同一端口复用记录与容器）；停止 = 删容器 + 删记录（**容器未确认删掉就不删记录**）；沙箱停止 → 转发容器一并停止、**记录保留**；沙箱删除 → 转发容器与转发记录纳入 `reclaim_plan` 一并回收（**排在网络删除之前**，否则网络删不掉）；服务重启 → `purge_leftover()` 清遗留容器、记录与 `.forward-*.tmp` 残留。
- **接口文档**：`apps/web/backend/API.md` 新增 `6ter. forwarding.py` 章节。

### 审查修复轮

- **3 Critical**：① **畸形记录不拖垮删除流程**（JSON 解析失败 / 内容不是 JSON 对象 / 标识或端口非法——三种都只告警跳过，不中断整批枚举）；② **非法转发标识一律跳过**，不流到删除路径上；③ **同名非平台容器绝不误删**（不带平台标签的容器抛 `ForwardError`，交回用户处理，平台不碰）。
- **7 Warning**：① 容器删不掉时**保留记录**并如实报进 `failed`；② **跨实例保护**（记录带 `host_pid`，归属进程仍存活的转发——别的服务实例正在用——记录与容器都跳过不删）；③ 字节泵按**进程组**回收；④ 环境变量前缀归一为 `SANDBOX_PLATFORM_FORWARD_*`；⑤ **转发容器不算依赖容器**（网络扫描时按 `sandbox-platform.role=forward` 标签剔除，避免同一批容器在回收清单里出现两次；它在清单里以独立条目出现）；⑥ `create` 加进程内并发锁（同名沙箱操作串行）；⑦ `ForwardError` 归位到 `errors.py`。

### 门禁

- 核心包 pytest：**288 passed**（含**新增 38 条**转发用例，`apps/core/tests/test_forwarding.py`）。
- ruff（`E4/E7/E9/F`）：退出码 **0**。
- 分层契约测试：红线不触发。
- 命令行 `apps/cli/`：**零改动**。

### 与任务文件的两处既定偏差（均已落账 `API.md`）

1. **环境变量名**：本文件初稿写 `SANDBOX_FORWARD_IMAGE`，落地为 **`SANDBOX_PLATFORM_FORWARD_IMAGE`**；转发容器名模板同理，落地为 **`SANDBOX_PLATFORM_FORWARD_CONTAINER_TEMPLATE`**（与核心包既有 `SANDBOX_PLATFORM_*` 前缀口径一致）。
2. **转发记录新增 `host_pid` 字段**：字段集在「id / sandbox / container_port / state / created_at / updated_at」之外增加 **`host_pid`**（建这条记录的服务进程号），**跨实例保护必需**——清理遗留转发时用它判归属，归属进程仍存活的转发记录与容器都跳过不删。**仍然没有 `host_port`**（链路两点化，后端宿主零端口）。
