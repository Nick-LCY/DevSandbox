---
prd: prds/phase3-desktop.md
status: todo
---
# 任务：端口转发核心包能力（转发容器编排 / 宿主端口分配 / 生命周期与清理）

## 目标

在控制面核心包 `sandbox_platform` 里落一条可复用的端口转发编排能力：转发容器起停、宿主回环端口分配与占位、平台标签枚举、以及删除沙箱 / 服务重启时的清理钩子。命令行与服务端本期都不接（命令行零改动是 ADR 0009 的既有口径）。

## 涉及文件

- 新增 `apps/core/src/sandbox_platform/forwarding.py` — 转发编排核心
- 改 `apps/core/src/sandbox_platform/__init__.py` — 导出公开符号
- 改 `apps/core/src/sandbox_platform/config.py` — 转发相关配置（宿主端口区间、转发镜像、内部端口）
- 改 `apps/core/src/sandbox_platform/lifecycle.py` — 删除沙箱时回收转发容器；`reclaim_plan` 增列
- 新增 `apps/core/tests/test_forwarding.py` — 单元测试
- 改 `apps/core/tests/` 下与回收清单相关的既有用例（回收清单结构变了）
- 改 `apps/web/backend/API.md` — 新增核心包转发模块章节

## 实施步骤

1. **配置**：`SANDBOX_FORWARD_PORT_RANGE`（默认 `18000-18999`）、`SANDBOX_FORWARD_IMAGE`（钉 digest）、转发容器内部端口常量。
2. **容器编排**（`PortForwardManager`）：
   - 容器名 `<沙箱名>-fwd-<端口>`；标签 `sandbox-platform.role=forward`、`sandbox-platform.forward.id=<id>`、`sandbox-platform.forward.sandbox=<沙箱名>`；
   - 镜像经统一镜像代理在沙箱守护进程内拉取；
   - 命令 `socat TCP-LISTEN:<内部端口>,fork,reuseaddr TCP:<沙箱容器名>:<端口>`；`--restart=no`；
   - **由沙箱的免 root 守护进程启动**（`daemon_for(sandbox)`），与沙箱容器同网络；
   - 端口发布 `-p 127.0.0.1:<宿主端口>:<内部端口>`（**若 P1 裁决为 Fallback B，则改为 `docker exec -i` 字节泵实现，接口不变**）。
3. **宿主端口分配**：先探测端口可绑定，再分配；分配结果记进转发记录形成占位；启动转发容器时绑定失败 → 换端口重试；仍失败 → 明确错误。
4. **转发记录**：落 `<平台数据根>/forwards/<id>.json`（`0600`，原子替换），字段：id / sandbox / container_port / host_port / state / created_at / updated_at。
5. **生命周期**：
   - 建立：幂等（同名同端口容器已存在则复用）；
   - 停止：停并删容器 + 释放宿主端口 + 删记录；
   - 沙箱停止 → 该沙箱转发容器一并停止（记录保留）；
   - 沙箱启动 → 不自动重建，隧道建立时幂等重建；
   - **沙箱删除 → 转发容器与记录纳入回收**（`reclaim_plan` 增列、删除流程增回收）；
   - **服务重启 → 全部转发会话丢失**，启动时清理遗留转发容器与记录（对齐 `purge_leftover_sessions` 的做法）。
6. **测试**：容器名 / 标签 / 命令构造、端口分配与重试、记录读写与原子性、幂等建立、沙箱停止 / 删除的收敛、遗留清理。

## 完成标准

- [ ] 新增 `apps/core/src/sandbox_platform/forwarding.py`，公开转发编排、端口分配、记录读写、清理四类能力。
- [ ] 转发容器由**沙箱自己的免 root 守护进程**启动、接入沙箱网络、带平台标签；沙箱容器与依赖容器零改动。
- [ ] 宿主端口自动分配并占位；绑定失败换端口重试；分配结果落进转发记录。
- [ ] 转发记录落 `<平台数据根>/forwards/<id>.json`（`0600`），写入走原子替换。
- [ ] 删除沙箱时转发容器与转发记录被回收，且出现在 `reclaim_plan` 的回收清单里（既有回收清单断言的用例已同步更新）。
- [ ] 提供「清理上次遗留转发容器与记录」的入口，供服务端启动时调用（与终端会话的遗留清理同款语义）。
- [ ] 核心包 pytest 全绿且新增转发用例；ruff（`E4/E7/E9/F`）退出码 0；分层契约测试红线不触发。
- [ ] 命令行 `apps/cli/` 零改动。
- [ ] `apps/web/backend/API.md` 新增核心包转发模块章节，写清接口签名、容器命名与标签、端口分配口径、生命周期语义。

## 依赖

- 依赖 [[tasks/phase3-desktop/01-prototype-and-spike.md|01 打样轮]] 的 **P1 裁决**（`-p` 主路径 vs Fallback B）——结论直接决定第 2 步的实现方式。
- 机制依据：[[architecture/decisions/0014-端口转发机制选型.md|ADR 0014]]。
- 后续任务：[[tasks/phase3-desktop/05-port-forward-server-api.md|05 端口转发服务端接口]] 依赖本任务。
