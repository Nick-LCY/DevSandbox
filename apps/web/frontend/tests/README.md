# 网页控制台端到端验收

二期收官验收：用**真实浏览器**驱动**真实的控制台服务**与**真实的沙箱**，
跑通网页全流程，并用实测数据证明一期行为无回归。

三期起后端对全部 `/api` 生效**令牌认证**（契约见 `apps/web/backend/API.md` 第 14 章），
验收套件同步 token 化：服务进程注入固定测试令牌、页面侧预置连接配置、
脚本直调统一带认证头（口径见下文「三、令牌与连接配置」）。

```
apps/web/frontend/tests/
├── playwright.config.ts        # 验收配置（串行、超时、产物留存、storageState 预置）
├── global-setup.ts             # 前端构建 → 本地测试镜像 → 起控制台服务 → 清残留沙箱
├── global-teardown.ts          # 停服务 → 清残留沙箱 → 删测试镜像
├── tsconfig.json               # 验收脚本的类型检查配置
├── helpers/
│   ├── api.ts          # 控制台 REST 接口直调（统一带认证头）
│   ├── auth.ts         # 验收用访问令牌（单一来源）与认证头
│   ├── cli.ts          # 一期命令行 sandboxctl 调用
│   ├── connection.ts   # 页面侧连接配置的预置 / 注入 / 清空
│   ├── console.ts      # 页面操作（新建、详情、列表）
│   ├── host.ts         # 宿主侧断言（用户、家目录、子 ID 段、容器、元数据）
│   ├── image.ts        # 现场构建「不存在于任何仓库」的测试镜像
│   ├── paths.ts        # 路径常量
│   ├── sandbox.ts      # 验收沙箱的命名与清理
│   ├── server.ts       # 控制台服务的启动 / 停止 / 重启
│   ├── terminal.ts     # 网页终端的操作与断言
│   └── workspace.ts    # 外部挂载目录与内容指纹
├── specs/                       # 用例
│   ├── 01-lifecycle.spec.ts     # 全流程
│   ├── 02-local-image.spec.ts   # 本地构建镜像
│   ├── 03-terminal.spec.ts      # 网页终端
│   ├── 04-equivalence.spec.ts   # 网页与命令行等价
│   ├── 05-reclaim.spec.ts       # 删除回收复验
│   ├── 06-boundary.spec.ts      # 镜像代理取证与安全边界
│   ├── 07-templates.spec.ts     # 启动模板（保存 / 回填 / 重命名 / 删除）
│   ├── 08-file-injection.spec.ts # 文件注入（副本只读 / 原件零变化 / 删除即消失 / 模板贯通）
│   ├── 09-terminal-clipboard.spec.ts # 终端剪贴板（Ctrl+Shift+C/V、语义锁、失败提示）
│   ├── 10-auth-connection.spec.ts # 认证与连接配置（401 负向 / 票据 / 引导面板 / 工作台挂载）
│   ├── 11-forward-web-notice.spec.ts # web 形态的端口转发区（说明卡 + 安装入口 + 零管理元素）
│   └── 12-file-transfer.spec.ts # 运行期文件传输（上传 / 下载 / 目录列表 / 覆盖 / 负例）
└── artifacts/                   # 运行产物：截图 / trace / 报告（不进版本库）
```

---

## 一、一条命令跑完

```bash
cd apps/web/frontend
pnpm install                    # 首次：装 @playwright/test
pnpm run test:acceptance        # 退出码 0 = 全部通过，非 0 = 有用例不通过
```

在仓库根目录也可以：

```bash
pnpm --dir apps/web/frontend run test:acceptance
```

**环境前提**

| 前提 | 说明 |
|---|---|
| Node ≥ 22 + pnpm | 前端工程同款工具链 |
| Python 工作区已同步 | 脚本自己会先跑 `cd apps && uv sync --all-packages --all-groups`，把核心包与服务端包的依赖一次性装齐 |
| Playwright chromium | `~/.cache/ms-playwright` 里已有 1.64.1 对应的 chromium |
| 免密 sudo | 沙箱创建要建系统用户、写 `/etc/subuid`、起用户级 systemd |
| 宿主 Docker | 平台控制面与免 root 守护进程都依赖它 |
| 镜像代理在跑 | 沙箱创建的代理预检要求代理可达（默认容器 `sandbox-platform-registry-proxy`，端口 3128） |

**端口**：宿主 8000 端口被无关进程占用，验收服务默认走 **8100**，可用环境变量覆盖：

```bash
CONSOLE_TEST_PORT=8200 pnpm run test:acceptance
```

页面侧预置的连接配置基址跟着**服务的实际端口**走（`global-setup` 起服务后写
`storage-state`），换端口不用改用例。

---

## 二、验收脚本自己做了什么

`global-setup.ts` 按固定顺序准备环境：

1. `cd apps && uv sync --all-packages --all-groups` 同步 Python 工作区环境（核心包与服务端包共用
   `apps/.venv`，按成员同步是精确对齐的，只同步一边会把另一边的依赖剪掉）；
2. `pnpm run build` 构建前端产物（后端在 `/` 路径托管同一份产物）；
3. 现场用 `docker build` 构建一个**名字带一次性随机后缀**的测试镜像——这个名字在任何镜像仓库里都不可能存在；
4. 清掉上一轮残留的验收沙箱（名字前缀 `acc-`，不碰别人的沙箱）；
5. 用平台虚拟环境里的 Python 直接拉起控制台服务（不经 `uv run` 的中间进程，
   进程号就是服务本体，重启不留孤儿），监听 `127.0.0.1:<端口>`，等 `/api/health` 通过
   （**健康自检带认证头**：三期起 `/api/health` 不豁免，没令牌恒 401）；
6. 服务起来后按**实际端口**写一份 `.runtime/storage-state.json`：预置页面侧的
   连接配置（基址 + 令牌），用例打开页面就直接在工作台里；写之前做**交叉断言**
   ——这个端口必须与 `playwright.config.ts` 的 `CONSOLE_TEST_PORT` 一致，不一致
   直接抛错（storageState 按 origin 注入，端口对不上时浏览器不注入那份预置，
   页面会静默落回「未配置」态）。

> 取解释器的 `uv run` 一律带 `--no-sync`：验收里核心包与服务端包的解释器都要用，
> 不让每次取解释器都顺手同步一次环境。

`global-teardown.ts` 收尾：停服务 → 清残留沙箱 → 删测试镜像 → 清运行期目录。

---

## 三、令牌与连接配置（三期 token 化口径）

三期起后端对**全部 `/api`**（含终端 WebSocket）生效令牌认证，验收链路上的令牌
**只有一处定义**（`helpers/auth.ts`），三处用法共用同一份：

| 位置 | 做法 | 口径 |
|---|---|---|
| **后端进程** | `helpers/server.ts` 起服务时用环境变量 `SANDBOX_CONSOLE_TOKEN` 注入 `TEST_TOKEN` | 注入优先 = **不落盘**（磁盘上不留令牌文件） |
| **脚本直调** | `helpers/api.ts` 的 `request()` 统一带 `Authorization: Bearer <令牌>`；用例里的 `page.request.*` 显式带 `authHeaders()` | 三期起 `/api/health` 也不豁免 |
| **页面侧** | `helpers/connection.ts` 把同一份令牌写进 localStorage 的连接配置（存储键 `sandbox-console-connection`） | 令牌为空 = **未配置**：不挂载工作台，改渲染引导面板 |

| 口径 | 说明 |
|---|---|
| 令牌是**固定常量** | 不是每次运行随机生成：页面预置、服务进程注入、直调请求头三处要在同一次运行里对上。它只在本机验收环境里用，不是任何环境的真实凭据 |
| 基址**恒非空** | 预置值是 `http://127.0.0.1:<测试服务实际端口>`（不是产品默认的 `http://127.0.0.1:8000`——宿主 8000 被无关进程占用）。决策 D：「空 = 同源」语义已废除 |
| 页面侧预置方式 | `playwright.config.ts` 的 `use.storageState` 读 `global-setup` 写的 `.runtime/storage-state.json`——**既有 9 条用例直接进工作台**，不在每条用例里多写一步「先配置再操作」 |
| 运行期注入方式 | `seedConnection` / `clearConnection` 走 `addInitScript`（页面脚本运行前写 / 删 localStorage）：负向用例用它构造「未配置」与「指定令牌」两种态 |
| 终端 WebSocket | 浏览器 WebSocket 不能带自定义头，握手靠**一次性票据**（`?ticket=`，30 秒有效、用过即废）；前端自动换票据，用例不用管；无票据的握手被拒（`10-auth-connection` 验这条） |

---

## 四、控制台 UI 改造后的新口径

控制台是**单页工作台**，验收脚本的定位方式跟着变了：

| 口径 | 含义 | 对验收脚本的影响 |
|---|---|---|
| **单页工作台** | 左侧边栏是沙箱列表，右侧工作区是选中沙箱的摘要与终端；新建沙箱 / 沙箱详情 / 代理设置 / 删除确认都是弹窗或抽屉 | 页面之间不再整页跳转，改成「开弹窗 / 开抽屉」的动作：`openCreateDialog` / `openDetailDialog` / `openDeleteDialog` / `openStopDialog` |
| **两层哈希路由** | 只有 `#/` 与 `#/sandboxes/<名>[/<会话标识>]` 两层，没有「列表页 / 详情页 / 终端页」之分 | 导航只有两个动作：`gotoWorkbench`（回工作台）与 `gotoDetail`（进沙箱工作区）；刷新与粘贴链接落到同一个位置 |
| **三个大面板是右侧抽屉** | 新建沙箱 / 沙箱详情 / 代理设置都是右侧滑出、宽度可拖拽的抽屉 | 关闭一律用「点 × / Esc」，**不写滑动关闭**（阈值是面板宽的 50%，很难触发）；抽屉宽度可拖拽且刷新后保持 |
| **删除一次确认** | 点「确认删除」就直接发 `DELETE`（删除前不再预取回收清单，弹窗里只有后果说明与「不受影响」提示） | 删除一律走 `confirmDelete`：点一次确认 + 等删除请求 |
| **镜像选择器不自动选中** | 抽屉打开后镜像输入框是空的，用户自己搜、自己选；没选中就提交会就地报「请选择沙箱镜像」 | 选镜像一律走 `selectImage`（展开 → 搜 → 点中命中的那条）；不能靠「默认已选中」写用例 |
| **停止一次确认** | 工作区头部的「停止」只开确认弹窗，确认后才发 `POST …/stop`；弹窗里有「同时停止依赖容器」勾选（默认勾选） | 停止一律走 `openStopDialog` + `confirmStop` |
| **创建不再自动选中** | 创建成功后抽屉关掉 + 弹成功 toast，不自动选中新建的沙箱 | 选中改走 `selectCreatedSandbox`（从侧栏选中新沙箱） |
| **标签 = 会话** | 终端标签条的数据源就是后端会话表，一个标签一个会话；点标签即附着到该会话（服务端回放现场缓冲） | 没有第二份「后端保留的会话」列表；重新附着用 `reattachTerminal`（点已有标签） |
| **侧边栏入口是「设置」** | 侧边栏底部入口从「代理设置」改成「设置」（图标换成 lucide `Settings`），抽屉里多了一区启动模板管理 | 入口标识从 `page-layout-proxy-button` 改成 `page-layout-settings-button`；开抽屉走 `openSettingsDrawer` |
| **模板选中即回填** | 新建沙箱抽屉**最上方**是「加载模板」下拉（选中即按「出现即替换、缺失即保持」回填表单）；「保存为模板」按钮在**页脚**（「创建沙箱」主按钮左侧，次级样式），点它开命名弹窗（空名禁提交） | 回填走 `applyTemplate`，保存走 `saveTemplateFromCreateDialog`；**模板声明原样透传**，不做任何占位符替换（回填与提交都是模板里的原文） |
| **模板管理在设置抽屉** | 模板的列表、行内重命名（回车提交 / Esc 取消）与删除（确认弹窗）都在设置抽屉的第二区 | 重命名走 `renameTemplate`，删除走 `deleteTemplate`；删模板不影响已创建的沙箱 |
| **侧栏可折叠** | 侧栏底部有折叠开关；折叠后宽 56px 只留图标，**只切样式不卸 DOM** | 页面恒有两个 `page-sandbox-list-create-button`（取第一个）；折叠态的底部工具贴底（用 `boundingBox` 比对 y 坐标，折叠按钮要落在视口下半部分）|
| **终端可全屏** | 终端面板右上角有全屏开关；纯 CSS 覆盖整页（`z-40`），退出全屏 = 再点同一个按钮 | 全屏态下关会话确认弹窗仍要浮在面板之上（比 z 索引）；不绑 Esc / F11 |

**helper 与实现标识的对应关系**（helper 里的标识一律照 README 的标识表，不另造名字）：

| helper | 动作 | 落到的标识 |
|---|---|---|
| `gotoWorkbench` | 回工作台首页 | `#/` → `page-sandbox-list-title` |
| `openCreateDialog` | 开新建沙箱抽屉 | `page-sandbox-list-create-button`（**双挂载，取第一个**）→ `page-sandbox-create-dialog` |
| `waitDrawerSettled` | 等抽屉滑入动画结束（面板位置稳定下来） | 拖拽把手前必须先等：动画中间帧量到的坐标是错的 |
| `gotoDetail` | 进某个沙箱的工作区 | `#/sandboxes/<名>` → `page-sandbox-detail-title` |
| `selectSandbox` | 在侧栏里选中沙箱 | `page-sandbox-list-item` → `page-sandbox-detail-title` |
| `selectCreatedSandbox` | 创建成功后选中新沙箱（创建不自动选中） | `page-sandbox-list-item` → `page-sandbox-detail-title` |
| `waitImageListLoaded` | 等宿主镜像列表到位（列表是异步拉回来的，没到时搜索命不中） | `page-sandbox-create-image-refresh-button`（加载中是「正在刷新」，到位后回到「刷新镜像」）|
| `openImagePicker` | 展开镜像选择器（点输入框；下拉箭头是纯指示器、不可点） | `page-sandbox-create-image-select` → `page-sandbox-create-image-popup` |
| `searchImage` | 在镜像选择器里搜关键字（前端本地筛选；先清空再填，清空即放弃当前选中） | `page-sandbox-create-image-select` |
| `selectImage` | 选一张宿主本地镜像（展开 → 搜 → 点中命中的那条） | `[data-image-reference="<引用>"]` → `page-sandbox-create-image-select`（回填引用）|
| `openDetailDialog` / `detailField` | 开详情抽屉 / 读详情字段 | `page-sandbox-detail-detail-button` → `page-sandbox-detail-dialog` |
| `closeDetailDialog` | 关详情抽屉（Esc） | `page-sandbox-detail-dialog` → 隐藏 |
| `openDeleteDialog` / `confirmDelete` | 开删除弹窗 / 一次点确认即删 | `page-sandbox-detail-delete-button` → `page-sandbox-detail-delete-dialog` → `page-sandbox-detail-delete-confirm-button` |
| `openStopDialog` / `confirmStop` | 开停止确认弹窗 / 确认停止 | `page-sandbox-detail-stop-button` → `page-sandbox-detail-stop-dialog` → `page-sandbox-detail-stop-confirm-button` |
| `openTerminal` | 新建一个终端会话 | `page-sandbox-detail-terminal-new-button` → `page-sandbox-detail-terminal-tab` |
| `reattachTerminal` | 附着到已有会话（点已有标签） | `page-sandbox-detail-terminal-tab[data-session-id=…]` → `page-sandbox-detail-terminal-tab-select` |
| `openSettingsDrawer` | 开设置抽屉（代理设置 + 启动模板） | `page-layout-settings-button` → `page-settings-dialog` |
| `applyTemplate` | 在新建抽屉里选中模板（选中即回填表单） | `page-sandbox-create-template-select` → `page-sandbox-create-template-popup` → `[data-template-name="…"]` |
| `saveTemplateFromCreateDialog` | 把当前表单存成模板（命名弹窗） | `page-sandbox-create-template-save-button` → `page-sandbox-create-template-dialog` → `page-sandbox-create-template-name-input` → `page-sandbox-create-template-confirm-button` |
| `renameTemplate` | 在设置抽屉里行内重命名模板（回车提交） | `page-settings-template-item` → `page-settings-template-rename-button` → `page-settings-template-rename-input`（Enter） |
| `deleteTemplate` | 在设置抽屉里删除模板（走确认弹窗） | `page-settings-template-delete-button` → `page-settings-template-delete-dialog` → `page-settings-template-delete-confirm-button` |

**同页双挂载的标识**：`page-sandbox-list-create-button` 在侧栏顶部与右侧空态引导块各挂一个（同页同时存在），取第一个即可：

```ts
await page.getByTestId('page-sandbox-list-create-button').first().click();
```

---

## 五、用例覆盖

| 用例文件 | 覆盖的验收标准 |
|---|---|
| `01-lifecycle` | 抽屉里用镜像选择器搜镜像并选中 → 创建（带挂载声明）→ 侧栏选中后核对详情 → 终端执行命令断言回显 → 停止（确认弹窗）→ 再启动 → 删除（确认弹窗先取消、再一次点确认）→ 回空态；镜像列表刷新（刷新前后候选条数不变）；详情刷新后字段一致；抽屉宽度可拖拽且刷新后保持；停止确认框取消时后端没收到停止请求；**设置抽屉里「刷新状态」「重启代理」两个按钮在代理设置区里（点得到、重启后结果面板出来）**；**折叠侧栏：底部工具贴底（折叠按钮的 y 坐标在视口下半部分）、`page-sandbox-list-create-button` 仍有两个且侧栏那份可见可点，展开恢复原状** |
| `02-local-image` | 本地构建镜像能搜到（网页镜像选择器里只剩这一条命中）；选中后创建成功；沙箱守护进程里确实拿到了它（注入路径走通）；宿主没有的镜像搜索 0 命中（弹层给空态）且按契约报错，不降级直连 |
| `03-terminal` | 同一沙箱两个终端并行可用且互不串扰；终端聚焦时 Ctrl+C 真的到达容器内的 shell（提示符回归 + 退出码 130）；断开浏览器后重连（点已有标签重新附着），终端现场（已输出内容与仍在运行的进程）不丢；重启服务后旧会话失效且页面明确提示；**终端全屏：面板覆盖整屏、关会话确认弹窗浮在全屏之上（z 比面板高）、再点按钮退出复原**；**切换标签后不点终端表面，命令仍然敲得进 pty（重挂载后的焦点回填）**；**跨过一次 10 秒轮询窗口：当前会话不变、焦点不丢**（标签条至少一个标签，按真实标签数断言，不对 `.last()` 断言数量） |
| `04-equivalence` | 同一沙箱：网页与命令行的列表字段、挂载清单、容器状态、回收清单逐项一致；参数相同的两个沙箱（网页建 / 命令行建）挂载与状态流转等价（网页停走确认弹窗） |
| `05-reclaim` | 经工作台删除（侧栏选中 → 头部删除 → 确认弹窗点一次即删），回收清单通过接口直取逐项核对（沙箱容器、依赖容器、守护进程、systemd 单元、用户与家目录、子 UID/GID 段、平台元数据）；用户声明挂载的外部目录原样存在、内容未变；重复删除幂等 |
| `06-boundary` | 沙箱内依赖镜像拉取统一经镜像代理（代理访问日志 + 守护进程单元环境变量取证）；服务只监听回环、**接口要令牌**（不带凭据 401 / 带令牌 200）、不暴露接口文档 |
| `07-templates` | 保存模板（新建抽屉页脚按钮 → 命名弹窗）→ 重新打开抽屉选中模板即回填（镜像与挂载一并回填、声明原样回填）→ 设置抽屉里行内重命名（标识不变）→ 删除（走确认弹窗，文案写明不影响已建沙箱）→ 刷新不复活；模板合并语义（出现的字段整体替换、没出现的保持现状）；删除确认弹窗的文案与取消不删；**模板下拉的箭头在输入框内（不可点、展开时转向）、候选项是指针光标、空列表不留空白带** |
| `08-file-injection` | 注入 0600 宿主文件 → 容器内读到副本 → 只读写入失败 → 宿主原件零变化（权限 / 内容 / 修改时间）；删除沙箱后注入副本随家目录消失、宿主原件仍在；模板里带文件声明 → 保存 → 回填 → 真机全流程（用模板建沙箱，容器内读到副本） |
| `09-terminal-clipboard` | `Ctrl+Shift+C` 把终端选区复制到系统剪贴板（读回来逐字比对）；`Ctrl+Shift+V` 把系统剪贴板的内容粘贴进终端（容器内的 shell 真收到了，判据是输出行整行就是标记串）；语义锁：`Ctrl+V` 仍然是字面量 0x16（不碰系统剪贴板），`Ctrl+C` 仍然是中断；没有选区时按 `Ctrl+Shift+C` 静默无反馈；剪贴板 API 不可用时弹失败提示 |
| `10-auth-connection` | **无令牌访问后端 → 401**（缺失与错误同一句文案「访问令牌无效或缺失」、不回显令牌、带 `WWW-Authenticate: Bearer`；`/api/health` 与业务接口都不豁免）；**错误令牌 → 401**；**正确令牌 → 200**；**终端 WebSocket 无票据 → 握手被拒**（连不上，关闭码**精确判 1006**；配一条**正向对照**：换票后带票连同一地址 → 握手成功，证明「连不上」确实是票据闸拒的）；**未配置连接 → 引导面板出现、工作台不挂载**（`page-connection-*` 在、`page-sandbox-list-title` 不在、地址栏里没有沙箱路由）；**配置正确 → 工作台挂载**（预置配置与引导面板里「保存并连接」两条路都验，页面请求确实带 `Authorization` 头）；**令牌无效时侧栏健康自检显示「令牌无效」**（与「后端不可达」分开） |
| `11-forward-web-notice` | **web 形态的端口转发区只有一张说明卡 + 一个「安装桌面端」按钮**（网页形态无法管理端口转发，请使用桌面端）；点「安装桌面端」弹三步指引（拿安装包 / 填后端地址与令牌 / 开启转发后访问），弹窗能关；**零管理元素**（表格 / 行 / 新建表单 / 「转发」按钮一个都不渲染）；**web 形态连转发记录都不读**（跨过一个 10 秒合并轮询周期，期间零转发请求） |
| `12-file-transfer` | **上传 → 容器内校验 → 下载回环 → 同名覆盖（取消 / 确认）→ 目录导航**：面板从沙箱容器内 workdir 起手（面包屑各级可点、点目录行即进入目录）；上传只能进当前浏览目录（行内进度出现并走完、列表出现该条目、名称与大小列正确）；**容器内校验**（字节数 / sha256 / 属主，宿主侧 `docker exec` 取证）；**接口直传 raw 上传**（钉裸字节流通道本身）；**下载回环**（点文件行即下载、字节逐一致、中文名 `Content-Disposition` 正确、`Content-Length` = 探测到的字节数）；**同名覆盖**（取消 → 容器内内容不变、确认 → 内容换成新版本）；**隐藏文件（`.` 开头）照常显示**、**文件夹排在列表最前**；负例：**下载目录 → 400**、**上传到目录 → 400**（UI 就地展示后端 detail）、**非法路径 → 400**、**沙箱已停止 → 409**、**无令牌 → 401** |

---

## 六、断言口径

- **终端内容**：xterm.js 用 DOM 渲染器，屏幕文本在 `.xterm-rows` 里，用 `textContent()` 读
  （`innerText()` 对隐藏元素返回空串，切换终端标签时会踩坑）。
- **状态标签**：「已连接」这类文案在面板的状态标签上，不在终端屏幕里，别混。
- **终端输出行**：判据是「**整行就是**标记串」（`expectTerminalRow`），不是「屏幕包含标记串」——命令回显行里也含标记串，拿它当证据会把「命令敲进去了」误判成「命令执行了」。
- **剪贴板**：内容在页面上下文里读写（`navigator.clipboard.readText()` / `writeText()`），读写权限在每个用例前用 `context.grantPermissions` 显式授予；粘贴是异步的（读剪贴板走 promise），断言前要等它落到终端上再回车。
- **回收清单**：网页接口与命令行打印的清单是同一份数据，逐项 `toEqual` 比对（同一个沙箱应当一字不差）。删除确认弹窗里**不再列清单**（页面不再预取），清单一律用接口直取核对。
- **外部挂载目录**：删除前后各取一次目录内容指纹（文件清单 + 每个文件的 sha256）比对，指纹一致才算「内容未变」。
- **宿主状态**：系统用户、家目录、`/etc/subuid`、`/etc/subgid`、平台元数据、守护进程进程都直接查宿主，不看平台的自我报告。
- **认证**：401 的判据是**状态码 + `detail` 原文**（「访问令牌无效或缺失」，缺失与错误不区分）；不带令牌与错令牌的响应必须**逐字相同**。无票据的 WebSocket 握手判据是「**没连上 + 关闭码 1006**」（生产环境表现是握手被拒后的 403，浏览器侧只能看到连接失败、异常断开 1006；关闭码 1008 是服务端语义、不送达客户端）。1006 是**精确值**：不能只判「不是 1000」（超时的兜底值 -1 也会蒙混过去）；同时用一条**正向对照**（换票 → 带票连同一地址 → 握手成功）兜住「地址写错 / 路由没挂 / 服务没起」这类会让负向用例恒绿的环境问题。
- **容器内取证**：要证明「容器里到底有什么」（字节数、sha256、属主）时，走**宿主侧的 `docker exec`**（沙箱守护进程里执行，路径见 `helpers/host.ts` 的 `sandboxExec`）——**不经过被测接口**。否则只是让平台自证（接口说「写成功了」不算数，容器里的字节才是）。被测接口的下载 / 列表作为**用户视角**的旁证并列保留，两者都要有。
- **行内进度**：上传一完成进度行就被摘掉，本机链路上几十毫秒就传完——**不用轮询等进度行出现**（会随机器负载偶发命不中）。改用 `page.addInitScript` 装 MutationObserver，把「上传行 / 下载进度条出现 + 每次的 `data-state` / `aria-valuenow` / 百分比文本」记进 `window.__acc`，动作结束后对**记录**做断言。观测器按元素留档（元素被摘掉后仍读得到它最后的属性），所以「出现 → 走完 → 被摘掉」整条链不会漏。
- **负向断言的正向对照**：凡是「不该发生 X」的断言，都要先有一条**确实发生了 X** 的正向对照兜底（例：断言「点目录行不发下载请求」之前，先点一次文件行、确认监听器听到了下载请求）。否则监听器没挂上 / 路由写错这类环境问题会让负向断言恒真。

---

## 七、产物

失败现场与全部用例的截图、trace 都留在 `tests/artifacts/`：

| 路径 | 内容 |
|---|---|
| `artifacts/test-results/` | 每条用例的截图与 `trace.zip`（失败用例可直接 `npx playwright show-trace` 回放） |
| `artifacts/results.json` | 机器可读的判定结果 |
| `artifacts/html-report/` | HTML 报告 |

`tests/.runtime/` 是运行期状态（服务进程信息、镜像引用、服务日志），验收结束即清空，不进版本库。

---

## 八、提交历史里的一个坑（按提交二分排查时先看这段）

- **提交 `ba8c6d7`（模板前端与设置抽屉改名）不是一棵独立可绿的树**：它把组件文件
  `ProxySettingsDialog.tsx` 用 `git mv` 改名为 `SettingsDialog.tsx`（保留文件历史），
  但**同名测试文件的内容重写落在了紧随其后的提交 `6a86a7c`**（测试文件按新增处理，
  没有保留历史）。
- 因此在 `ba8c6d7` 这一棵树上跑 `pnpm run typecheck:tests` 与 `pnpm run test`
  都是**红的**：旧测试文件仍然 import 已改名的组件模块，模块找不到。
- **按提交二分排查时不要把 `ba8c6d7` 当成回归点**：`ba8c6d7` + `6a86a7c` 两棵合起来
  才是绿树。历史不改写（不 rebase），此处留一行说明。
