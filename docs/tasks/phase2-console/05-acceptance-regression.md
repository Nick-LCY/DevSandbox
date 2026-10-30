---
prd: prds/phase2-console.md
status: done
---
# 任务：二期端到端验收与一期回归复验

## 目标
用可重复执行的验收脚本驱动真实浏览器，跑通网页全流程「从宿主本地镜像选一个创建沙箱 → 开终端操作 → 停止 → 再启动 → 删除」，并复验网页操作与一期命令行行为等价、一期行为无回归。验收结论与实测数据留档。

## 完成标准
- [x] 验收脚本落在 `platform/console/tests/`（Playwright 驱动真实浏览器 + 控制台页面），一条命令可跑完并产出明确退出码；失败时保留截图与 trace。
- [x] 全流程用例覆盖：下拉选择宿主本地镜像 → 创建沙箱 → 打开网页终端并执行命令（断言回显）→ 停止 → 再启动 → 删除；每步都有可判定的断言，不靠人工点击。
- [x] 验收用镜像为「不存在于任何仓库的本地构建镜像」（现场在宿主构建一个测试镜像），确认网页选用后创建成功、注入路径走通。
- [x] 终端用例：同一沙箱开两个终端并行可用（两端各自执行命令互不串扰）；断开浏览器后重连，终端现场（已输出内容与仍在运行的进程）不丢；重启服务后旧会话失效且页面给出明确提示。
- [x] 等价性复验：对同一沙箱分别用网页与 `sandboxctl` 操作，核对列表字段一致、挂载清单一致、停止与启动后的容器状态一致、删除回收清单一致。
- [x] 删除复验：按一期回收清单逐项核对平台资源已回收（沙箱容器、依赖容器、守护进程、systemd 单元、用户与家目录、子 UID/GID 段、平台元数据），并确认用户声明挂载的外部目录原样存在、内容未变。
- [x] 一期回归：`uv run pytest` 全绿（一期 141 项 + 本期新增用例），`platform/scripts/smoke-lifecycle.sh` 冒烟判定全通过；沙箱内 `docker pull` 仍统一经镜像代理（缓存命中不重复走外网）。
- [x] 验收结论与实测数据写入 `platform/console/RESULTS.md`（逐条对应 PRD 验收标准，标注通过 / 不通过，不通过项给出原因与后续动作）；平台侧结论追加到仓库根目录 `RESULTS.md`。
- [x] 文档同步：更新 `docs/current-state.md` 看板与「最近变更」；`docs/prds/README.md`、`docs/tasks/README.md`、`docs/tasks/phase2-console/README.md` 的清单与状态保持一致。

## 依赖
- 依赖 [[tasks/phase2-console/01-service-core-api.md|01 控制面服务骨架与沙箱管理接口]]、[[tasks/phase2-console/02-image-proxy-api.md|02 宿主镜像枚举与代理状态管理接口]]、[[tasks/phase2-console/03-web-terminal.md|03 网页终端]]、[[tasks/phase2-console/04-console-frontend.md|04 网页控制台前端]]（四个任务共同构成可验收的完整网页控制台）。

## 验收摘要

**一句话结论**：PRD 8 条验收标准首次运行即全部通过（8/8），无不通过项、无「先红后绿」的修复过程，验收期间未发现平台缺陷。

**关键实测数据**：
- 全流程用例（下拉选宿主本地镜像 → 创建沙箱 → 终端执行命令 → 停止 → 再启动 → 删除）：**20.25 秒**，其中沙箱创建 4359 毫秒；验收脚本共 14 条用例全部通过，退出码 0，总耗时 246.03 秒。
- 一期回归：`uv run pytest` **288 项全绿**（0 失败，330.24 秒）；`platform/scripts/smoke-lifecycle.sh` **30 项判定全过**（不通过 0 项，退出码 0）；命令行 `platform/cli/sandboxctl.py` 源码一行未改。
- 本地构建镜像注入：现场构建 `sandbox-console-acceptance/local-only-cbd1dacd:0.1.0`，**26.9 MB**，不在任何仓库；网页下拉可选中并创建成功，沙箱守护进程内 `docker image inspect` 取得到该镜像。
- 代理缓存命中取证：沙箱守护进程单元仍注入 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` / `SSL_CERT_FILE`；代理访问日志把该次拉取记为 `"upstream_cache_status":"HIT"`、`"host":"registry-1.docker.io"`，确认缓存命中未走外网。

**留档指引**：
- 逐条实测记录：`platform/console/RESULTS.md`（PRD 8 条验收标准逐条结论、一期回归明细、遗留边界、复现方式）。
- 平台侧结论：仓库根目录 `RESULTS.md`（二期分项结论与任务逐条完成情况）。
- 提交：commit `b72c1ec`（`test(console): 二期任务05 端到端验收与一期回归复验`）。
