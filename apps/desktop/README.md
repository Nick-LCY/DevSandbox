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
    ├── Cargo.toml            # tauri = "2" + tauri-build
    ├── build.rs
    ├── tauri.conf.json       # productName / identifier / frontendDist / bundle.targets
    ├── src/main.rs           # 最小骨架：tauri::Builder
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

> 连接配置与后端连通**本轮不可验**：连接配置 / 令牌入口属**任务 03**（前端连接层），当前前端产物走的是相对路径下的接口请求，没有连接配置界面；「填后端地址与令牌 → 沙箱列表能拉到 → 能开终端」这一段要等任务 03 落地后才能验。

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

## 已知边界

- **前端 `base` 仍是绝对路径**：`apps/web/frontend/dist/index.html` 里资源引用形如 `/assets/xxx.js`。这在 Tauri 自定义协议（Windows 上是 `http://tauri.localhost` 根路径）下能解析，但改成相对路径（`base: './'`）是三期前端连接层任务的既定改动，届时必须重跑既有验收。
- **端口转发尚未接入**：Rust 侧的「本机监听 + 隧道桥接」在后续任务（[[tasks/phase3-desktop/06-port-forward-desktop.md|任务 06]]）里补；本轮只有最小骨架。
- **Linux 只保证源码层面可构建**，不承诺出包；Windows 安装包见上文「Windows 构建指引」。
