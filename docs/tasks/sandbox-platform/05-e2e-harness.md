---
prd: prds/sandbox-platform.md
status: todo
---
# 任务：端到端测试基建

## 目标
建立以 Playwright 为核心的端到端测试基建：脚本模式为主、探索模式为辅；用健康检查门禁固定「依赖就绪 → 迁移 → 种子 → 起测」的顺序；每个用例使用独立数据库；统一 data-testid 元素定位规范；截图与 trace 留存到代码目录。

## 完成标准
- [ ] `platform/e2e/` 使用 nvm + pnpm 管理 Node 依赖，`package.json` 声明 `@playwright/test` 依赖，`pnpm install` 与 `pnpm exec playwright --version` 均成功。
- [ ] `platform/e2e/playwright.config.ts` 定义两个 project：`scripted`（执行 `tests/e2e/**/*.spec.ts` 脚本化用例，作为判定依据，有明确退出码）与 `explore`（交互式探索会话，产出截图与 trace，不参与判定）。
- [ ] 两条模式都能用单条命令单独执行，并产出可复现的退出码（0 = 通过）。
- [ ] 健康检查门禁实现在全局 setup 中，顺序固定：等待依赖健康（每个依赖有明确判据与超时上限，上限 120 秒）→ 执行数据库迁移 → 载入种子数据 → 才允许跑用例；任一步失败即整体失败并打印失败的具体依赖名与判据。
- [ ] 每用例独立数据库工具 `platform/e2e/tools/new-test-db.sh`：以模板库为基础克隆出用例库（postgres 模板库机制，`CREATE DATABASE ... TEMPLATE ...`），用例结束后销毁；实测记录连续创建 10 个用例库的耗时，单个用例库创建耗时 ≤ 5 秒。
- [ ] 种子数据放在 `platform/e2e/seeds/` 并带版本号（如 `v1.sql`），同一版本在任意用例库上载入结果一致（用行数校验值佐证）。
- [ ] data-testid 规范写入 `platform/e2e/TESTID.md`：命名规则（如 `page-<页面>-<元素>`、只允许字母数字与连字符、不含 CSS 特殊字符）、不少于 10 个示例、违规写法的反例。
- [ ] 元素定位统一走 `data-testid`：`platform/e2e/tests/` 下用例不出现 CSS / XPath 定位（全文检索断言匹配数为 0）。
- [ ] 证据留存：截图与 trace 输出到用户声明挂载的代码目录（不在容器临时层、不上传外部服务）；失败用例自动保留截图；运行后该目录内出现 `*.png` 与 `trace.zip` 文件。
- [ ] 用例隔离：两个用例并行运行时连接的数据库名不同且互不影响（用例日志中打印各自数据库名作为佐证）。
- [ ] 依赖全容器化：`platform/e2e/` 全部连接串走容器名（如 `postgres://postgres:5432`、`http://minio:9000`），全文检索断言不存在 `localhost` / `127.0.0.1` 连接串（匹配数为 0）。
- [ ] 提供最小端到端样例用例（打开示例页 → 断言元素存在 → 截图），一条命令可跑通并产出 PNG 文件。

## 依赖
- 依赖 [[tasks/sandbox-platform/04-lifecycle-core-cli.md|04 生命周期核心模块与 CLI]]（需要真实沙箱实例作为运行环境）。
- 依赖 [[tasks/sandbox-platform/03-sandbox-image.md|03 默认全栈沙箱镜像]]（Playwright 浏览器随沙箱镜像提供）。
- 本任务的脚本与规范文档可与镜像构建并行推进。
