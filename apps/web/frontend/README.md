# 网页控制台前端

沙箱平台的网页控制台：**单页工作台**。左侧边栏是沙箱列表，右侧工作区是选中沙箱的摘要与网页终端；新建沙箱 / 沙箱详情 / 设置（代理设置 + 启动模板）都是**右侧滑出、宽度可拖拽的抽屉**。

- 技术栈：React 19 + Vite 7 + TypeScript 5.9 + Tailwind v4 + shadcn/ui（Base UI 原语），pnpm 管理，Node ≥ 22。
- 产物由后端服务在 `/` 路径直接托管，单端口对外，**前端不含任何认证逻辑**，全部接口走同源相对路径。
- 接口契约以 `apps/web/backend/API.md` 为唯一权威，本前端只做编排与展示。

## 安装

```bash
cd apps/web/frontend
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

产物落在 `apps/web/frontend/dist`，后端启动时自动挂载到 `/`：

```bash
uv run --project apps/web/backend python -m sandbox_console        # 默认监听 127.0.0.1:8000
```

后端相关环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `SANDBOX_CONSOLE_HOST` | 监听地址 | `127.0.0.1` |
| `SANDBOX_CONSOLE_PORT` | 监听端口 | `8000` |
| `SANDBOX_CONSOLE_DIST` | 前端构建产物目录 | `apps/web/frontend/dist` |

## 类型检查与单元测试

```bash
pnpm run typecheck  # tsc --noEmit，零错误
pnpm run test       # vitest run，纯数据转换逻辑与组件交互的单元测试
```

单元测试覆盖挂载声明解析、环境变量解析、启动模板的纯逻辑（宽松挂载解析、表单合并语义与配置收集）、两层路由解析（含畸形百分号编码）、字节与时间格式化、终端帧协议解析、终端状态提示的口径与去重规则（纯函数，含用户主动关闭、空闲回收与服务退出兜底三种结束原因）、代理状态文案转换、主题存取、抽屉宽度的存取与换算、轮询失败计数，终端面板的会话标签与关闭会话交互（标签渲染、点标签回调、运行中与已退出的两套确认文案、确认与取消、失败提示、记录已不存在、关闭流程未走完、列表刷新失败、终态提示、同一状态反复上报不重复刷屏、轮询连续失败），工作台的列表读取失败与轮询失败反馈、停止沙箱先弹确认框，新建沙箱抽屉的镜像列表失败说明、镜像选择器的本地筛选（输入关键字只剩命中项）、列表到位后输入框不被预填、逐字符打字能命中、没命中时的空态、弹层顶部无空白块、输入框内部的下拉箭头（纯指示器、点击落在输入框上）、候选项的指针光标、空列表不留空白带、键盘选中、选中后的详情行、改字即放弃选择与未选镜像时的校验红字、挂载空态的精简文案，模板选择器的可搜可选、选中回填（模板声明原样回填与镜像不在宿主列表时的留空）、模板下拉下不再挂说明段、模板入口的位置（加载模板在抽屉最上方、保存为模板在页脚且在主按钮左侧）、保存为模板的空名禁提交与成功提示、保存弹窗的精简文案，以及创建成功收口，设置抽屉的代理重启失败反馈不被状态刷新失败顶掉、刷新与重启两个按钮在代理设置区里（抽屉没有全局页脚）、模板列表渲染与空态、管理区不再挂说明段、模板列表读取失败、行内重命名（回车提交 / Esc 取消 / 空名禁提交）与删除确认弹窗，删除沙箱确认的一次点即执行，停止沙箱确认弹窗的勾选项与忙碌锁，以及抽屉外壳的焦点管理、关闭途径、宽度拖拽把手（条子中间带竖向抓握图标）与指针拖拽路径（拖动中不落盘、松手落盘一次、按下即松手不落盘、视口宽不可用时不换算），最后是全局 toast 组件本身（类型 → 配色类映射、5 秒自动消失、关闭键提前关闭、倒计时圆环的动画类名与时长、悬停 / 点提示区 / 聚焦提示区 / 按下提示条不暂停倒计时、按 F6 不被 Base UI 接管、窗口失焦停表与回前台整体重走 5 秒、新反馈顶掉旧条并重置计时、退场竞态下圆环重建）。组件测试用 jsdom 环境（文件头部 `@vitest-environment jsdom` 注解切换），依赖 `@testing-library/react` 与 `jsdom`。

toast 挂全局 `ToastProvider`：组件测试渲染带 Provider 的片段，断言看 `page-toast-item` 与 `data-toast-kind`（必要时再加 `data-toast-source`）。

## 端到端验收

验收脚本在 `apps/web/frontend/tests/`：Playwright 驱动真实浏览器，打真实控制台服务与真实沙箱。

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
用例清单、断言口径与产物位置见 `apps/web/frontend/tests/README.md`；实测数据见 `apps/web/frontend/RESULTS.md`。

## 目录结构

```
apps/web/frontend/
├── index.html            静态外壳（带 data-testid 的占位内容）
├── package.json          pnpm@10.32.1，Node ≥ 22
├── tsconfig.json         tsc --noEmit 的配置
├── vite.config.ts        构建配置 + 开发代理
├── vitest.config.ts      单元测试配置（Node 环境）
└── src/
    ├── main.tsx          挂载入口
    ├── App.tsx           挂 ToastProvider + 只渲染工作台
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
    │   ├── templates.ts  启动模板（挂载解析 / 表单合并与收集）
    │   ├── proxy.ts      代理状态文案转换
    │   ├── terminal.ts   终端帧协议
    │   ├── sessions.ts   会话定序与标签序号登记
    │   ├── poll.ts       后台轮询的连续失败计数（到阈值弹一条 toast）
    │   ├── toast.ts      操作反馈（toast）的类型与配色口径
    │   ├── theme.ts      亮 / 暗主题切换
    │   ├── drawer-width.ts 抽屉宽度的存取、钳位与视口换算（三个抽屉共用）
    │   ├── cn.ts         类名合并（clsx + tailwind-merge）
    │   └── validate.ts   沙箱名 / 镜像选择校验
    ├── components/
    │   ├── Toast.tsx        全局操作反馈（Base UI Toast：右上角视口 + 倒计时圆环）
    │   ├── TerminalPanel.tsx 终端标签与面板
    │   ├── TerminalView.tsx  单个终端（xterm + WebSocket）
    │   ├── ui/                shadcn/ui 原语（Base UI）
    │   │   └── combobox.tsx     可搜索选择器（Base UI Combobox：输入即本地筛选）
    │   └── workbench/         工作台各部件
    │       ├── Workbench.tsx          总装与状态中枢
    │       ├── AppShell.tsx           外壳（侧栏 + 工作区）
    │       ├── Sidebar.tsx            侧栏（品牌 / 新建 / 列表 / 底部工具）
    │       ├── SandboxList.tsx        沙箱列表项
    │       ├── WorkspaceHeader.tsx    选中沙箱的摘要与操作
    │       ├── TerminalTabs.tsx       终端会话标签条
    │       ├── EmptyState.tsx         没选中沙箱时的引导块
    │       ├── CreateSandboxDialog.tsx  新建沙箱抽屉
    │       ├── SandboxDetailDialog.tsx 沙箱详情抽屉
    │       ├── SettingsDialog.tsx      设置抽屉（代理设置 + 启动模板）
    │       ├── TemplateManager.tsx     启动模板管理区（列表 / 重命名 / 删除）
    │       ├── DrawerShell.tsx        抽屉外壳（Base UI Drawer：右侧滑出 / 宽度可拖拽）
    │       ├── DeleteSandboxDialog.tsx 删除确认弹窗（一次点即执行）
    │       ├── StopSandboxDialog.tsx   停止沙箱确认弹窗（含依赖容器勾选）
    │       ├── CloseSessionDialog.tsx   关闭终端会话弹窗
    │       └── ModalShell.tsx          弹窗外壳（Base UI Dialog：焦点陷阱 / Esc / 标题栏）
```

**改名记录**：组件文件 `ProxySettingsDialog.tsx` 用 `git mv` 改名为 `SettingsDialog.tsx`（**保留文件历史**）；**同名测试文件 `ProxySettingsDialog.test.tsx` 的内容是重写的，按新增处理**（没有保留历史，内容整体重写为 `SettingsDialog.test.tsx`）——侧边栏的「代理设置」入口改成「设置」后，抽屉里多了一区启动模板管理，文件名与组件名跟着改。**既有 `page-settings-*` 定位标识一个都没动**，只改了侧栏那一处 `page-layout-proxy-button` → `page-layout-settings-button`。

## 样式底座

Tailwind v4 + CSS 变量令牌（`src/styles/globals.css`）：

- 令牌分两套主题：亮色是 OKLCH 色板，暗色逐项映射旧暗色变量；`html.dark` 切换，`src/lib/theme.ts` 的 `useTheme()` 负责读写（只认用户明确选过的值，不跟随系统）。
- 颜色语义统一成 `--color-*`（Tailwind 主题层），因此类名是 `bg-primary` / `text-status-running` 这类常规写法。
- 侧栏与终端的配色固定：侧栏两套主题下都是深常青绿，终端恒为深色（`bg-terminal-bg`），亮暗切换不影响终端可读性。
- 选中态与 `color-scheme` 收在 `[data-console-shell]` 作用域内，只对外壳生效。

## 字体

字体自托管：Noto Sans SC 400/500/600/700 与 Geist Mono 400/500 的子集化 woff2 已入库 `public/fonts/`，构建不依赖外网；文件缺失时浏览器自动回退系统字体栈。

- **字符集来源共四处**：控制台前端源码、控制台测试源码、后端沙箱平台源码（后端中文错误文案必须覆盖）、ASCII 可打印区与一组界面常用符号，最后并入**常用汉字表**。
- **常用汉字表**：`scripts/fonts/common-hanzi.txt`（UTF-8，每行一个字，文件头三行注释写明来源与用途），内容是**通用规范汉字表一级字表**（3500 字）。并进去以后，界面上常用的汉字不再缺字形（缺字形会显示为方框）。
- **字符集规模**：并入常用汉字表那次重生成，字符集由 **1104 个字符涨到 3634 个字符**（产物 `scripts/fonts/charset.txt` 与 `public/fonts/*.woff2` 同步入库）。
- **文件缺失时报错退出**：`bash scripts/build-fonts.sh` 在 `common-hanzi.txt` 不存在时直接失败，**不静默跳过**（静默跳过会产出缺字形的子集）。
- **新增中文文案后必须重跑脚本**：`bash apps/web/frontend/scripts/build-fonts.sh`（脚本会重建字符集 → 按字重实例化 → 子集化 → 整体替换 `public/fonts/`，任一字重失败则丢弃暂存产物、保留原产物）。产物入库，仓库里的字体比界面实际用到的字符多（常用汉字表全量并入）。

## 路由（两层）

前端用**哈希路由**：后端把构建产物挂在 `/` 上（静态目录托管），深链接没有服务端回退规则会直接 404；哈希路由不依赖服务端回退，刷新与粘贴链接都能落到同一个页面。

路由只有两层：工作台本身，以及「工作台 + 选中的沙箱（可选终端会话）」。

| 路由 | 地址 | 说明 |
|---|---|---|
| 工作台 | `#/` | 左侧沙箱列表，右侧空态引导块 |
| 选中沙箱 | `#/sandboxes/<名字>` | 右侧显示该沙箱的摘要与终端会话标签 |
| 选中沙箱 + 终端会话 | `#/sandboxes/<名字>/<会话标识>` | 右侧工作区直接落在该终端会话上 |

- 新建沙箱 / 沙箱详情 / 设置**不是路由**：它们是抽屉，开关状态不入路由，刷新页面自然关闭。
- 地址里的沙箱名与会话标识会做一次百分号解码；解码失败（畸形编码，如 `#/sandboxes/%`）不会抛异常打断渲染，一律退回工作台。
- 旧四页地址（`#/new`、`#/settings` 等）不再有对应路由，解析时也退回工作台。

## 后端健康自检

侧栏底部常驻一条健康自检（`GET /api/health`，每 15 秒一次）：后端不可达时直接提示「后端服务不可达」并给出原因；后端可用但前端产物未挂载时提示「前端产物未挂载」。

## 操作反馈（toast）

**所有操作结果反馈都从右上角以 toast 弹出**，不再在页面里挂内嵌的结果横幅。
底座是 Base UI 自带的 Toast 原语（`src/components/Toast.tsx`），全局只挂一个
`ToastProvider`（在 `src/App.tsx`），不引第二套组件库。

| 口径 | 规定 |
|---|---|
| 位置 | 右上角固定视口（`page-toast-region`），`Portal` 挂到 `body`；视口补 `data-console-shell`，选中态与 `color-scheme` 规则照样命中 |
| 类型 | 成功=品牌绿（`--app-success` / `--app-success-soft`）、失败=红（`--app-destructive` / `--app-destructive-soft`）、提示=蓝（`--app-info` / `--app-info-soft`）；组件里不写裸色值 |
| 时长 | 出现后 **5 秒自然消失**（倒计时由 `ToastProvider` 层的自有计时器统一管：Base UI 的自动关闭置 0，圆环画满与 toast 消失共用同一份时间，不会各走各的） |
| 关闭键 | 每条 toast 右上角有 `×` 关闭键，可提前关闭 |
| 倒计时 | 关闭键外围一圈描边圆环（SVG `stroke-dasharray` / `stroke-dashoffset`），5 秒线性画满，与自动消失同步（画满即消失）；关键帧 `app-toast-countdown` 写在 `src/styles/globals.css`，时长取同一个常量。反馈被顶替时圆环按「代次」重建（代次只增不减），画满与消失始终同步 |
| 同时几条 | 同一时刻只留**最新一条**：新的操作结果直接顶掉旧的（轮询失败不会刷屏） |
| 谁弹 | 用户主动触发的操作失败**立刻弹**；**首次加载失败也立刻弹**；后台轮询（沙箱列表 5 秒一轮、终端会话表 10 秒一轮）**逐次失败不弹，连续失败 3 次弹一条**（任一次成功即清零）——后端整体不可达时侧栏底部的健康自检已经常驻提示，但端点级失败（接口 500）它兜不住，必须另有提示 |
| 倒计时何时会停 | **只有窗口失焦会停**（`window` 的 blur 事件）：失焦时倒计时停表、圆环停画；回前台时整条**重走 5 秒**（圆环重画 + 计时器重走），不是接着上次剩的时间继续。页面上悬停、点提示区、聚焦提示区、按下提示条、按 F6 都**不**暂停（Base UI 默认会暂停，还会接管 F6 把提示区聚焦并按停倒计时，已逐条拦掉） |
| 滑动关闭 | 关掉（`swipeDirection={[]}`）：Base UI 的滑动会顺带挂 pointerdown 处理器，触摸按下会把倒计时按停 |

不归 toast 管的就地展示（豁免）：

- **本地表单校验红字**：留在抽屉内就地展示（如新建沙箱的沙箱名 / 挂载 / 环境变量校验）；
- **删除确认弹窗里的绿色提示块**（`page-sandbox-detail-delete-untouched-note`，「用户挂载的宿主机目录不受影响」）：留在弹窗原位，不走 toast；
- **镜像列表读取失败的就地说明**（`page-sandbox-create-image-status`，`role="status"`）：一行灰色环境状态说明（「镜像列表读取失败，原因见右上角提示：…」）。它是**环境状态**不是操作结果（操作结果仍走右上角 toast），但 toast 5 秒就消失，只留 toast 会让抽屉里只剩一个没有解释的空的选择器；
- **模板列表读取失败的就地说明**（`page-sandbox-create-template-status` 与 `page-settings-template-status`，`role="status"`）：同上口径，镜像那份的孪生兄弟；
- 加载态、状态点与胶囊、空态、确认弹窗文案：一律不动。**按钮的加载态**（新建沙箱 / 刷新镜像 / 停止 / 删除 / 关闭会话 / 重启代理）统一是「旋转图标 + 无省略号文字」（图标用 lucide `Loader2`，尺寸 `size-3.5`，旋转用 `animate-spin`，图标在文字前、间距沿用按钮既有的 `gap-1.5`）；**不是按钮的加载文案**（`正在读取沙箱列表…` / `正在读取沙箱详情…` / `正在读取代理状态…` 等段落文字）保持省略号不变。

## 删除确认弹窗

弹窗支持 `Esc` 关闭与点遮罩关闭（删除进行中两者都不响应）。

删除沙箱是**一次确认**：点「确认删除」就直接发 `DELETE`。删除前不再预取回收清单，
弹窗只说两件事——删了会怎样（容器、网络、守护进程与系统用户都会被回收，不可撤销）、
哪些东西不受影响（「用户挂载的宿主机目录不受影响」，绿色提示块）。

## 停止确认弹窗

停止沙箱也要确认：工作区头部的「停止」按钮只开弹窗，不直接发请求。
弹窗标题是「停止沙箱 {名字}」，内容是后果说明（容器退出、文件与配置保留、可随时再启动）
加一个「同时停止依赖容器」复选框（**默认勾选**，与命令行默认一致）。
点「确认停止」才发 `POST /api/sandboxes/{name}/stop`；停止进行中 Esc 与遮罩都不响应。

- **每次打开都回到默认勾选**：上一次取消时的勾选状态不粘到下一次（否则会误停别的依赖容器）。
- **停止失败不关弹窗**：请求失败只弹一条失败 toast，弹窗留在原地可以直接重试（只有成功才关）。

## 弹窗与焦点管理

确认类弹窗走 `src/components/workbench/ModalShell.tsx`，底层是 Base UI 的 Dialog 原语（`src/components/ui/dialog.tsx`，`@base-ui/react`）。

- **焦点陷阱**：弹窗打开时焦点落进面板，`Tab` / `Shift+Tab` 在面板里循环，不会跑到背后的页面上。
- **背景不可交互**：弹窗开着时背景内容被标记为 `aria-hidden`（辅助技术读不到），`Tab` 走不到背景上；遮罩盖住整页，背景也点不到。
- **焦点归位**：弹窗关闭后焦点回到打开它的那个按钮。
- **关闭途径三条**：Esc、点遮罩、点右上角 `×`（lucide 图标）；三条都走 `onOpenChange(false)`，调用方可以按业务需要拦住（比如删除进行中一律不响应）。
- **默认宽度 440px**，确认类弹窗都按内容大小再单独收窄（删除 400px、停止 400px、关闭会话 360px）。
- **宽度只收像素数字**：`ModalShell` 的 `maxWidthPx` 属性收的是像素值，类名从源码里的字面量表（`WIDTH_CLASS`）取。**不能改成运行期拼类名**：Tailwind v4 只为源码里的字面量生成 CSS，运行期拼出来的 `sm:max-w-[…]` 根本没有对应规则，面板会一路撑到视口宽度（曾因此把 400px 的弹窗渲染成 1872px 满宽）。`globals.css` 里有三条 `@source inline(...)` 兜底。
- **窄屏回落**：视口窄于 640px 时不套断点变体，按视口留边（`max-w-[calc(100%-3rem)]`）。

## 抽屉（右侧滑出）

新建沙箱 / 沙箱详情 / 设置走 `src/components/workbench/DrawerShell.tsx`，底层是 Base UI 的 Drawer 原语（`src/components/ui/drawer.tsx`，零新增依赖）。

- **右侧滑出**：抽屉从右侧滑入，`swipeDirection="right"`。
- **宽度可拖拽**：面板左边缘一条 14 像素竖条（`page-drawer-resize-handle`，`role="separator"`），条子中间竖直放一个抓握图标（lucide `GripVertical`）提示这里能拖。拖动时只更新抽屉内部的本地状态，**松手才**把最终宽度上抛并写入存储（避免每像素重渲染整个工作台）。把手上按左右方向键每次调 2 个百分点，`Home` 回默认宽度。
- **已知边界（窄屏）**：视口宽度 < 640px 时抽屉**占满整屏**（宽度百分比不生效），**拖拽把手不提供入口**（`hidden sm:flex`）——可见但拖不动的把手会把脏宽度写进存储，窄屏干脆不给拖拽入口。窄屏下想调宽度得把窗口拉宽。
- **宽度共用一个存储键**：`sandbox-console-drawer-width`（`src/lib/drawer-width.ts`），存的是视口宽度的百分比，默认 40，钳位区间 [20, 80]。三个抽屉共用一份宽度：拖动任意一个，其余两个跟着变；刷新页面后保持。
- **滑动关闭**：Base UI 的横向滑动关闭**没有开关**，因此拖拽把手挂了 `data-base-ui-swipe-ignore="x"`，正文容器挂了 `data-base-ui-swipe-ignore`（表单里拖选文本不会被吃掉）。验收脚本一律用「点 × / Esc」关闭，不写滑动关闭。
- **传送 body 后配色不丢**：抽屉传送挂到 `body`，脱离了 `[data-console-shell]` 作用域，因此面板上自己挂 `data-console-shell=""`，选中态与 `color-scheme` 规则照样命中。
- **关闭途径**：Esc、点遮罩、点右上角 `×`；三条都走 `onOpenChange(false)`。
- **退场动画两层同长（150ms）**：遮罩（`ui/drawer.tsx` 的 `duration-150`）与面板（`DrawerShell.tsx` 的 `[--tw-duration:150ms]`）必须一致——Base UI 只等**面板**上的动画结束就卸载整棵树，遮罩若先播完，淡出结束后会闪回全屏（实测透明度 0.07 → 1.00）。两层都带 `data-closed:[--tw-animation-fill-mode:forwards]`，动画播完停在末帧，不回弹。
- **面板不挂 `duration-*`**：Tailwind 的 `duration-*` 会同时输出 `transition-duration`，默认 `transition-property: all` 会把宽度一起过渡，拖拽把手时面板滞后 150ms 不跟手。动画时长只写 `[--tw-duration:…]`（只影响 `animation` 简写）。

## 关键行为

### 新建沙箱

- 镜像选择器（输入即本地筛选）来自 `GET /api/images`（后端返回**裸数组**，前端按数组消费）。底座是 Base UI 的 Combobox 原语（`src/components/ui/combobox.tsx`）：输入框里打字只在前端筛，不发请求；选中后输入框回填镜像引用。
- **不自动选中任何镜像**：抽屉打开后输入框是空的（只有 placeholder 引导），详情行为空，选中由用户显式决定；没选中就提交会就地报「请选择沙箱镜像」。曾经自动选中默认镜像，原语随即把 label 回填进输入框，真实用户是在预填文字后追加，打字永远命中不了。
- **「输入框显示」与「实际提交」同一份**：提交用的镜像引用就是输入框文字完全匹配上的那张；用户改字等于放弃原选择，两者不会分叉。
- 输入框**内部右侧**有下拉箭头（`page-sandbox-create-image-trigger`，lucide `ChevronDown`，`size-4`）：箭头是**纯指示器**——绝对定位贴在输入框内、`pointer-events-none`、对辅助技术隐藏，**点击穿透到输入框**（原语默认点输入框即展开弹层）；弹层展开时输入组带 `data-popup-open`，箭头据此**旋转 180°**（带过渡）。弹层内容区限高 288px 且不超过视口可用高度，选项超高时列表内部滚动。
- 候选项**逐项给指针光标**（`cursor-pointer`）：选项渲染成 `role="option"` 的 div，不是 button，`globals.css` base 层的 `[role=option]` 兜底会被组件层的工具类盖住，因此光标在 `ui/combobox.tsx` 的选项层直接写死。
- **候选为空时列表不留空白带**：列表带 `data-empty`，据此去掉内边距（`data-[empty]:p-0`），弹层高度贴合内容（空态提示之外不多出一截）。
- 镜像选择器的弹层挂在 body 上（`page-sandbox-create-image-popup`）：脱离控制台外壳的作用域，因此 Portal 上补了 `data-console-shell`（配色作用域照样命中）与 `data-base-ui-swipe-ignore`（抽屉的横向滑动关闭不误伤弹层）。
- 镜像选择器在**页面重新可见时**（`visibilitychange`）会补拉一次，贴合「实时」要求：切回标签页就能看到宿主上的最新镜像。
- 挂载按 `宿主路径:容器路径[:ro]` 语法声明，可多条；前端先做一遍格式与敏感路径校验，**容器路径重复也在前端先拦**（少一次往返），后端仍会再校验一次。
- 提交时固定带 `image_source=host`：平台把镜像从宿主导出注入沙箱守护进程，不经镜像代理拉取。
- 读镜像列表失败与提交失败都弹**失败 toast**；本地校验（沙箱名 / 镜像 / 挂载 / 环境变量）仍在抽屉里就地展示红字。镜像列表读不到时，抽屉里另留一行就地环境状态说明（`page-sandbox-create-image-status`），免得只剩一个没有解释的空的选择器。
- **创建成功后直接关抽屉**并弹一条**成功 toast**「沙箱 X 创建成功」，列表自动刷新；不再有成功面板，也**不自动选中**新建的沙箱（需要时从左侧边栏选）。
- **创建请求在途时抽屉不响应关闭**（Esc / 遮罩 / × 一律不关）：请求已经发出，不能半途退出（与删除 / 停止弹窗口径一致）。

### 加载模板与保存为模板

新建沙箱抽屉里**最上方**（沙箱名输入之前）就是「加载模板」块；「保存为模板」按钮在抽屉**页脚**，紧靠「创建沙箱」主按钮的左侧（次级按钮样式）：

- **加载模板**是可搜索下拉（复用 `src/components/ui/combobox.tsx`，与镜像选择器同一套写法），候选来自 `GET /api/templates`（后端返回裸数组），**前端本地按模板名做子串筛选**，不发请求。
- **选中即回填**：选中模板后直接按合并口径改写表单（不另设「应用」按钮）。
- **模板声明原样回填**：模板里的字符串**不做任何占位符替换**（含 `{name}` 这样的字面量），模板里写了什么，表单里就是什么。
- **模板里的镜像不在宿主本地镜像列表里**：镜像选择器留空（不回填一个选不上的镜像），提交时走既有的「请选择沙箱镜像」校验红字。
- **保存为模板**走 `ModalShell` 命名弹窗（面板宽 400px）：名称输入 + 保存 / 取消，**空名禁提交**（按钮直接禁用 + 就地红字），保存成功弹一条**成功 toast**（来源 `sandbox-template`）并关掉弹窗、刷新模板列表。
- 抽屉打开时**并行**拉镜像列表与模板列表；两个列表读不到时各自弹失败 toast，并在抽屉里留一行就地环境状态说明。
- 模板管理区在设置抽屉里（见下）。

### 启动模板

模板是一份「沙箱启动配置」：镜像、挂载声明、启动命令、工作目录、环境变量、网桥网络。口径四条：

| 口径 | 规定 |
|---|---|
| **合并语义** | 模板里**出现**的字段**整体替换**表单值（挂载列表整组替换，不是逐条并入；环境变量整组替换），**没出现**的字段保持表单现状。「出现」用 `hasOwnProperty` 判——`{"image": null}`（填了空值）与缺 `image` 字段（没填过）是两回事 |
| **声明原样透传** | 模板配置里的字符串**不做任何占位符替换**：加载时原样回填表单，提交时原样进创建请求（挂载路径、环境变量值、启动命令、工作目录、网桥网络名一律不替换）。模板里写了 `{name}` 这样的字面量，平台就收到这个字面量，由后端既有校验兜底（路径不存在会得到明确报错） |
| **命令可以是数组** | 后端契约收 `str \| list[str] \| null`：字符串命令按 shell 引号规则切分；**数组命令前端装不进单行输入框**，加载模板时进隐藏状态原样透传（每个元素同样原样保留），命令输入框留空，提交时**隐藏的数组命令优先于表单命令** |
| **`~` 口径** | 挂载声明的宿主路径允许家目录写法（`~`、`~/data`）；前端解析器放行，后端落库前把 `~` 展开成服务运行用户的家目录。`~other`（别人的家目录）不展开也不放过。**服务以 root 身份运行时 `~` 展开为 `/root`，命中敏感目录拒绝清单返回 400**——这是既有契约的自然结果，不是缺陷 |

- 模板里的**网络**不在新建沙箱抽屉里渲染输入项（表单默认用平台自建网络），但模板携带的网络会**透传**进 `POST /api/sandboxes`。
- **模板回填的镜像**：只有宿主镜像列表**已经拿到过**时才判「模板镜像在不在宿主上」——镜像列表是秒级的宿主枚举、模板列表是毫秒级的文件读，模板几乎总是先到；列表没到手时**先原样保留**模板镜像（不能拿空列表当全集），列表到齐后由既有的清理逻辑兜底（镜像真不在就清空，提交时报既有校验）。
- 保存为模板时**只写有值的字段**（镜像 / 命令 / 工作目录 / 网络非空、挂载列表非空、环境变量非空才写入），没值字段不进配置（空配置会让「出现即替换」变成「清空用户填的东西」）；**空挂载行不进配置**（宿主路径与容器路径同时为空的行是假声明），两段路径先 trim 再入库。
- 模板里的挂载声明解析采用**宽松口径**：宿主路径不要求已存在、不查宿主敏感目录；解析不了的声明**整条跳过**并报条数（提示 toast，来源 `sandbox-template`），不让一条畸形声明把整份模板废掉。

### 删除沙箱

点「删除」直接开确认弹窗（**不预取回收清单**），点「确认删除」才发 `DELETE`，点「取消」一个删除请求都不发。删除后弹一条 toast 告知回收了多少项，沙箱没了则回到工作台首页。

### 网页终端

- xterm.js（`@xterm/xterm`）+ fit 插件（`@xterm/addon-fit`），随窗口自适应。
- **终端表面分两层**：外层是视觉层（圆角、边框、内边距、深色底，`overflow-hidden` 不滚动），内层是测量/挂载盒（`page-sandbox-detail-terminal-mount`，无内边距无边框，xterm 根元素挂在这里）。fit 插件量的是父容器的**边框盒**且只减终端元素自身的 padding，所以测量盒必须单独一层：放在带 padding 与 border 的表面上，那 26 像素（padding 24 + border 2）会被漏算，终端恒定溢出、外层长出原生滚动条。
- **终端区域只有一根滚动条**：xterm 内部那根（`.xterm-viewport`，承载 5000 行回滚），暗色定制样式在 `src/styles/globals.css`（8 像素宽、半透明滑块、悬停加深；Firefox 走标准属性兜底）。外层任何容器都不滚动，字符不会越过暗色面边缘。
- 自托管字体 swap 晚到会让列数失配（fit 用的是量出来的字符宽度），字体就绪后补一次 fit。
- **标签 = 会话**：标签条的数据源就是后端的会话表（`GET /api/terminal/sessions?sandbox=<名>`），一个标签一个会话；点标签即附着到该会话（服务端回放现场缓冲），标签尾的 `×` 是**关闭会话**（会终止容器内该会话的进程树），先弹确认。
- 终端配色与字体固定（两套主题恒定）：`Geist Mono` 12.5px，背景 `#152019`、前景 `#e3ebe5`、光标 `#a7d8af`、选区 `#2b3d31`。
- **快捷键全量拦截**：带 Ctrl / Meta / Alt 的组合一律 `preventDefault`（不让浏览器抢走），但仍然编码后送进容器内的 shell（`Ctrl+C` 必须能到 pty）。浏览器保留键交回浏览器：`Ctrl+N`/`Ctrl+Shift+N`、`Ctrl+T`/`Ctrl+Shift+T`、`Ctrl+W`/`Ctrl+Shift+W`、`Ctrl+Q`、`Ctrl+Tab`/`Ctrl+Shift+Tab`、`F5`、`F11`、`F12`、`Alt+F4`、`Ctrl+P`、`Ctrl+S`。
- 帧协议按 `API.md` 12.3：客户端二进制帧 = 终端输入字节，客户端文本帧 = `{"type":"resize","cols":..,"rows":..}`；服务端二进制帧 = 终端输出字节，服务端文本帧 = `hello` / `exit` / `error`。
- 同一沙箱可开多个终端标签，每个标签一个独立会话（容器内一个带真实 TTY 的 shell）；标签标题是「终端 N」，**N 是会话自己的登记号**（见下）。
- **标签序号跟会话身份绑定**：会话第一次被看到时按递增顺序分配一个序号（同一个沙箱内从 1 开始），之后不再变动——关掉中间的标签，其余标签的序号不重排，用户正在用的那个不会改名字。标签的**顺序**按会话的创建时间排（同一时刻创建的按会话标识排）。
- **会话表轻轮询**：面板可见时每 10 秒重新拉一次会话表（页面不可见时不拉），保证标签条与后端一致，关闭确认弹窗的「还在跑」判定也拿到较新的记录。**首次加载失败立刻弹失败 toast**；轮询失败静默（面板沿用旧数据），**连续 3 次失败弹一条失败 toast**，任一次成功即清零。
- **连接状态按会话存**：每个会话各记各的连接状态，状态栏只反映当前选中的会话；切换标签的瞬间不会还挂着上一个会话的「已连接」。
- **切沙箱不会串台**：详情加载与会话表刷新都带请求序号护栏，旧沙箱的在途响应回来时直接丢弃，不会覆盖新沙箱的头部或标签条。
- 断线后按退避节奏自动重连，**始终携带原 `session_id`**：服务端先回放环形缓冲再接实时流，现场不丢。页面刷新后（会话还在后端会话表里）点标签就能重新挂回原会话。
- **退避计数只在连接真的可用时才清零**：收到服务端的 `hello` 帧，或连接稳定存活超过 5 秒。握手成功不等于连上了——服务端握手后立刻关闭时，如果在 `onopen` 就清零计数，会退化成每 500ms 一次的连接风暴。
- 连续失败 10 次即停掉自动重连，界面显示「重连失败，点击重试」，由用户点「重试连接」手动触发。
- 后端服务重启会让全部会话失效：此时前端明确提示「终端会话已失效（后端服务已重启），请新建终端」，并停止重连。
- 服务端发来的 `error` 帧与「会话失效」都弹**失败 toast**（会话失效的文案是「终端会话已失效（后端服务已重启），请新建终端」），不会与状态栏的「已连接」混成一个文案。
- **终态也有反馈**：进程正常退出（退出码 0）弹**提示 toast**「终端会话已结束」；退出码非 0 弹**失败 toast**（文案带退出码）；**退出码未知**（后端没给退出码）同样弹**失败 toast**（文案「终端会话异常结束（退出码未知）」）；退避重连中弹**提示 toast**（文案带退避秒数）；重连到上限弹**失败 toast**「重连失败，点击重试」。同一会话的同一条提示不重复弹（服务端可能反复推同一个 error 帧）；连接恢复后清掉记录，下一轮失败能重新提示。

### 删除终端会话

- **一个标签就是一个会话**，没有第二份「后端保留的会话」列表。标签尾的 `×` 就是关闭会话：点一下弹确认弹窗，确认后发 `DELETE /api/terminal/sessions/{session_id}`；后端先完整关闭（终止宿主伪终端、容器内按会话标识清进程树）再删记录。
- **运行中的会话**：确认弹窗的标题是「关闭终端会话」，后果说明是「关闭会终止容器内该会话的进程树，终端现场不保留」，按钮文案是「关闭并移除」。
- **已退出的会话**：确认弹窗的标题是「移除终端会话记录」，后果说明是「会话已退出，只移除记录，容器内无残留进程」，按钮文案是「移除记录」。
- **确认口径保守**：标签状态与后端记录任一为 `running` 就算会话还在跑，一律按「运行中」处理（终止现场不可逆，宁可多问一句）。
- 已退出的会话**保留显示，不做自动清理**：后端的空闲回收只回收运行中且无附着的会话，已退出的会话一直列在标签条上，等用户手动删。
- 删除成功后标签消失；删除失败时展示后端 `detail` 原文。
- 删除**本体成功**与**列表刷新失败**分开提示：两者合进同一条**提示 toast（蓝色）**，不把已成功的删除说成失败；后端回报 `removed=false` 时提示「记录已不存在（可能已被删除）」，回报 `closed=false` 时提示关闭流程未走完。

### 设置（代理设置 + 启动模板）

设置是抽屉（侧边栏底部的入口文案是「设置」，图标是 lucide `Settings`）。抽屉分两区：

**第一区：代理设置**。直接展示六个字段：容器运行状态、健康状态、端口连通、缓存目录占用、证书就绪状态与代理访问地址。读状态失败与重启失败都弹**失败 toast**；点「重启代理」后弹一条**提示 toast（蓝色）**「代理正在重启，重启期间依赖镜像拉取会失败，属预期行为」（toast 5 秒后消失；按钮自身的加载态是「旋转图标 + 正在重启」）；重启结果按 `restarted` / `ca_changed` / `ca_reinstalled` / `reinstalled_users` / `failed_users` 如实展示，不把未修复报成已修复。**「刷新状态」与「重启代理」两个按钮在第一区里**（状态字段区之后、右对齐）：它们只管代理，挨着代理设置区更贴切；因此**抽屉不再有全局页脚**（两个按钮的 `data-testid` 与行为一个没变）。

**第二区：启动模板**（`src/components/workbench/TemplateManager.tsx`）：

- 列表每行给**模板名 + 最近更新时间**，另有「重命名」与「删除」两个行内按钮；列表为空时给一句空态说明，列表读不到时弹失败 toast（来源 `settings-template`）并在抽屉里留一行就地环境状态说明。
- **行内重命名**：该行变成输入框，**回车提交 / Esc 取消**，**空名禁提交**（按钮禁用 + 就地红字）；成功后弹成功 toast（来源 `settings-template`）。模板**标识不变**（标识由服务端生成，与名称解耦）。
- **删除**走 `ModalShell` 确认弹窗（面板宽 400px），文案写明**只删模板、不影响已创建的沙箱**（沙箱一旦创建就不再依赖模板）；删除失败弹失败 toast，弹窗留在原地可以重试。

## data-testid 规范

命名 `page-<页面>-<元素>`，字符集只允许小写字母、数字与连字符。

| 页面 | 页面段 | 主要标识 |
|---|---|---|
| 外壳 | `layout` | `page-layout-title` / `page-layout-health`（带 `data-health-state`）/ `page-layout-settings-button` / `page-layout-theme-toggle` |
| 沙箱列表 | `sandbox-list` | `page-sandbox-list-title` / `page-sandbox-list-item` / `page-sandbox-list-item-name` / `page-sandbox-list-item-state` / `page-sandbox-list-item-image` / `page-sandbox-list-refresh-button` / `page-sandbox-list-create-button` / `page-sandbox-list-empty` / `page-sandbox-list-loading` |
| 新建沙箱 | `sandbox-create` | `page-sandbox-create-dialog`（抽屉容器）/ `page-sandbox-create-title` / `page-sandbox-create-name-input` / `page-sandbox-create-image-select`（**镜像选择器的输入框**，可搜索；不再是原生 `select`）/ `page-sandbox-create-image-trigger`（输入框**内部右侧**的下拉箭头指示器，装饰性不可点）/ `page-sandbox-create-image-popup`（镜像选择器的弹层）/ `page-sandbox-create-image-option`（弹层里的候选镜像，带 `data-image-reference="<引用>"`）/ `page-sandbox-create-image-no-match`（搜索没命中时的空态）/ `page-sandbox-create-image-refresh-button` / `page-sandbox-create-image-detail` / `page-sandbox-create-image-empty` / `page-sandbox-create-image-status`（镜像列表读取失败的就地环境状态说明，`role="status"`）/ `page-sandbox-create-template-select`（**模板选择器的输入框**，可搜索）/ `page-sandbox-create-template-trigger`（输入框**内部右侧**的下拉箭头指示器，装饰性不可点）/ `page-sandbox-create-template-popup` / `page-sandbox-create-template-option`（弹层里的候选模板，带 `data-template-id` 与 `data-template-name`）/ `page-sandbox-create-template-no-match` / `page-sandbox-create-template-save-button`（「保存为模板」，在抽屉页脚、「创建沙箱」主按钮左侧）/ `page-sandbox-create-template-empty` / `page-sandbox-create-template-status`（模板列表读取失败的就地环境状态说明，`role="status"`）/ `page-sandbox-create-template-dialog`（命名弹窗）/ `page-sandbox-create-template-name-input` / `page-sandbox-create-template-name-error`（空名红字）/ `page-sandbox-create-template-confirm-button` / `page-sandbox-create-template-cancel-button` / `page-sandbox-create-mount-add-button` / `page-sandbox-create-mount-empty` / `page-sandbox-create-mount-item` / `page-sandbox-create-mount-host-input` / `page-sandbox-create-mount-container-input` / `page-sandbox-create-mount-readonly-checkbox` / `page-sandbox-create-mount-remove-button` / `page-sandbox-create-command-input` / `page-sandbox-create-workdir-input` / `page-sandbox-create-env-input` / `page-sandbox-create-submit-button` / `page-sandbox-create-validation-error`（本地表单校验红字）|
| 沙箱详情（工作区头部） | `sandbox-detail` | `page-sandbox-detail-title` / `page-sandbox-detail-state` / `page-sandbox-detail-image` / `page-sandbox-detail-refresh-button` / `page-sandbox-detail-start-button` / `page-sandbox-detail-stop-button` / `page-sandbox-detail-detail-button` / `page-sandbox-detail-delete-button` / `page-sandbox-detail-empty` |
| 沙箱详情抽屉 | `sandbox-detail-dialog` | `page-sandbox-detail-dialog`（抽屉容器）/ `page-sandbox-detail-dialog-state` / `page-sandbox-detail-dialog-image` / `page-sandbox-detail-dialog-created-at` / `page-sandbox-detail-dialog-updated-at` / `page-sandbox-detail-image-source` / `page-sandbox-detail-system-user` / `page-sandbox-detail-container-name` / `page-sandbox-detail-network-name` / `page-sandbox-detail-socket-path` / `page-sandbox-detail-socket-mount-path` / `page-sandbox-detail-workdir` / `page-sandbox-detail-command` / `page-sandbox-detail-subid` / `page-sandbox-detail-network-owned` / `page-sandbox-detail-env` / `page-sandbox-detail-env-item` / `page-sandbox-detail-env-empty` / `page-sandbox-detail-mounts` / `page-sandbox-detail-mount-item` / `page-sandbox-detail-mounts-empty` / `page-sandbox-detail-dependencies` / `page-sandbox-detail-dependency-item` / `page-sandbox-detail-dependencies-empty` / `page-sandbox-detail-loading` / `page-sandbox-detail-unavailable`（读不到详情时的空态说明）|
| 终端 | `sandbox-detail-terminal` | `page-sandbox-detail-terminal-panel` / `page-sandbox-detail-terminal-tabs` / `page-sandbox-detail-terminal-tab` / `page-sandbox-detail-terminal-tab-select` / `page-sandbox-detail-terminal-tab-close` / `page-sandbox-detail-terminal-new-button` / `page-sandbox-detail-terminal-status` / `page-sandbox-detail-terminal-retry-button` / `page-sandbox-detail-terminal-stopped-hint` / `page-sandbox-detail-terminal-surface` / `page-sandbox-detail-terminal-mount`（终端表面内层的测量/挂载盒，xterm 根元素的父节点）/ `page-sandbox-detail-terminal-placeholder` / `page-sandbox-detail-terminal-remove-confirm` / `page-sandbox-detail-terminal-remove-confirm-button` / `page-sandbox-detail-terminal-remove-cancel-button` |
| 设置 | `settings` | `page-settings-dialog`（抽屉容器）/ `page-settings-title` / `page-settings-container-running` / `page-settings-healthy` / `page-settings-tcp-ok` / `page-settings-cache-size` / `page-settings-certificate-ready` / `page-settings-proxy-url` / `page-settings-refresh-button` / `page-settings-restart-button` / `page-settings-restart-result` / `page-settings-restarted` / `page-settings-restart-message` / `page-settings-ca-changed` / `page-settings-ca-reinstalled` / `page-settings-ca-conclusion` / `page-settings-reinstalled-users` / `page-settings-failed-users` / `page-settings-loading` |
| 启动模板 | `settings-template` | `page-settings-template-section` / `page-settings-template-list` / `page-settings-template-item`（带 `data-template-id` 与 `data-template-name`）/ `page-settings-template-name` / `page-settings-template-updated-at` / `page-settings-template-rename-button` / `page-settings-template-rename-input` / `page-settings-template-rename-save-button` / `page-settings-template-rename-cancel-button` / `page-settings-template-rename-error` / `page-settings-template-delete-button` / `page-settings-template-delete-dialog` / `page-settings-template-delete-untouched-note`（「只删模板，不影响已创建的沙箱」）/ `page-settings-template-delete-confirm-button` / `page-settings-template-delete-cancel-button` / `page-settings-template-empty` / `page-settings-template-loading` / `page-settings-template-status`（模板列表读取失败的就地环境状态说明，`role="status"`）/ `page-settings-template-refresh-button` |
| 删除沙箱 | `sandbox-detail-delete` | `page-sandbox-detail-delete-dialog` / `page-sandbox-detail-delete-title` / `page-sandbox-detail-delete-untouched-note` / `page-sandbox-detail-delete-confirm-button` / `page-sandbox-detail-delete-cancel-button` |
| 停止沙箱 | `sandbox-detail-stop` | `page-sandbox-detail-stop-dialog` / `page-sandbox-detail-stop-title` / `page-sandbox-detail-stop-dependencies-checkbox`（「同时停止依赖容器」，默认勾选）/ `page-sandbox-detail-stop-confirm-button` / `page-sandbox-detail-stop-cancel-button` |
| 抽屉 | `drawer` | `page-drawer-resize-handle`（宽度拖拽把手，`role="separator"`，条子中间带竖向抓握图标）|
| 全局反馈 | `toast` | `page-toast-region`（右上角视口容器）/ `page-toast-item`（每条提示，带 `data-toast-kind="success\|error\|info"`，可选带 `data-toast-source="<来源>"`）/ `page-toast-close`（关闭键）|

**已退役的标识**：

旧四页与「后端保留的会话」列表下线后不再存在：
`page-layout-nav-sandboxes` / `page-layout-nav-create` / `page-layout-nav-settings`、
`page-sandbox-list-delete-*`、`page-sandbox-list-item-start-button` / `-item-stop-button` / `-item-detail-button` / `-item-delete-button` / `-item-name-link` / `-item-created-at` / `page-sandbox-list-table`、
`page-sandbox-detail-terminal-existing-list` / `-existing-item` / `-existing-attach-button` / `-existing-remove-button`、
`page-sandbox-detail-terminal-tab-remove-button`、`page-sandbox-detail-back-button`、`page-sandbox-create-back-button`。

操作结果反馈改走右上角 toast 后，内嵌的结果横幅与提示位一并退役：
`page-sandbox-list-action-message`（工作台操作提示条）/ `page-sandbox-list-error-message`（侧栏列表读取失败）/
`page-sandbox-detail-error-message`（工作区详情读取失败）/ `page-sandbox-detail-dialog-error`（详情抽屉读取失败）/
`page-sandbox-detail-terminal-error`（终端面板红色错误横幅）/ `page-sandbox-detail-terminal-notice`（终端面板蓝色提示条）/
`page-sandbox-create-error-message`（新建沙箱提交失败）/ `page-sandbox-create-image-error`（镜像列表读取失败）/
`page-settings-error-message`（代理读取 / 重启失败）/ `page-settings-restarting-message`（代理重启进行中）/
`page-sandbox-detail-terminal-message`（终端状态文案行）/ `page-sandbox-detail-terminal-count`（会话计数）/
`page-sandbox-list-count`（列表计数）/ `page-sandbox-list-updated-at`（上次刷新时间）。

抽屉改造与确认弹窗精简后下线的标识：

- **新建沙箱成功面板**（创建成功直接关抽屉 + toast，不再留成功面板）：
  `page-sandbox-create-success` / `page-sandbox-create-success-message` / `page-sandbox-create-steps` / `page-sandbox-create-success-link`；
- **删除确认的清单与武装提示**（删除改一次点即执行，不再预取回收清单）：
  `page-sandbox-detail-delete-armed-hint` / `page-sandbox-detail-delete-items` / `page-sandbox-detail-delete-item` /
  `page-sandbox-detail-delete-user-mounts` / `page-sandbox-detail-delete-user-mount-item` / `page-sandbox-detail-delete-incomplete`。

界面精简后下线的标识：

- **工作区头部的时间**（头部只留状态 / 镜像两项摘要）：
  `page-sandbox-detail-created-at` / `page-sandbox-detail-updated-at`；
- **代理设置的摘要与两个字段**（抽屉里不再有顶部摘要绿条，也不再展示 CA 可取回与状态明细）：
  `page-settings-summary` / `page-settings-ca-fetchable` / `page-settings-detail`。

侧边栏「代理设置」改名「设置」后下线的标识：

- `page-layout-proxy-button`（侧边栏底部入口：现为 `page-layout-settings-button`）。
  抽屉本身的标识（`page-settings-*`）**一个都没动**，只改了侧栏那一处。

**重复元素的定位方式**：沙箱列表项与终端标签在同一个页面上会重复出现，标识本身保持一致，另带一个属性用于区分：

```ts
// 列表项：按沙箱名筛出那一项
const item = page.getByTestId('page-sandbox-list-item').filter({ hasText: 'demo-01' });

// 终端标签：按会话标识区分
const tab = page.locator('[data-testid="page-sandbox-detail-terminal-tab"][data-session-id="abc123"]');
```

列表项额外带 `data-sandbox-name` 与 `data-sandbox-state`，终端标签与终端表面额外带 `data-session-id`（终端标签还带 `data-active`）。

toast 条目另带 `data-toast-kind` 区分类型（`success` / `error` / `info`），可选再带 `data-toast-source` 区分来源：

```ts
// 失败 toast：右上角唯一一条
const failed = page.locator('[data-testid="page-toast-item"][data-toast-kind="error"]');

// 只认「沙箱详情读取失败」这一条：同页上残留的无关失败提示不算数
const detailFailed = page.locator(
  '[data-testid="page-toast-item"][data-toast-kind="error"][data-toast-source="sandbox-detail"]',
);
```

`data-toast-source` 的取值（没写的 toast 不带这个属性）：

| 来源 | 什么时候弹 |
|---|---|
| `sandbox-list` | 沙箱列表读取失败（首次加载 / 连续 3 次轮询失败） |
| `sandbox-detail` | 沙箱详情读取失败 |
| `sandbox-lifecycle` | 启动 / 停止沙箱的结果 |
| `sandbox-delete` | 删除沙箱的结果 |
| `terminal-sessions` | 终端会话表读取失败、关闭会话的副作用提示 |
| `terminal-status` | 终端会话状态变化（失效 / 报错 / 退出 / 重连） |
| `sandbox-create` | 新建沙箱抽屉里的镜像列表读取失败、提交失败 |
| `sandbox-template` | 新建沙箱抽屉里的模板列表读取失败、保存模板的结果、模板里有解析不了的挂载声明 |
| `proxy-settings` | 代理状态读取失败、代理重启结果 |
| `settings-template` | 设置抽屉里的模板列表读取失败、重命名与删除模板的结果 |

toast 5 秒后自动消失，断言要放在动作之后立即执行。

**同页双挂载的标识**（页面上同时存在多个，取第一个即可）：

- `page-sandbox-list-create-button`：侧栏顶部的「新建沙箱」按钮与右侧空态引导块里的「新建沙箱」按钮各挂一个。用 `page.getByTestId('page-sandbox-list-create-button').first().click()` 即可。
- `page-sandbox-detail-dialog-*`（状态 / 镜像）：这两个字段在工作区头部也有同名元素（`page-sandbox-detail-state` / `-image`），抽屉里的版本加了 `dialog-` 前缀，两者不会撞名。

## 接口一览

| 方法 | 路径 | 前端用途 |
|---|---|---|
| GET | `/api/health` | 侧栏底部的健康自检 |
| GET | `/api/sandboxes` | 侧栏沙箱列表（裸数组） |
| POST | `/api/sandboxes` | 新建沙箱（带 `image_source=host`） |
| GET | `/api/sandboxes/{name}` | 工作区摘要与详情抽屉 |
| POST | `/api/sandboxes/{name}/start` | 启动 |
| POST | `/api/sandboxes/{name}/stop` | 停止（带 `stop_dependencies`） |
| GET | `/api/sandboxes/{name}/reclaim` | 删除前的回收清单（控制台页面已不再调用，保留给脚本与将来的清单预览）|
| DELETE | `/api/sandboxes/{name}` | 删除 |
| GET | `/api/images` | 新建抽屉的镜像选择器（裸数组） |
| GET | `/api/proxy/status` | 代理设置抽屉 |
| POST | `/api/proxy/restart` | 重启代理 |
| GET | `/api/templates` | 启动模板列表（裸数组；新建抽屉的模板选择器与设置抽屉的模板管理区共用） |
| POST | `/api/templates` | 保存为模板（名称 + 配置体） |
| POST | `/api/templates/{id}/rename` | 重命名模板（只改名称，标识不变） |
| DELETE | `/api/templates/{id}` | 删除模板 |
| POST | `/api/terminal/sessions` | 新建终端会话 |
| GET | `/api/terminal/sessions?sandbox=` | 终端标签条的数据源（裸数组） |
| DELETE | `/api/terminal/sessions/{session_id}` | 删除会话（运行中＝先关后删，已退出＝走一遍收尾再删） |
| WS | `/api/terminal/sessions/{session_id}` | 终端帧桥接 |

错误消息一律直接展示后端 `{"detail": "中文消息"}` 里的 `detail`，前端不另造说法。
