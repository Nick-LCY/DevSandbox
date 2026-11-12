---
prd: prds/file-pane-obsidian.md
status: todo
---
# 任务：镜像 PS1 注入（OSC 1337 CurrentDir）

> 需求见 [[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
> **依赖 01 的实测结论**——注入写法（bash 转义与引号）按 01 轮实测校准后的版本落地，不自行发挥。

## 目标

把 01 轮实测确定的 OSC 1337 上报片段**正式注入基础镜像**，让平台起的 `bash` 会话默认上报工作目录。

- 注入点：**base-image 的 `/etc/bash.bashrc`**（追加，不覆盖原有内容）；
- 注入内容：**保留原 PS1 + 追加 OSC 1337 CurrentDir 序列**（tabby 方案写法，最终形态按 01 轮实测校准）；
- **镜像版本 bump 并构建推送**；
- 「**交互式**非登录 shell 会读 `~/.bashrc` 与 `/etc/bash.bashrc`（系统级生效、不依赖容器内用户家目录）」这一机制（控制台的终端会话以 `bash -i` 起）写进 PRD 的「方案」节（**已写**，本轮复核措辞与实测一致即可）。

## 涉及文件

- 基础镜像的 Dockerfile / 构建脚本 — 追加 `/etc/bash.bashrc` 注入段
- 基础镜像版本号（**bump**）与镜像代理内的发布配置
- `docs/prds/file-pane-obsidian.md` — 复核「方案」节里的 PS1 片段与 bash 读取机制表述
- 镜像构建产物（构建与推送）

## 完成标准

- [ ] base-image 的 `/etc/bash.bashrc` **追加**了 OSC 1337 CurrentDir 注入段，**原 PS1 保留不变**（注入前后对比原提示符不变）；最终写法与 01 轮实测结论一致（对应 PRD 验收项 **PWD-01**）。
- [ ] 基础镜像**版本 bump** 完成，**构建并推送成功**；镜像代理里能拉到新版本。
- [ ] 用新镜像起的沙箱里，`bash -i` 会话**实测能收到 pwd 上报**（对应 PRD 验收项 **PWD-02**）。
- [ ] `dash` / `sh` 会话**自然降级**：不产生 OSC 序列、终端输出不被污染（对应 PRD 验收项 **PWD-02**）。
- [ ] PRD「方案」节关于 **交互式非登录 shell 读 `~/.bashrc` 与 `/etc/bash.bashrc`** 的机制说明与实测一致（措辞如需调整，**只改本轮新增段落**，不改既有轮次的历史表述）。
- [ ] **外部依赖登记**：现有沙箱需要**重建**才能用上新镜像——**重建由用户执行**（本任务不代劳），此事实作为**验收前置**登记进任务文件与收口留档。

## 依赖

- 依赖 [[tasks/file-pane-obsidian/01-prototype-osc-loop.md|01 打样轮]]（注入写法的实测结论——**硬前置**）。
- 需求：[[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
