# 网页控制台前端

沙箱平台的网页控制台：**单页工作台**。左侧边栏是沙箱列表，右侧工作区是选中沙箱的摘要与网页终端；新建沙箱 / 沙箱详情 / 代理设置都是弹窗。

- 技术栈：React 19 + Vite 7 + TypeScript 5.9 + Tailwind v4 + shadcn/ui（Base UI 原语），pnpm 管理，Node ≥ 22。
- 产物由后端服务在 `/` 路径直接托管，单端口对外，**前端不含任何认证逻辑**，全部接口走同源相对路径。
- 接口契约以 `platform/src/sandbox_platform/API.md` 为唯一权威，本前端只做编排与展示。

## 安装

```bash
cd platform/console
nvm use 22          # Node ≥ 22
pnpm install
```

## 开发启动

```bash
pnpm dev            # 起在 5173
```

开发模式下 `/api`（含网页终端的 WebSocket）由 Vite 代理转发到后端，无需额外配置跨域：

| 前端 | 后端 |
|---|---|
| `http://127.0.0.1:5173/` | `http://127.0.0.1:8000/` |

后端地址可用环境变量覆盖（默认 `http://127.0.0.1:8000`）：

```bash
BACKEND_URL=http://127.0.0.1:8010 pnpm dev
```

代理配置在 `vite.config.ts`：`'/api'` 一条规则同时覆盖 REST 与 WebSocket（`ws: true`）。

## 构建

```bash
pnpm run build      # = tsc --noEmit && vite build
```

产物落在 `platform/console/dist`，后端启动时自动挂载到 `/`：

```bash
cd platform
uv run python -m sandbox_platform.server        # 默认监听 127.0.0.1:8000
```

后端相关环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `SANDBOX_CONSOLE_HOST` | 监听地址 | `127.0.0.1` |
| `SANDBOX_CONSOLE_PORT` | 监听端口 | `8000` |
| `SANDBOX_CONSOLE_DIST` | 前端构建产物目录 | `platform/console/dist` |

## 类型检查与单元测试

```bash
pnpm run typecheck  # tsc --noEmit，零错误
pnpm run test       # vitest run，纯数据转换逻辑与组件交互的单元测试
```

单元测试覆盖挂载声明解析、环境变量解析、两层路由解析（含畸形百分号编码）、字节与时间格式化、终端帧协议解析、代理状态文案转换、主题存取，以及终端面板的会话标签与关闭会话交互（标签渲染、点标签回调、运行中与已退出的两套确认文案、确认与取消、失败提示、记录已不存在、关闭流程未走完、列表刷新失败）。组件测试用 jsdom 环境（文件头部 `@vitest-environment jsdom` 注解切换），依赖 `@testing-library/react` 与 `jsdom`。

## 端到端验收

验收脚本在 `platform/console/tests/`：Playwright 驱动真实浏览器，打真实控制台服务与真实沙箱。

```bash
pnpm install                # 首次：装 @playwright/test
pnpm run test:acceptance    # 一条命令跑完全部用例，退出码 0 = 通过
```

宿主 8000 端口被无关进程占用时用环境变量换端口（默认 8100）：

```bash
CONSOLE_TEST_PORT=8200 pnpm run test:acceptance
```

环境前提：Playwright chromium 1.64.1、免密 sudo、宿主 Docker、镜像代理在跑。
验收脚本自己会构建前端产物、构建一个「不存在于任何仓库」的测试镜像、拉起控制台服务并在收尾时清理干净。
用例清单、断言口径与产物位置见 `platform/console/tests/README.md`；实测数据见 `platform/console/RESULTS.md`。

## 目录结构

```
platform/console/
├── index.html            静态外壳（带 data-testid 的占位内容）
├── package.json          pnpm@10.32.1，Node ≥ 22
├── tsconfig.json         tsc --noEmit 的配置
├── vite.config.ts        构建配置 + 开发代理
├── vitest.config.ts      单元测试配置（Node 环境）
└── src/
    ├── main.tsx          挂载入口
    ├── App.tsx           只渲染工作台
    ├── styles/
    │   ├── globals.css   样式底座（Tailwind v4 + 双主题令牌 + Preflight）
    │   └── fonts.css     自托管字体（思源黑体 / Geist Mono）
    ├── api/
    │   ├── client.ts     接口调用与错误映射（统一读后端 detail 文案）
    │   └── types.ts      接口数据形状（与后端 schemas.py 对齐）
    ├── lib/              纯逻辑（可单测）
    │   ├── router.ts     两层哈希路由
    │   ├── format.ts     字节数 / 时间戳格式化
    │   ├── mounts.ts     挂载声明解析与校验
    │   ├── env.ts        环境变量声明解析
    │   ├── proxy.ts      代理状态文案转换
    │   ├── terminal.ts   终端帧协议
    │   ├── sessions.ts   会话定序与标签序号登记
    │   ├── action.ts     操作提示条的文案与样式
    │   ├── theme.ts      亮 / 暗主题切换
    │   ├── cn.ts         类名合并（clsx + tailwind-merge）
    │   └── validate.ts   沙箱名 / 镜像选择校验
    ├── components/
    │   ├── ErrorBanner.tsx   错误提示条
    │   ├── TerminalPanel.tsx 终端标签与面板
    │   ├── TerminalView.tsx  单个终端（xterm + WebSocket）
    │   ├── ui/                shadcn/ui 原语（Base UI）
    │   └── workbench/         工作台各部件
    │       ├── Workbench.tsx          总装与状态中枢
    │       ├── AppShell.tsx           外壳（侧栏 + 工作区）
    │       ├── Sidebar.tsx            侧栏（品牌 / 新建 / 列表 / 底部工具）
    │       ├── SandboxList.tsx        沙箱列表项
    │       ├── WorkspaceHeader.tsx    选中沙箱的摘要与操作
    │       ├── TerminalTabs.tsx       终端会话标签条
    │       ├── EmptyState.tsx         没选中沙箱时的引导块
    │       ├── CreateSandboxDialog.tsx  新建沙箱弹窗
    │       ├── SandboxDetailDialog.tsx 沙箱详情弹窗
    │       ├── ProxySettingsDialog.tsx 代理设置弹窗
    │       ├── DeleteSandboxDialog.tsx 删除确认弹窗（两步确认）
    │       ├── CloseSessionDialog.tsx   关闭终端会话弹窗
    │       └── ModalShell.tsx          弹窗外壳（Base UI Dialog：焦点陷阱 / Esc / 标题栏）
```

## 样式底座

Tailwind v4 + CSS 变量令牌（`src/styles/globals.css`）：

- 令牌分两套主题：亮色是 OKLCH 色板，暗色逐项映射旧暗色变量；`html.dark` 切换，`src/lib/theme.ts` 的 `useTheme()` 负责读写（只认用户明确选过的值，不跟随系统）。
- 颜色语义统一成 `--color-*`（Tailwind 主题层），因此类名是 `bg-primary` / `text-status-running` 这类常规写法。
- 侧栏与终端的配色固定：侧栏两套主题下都是深常青绿，终端恒为深色（`bg-terminal-bg`），亮暗切换不影响终端可读性。
- 选中态与 `color-scheme` 收在 `[data-console-shell]` 作用域内，只对外壳生效。

## 路由（两层）

前端用**哈希路由**：后端把构建产物挂在 `/` 上（静态目录托管），深链接没有服务端回退规则会直接 404；哈希路由不依赖服务端回退，刷新与粘贴链接都能落到同一个页面。

路由只有两层：工作台本身，以及「工作台 + 选中的沙箱（可选终端会话）」。

| 路由 | 地址 | 说明 |
|---|---|---|
| 工作台 | `#/` | 左侧沙箱列表，右侧空态引导块 |
| 选中沙箱 | `#/sandboxes/<名字>` | 右侧显示该沙箱的摘要与终端会话标签 |
| 选中沙箱 + 终端会话 | `#/sandboxes/<名字>/<会话标识>` | 右侧工作区直接落在该终端会话上 |

- 新建沙箱 / 沙箱详情 / 代理设置**不是路由**：它们是弹窗，开关状态不入路由，刷新页面自然关闭。
- 地址里的沙箱名与会话标识会做一次百分号解码；解码失败（畸形编码，如 `#/sandboxes/%`）不会抛异常打断渲染，一律退回工作台。
- 旧四页地址（`#/new`、`#/settings` 等）不再有对应路由，解析时也退回工作台。

## 后端健康自检

侧栏底部常驻一条健康自检（`GET /api/health`，每 15 秒一次）：后端不可达时直接提示「后端服务不可达」并给出原因；后端可用但前端产物未挂载时提示「前端产物未挂载」。

## 操作提示条

操作结果分两种样式：成功用绿色提示条，失败（启动 / 停止 / 删除失败、回收有残留项）用红色错误提示条，不再全部挂在同一种中性提示条上。

## 删除确认弹窗

弹窗支持 `Esc` 关闭与点遮罩关闭（删除进行中两者都不响应）。

删除沙箱是**两步确认**：第一次点「确认删除」只进入武装状态（按钮变「再点一次确认删除」，弹窗顶部出现红色提示「此操作不可撤销，再点一次确认删除」），武装窗口 5 秒内第二次点才真的发 `DELETE`；窗口过期自动解除武装。

## 弹窗与焦点管理

全站只有**一套弹窗实现**：所有弹窗都走 `src/components/workbench/ModalShell.tsx`，而 ModalShell 底层是 Base UI 的 Dialog 原语（`src/components/ui/dialog.tsx`，`@base-ui/react`）。

- **焦点陷阱**：弹窗打开时焦点落进面板，`Tab` / `Shift+Tab` 在面板里循环，不会跑到背后的页面上。
- **背景不可交互**：弹窗开着时背景内容被标记为 `aria-hidden`（辅助技术读不到），`Tab` 走不到背景上；遮罩盖住整页，背景也点不到。
- **焦点归位**：弹窗关闭后焦点回到打开它的那个按钮。
- **关闭途径三条**：Esc、点遮罩、点右上角 `×`（lucide 图标）；三条都走 `onOpenChange(false)`，调用方可以按业务需要拦住（比如删除进行中一律不响应）。

## 关键行为

### 新建沙箱

- 镜像下拉来自 `GET /api/images`（后端返回**裸数组**，前端按数组消费）。
- 镜像下拉在**页面重新可见时**（`visibilitychange`）会补拉一次，贴合「实时」要求：切回标签页就能看到宿主上的最新镜像。
- 挂载按 `宿主路径:容器路径[:ro]` 语法声明，可多条；前端先做一遍格式与敏感路径校验，**容器路径重复也在前端先拦**（少一次往返），后端仍会再校验一次。
- 提交时固定带 `image_source=host`：平台把镜像从宿主导出注入沙箱守护进程，不经镜像代理拉取。

### 删除沙箱

先 `GET /api/sandboxes/{name}/reclaim` 拿到平台回收清单，弹窗列出清单并写明「用户挂载的宿主机目录不受影响」；用户点「确认删除」才发 `DELETE`，点「取消」一个删除请求都不发。

### 网页终端

- xterm.js（`@xterm/xterm`）+ fit 插件（`@xterm/addon-fit`），随窗口自适应。
- **标签 = 会话**：标签条的数据源就是后端的会话表（`GET /api/terminal/sessions?sandbox=<名>`），一个标签一个会话；点标签即附着到该会话（服务端回放现场缓冲），标签尾的 `×` 是**关闭会话**（会终止容器内该会话的进程树），先弹确认。
- 终端配色与字体固定（两套主题恒定）：`Geist Mono` 12.5px，背景 `#152019`、前景 `#e3ebe5`、光标 `#a7d8af`、选区 `#2b3d31`。
- **快捷键全量拦截**：带 Ctrl / Meta / Alt 的组合一律 `preventDefault`（不让浏览器抢走），但仍然编码后送进容器内的 shell（`Ctrl+C` 必须能到 pty）。浏览器保留键交回浏览器：`Ctrl+N`/`Ctrl+Shift+N`、`Ctrl+T`/`Ctrl+Shift+T`、`Ctrl+W`/`Ctrl+Shift+W`、`Ctrl+Q`、`Ctrl+Tab`/`Ctrl+Shift+Tab`、`F5`、`F11`、`F12`、`Alt+F4`、`Ctrl+P`、`Ctrl+S`。
- 帧协议按 `API.md` 12.3：客户端二进制帧 = 终端输入字节，客户端文本帧 = `{"type":"resize","cols":..,"rows":..}`；服务端二进制帧 = 终端输出字节，服务端文本帧 = `hello` / `exit` / `error`。
- 同一沙箱可开多个终端标签，每个标签一个独立会话（容器内一个带真实 TTY 的 shell）；标签标题是「终端 N」，**N 是会话自己的登记号**（见下）。
- **标签序号跟会话身份绑定**：会话第一次被看到时按递增顺序分配一个序号（同一个沙箱内从 1 开始），之后不再变动——关掉中间的标签，其余标签的序号不重排，用户正在用的那个不会改名字。标签的**顺序**按会话的创建时间排（同一时刻创建的按会话标识排）。
- **会话表轻轮询**：面板可见时每 10 秒重新拉一次会话表（页面不可见时不拉），保证标签条与后端一致，关闭确认弹窗的「还在跑」判定也拿到较新的记录。刷新失败会在面板上挂错误提示，**下一次刷新成功或切换沙箱时自动清掉**。
- **连接状态按会话存**：每个会话各记各的连接状态，状态栏只反映当前选中的会话；切换标签的瞬间不会还挂着上一个会话的「已连接」。
- **切沙箱不会串台**：详情加载与会话表刷新都带请求序号护栏，旧沙箱的在途响应回来时直接丢弃，不会覆盖新沙箱的头部或标签条。
- 断线后按退避节奏自动重连，**始终携带原 `session_id`**：服务端先回放环形缓冲再接实时流，现场不丢。页面刷新后（会话还在后端会话表里）点标签就能重新挂回原会话。
- **退避计数只在连接真的可用时才清零**：收到服务端的 `hello` 帧，或连接稳定存活超过 5 秒。握手成功不等于连上了——服务端握手后立刻关闭时，如果在 `onopen` 就清零计数，会退化成每 500ms 一次的连接风暴。
- 连续失败 10 次即停掉自动重连，界面显示「重连失败，点击重试」，由用户点「重试连接」手动触发。
- 后端服务重启会让全部会话失效：此时前端明确提示「终端会话已失效（后端服务已重启），请新建终端」，并停止重连。
- 服务端发来的 `error` 帧有独立的告警样式（黄色），不会与「已连接」混成一个文案。

### 删除终端会话

- **一个标签就是一个会话**，没有第二份「后端保留的会话」列表。标签尾的 `×` 就是关闭会话：点一下弹确认弹窗，确认后发 `DELETE /api/terminal/sessions/{session_id}`；后端先完整关闭（终止宿主伪终端、容器内按会话标识清进程树）再删记录。
- **运行中的会话**：确认弹窗的标题是「关闭终端会话」，后果说明是「关闭会终止容器内该会话的进程树，终端现场不保留」，按钮文案是「关闭并移除」。
- **已退出的会话**：确认弹窗的标题是「移除终端会话记录」，后果说明是「会话已退出，只移除记录，容器内无残留进程」，按钮文案是「移除记录」。
- **确认口径保守**：标签状态与后端记录任一为 `running` 就算会话还在跑，一律按「运行中」处理（终止现场不可逆，宁可多问一句）。
- 已退出的会话**保留显示，不做自动清理**：后端的空闲回收只回收运行中且无附着的会话，已退出的会话一直列在标签条上，等用户手动删。
- 删除成功后标签消失；删除失败时展示后端 `detail` 原文。
- 删除**本体成功**与**列表刷新失败**分开提示：刷新失败只进提示位（蓝色信息条），不把已成功的删除说成失败；后端回报 `removed=false` 时提示「记录已不存在（可能已被删除）」，回报 `closed=false` 时提示关闭流程未走完。

### 代理设置

代理设置是弹窗。顶部先给一行状态摘要（容器 / 健康 / 证书），下面展示容器运行状态、健康状态、端口连通、CA 是否可取回、缓存目录占用、证书就绪状态与代理访问地址。「重启代理」按钮在重启期间提示「代理正在重启，重启期间依赖镜像拉取会失败，属预期行为」；重启结果按 `restarted` / `ca_changed` / `ca_reinstalled` / `reinstalled_users` / `failed_users` 如实展示，不把未修复报成已修复。

## data-testid 规范

命名 `page-<页面>-<元素>`，字符集只允许小写字母、数字与连字符。

| 页面 | 页面段 | 主要标识 |
|---|---|---|
| 外壳 | `layout` | `page-layout-title` / `page-layout-health`（带 `data-health-state`）/ `page-layout-proxy-button` / `page-layout-theme-toggle` |
| 沙箱列表 | `sandbox-list` | `page-sandbox-list-title` / `page-sandbox-list-count` / `page-sandbox-list-item` / `page-sandbox-list-item-name` / `page-sandbox-list-item-state` / `page-sandbox-list-item-image` / `page-sandbox-list-refresh-button` / `page-sandbox-list-create-button` / `page-sandbox-list-error-message` / `page-sandbox-list-action-message` / `page-sandbox-list-empty` / `page-sandbox-list-loading` / `page-sandbox-list-updated-at` |
| 新建沙箱 | `sandbox-create` | `page-sandbox-create-dialog`（弹窗容器）/ `page-sandbox-create-title` / `page-sandbox-create-name-input` / `page-sandbox-create-image-select` / `page-sandbox-create-image-refresh-button` / `page-sandbox-create-image-detail` / `page-sandbox-create-image-empty` / `page-sandbox-create-image-error` / `page-sandbox-create-mount-add-button` / `page-sandbox-create-mount-empty` / `page-sandbox-create-mount-item` / `page-sandbox-create-mount-host-input` / `page-sandbox-create-mount-container-input` / `page-sandbox-create-mount-readonly-checkbox` / `page-sandbox-create-mount-remove-button` / `page-sandbox-create-command-input` / `page-sandbox-create-workdir-input` / `page-sandbox-create-env-input` / `page-sandbox-create-submit-button` / `page-sandbox-create-error-message` / `page-sandbox-create-success` / `page-sandbox-create-success-message` / `page-sandbox-create-success-link` / `page-sandbox-create-steps` |
| 沙箱详情（工作区头部） | `sandbox-detail` | `page-sandbox-detail-title` / `page-sandbox-detail-state` / `page-sandbox-detail-image` / `page-sandbox-detail-created-at` / `page-sandbox-detail-updated-at` / `page-sandbox-detail-refresh-button` / `page-sandbox-detail-start-button` / `page-sandbox-detail-stop-button` / `page-sandbox-detail-stop-dependencies-checkbox` / `page-sandbox-detail-detail-button` / `page-sandbox-detail-delete-button` / `page-sandbox-detail-empty` / `page-sandbox-detail-error-message` |
| 沙箱详情弹窗 | `sandbox-detail-dialog` | `page-sandbox-detail-dialog`（弹窗容器）/ `page-sandbox-detail-dialog-state` / `page-sandbox-detail-dialog-image` / `page-sandbox-detail-dialog-created-at` / `page-sandbox-detail-dialog-updated-at` / `page-sandbox-detail-image-source` / `page-sandbox-detail-system-user` / `page-sandbox-detail-container-name` / `page-sandbox-detail-network-name` / `page-sandbox-detail-socket-path` / `page-sandbox-detail-socket-mount-path` / `page-sandbox-detail-workdir` / `page-sandbox-detail-command` / `page-sandbox-detail-subid` / `page-sandbox-detail-network-owned` / `page-sandbox-detail-env` / `page-sandbox-detail-env-item` / `page-sandbox-detail-env-empty` / `page-sandbox-detail-mounts` / `page-sandbox-detail-mount-item` / `page-sandbox-detail-mounts-empty` / `page-sandbox-detail-dependencies` / `page-sandbox-detail-dependency-item` / `page-sandbox-detail-dependencies-empty` / `page-sandbox-detail-loading` / `page-sandbox-detail-dialog-error` |
| 终端 | `sandbox-detail-terminal` | `page-sandbox-detail-terminal-panel` / `page-sandbox-detail-terminal-tabs` / `page-sandbox-detail-terminal-tab` / `page-sandbox-detail-terminal-tab-select` / `page-sandbox-detail-terminal-tab-close` / `page-sandbox-detail-terminal-new-button` / `page-sandbox-detail-terminal-status` / `page-sandbox-detail-terminal-count` / `page-sandbox-detail-terminal-message` / `page-sandbox-detail-terminal-error` / `page-sandbox-detail-terminal-notice` / `page-sandbox-detail-terminal-retry-button` / `page-sandbox-detail-terminal-stopped-hint` / `page-sandbox-detail-terminal-surface` / `page-sandbox-detail-terminal-placeholder` / `page-sandbox-detail-terminal-remove-confirm` / `page-sandbox-detail-terminal-remove-confirm-button` / `page-sandbox-detail-terminal-remove-cancel-button` |
| 代理设置 | `settings` | `page-settings-dialog`（弹窗容器）/ `page-settings-title` / `page-settings-summary` / `page-settings-container-running` / `page-settings-healthy` / `page-settings-tcp-ok` / `page-settings-ca-fetchable` / `page-settings-cache-size` / `page-settings-certificate-ready` / `page-settings-proxy-url` / `page-settings-detail` / `page-settings-refresh-button` / `page-settings-restart-button` / `page-settings-restarting-message` / `page-settings-restart-result` / `page-settings-restarted` / `page-settings-restart-message` / `page-settings-ca-changed` / `page-settings-ca-reinstalled` / `page-settings-ca-conclusion` / `page-settings-reinstalled-users` / `page-settings-failed-users` / `page-settings-error-message` / `page-settings-loading` |
| 删除沙箱 | `sandbox-detail-delete` | `page-sandbox-detail-delete-dialog` / `page-sandbox-detail-delete-title` / `page-sandbox-detail-delete-untouched-note` / `page-sandbox-detail-delete-items` / `page-sandbox-detail-delete-item` / `page-sandbox-detail-delete-user-mounts` / `page-sandbox-detail-delete-user-mount-item` / `page-sandbox-detail-delete-incomplete` / `page-sandbox-detail-delete-armed-hint` / `page-sandbox-detail-delete-confirm-button` / `page-sandbox-detail-delete-cancel-button` |

**已退役的标识**（旧四页与「后端保留的会话」列表下线后不再存在）：
`page-layout-nav-sandboxes` / `page-layout-nav-create` / `page-layout-nav-settings`、
`page-sandbox-list-delete-*`、`page-sandbox-list-item-start-button` / `-item-stop-button` / `-item-detail-button` / `-item-delete-button` / `-item-name-link` / `-item-created-at` / `page-sandbox-list-table`、
`page-sandbox-detail-terminal-existing-list` / `-existing-item` / `-existing-attach-button` / `-existing-remove-button`、
`page-sandbox-detail-terminal-tab-remove-button`、`page-sandbox-detail-back-button`、`page-sandbox-create-back-button`。

**重复元素的定位方式**：沙箱列表项与终端标签在同一个页面上会重复出现，标识本身保持一致，另带一个属性用于区分：

```ts
// 列表项：按沙箱名筛出那一项
const item = page.getByTestId('page-sandbox-list-item').filter({ hasText: 'demo-01' });

// 终端标签：按会话标识区分
const tab = page.locator('[data-testid="page-sandbox-detail-terminal-tab"][data-session-id="abc123"]');
```

列表项额外带 `data-sandbox-name` 与 `data-sandbox-state`，终端标签与终端表面额外带 `data-session-id`（终端标签还带 `data-active`）。

**同页双挂载的标识**（页面上同时存在多个，取第一个即可）：

- `page-sandbox-list-create-button`：侧栏顶部的「新建沙箱」按钮与右侧空态引导块里的「新建沙箱」按钮各挂一个。用 `page.getByTestId('page-sandbox-list-create-button').first().click()` 即可。
- `page-sandbox-detail-dialog-*`（状态 / 镜像 / 创建时间 / 更新时间）：这四个字段在工作区头部也有同名元素（`page-sandbox-detail-state` / `-image` / `-created-at` / `-updated-at`），弹窗里的版本加了 `dialog-` 前缀，两者不会撞名。

## 接口一览

| 方法 | 路径 | 前端用途 |
|---|---|---|
| GET | `/api/health` | 侧栏底部的健康自检 |
| GET | `/api/sandboxes` | 侧栏沙箱列表（裸数组） |
| POST | `/api/sandboxes` | 新建沙箱（带 `image_source=host`） |
| GET | `/api/sandboxes/{name}` | 工作区摘要与详情弹窗 |
| POST | `/api/sandboxes/{name}/start` | 启动 |
| POST | `/api/sandboxes/{name}/stop` | 停止（带 `stop_dependencies`） |
| GET | `/api/sandboxes/{name}/reclaim` | 删除前的回收清单 |
| DELETE | `/api/sandboxes/{name}` | 删除 |
| GET | `/api/images` | 新建弹窗的镜像下拉（裸数组） |
| GET | `/api/proxy/status` | 代理设置弹窗 |
| POST | `/api/proxy/restart` | 重启代理 |
| POST | `/api/terminal/sessions` | 新建终端会话 |
| GET | `/api/terminal/sessions?sandbox=` | 终端标签条的数据源（裸数组） |
| DELETE | `/api/terminal/sessions/{session_id}` | 删除会话（运行中＝先关后删，已退出＝走一遍收尾再删） |
| WS | `/api/terminal/sessions/{session_id}` | 终端帧桥接 |

错误消息一律直接展示后端 `{"detail": "中文消息"}` 里的 `detail`，前端不另造说法。
