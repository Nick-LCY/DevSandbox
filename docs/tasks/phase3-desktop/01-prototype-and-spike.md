---
prd: prds/phase3-desktop.md
status: todo
---
# 任务：打样轮（免 root 端口发布 / Tauri 壳 / WebView2 三项冒烟 / Windows 出包路径）

## 目标

三期开工前把四条「结论未知」的技术前提问清楚，产出一份可裁决的实测结论文档。打样轮不交付用户可见功能，只交付**结论**与**备案路径的裁决**。

## 涉及文件

- 新增 `docs/tasks/phase3-desktop/RESULTS.md` — 打样实测留档（四项结论、命令与关键输出、通过 / 不通过、裁决）
- 新增 `apps/desktop/` — Tauri v2 工程骨架（`package.json`、`src-tauri/`、`tauri.conf.json`）
- 新增 `apps/core/tests/` 下的打样脚本或 `apps/desktop/scripts/` 下的探针脚本（按 P1 的形态择一落位）
- 只读参考：`apps/core/src/sandbox_platform/userspace.py`（免 root 单元渲染）、`apps/core/src/sandbox_platform/proxy.py`（`-p` 先例）、`apps/core/src/sandbox_platform/daemon.py`（`run_container`）

## 实施步骤

1. **P1 免 root 端口发布**：
   - 用既有机制创建一个测试沙箱（或复用探针用户起一个免 root 守护进程）；
   - 在该守护进程下 `docker run -d --name probe-fwd -p 127.0.0.1:<端口>:<内部端口> <转发镜像>`；
   - 判定一：宿主 `ss -ltn` 是否出现该端口；
   - 判定二：从宿主 `curl 127.0.0.1:<端口>` 是否能连到容器内目标服务；
   - 记录：Docker / rootlesskit 版本、守护进程单元的环境变量（`DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS=true`）、`docker info` 的网络相关字段。
2. **P1 裁决**：通过 → 04/05/06 按主路径实现；不通过 → 验证 Fallback B 的最小可行性（`docker exec -i <转发容器> socat - TCP:<沙箱容器>:<端口>` 能否建立双向字节流），并把裁决写进 `RESULTS.md` 与 ADR 0014 的「影响」段。
3. **P2 Tauri 壳 + WebView2 三项冒烟**：
   - 起 Tauri v2 工程，`frontendDist` 指向 `apps/web/frontend/dist`；
   - 在 Windows 真机上打开应用，验三项：`oklch()` 配色、xterm.js（渲染 + fit + 终端表面不溢出）、`navigator.clipboard`（`window.isSecureContext` 取值 + 读写）；
   - 每项记录「通过 / 不通过 + 现象截图或输出」。
4. **P3 转发镜像**：`alpine/socat`（钉 digest）在沙箱守护进程内经统一镜像代理拉取，记录代理命中情况。
5. **P4 Windows 出包路径**：GitHub Actions（windows-latest）与「用户自有 Windows 机器」两条各试一次，记录所需环境与耗时；交叉编译从 Linux 出 Windows 包**不作为选项**（Tauri v2 不支持）。
6. 汇总进 `RESULTS.md`，给出四项裁决与后续任务的影响面。

## 完成标准

- [ ] `RESULTS.md` 给出 P1~P4 四项的实测结论，每项含命令与关键输出片段、通过 / 不通过判定、失败时的备案路径。
- [ ] P1 有明确裁决：主路径（`-p`）成立，或 Fallback B 成立并被采纳。
- [ ] P2 三项冒烟（`oklch` / xterm.js / `navigator.clipboard`）逐项有结论，且**在真机 Windows + WebView2 上**完成，不接受「在桌面版 Chromium 里过了就算过」。
- [ ] P3 记录转发镜像的拉取方式与代理命中情况，digest 已钉死。
- [ ] P4 给出至少一条可执行的 Windows 出包路径（含所需环境、耗时、产物形态），并明确是否需要用户提供机器或远端仓库。
- [ ] Tauri 工程骨架可启动，`frontendDist` 指向 `apps/web/frontend/dist`（同一份产物，无第二份前端）。
- [ ] 打样过程中的临时资源（测试沙箱、探针容器、探针用户）清理干净，不留残留。

## 依赖

- 无前置任务依赖，可立即开工。
- 结论直接决定 [[tasks/phase3-desktop/04-port-forward-core.md|04 端口转发核心包能力]]、[[tasks/phase3-desktop/08-windows-package.md|08 Windows 打包产物与冒烟]] 的实现路径，必须先于它们完成。
- 打样前置项与风险清单见 [[prds/phase3-desktop.md|三期 PRD]]；机制依据见 [[architecture/decisions/0014-端口转发机制选型.md|0014 端口转发机制选型]]。
