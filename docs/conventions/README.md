# 约定

编码、提交、命名等规范（稳定层）。

## 内容
- 网页控制台前端：技术栈与依赖、设计令牌与双主题、字体子集重生成、弹窗与抽屉、路由、终端接入与快照恢复、终端实例常驻、data-testid 规范。
- 发布流程：单人维护模式、tag 发布触发、`production` Environment 的部署记录定位、凭据最小暴露面、版本一致性、状态口径。

其余编码 / 提交 / 命名规范待补充（如 `coding-style.md`、`commit-message.md`）。

## 文档链接约定

文档间相互引用具体文件时，统一使用 wikilink 语法，路径相对 docs/ 根目录（例如指向 `[[architecture/overview.md]]`，从任意位置都写完整路径）。仅引用 docs/ 内已存在的文件，不留死链。文件名模式或占位符（如 `<feature>.md`、`NNNN-短标题.md`）使用行内代码，不写为 wikilink。

> 写法示例：`\[\[architecture/overview.md\]\]` 渲染为可见的 `[[architecture/overview.md]]`，避免在示例文本里被误判为真实链接。

## 清单
- [[conventions/console-frontend.md]] — 网页控制台前端约定（`apps/web/frontend/`）：令牌与双主题、字体、弹窗与抽屉、路由、终端接入与快照恢复、终端实例常驻、data-testid。
- [[conventions/release-process.md]] — 发布流程约定：单人维护仓库、push `vX.Y.Z` tag 即正式发布、不设 required reviewers 与 tag 保护规则、`production` Environment 仅作部署记录分类。