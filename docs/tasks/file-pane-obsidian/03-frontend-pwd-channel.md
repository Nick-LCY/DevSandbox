---
prd: prds/file-pane-obsidian.md
status: todo
---
# 任务：前端 pwd 通道（OSC 解析与按会话缓存）

> 需求见 [[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
> **依赖 01 的实测结论**（注入写法 / 降级表现 / 重连恢复方案）与 **02 的镜像注入**（真沙箱要能收到上报才能端到端复验；**实现层面与 02 可并行**）。

## 目标

在前端把 OSC 1337 的 `CurrentDir` 序列接成一条**可靠的 pwd 通道**，供文件窗格定位与回跳使用。

- **解析**：用 xterm.js 的 `term.parser.registerOscHandler(1337, cb)` 接管，**不手写字节流扫描器**——xterm 的状态机负责跨帧序列边界；
- **纯函数化**：解析逻辑收敛为 `src/lib` 下的**独立纯函数模块**并配**单元测试**（解析 `1337;CurrentDir=<path>`、校验绝对路径、过一遍既有 `normalizeContainerPath`）；
- **不引入新的解码口径**：终端帧处理**不得**引入逐帧 `TextDecoder`（既有 TODO「终端中文间歇乱码」点名的正是这一片区域）；
- **生命周期**：pwd 是**纯前端产物**——按会话在前端内存缓存，**后端会话记录不加字段**；断线重连后触发一次**提示符刷新**（空行或 resize，方案按 01 轮实测结论）恢复 pwd。

## 涉及文件

- `apps/web/frontend/src/components/TerminalView.tsx` — 注册 OSC 处理器、把解析结果送进会话级缓存
- `apps/web/frontend/src/lib/`（新增）— pwd 解析纯函数模块 + 单元测试
- 前端会话状态层 — 按会话 id 缓存 pwd（内存），**不落后端、不入 localStorage**
- `docs/prds/file-pane-obsidian.md` — 复核「方案」节措辞

## 完成标准

- [ ] OSC 1337 由 **`term.parser.registerOscHandler(1337, cb)`** 接管，代码里**没有手写字节流扫描器**（跨帧序列边界交给 xterm 状态机）（对应 PRD 验收项 **PWD-03**）。
- [ ] pwd 解析收敛为 `src/lib` 下的**独立纯函数模块**，**单元测试齐备**且逐条钉死：解析 `1337;CurrentDir=<path>`、**拒绝非绝对路径**、过一遍既有 `normalizeContainerPath`（对应 PRD 验收项 **PWD-04**）。
- [ ] 终端帧处理**未引入逐帧 `TextDecoder`**，既有解码路径**零改动**（对应 PRD 验收项 **PWD-03**）。
- [ ] pwd **按会话**在前端内存缓存；**后端会话记录零改动**（无新增字段、无新增接口）（对应 PRD 验收项 **PWD-05**）。
- [ ] **断线重连后**触发一次提示符刷新（空行或 resize，方案按 01 轮实测结论）**能恢复 pwd**，且刷新动作**不产生多余的可见输出**。
- [ ] 真沙箱里 `bash -i` 会话能收到上报并**解析出正确路径**；`dash` / `sh` 会话**无上报**且前端**不报错**（静默保持无 pwd 状态）。

## 依赖

- 依赖 [[tasks/file-pane-obsidian/01-prototype-osc-loop.md|01 打样轮]]（实测结论——**硬前置**）；与 [[tasks/file-pane-obsidian/02-image-ps1-injection.md|02 镜像注入]] **可并行**（03 的实现只等 01 的结论，端到端复验要等 02 的镜像就绪）。
- 需求：[[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
