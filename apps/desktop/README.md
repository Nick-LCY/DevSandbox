# 沙箱控制台桌面端（Tauri v2）

沙箱平台的**桌面壳**。它是一个**纯连接器**：只做「装载前端静态产物 + 按连接配置设定 CSP + 维护端口转发的本机监听与隧道桥接」三件事，**不拉起后端、不托管后端进程、不管理后端生命周期**。

- 技术栈：Tauri v2（Rust）+ 复用 `apps/web/frontend` 的 React 19 前端产物，pnpm 管理 JS 侧，Node ≥ 22。
- **同一份前端产物**：桌面与 web 形态共用 `apps/web/frontend/dist`，**不存在第二份前端源码或第二份产物**（`tauri.conf.json` 的 `build.frontendDist` 直接指过去）。
- 前端用特性探测判断是否运行在 Tauri 里（检查 `window.__TAURI_INTERNALS__`），**不引入 `@tauri-apps/api` 依赖**，web 形态的产物因此不被 Tauri 污染。

## 目录结构

```
apps/desktop/
├── package.json              # 私有包；devDependencies 只有 @tauri-apps/cli（^2）
├── pnpm-lock.yaml            # JS 侧依赖锁
├── scripts/
│   └── probe_rootless_port_forward.py   # 三期打样探针（P1 / P3），不属于运行时依赖
└── src-tauri/
    ├── Cargo.toml            # tauri = "2"（开 config-json5：tauri.conf.json 能写注释）+ tauri-build
    ├── build.rs
    ├── tauri.conf.json       # productName / identifier / frontendDist / bundle.targets / app.security.csp
    ├── src/main.rs           # 窗口与 webview 创建（在这里注入运行期 CSP）+ 连接配置命令 + 转发命令注册
    ├── src/csp.rs            # CSP 基线策略与运行期改写（纯函数 + 单元测试）
    ├── src/forward.rs        # 端口转发：本机 TCP 监听 + 隧道 WS 桥接（纯函数 + 单元测试）
    ├── src/commands.rs       # 端口转发的 Tauri 命令（start_forward / stop_forward / forward_listeners）
    ├── capabilities/         # ACL 能力清单（default.json：放行 core:event 的 listen / unlisten）
    └── icons/                # 图标（source.png 是源图，其余由 `pnpm tauri icon` 生成）
```

## 本机（Linux）开发与校验

本机没有 WebView2，**只能校验到「能编译」这一层**；真机行为（WebView2 冒烟、NSIS 出包）在 Windows 上验。

```bash
cd apps/desktop
pnpm install

# 1) 前端产物（与 web 形态同一份）
pnpm --dir ../web/frontend install --frozen-lockfile
pnpm --dir ../web/frontend build

# 2) Rust 侧编译校验
cd src-tauri && cargo check
```

Linux 上编 Tauri 需要系统开发库（Ubuntu 24.04 / 26.04）：

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config
```

## Windows 构建指引

### 前置环境

| 依赖 | 说明 |
|---|---|
| **Rust stable（MSVC 工具链）** | `rustup toolchain install stable-msvc`；`rustup default stable-msvc`。Tauri v2 **不支持从 Linux 交叉编译出 Windows 安装包**（WebView2 SDK + MSVC 工具链 + NSIS/WiX 打包器三重依赖），必须在 Windows 上构建。 |
| **Visual Studio Build Tools** | 勾选「使用 C++ 的桌面开发」工作负载（含 MSVC v143 + Windows SDK）。 |
| **WebView2 SDK** | Tauri v2 的 `tauri-build` 需要 `Microsoft.Web.WebView2` NuGet 包；装好 Build Tools 后由 `tauri` CLI 自动拉取。 |
| **Node ≥ 22 + pnpm 10** | `nvm use 22` / `corepack enable`。 |
| **WebView2 运行时** | Windows 11 与较新的 Windows 10 已内置；旧机器需装 Evergreen Runtime（见下「WebView2 运行时策略」）。 |

### 构建命令序列

在 **仓库根目录**执行（或在 `apps/desktop` 下执行，注意 `beforeBuildCommand` 的相对路径按 `apps/desktop` 计算）：

```powershell
# 0) 拉代码后切到需要出包的分支

# 1) JS 侧依赖
cd apps\desktop
pnpm install

# 2) 前端产物（与 web 形态同一份，落在 apps\web\frontend\dist）
pnpm --dir ..\web\frontend install --frozen-lockfile
pnpm --dir ..\web\frontend build

# 3) 出包（NSIS 安装包）
pnpm tauri build
```

`tauri.conf.json` 里已经配了 `build.beforeBuildCommand = "pnpm --dir ../web/frontend build"`，所以第 3 步会**自动重跑前端构建**，第 2 步的 **`build` 可以省掉**（显式跑一次便于先确认前端本身能过 `tsc`）。

> ⚠️ 但第 2 步的 **`install --frozen-lockfile` 不能省**：`beforeBuildCommand` 调的是 `pnpm --dir ../web/frontend build`，它靠前端目录里的 `node_modules` 提供 `tsc` / `vite`；前端依赖没装过时，`build` 会直接报「命令找不到」。

### 产物位置

| 产物 | 路径 |
|---|---|
| NSIS 安装包 | `apps\desktop\src-tauri\target\release\bundle\nsis\沙箱控制台_<版本>_x64-setup.exe` |
| cargo 原始产物（可执行文件） | `apps\desktop\src-tauri\target\release\sandbox-console-desktop.exe`（**按 Cargo 包名命名，不是中文**） |
| 安装后的可执行文件 | `%LOCALAPPDATA%\沙箱控制台\沙箱控制台.exe`（NSIS 安装后落在安装目录里，用的是中文 productName） |
| Rust 中间产物 | `apps\desktop\src-tauri\target\`（已被 `.gitignore` 忽略） |

> ⚠️ **中文 `productName` 的风险（留待任务 08 评估）**：`productName` 是中文「沙箱控制台」，它会进入**安装包文件名**（`沙箱控制台_<版本>_x64-setup.exe`）与 **NSIS 安装脚本的代码页**。中文文件名 + 非 ASCII 路径在部分 CI 环境、杀软 / Windows Defender 的启发式扫描、以及从压缩包释放的安装脚本里，可能触发误报或编码坑；重命名 / 改用 ASCII productName 属于产品命名决策，**本轮不自行改动**，记在这里等任务 08 评估。

`bundle.targets` 目前只含 `nsis`（Windows 安装包）；要加 MSI 时在 `tauri.conf.json` 的 `bundle.targets` 里补 `"msi"`。

### 快速冒烟（开发模式）

```powershell
cd apps\desktop
pnpm tauri dev
```

`pnpm tauri dev` 会：

1. 跑 `beforeBuildCommand` 之外的前端开发服务（`beforeDevCommand` = `pnpm --dir ../web/frontend dev`，起在 `http://localhost:5173`）；
2. 打开 Tauri 窗口并加载 `devUrl`（`http://localhost:5173`）。

冒烟路径（**当前打样壳只能验到前两步**）：**窗口能打开 → 页面正常渲染 →（样式 / 终端表面看起来正常）**。

> 连接配置与后端连通**本轮（打样轮）不可验**：任务 03（前端连接层）已落地引导面板与连接配置区，但真机上的「填后端地址与令牌 → 沙箱列表能拉到 → 能开终端」要等真机（Windows + WebView2）复验；且令牌与票据需要后端 02 的服务真跑起来。

> 开发模式下前端跑在 `http://localhost:5173`，生产模式跑在 Tauri 自定义协议下（Windows 上是 `http://tauri.localhost`）。两者的资源路径解析差异由前端 `base` 决定，见「已知边界」。

## WebView2 三项冒烟（P2 真机操作步骤）

在 **Windows 真机 + WebView2** 上跑（不接受「桌面版 Chromium 里过了就算过」）。每项都要留下「现象截图或输出」。

准备：`pnpm tauri build` 出包后安装并启动「沙箱控制台」，或直接 `pnpm tauri dev`（两条路径都验，dev 与安装包行为可能不同，建议先验安装包）。

### ① `oklch()` 配色

Tailwind v4 的整套色板以 `oklch()` 为底座，Chromium < 111 会整页掉色。

- **怎么看**：应用打开后界面**有颜色**（不是一片灰白 / 黑）。
- **怎么算过**：任选一处令牌色元素（如选中态、按钮、标签），肉眼确认颜色正常；进一步可在 DevTools（`Ctrl+Shift+I`）控制台执行：

  ```js
  getComputedStyle(document.documentElement).getPropertyValue('--primary')
  // 或直接验证 oklch 解析能力：
  CSS.supports('color', 'oklch(0.7 0.15 200)')   // 必须为 true
  ```

  两个都为真 / 界面有颜色 → 通过。
- **不通过的现象**：整页无色（所有颜色退化成同一灰度）、`CSS.supports('color', 'oklch(...)')` 为 `false`。
- **备案路径**：令牌层补一条 `rgb()` 回退色（只改 `globals.css` 的 `:root` / `.dark` 与 `@theme` 映射，不在组件里写裸色值）。

### ② xterm.js（渲染 + fit + 表面不溢出）

- **怎么看**：沙箱详情 → 网页终端，终端区域出现字符、且**字体度量正常**（不是方块、不是挤成一团）。
- **怎么算过**：
  1. **渲染**：终端里能看到 shell 提示符并能敲命令回显；
  2. **fit 列数正确**：在 DevTools 里读 xterm 的实际列数，与窗口宽度相符——例如窗口宽度不变时**拖动窗口改变宽度**，列数应跟着变（`Ctrl+Shift+I` → Console 执行，或在终端里 `tput cols` 看宿主环境列数，注意二者可能不同，判断标准是「改变宽度时列数会变且与可视区域匹配」）；
  3. **表面不溢出**：终端右边缘不出现原生滚动条，字符不被裁切（`Ctrl+Shift+I` 里看 `.xterm-viewport` 是否有 `overflow` 滚动条，或直接看屏幕）。
- **已知坑**：自托管字体 swap 晚到会让列数失配（前端已有 `document.fonts.ready` 后补 `fit` 的处理），要在 WebView2 下复验一次。
- **不通过的备案**：调整终端测量盒与字体度量。

### ③ `navigator.clipboard`

- **怎么看**：在终端里选中一段文本按 `Ctrl+Shift+C`，再到别的应用里粘贴；再在别的应用复制一段文本回终端按 `Ctrl+Shift+V`。
- **怎么算过**：
  1. **安全上下文**：DevTools Console 执行 `window.isSecureContext` —— 必须为 `true`（Tauri 的自定义协议在 Windows 上被当作安全上下文）；
  2. **读写都成功**：复制与粘贴两个方向都能拿到正确内容；
  3. **接口存在**：`typeof navigator.clipboard !== 'undefined'`。
- **不通过的备案**：剪贴板快捷键改走 Tauri 侧剪贴板能力（会改 `src/lib/terminal-shortcuts.ts` 的分类口径与单元测试）。既有约定是「非安全上下文下接口不存在，走失败路径弹提示，不做降级」——所以判定重点是**接口在不在**，而不是有没有做降级。

## WebView2 运行时策略（P5）

`webviewInstallMode` 三选一，打样轮的结论与取值见 [[tasks/phase3-desktop/RESULTS.md|三期留档]]：

1. **Evergreen 静默安装**（默认）：目标机器没装运行时时由安装包静默拉取——**离线机器会失败**；
2. **离线安装包随包分发**：把 Evergreen Bootstrapper 打进安装包——体积变大，但离线可用；
3. **提示用户自装**：安装包检测到缺运行时时给出手动下载指引。

无论选哪条，README 与安装包引导里都要写明**最低 WebView2 版本**。

## CSP（内容安全策略）

**CSP 不再是 `null`**：`tauri.conf.json` 的 `app.security.csp` 写的是基线策略，
**Rust 侧在主文档被请求时再动态改写一次**（`src/main.rs` 的 `on_web_resource_request`）。

三条设计要点（依据：ADR 0015 第 6 节）：

| 要点 | 口径 | 理由 |
|---|---|---|
| `connect-src` | **host 级**：基线只有 `'self'`，运行期把**当前后端主机**补进去（`http(s)://<后端host>:*` 与 `ws(s)://<后端host>:*`）。**不放行 `http:` / `https:` / `ws:` / `wss:` 这类 scheme 通配** | 后端地址是**用户运行期可配的主机**，静态策略枚举不完运行期才出现的地址——但枚举不完不等于「全放行」：scheme 通配等于「页面能往任意主机连」，CSP 就失去意义了。host 级放行只开用户**真填的那台主机**；端口用 `:*` 是因为端口也是用户填的。真正的准入边界是**令牌与一次性票据**（后端侧校验），CSP 只管「页面能往哪台主机连」 |
| `script-src` | **不放行 `unsafe-inline`**；配置里只写 `script-src 'self'` | 前端产物里的内联防闪烁脚本靠**内容 hash**（`'sha256-...'`）放行：hash 由 Tauri 在**构建期**按产物 `index.html` 里的内联脚本内容算出来并注入策略（tauri-codegen 的 `inject_script_hashes`）。hash 跟着产物走，改了脚本重新构建即可，不会失效 |
| `style-src` | 放行 `'unsafe-inline'` | **如实放行**：xterm.js 与 React 都会写行内样式（xterm 的终端表面定位、toast 的倒计时圆环变量），行内 `style` 属性在 CSP 下归 `style-src` 管，不放行就整片样式失效 |
| `style-src-attr` | **不单独收紧**（本轮保持现状） | Chromium / WebView2 支持这个指令，收紧成 `'none'` 在技术上可行；但 xterm.js 与 React 都写行内 `style` 属性（行内 `style` 属性归 `style-src-attr` 管，不受 `style-src` 的 `'unsafe-inline'` 覆盖），收紧后要先确认这些样式全部能改成 class / CSS 变量，否则终端表面会整片错位。**这是个需要真机（WebView2）复验的改动**，本轮不冒险；要收紧的前提是先在 CSS 层消除行内样式 |

### 时序契约（CSP 与主文档重载）

**主文档的 CSP 只在主文档被请求时生成**（`on_web_resource_request` 挂在 webview 创建时，
运行期没有「给已有 webview 换 CSP」的接口）。因此「知道后端主机」与「这一版主文档的 CSP 带上它」
之间有一个时间窗，**必须用重载补上**：

```
前端                                        桌面壳（Rust）
────                                        ─────────────
保存连接配置
  └ await invoke('set_backend_base_url', 后端基址)
                                              └ 更新状态 desired（幂等）
  └ await invoke('csp_needs_reload')
                                              └ 比对 loaded（这一版主文档用的基址）与 desired
  └ 不一致 → location.reload()
                                              ┌ 主文档重新被请求
                                              └ 按 desired 生成这一版 CSP（connect-src 带上后端主机）
```

- **顺序是硬要求**：先更新状态（`set_backend_base_url` 返回），再重载主文档。反了就拿到旧 CSP。
- **谁触发重载**：前端（它要知道「状态已更新」才能重载）。Rust 侧不主动 reload，只提供
  `csp_needs_reload` 这个判定。
- **dev 构建下恒不需要重载**（dev 页面不经协议提供，CSP 状态机不适用）：dev 下 webview 直接导航到
  devUrl（`http://localhost:5173`），主文档**不经 tauri 协议提供**（Tauri 的 `PROXY_DEV_SERVER`
  只在 mobile 生效），`on_web_resource_request` 不会触发 → `loaded` 永远是 `None`，
  「已加载 CSP」的状态机在 dev 下不适用。此时若照常判定就会永远「不一致」，前端会陷入
  **无限整页刷新**。因此 `csp_needs_reload` 在 dev 下**恒返回 false**（判定用
  `tauri::is_dev()`，编译期常量；逻辑收敛在 `src/csp.rs` 的纯函数 `needs_csp_reload`，有单元测试）。
  发布构建（主文档走协议提供）才按「`loaded` 与 `desired` 是否一致」判定。
- **潜在坑：`build.frontendDist` 不得配成外部 URL**（`FrontendDist::Url` 形态）：那种形态下**发布构建**的
  主文档**同样不经协议提供**（Tauri 把那个外部 URL 直接当作应用 URL），`on_web_resource_request`
  不触发 → `loaded` 永远是 `None` → 与 dev 同款的**无限整页刷新**。当前 `tauri.conf.json` 里配的是
  **本地目录路径**（`../../web/frontend/dist`），不受影响。
- **重载不丢配置**：连接配置存在 localStorage 里，重载后前端直接进工作台。
- **发布构建下，基址恒非空后，桌面端每次启动会同步一次 CSP 并重载一次主文档**：前端启动时把后端基址
  （**恒非空、恒归一**：`normalizeBaseUrl` 补 scheme、空值落回默认地址）经 `set_backend_base_url` 送来，
  `desired` 从 `None` 变成那个基址；而这一版主文档的 CSP 还是启动时生成的（`loaded` 仍是 `None`），
  `loaded != desired` → **重载一次主文档**。重载后主文档按 `desired` 重新生成 CSP（`loaded == desired`），
  **不再重载**——这是**预期行为，不是死循环**（dev 构建恒不重载，见上）。
- **桌面形态首次配置**：跨主机的健康检查会被 CSP 拦死（这一版主文档的 CSP 里还没有后端主机），
  所以引导面板的「保存并连接」先走「写待验证配置 → 同步 CSP → 重载」，重载回来时再体检，
  **体检通过才提升为生效配置**（口径见 `apps/web/frontend/README.md` 的「连接配置」一节）。
- **Rust 侧只存基址，不存令牌**：`CspState` 里只有 `desired` 与 `loaded` 两个基址字符串。

其它说明：

- **窗口在 Rust 侧建**（`src/main.rs` 的 `WebviewWindowBuilder`，**不走 `tauri.conf.json` 的 `app.windows`**）：
  `on_web_resource_request` 只能在 webview 创建时挂上，运行期没有「给已有 webview 换 CSP」的接口。
  窗口参数（标题、1280×800、最小 1024×640、可缩放）与原配置一致。
  `tauri.conf.json` 里 `app.windows` 的位置留了一行注释指向 `main.rs`（**别加回去**：会开出第二个窗口）。
- **`tauri.conf.json` 能写注释**：`Cargo.toml` 里给 `tauri` 与 `tauri-build` 都开了 `config-json5`
  特性（与 tauri-cli 的解析口径一致——CLI 恒开这个特性），因此配置里可以用 `//` 注释。
- **命令的 ACL**：`set_backend_base_url` 与 `csp_needs_reload` 都是**应用自带命令**。
  应用自带命令只被两样东西拦：① 应用自己的权限清单（`src-tauri/permissions/`，
  本工程**没有**）；② 非本地来源（远程网页发起的调用）。
  **能力清单（`src-tauri/capabilities/`）不拦应用自带命令**——它拦的是**插件命令**
  （`plugin:*`）。本工程的能力清单只放行了 `core:event` 的 listen / unlisten
  （见「端口转发」一节），不涉及这两条命令。
- 策略改写是**幂等**的：重复改写不会把来源加两遍（`src/csp.rs` 有单元测试）。
- **IPv6 主机**：`url::Url::host_str()` 返回的主机**已经带方括号**（`[::1]`），拼来源时不再包一层
  （否则会变成 `[[::1]]`，那条来源在 CSP 里不合法）。
- **响应上没有 CSP 头的兜底分支**：正常路径走不到（Tauri 总会给主文档写 CSP 头）。真走到时补一条基线策略，
  **它不含 script 内容 hash**（hash 是构建期算出来注入响应头的，这里算不出来）——后果是内联防闪烁脚本被拦
  （首帧可能闪一下白），连接不会被拦死。该分支会打一行提示（`eprintln!`；发布版 Windows 没有控制台，只在开发态可见）。

### `style-src-attr` 收紧（未做，附论证）

见上表的 `style-src-attr` 行：技术上可行（Chromium / WebView2 支持），但要先在 CSS 层消除行内样式、
并经真机复验，本轮不做。

```bash
cd src-tauri && cargo check      # Rust 侧编译校验
cd src-tauri && cargo test       # CSP 与端口转发的纯函数单元测试
```

## 端口转发（本机监听 + 隧道桥接）

实现见 `src/forward.rs`（监听管理与字节桥接）与 `src/commands.rs`（Tauri 命令）。
链路与协议口径见 `apps/web/backend/API.md` 第 15 章与
[[architecture/decisions/0014-端口转发机制选型.md|ADR 0014]]。

### 监听模型

- **一个「开启的转发」= 一个本机 `TcpListener`**（`127.0.0.1:<本机端口>`，**只绑回环**，不出本机）。
- **监听器活到用户 `stop_forward` 为止**：单条隧道断开**不关监听**——只关掉那一条本机连接，
  并上报**连接级**状态（`forward://connection`）。下一次连接会重新建隧道。
- **每条 accept 到的 TCP 连接各开一条隧道 WS**（服务端支持并发隧道，天然满足
  「同一转发的多条并发连接互不串扰」）。
- **转发级的致命失败**（后端不可达、令牌无效、转发不存在/已停止……，都发生在**隧道建立阶段**）
  → 上报**转发级**状态（`forward://state`），监听器仍然保留（用户改完配置可以再试一次）。
- **停止转发 = 关监听 + 关全部连接**：取消信号覆盖**每条连接**的桥接 future
  （`src/forward.rs` 的 `accept_loop` 里，整条 `bridge` 挂在
  `tokio::select!` 的取消分支上），取消即 drop future、本机 socket 与隧道 WS
  **两个 socket 随之关闭**。
  **为什么要这么包**：桥接里的 `sink.send`（往隧道写）与 `local_write.write_all`
  （往本机写）都可能因为**对端不读**而永久阻塞，它们不在 select 的取消分支里——
  不这么做的话，停止转发之后那些本机连接会一直挂着（**僵尸连接**），端口也一直占着。
  **验证口径**：停止转发后，本机上那条连着的 socket 应当被关闭（对端随即读到
  EOF / 「连接被重置」），而不是继续挂着。
- **`stopped` 状态事件只发一次**：在 `stop()` 里发（监听循环退出时不再重复发），
  免得前端把同一次停止当成两次。

### 命令与事件

| 命令 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `start_forward` | `forwardId` / `backendBaseUrl` / `token` / `containerPort` / `localPort?` | **实际生效**的本机端口 | 开启本机监听；**幂等**（同一条转发重复开启返回现有端口） |
| `stop_forward` | `forwardId` | — | 关监听 + 关全部连接；没开启时**明确报错** |
| `forward_listeners` | — | 监听状态数组 | 当前所有「已开启本机监听」的转发（前端挂载时回填用） |

| 事件 | 载荷 | 含义 |
|---|---|---|
| `forward://state` | `{forward_id, state, container_port, local_port, message}` | **转发级**：`listening` / `stopped` / `error` |
| `forward://connection` | `{forward_id, state, container_port, local_port, message}` | **连接级**：`connected` / `closed` / `error` |

**关闭码文案**：已知关闭码给固定中文（`1000` 正常 / `1001` 服务退出可重连 /
`1008` 策略违规不可重试 / `1011` 字节泵异常可重试）；**未知关闭码带码值**
（如「隧道已断开（关闭码 1006）」），与 `1000` 的「隧道已正常关闭」拉开区分度。

事件名带 `://` 是合法的（Tauri 事件名允许字母、数字与 `-` / `/` / `:` / `_`）。

#### 事件订阅需要 capabilities 里的 `core:event` 权限

**Tauri v2 对 `plugin:event|listen` / `plugin:event|unlisten` 一律走 ACL 校验**——不是
「本工程没有 ACL 清单就放行」，而是**没有能力清单 = 一律拒绝**。所以事件订阅要在
`src-tauri/capabilities/default.json` 里显式放行：

```json
{
  "identifier": "default",
  "windows": ["main"],
  "permissions": ["core:event:allow-listen", "core:event:allow-unlisten"]
}
```

- `windows` **必须写**：能力清单里的窗口标签要跟 `main.rs` 里
  `WebviewWindowBuilder` 创建的窗口标签一致（本工程是 `main`）；
  不写（空列表）时命令一条都匹配不上，等于没放行。
- 少了这条能力 → 前端订阅被 ACL 拒 → **事件通道整体不通**（界面看着正常，
  实际状态一直不同步）。前端侧还有一道兜底：订阅失败会打一条 `console.warn`
  （`src/lib/desktop-forward.ts`），别让它静默。
- **验证口径**：构建后 `src-tauri/gen/schemas/capabilities.json` 不再是空对象
  （`{}`），且编译产物里能查到 `plugin:event|listen` / `plugin:event|unlisten`
  （它们是被解析进运行时允许清单的命令名）。

> **另一处硬约束**：Rust 侧的 `EventTarget` 是**带标签的枚举**
> （`#[serde(tag = "kind")]`），「任意目标」是 `{"kind":"Any"}`——
> 传裸字符串 `"Any"` 会被反序列化拒掉（前端 `desktop-forward.ts` 里已按对象形状传）。

### 本机端口规则（ADR 0014 第 4 节）

- **默认 = 容器端口**（用户可改，改动经 IPC 传进来）；
- **不可为空**（空值在表单层就拦掉）；
- **被占自动换空闲端口**（从 `18000` 起扫），**返回并显示实际生效的端口**；
- **允许 <1024**（低端口）：Windows 可绑、macOS 现代版可绑；**Linux 上非 root 绑不了**
  ——那种情况**明确报错**（`本机端口 N 小于 1024，当前系统不允许普通用户绑定低端口`），不静默失败。

### 隧道协议（与 API.md 15.4 一一对应）

- 地址：`ws(s)://<后端host>[:<port>]/api/forward/tunnel/<forward_id>`（由后端基址推导：
  `http`→`ws`、`https`→`wss`）；
  **基址带路径 / 参数 / # 时明确报错**（与前端 `validateBaseUrl` 一个口径）——
  隧道地址的路径是固定的，拼不出正确地址，不静默忽略；
- 握手头：`Authorization: Bearer <令牌>`（**令牌不落盘**：每次由前端经 IPC 传入，只活在内存里）；
- **首帧必为服务端的文本 `hello` 帧**：不是 hello（或直接是错误帧）→ 按错误帧的
  **固定中文文案**上报并关掉那条本机连接；
- 二进制帧 = 双向透传字节；文本帧 = 控制（错误帧的文案直接展示）；
- 关闭码分类：`1000` 正常收敛 / `1001` 服务退出（可重连）/ `1008` 策略违规
  （令牌无效、转发不存在或已停止——**不可重试**，提示去检查配置或转发状态）/
  `1011` 字节泵异常结束（可重试）；**未知关闭码带码值**（如 `1006`）。

### CSP

**不用改 CSP**：隧道 WS 走的是 `ws(s)://<后端host>:*`，**已经在动态 CSP 的放行范围内**
（见上文「CSP」一节的 `connect-src` 行）。本任务**未改** `csp.rs` 与 `tauri.conf.json` 的 CSP 口径。

## 已知边界

- **前端 `base` 已是相对路径**：`vite.config.ts` 的 `base: './'`（三期任务 03 落地），产物里的资源引用形如 `./assets/xxx.js`；网页形态（后端 `StaticFiles` 挂在 `/`）与桌面形态（Tauri 自定义协议）都能解析。改基址会动全量产物，必须重跑既有验收。
- **桌面形态启动时会重载一次主文档**：Rust 进程是新的，还不知道后端主机（这一版主文档的 CSP 里只有 `'self'`），前端启动同步后会重载主文档（重载后这一版 CSP 才带上后端主机）。这是**预期行为**，不是故障。
- **端口转发已接入**（任务 06 落地）：Rust 侧的「本机监听 + 隧道桥接」在 `src/forward.rs`，命令在 `src/commands.rs`。**隧道链路的真机验证（真实后端 + 真实沙箱）待 Windows 真机复验**（见上文「已知边界」与三期留档页）。
- **Linux 只保证源码层面可构建**，不承诺出包；Windows 安装包见上文「Windows 构建指引」。
