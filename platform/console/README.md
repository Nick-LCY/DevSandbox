# 网页控制台前端

沙箱平台的网页控制台：沙箱列表、新建沙箱、沙箱详情（含网页终端）、代理设置四个页面。

- 技术栈：React 19 + Vite 7 + TypeScript 5.9，pnpm 管理，Node ≥ 22。
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
pnpm run test       # vitest run，纯数据转换逻辑的单元测试
```

单元测试覆盖挂载声明解析、环境变量解析、路由解析、字节与时间格式化、终端帧协议解析、代理状态文案转换。

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
    ├── App.tsx           路由分发
    ├── styles.css        样式
    ├── api/
    │   ├── client.ts     接口调用与错误映射（统一读后端 detail 文案）
    │   └── types.ts      接口数据形状（与后端 schemas.py 对齐）
    ├── lib/              纯逻辑（可单测）
    │   ├── router.ts     哈希路由
    │   ├── format.ts     字节数 / 时间戳格式化
    │   ├── mounts.ts     挂载声明解析与校验
    │   ├── env.ts        环境变量声明解析
    │   ├── proxy.ts      代理状态文案转换
    │   ├── terminal.ts   终端帧协议
    │   └── validate.ts   沙箱名 / 镜像选择校验
    ├── components/
    │   ├── Layout.tsx        外壳与导航
    │   ├── ErrorBanner.tsx   错误提示条
    │   ├── ReclaimDialog.tsx 删除前的回收清单弹窗
    │   ├── TerminalPanel.tsx 终端标签与面板
    │   └── TerminalView.tsx  单个终端（xterm + WebSocket）
    └── pages/
        ├── SandboxListPage.tsx    沙箱列表
        ├── SandboxCreatePage.tsx  新建沙箱
        ├── SandboxDetailPage.tsx  沙箱详情（含终端）
        └── SettingsPage.tsx       代理设置
```

## 页面与路由

前端用**哈希路由**：后端把构建产物挂在 `/` 上（静态目录托管），深链接没有服务端回退规则会直接 404；哈希路由不依赖服务端回退，刷新与粘贴链接都能落到同一个页面。

| 页面 | 地址 | 说明 |
|---|---|---|
| 沙箱列表 | `#/` | 名字 / 状态 / 镜像 / 创建时间 + 行内操作；每 5 秒轮询，也可手动刷新 |
| 新建沙箱 | `#/new` | 镜像下拉实时拉 `GET /api/images`；可声明多条挂载；提交带 `image_source=host` |
| 沙箱详情 | `#/sandboxes/<名字>` | 完整信息 + 启动 / 停止 / 删除 + 网页终端面板 |
| 代理设置 | `#/settings` | 代理状态与「重启代理」 |

## 关键行为

### 新建沙箱

- 镜像下拉来自 `GET /api/images`（后端返回**裸数组**，前端按数组消费）。
- 挂载按 `宿主路径:容器路径[:ro]` 语法声明，可多条；前端先做一遍格式与敏感路径校验，后端仍会再校验一次。
- 提交时固定带 `image_source=host`：平台把镜像从宿主导出注入沙箱守护进程，不经镜像代理拉取。

### 删除沙箱

先 `GET /api/sandboxes/{name}/reclaim` 拿到平台回收清单，弹窗列出清单并写明「用户挂载的宿主机目录不受影响」；用户点「确认删除」才发 `DELETE`，点「取消」一个删除请求都不发。

### 网页终端

- xterm.js（`@xterm/xterm`）+ fit 插件（`@xterm/addon-fit`），随窗口自适应。
- 帧协议按 `API.md` 12.3：客户端二进制帧 = 终端输入字节，客户端文本帧 = `{"type":"resize","cols":..,"rows":..}`；服务端二进制帧 = 终端输出字节，服务端文本帧 = `hello` / `exit` / `error`。
- 同一沙箱可开多个终端标签，每个标签一个独立会话（容器内一个带真实 TTY 的 shell）。
- 断线后按退避节奏自动重连，**始终携带原 `session_id`**：服务端先回放环形缓冲再接实时流，现场不丢。页面刷新后也可以在「后端保留的会话」列表里点「附着」重新挂回原会话。
- 后端服务重启会让全部会话失效：此时前端明确提示「终端会话已失效（后端服务已重启），请新建终端」，并停止重连。

### 代理设置

展示容器运行状态、健康状态、端口连通、CA 是否可取回、缓存目录占用、证书就绪状态与代理访问地址。「重启代理」按钮在重启期间提示「代理正在重启，重启期间依赖镜像拉取会失败，属预期行为」；重启结果按 `restarted` / `ca_changed` / `ca_reinstalled` / `reinstalled_users` / `failed_users` 如实展示，不把未修复报成已修复。

## data-testid 规范

命名 `page-<页面>-<元素>`，字符集只允许小写字母、数字与连字符。

| 页面 | 页面段 | 主要标识 |
|---|---|---|
| 沙箱列表 | `sandbox-list` | `page-sandbox-list-title` / `-table` / `-item` / `-item-name` / `-item-state` / `-item-image` / `-item-created-at` / `-item-start-button` / `-item-stop-button` / `-item-detail-button` / `-item-delete-button` / `-refresh-button` / `-create-button` / `-error-message` / `-empty` |
| 新建沙箱 | `sandbox-create` | `page-sandbox-create-title` / `-name-input` / `-image-select` / `-image-refresh-button` / `-image-detail` / `-mount-add-button` / `-mount-item` / `-mount-host-input` / `-mount-container-input` / `-mount-readonly-checkbox` / `-mount-remove-button` / `-command-input` / `-workdir-input` / `-env-input` / `-submit-button` / `-error-message` / `-success` / `-success-link` |
| 沙箱详情 | `sandbox-detail` | `page-sandbox-detail-title` / `-state` / `-image` / `-image-source` / `-system-user` / `-container-name` / `-network-name` / `-created-at` / `-updated-at` / `-socket-path` / `-workdir` / `-command` / `-env` / `-mounts` / `-dependencies` / `-start-button` / `-stop-button` / `-delete-button` / `-refresh-button` / `-back-button` / `-terminal-panel` / `-terminal-new-button` / `-terminal-tab` / `-terminal-status` / `-terminal-message` / `-terminal-surface` / `-terminal-existing-list` / `-terminal-existing-item` / `-terminal-existing-attach-button` |
| 代理设置 | `settings` | `page-settings-title` / `-container-running` / `-healthy` / `-tcp-ok` / `-ca-fetchable` / `-cache-size` / `-certificate-ready` / `-proxy-url` / `-detail` / `-restart-button` / `-restarting-message` / `-restarted` / `-restart-message` / `-ca-changed` / `-ca-reinstalled` / `-ca-conclusion` / `-reinstalled-users` / `-failed-users` / `-error-message` |
| 外壳 | `layout` | `page-layout-title` / `page-layout-nav-sandboxes` / `page-layout-nav-create` / `page-layout-nav-settings` |

删除确认弹窗的标识按所在页面加前缀：`page-sandbox-list-delete-*` 与 `page-sandbox-detail-delete-*`（`-dialog` / `-title` / `-untouched-note` / `-items` / `-item` / `-user-mounts` / `-confirm-button` / `-cancel-button`）。

**重复元素的定位方式**：列表行与终端标签在同一个页面上会重复出现，标识本身保持一致，另带一个属性用于区分：

```ts
// 列表行：按沙箱名筛出那一行
const row = page.getByTestId('page-sandbox-list-item').filter({ hasText: 'demo-01' });
await row.getByTestId('page-sandbox-list-item-start-button').click();

// 终端标签：按会话标识区分
const tab = page.getByTestId('page-sandbox-detail-terminal-tab').filter({ hasText: '终端 2' });
```

列表行额外带 `data-sandbox-name`，终端标签与终端面板额外带 `data-session-id`。

## 接口一览

| 方法 | 路径 | 前端用途 |
|---|---|---|
| GET | `/api/health` | 预留（服务自检） |
| GET | `/api/sandboxes` | 列表页（裸数组） |
| POST | `/api/sandboxes` | 新建沙箱（带 `image_source=host`） |
| GET | `/api/sandboxes/{name}` | 详情页 |
| POST | `/api/sandboxes/{name}/start` | 启动 |
| POST | `/api/sandboxes/{name}/stop` | 停止（带 `stop_dependencies`） |
| GET | `/api/sandboxes/{name}/reclaim` | 删除前的回收清单 |
| DELETE | `/api/sandboxes/{name}` | 删除 |
| GET | `/api/images` | 新建页镜像下拉（裸数组） |
| GET | `/api/proxy/status` | 设置页状态 |
| POST | `/api/proxy/restart` | 重启代理 |
| POST | `/api/terminal/sessions` | 新建终端会话 |
| GET | `/api/terminal/sessions?sandbox=` | 列出可重新附着的会话（裸数组） |
| WS | `/api/terminal/sessions/{session_id}` | 终端帧桥接 |

错误消息一律直接展示后端 `{"detail": "中文消息"}` 里的 `detail`，前端不另造说法。
