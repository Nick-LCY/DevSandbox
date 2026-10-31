# 网页控制台前端约定

适用范围：`platform/console/`。本文只写「改了会被别人踩」的稳定约定；实现细节看 `platform/console/README.md`。

## 技术栈与依赖

- 样式底座：Tailwind CSS v4（`@tailwindcss/vite`）+ shadcn/ui（base-nova 预设），组件层落在 `src/components/ui/`。
- 交互原语：**只用 Base UI（`@base-ui/react`），不得引入 Radix**（任何 `@radix-ui/*` 包都不加）。shadcn 的 `data-*` 变体与 accordion 关键帧已内联进 `src/styles/globals.css`，不靠 devDependencies 里的 shadcn 样式文件。
- 图标：**只用 lucide-react**，不引第二套图标库。
- 新增交互原语时，先在 `src/components/workbench/ModalShell.tsx` 这类统一外壳上扩展，不要在页面里各自造弹窗。

## 设计令牌

- 颜色一律走令牌：底层写 `--app-*`（`src/styles/globals.css` 的 `:root` 与 `.dark`），主题层映射成 Tailwind 的 `--color-*`，组件里用 `bg-primary`、`text-status-running` 这类工具类。
- **组件里不得写裸色值**（十六进制、`rgb()`、`oklch()` 字面量一律禁止）。确需新色时先进令牌再引用。
- 新增令牌必须同时写 `:root` 与 `.dark` 两处（暗色逐项映射），并在 `@theme` 里补 `--color-*` 映射，否则暗色下会退回浏览器默认色。
- 透明度通道：所有颜色令牌的 alpha 槽位统一写 `oklch(L C H / var(--app-alpha))`，要整体调透明度只改 `--app-alpha` 一个值。
- 豁免清单（用字面 alpha、不跟通道缩放）：`--app-ring`（聚焦环）、`--app-shadow-sm` / `--app-shadow-md` / `--app-shadow-lg`（三层阴影需要各自不同的 alpha）。
- 状态色只有四个语义，不另造：运行 = 品牌绿、启动中 / 停止中 = 琥珀（脉动用 `animate-status-pulse`）、已停止 = 灰、失败 = 红。
- 侧栏两套主题下都是深常青绿；**终端区域恒定局部深色**（`--app-terminal-bg` / `--app-terminal-fg` / `--app-terminal-accent`），亮暗切换不影响终端可读性。

## 双主题

- 默认亮色，**不跟随系统**：只认用户明确选过的值，读取失败或值非法一律回落亮色。
- 存储键 `sandbox-console-theme`，读写统一走 `src/lib/theme.ts` 的 `useTheme()`；挂载时不写存储。
- 暗色由 `<html class="dark">` 表达（`@custom-variant dark`）；`index.html` 的首帧防闪烁脚本必须用同一套存储键。
- 会渗漏到外壳外的规则（选中态 `::selection`、`color-scheme`）一律收在 `[data-console-shell]` 作用域内；**外壳根元素必须携带 `data-console-shell` 属性**，否则这两条规则不命中。

## 字体

- 字体自托管：Noto Sans SC 400/500/600/700 与 Geist Mono 400/500 的子集化 woff2 已入库 `public/fonts/`，构建不依赖外网；文件缺失时浏览器自动回退系统字体栈。
- **新增中文文案后必须重跑 `bash platform/console/scripts/build-fonts.sh`**：字符集是从控制台前端、控制台测试、后端沙箱平台三处源码抽取的，不重跑就会出现新字缺字形（显示为方框）。
- 脚本失败时（任一字重拿不到）会丢弃暂存产物、保留原 `public/fonts/`，不留半成品；此时先排查网络，不要手工往 `public/fonts/` 里塞文件。

## 组件与路由

- 全站只有**一套弹窗实现**：所有弹窗走 `src/components/workbench/ModalShell.tsx`，底层是 Base UI Dialog（焦点陷阱、Esc 关闭、点遮罩关闭、焦点归位）。
- 路由只有两层：`#/` 与 `#/sandboxes/<沙箱名>[/<终端会话标识>]`。**弹窗不入路由**（新建沙箱、沙箱详情、代理设置等开关状态不入 URL）。
- 地址里的百分号解码失败一律退回工作台，不抛异常打断渲染。
- 前端只做编排与展示：错误消息直接展示后端 `{"detail": "中文消息"}` 里的 `detail`，**不另造说法**。
- **操作结果反馈一律走右上角 toast**（`src/components/Toast.tsx`，底座是 Base UI 的 Toast 原语）：成功绿 / 失败红 / 提示蓝，5 秒自然消失，关闭键带与消失同步的倒计时圆环。页面里**不再挂内嵌的结果横幅**；四处豁免：本地表单校验红字（留在弹窗内就地展示）、代理状态摘要绿条（留在弹窗原位）、删除沙箱的武装提示（`page-sandbox-detail-delete-armed-hint`）、新建沙箱弹窗里镜像列表读取失败的**就地环境状态说明**（`page-sandbox-create-image-status`，`role="status"`；它是环境状态不是操作结果，但 toast 5 秒就消失，只留 toast 会让空下拉没有解释）。
- 后台轮询失败**逐次不弹**，**连续 3 次失败弹一条**（任一次成功即清零）：后端整体不可达时侧栏底部的健康自检已经常驻提示，但端点级失败（接口 500）它兜不住。用户主动触发的操作失败立刻弹。
- toast 的倒计时**只有窗口失焦会暂停**：失焦时倒计时停表、圆环停画；回前台时整条**重走 5 秒**（圆环重画 + 计时器重走），不是接着上次剩的时间继续。页面上悬停、点提示区、聚焦提示区、按下提示条都不暂停——Base UI 默认会暂停，必须逐条拦掉。Base UI 还会在 `window` 上接管 F6（把提示区聚焦并按停倒计时），同样要拦掉。倒计时由 `ToastProvider` 层的自有计时器统一管（Base UI 的自动关闭置 0），保证圆环画满与 toast 消失共用同一份时间。
- toast 条目带 `data-toast-kind`（类型）与可选的 `data-toast-source`（来源）：同一页面上可能先后出现多条失败提示，验收脚本靠来源把本用例关心的那条与前一步残留的无关那条区分开。
- 纯数据转换逻辑（路由解析、挂载声明、环境变量、格式化、终端帧协议、终端状态提示口径与去重、代理文案、主题存取、会话定序、轮询失败计数）收敛在 `src/lib/`，并有单元测试。
- **交互组件的 pointer 光标由 `src/styles/globals.css` 的 base 层统一兜底**（Tailwind v4 的 preflight 把 button 等元素的默认光标改成了 `default`，v3 时代是 `pointer`）：新增交互原语不必逐个补 `cursor-pointer`；要别的光标语义就用工具类覆盖（工具类层级高于 base，下拉选项的 `cursor-default` 即是此例）。

## data-testid 规范

- 命名 `page-<页面>-<元素>`，字符集只允许小写字母、数字与连字符。
- 同页重复出现的元素**标识本身保持一致**，另挂属性区分：沙箱列表项带 `data-sandbox-name` 与 `data-sandbox-state`，终端标签与终端表面带 `data-session-id`（标签另带 `data-active`）。
- 同页双挂载的标识（侧栏与空态引导块各有一个「新建沙箱」按钮）按「取第一个」处理，不另造名字。
- 端到端脚本只使用 `platform/console/README.md` 标识表里的名字，不另造；helper 里的标识必须与实现一致。
- 旧四页与「后端保留会话」列表下线后，相关标识已退役，不得复用。完整标识表与已退役清单见 `platform/console/README.md`。

## 相关文档

- [[tasks/phase2-console/07-console-ui-overhaul.md|07 控制台 UI 全面改造]] — 本套约定的由来（单页工作台与新视觉底座的落地任务）。
- [[tasks/phase2-console/04-console-frontend.md|04 网页控制台前端]] — 前端工程的首个落地任务。
