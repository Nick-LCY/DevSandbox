# 沙箱平台任务集（一期本地闭环）

本目录是沙箱平台**一期（本地闭环）**的任务集，共 6 个任务，需求来源见 [[prds/sandbox-platform.md]]。

一期 6 个任务已全部完成，任务状态汇总见 [[current-state.md]]；平台侧验收结论（一期总验收 + 8 条分项 + 二期分项）留档见 [[tasks/sandbox-platform/RESULTS.md|验收结论]]。

## 清单

按依赖顺序排列：

- [[tasks/sandbox-platform/01-rootless-probe.md]] — 在真实宿主机上验证「专属用户 + 子 ID 段 + 免 root 守护进程 + 套接字挂载 + 同网桥按容器名互访」主链路是否可行。
- [[tasks/sandbox-platform/02-base-image.md]] — 构建平台基础镜像：只含 docker 客户端、纯 bash 入口脚本与套接字默认路径约定（该版本曾随镜像分发依赖镜像离线包，机制已废弃，见 ADR 0008）。
- [[tasks/sandbox-platform/03-sandbox-image.md]] — 在基础镜像上构建默认全栈沙箱镜像：内含 pi、git、uv、nvm + node、pnpm 与 Playwright 浏览器。
- [[tasks/sandbox-platform/04-lifecycle-core-cli.md]] — 实现沙箱生命周期核心模块（创建 / 关闭 / 删除 / 列表）与只做参数解析的薄壳 CLI。
- [[tasks/sandbox-platform/05-e2e-harness.md]] — 建立以 Playwright 为核心的端到端测试基建：健康检查门禁、每用例独立数据库、统一 data-testid 定位。
- [[tasks/sandbox-platform/06-sample-app-acceptance.md]] — 搭建真实全栈示例项目并完成一期验收演练：跑通「改码 → 起环境 → 端到端 → 看截图 → 修复 → 全绿」闭环。

## 依赖图

- 01 最先做，结论不成立则 02、04 都要改方案，因此阻塞这两项。
- 02 → 03：默认全栈沙箱镜像建立在平台基础镜像之上。
- 03 + 04 + 05 共同支撑 06：示例项目验收需要默认镜像、生命周期能力与端到端基建齐备。
