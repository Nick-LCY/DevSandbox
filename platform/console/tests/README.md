# 网页控制台端到端验收

二期收官验收：用**真实浏览器**驱动**真实的控制台服务**与**真实的沙箱**，
跑通网页全流程，并用实测数据证明一期行为无回归。

```
platform/console/tests/
├── playwright.config.ts        # 验收配置（串行、超时、产物留存）
├── global-setup.ts             # 前端构建 → 本地测试镜像 → 起控制台服务 → 清残留沙箱
├── global-teardown.ts          # 停服务 → 清残留沙箱 → 删测试镜像
├── tsconfig.json               # 验收脚本的类型检查配置
├── helpers/
│   ├── api.ts          # 控制台 REST 接口直调
│   ├── cli.ts          # 一期命令行 sandboxctl 调用
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
│   └── 06-boundary.spec.ts      # 镜像代理取证与安全边界
└── artifacts/                   # 运行产物：截图 / trace / 报告（不进版本库）
```

---

## 一、一条命令跑完

```bash
cd platform/console
pnpm install                    # 首次：装 @playwright/test
pnpm run test:acceptance        # 退出码 0 = 全部通过，非 0 = 有用例不通过
```

在仓库根目录也可以：

```bash
pnpm --dir platform/console run test:acceptance
```

**环境前提**

| 前提 | 说明 |
|---|---|
| Node ≥ 22 + pnpm | 前端工程同款工具链 |
| Playwright chromium | `~/.cache/ms-playwright` 里已有 1.64.1 对应的 chromium |
| 免密 sudo | 沙箱创建要建系统用户、写 `/etc/subuid`、起用户级 systemd |
| 宿主 Docker | 平台控制面与免 root 守护进程都依赖它 |
| 镜像代理在跑 | 沙箱创建的代理预检要求代理可达（默认容器 `sandbox-platform-registry-proxy`，端口 3128） |

**端口**：宿主 8000 端口被无关进程占用，验收服务默认走 **8100**，可用环境变量覆盖：

```bash
CONSOLE_TEST_PORT=8200 pnpm run test:acceptance
```

---

## 二、验收脚本自己做了什么

`global-setup.ts` 按固定顺序准备环境：

1. `pnpm run build` 构建前端产物（后端在 `/` 路径托管同一份产物）；
2. 现场用 `docker build` 构建一个**名字带一次性随机后缀**的测试镜像——这个名字在任何镜像仓库里都不可能存在；
3. 清掉上一轮残留的验收沙箱（名字前缀 `acc-`，不碰别人的沙箱）；
4. 用平台虚拟环境里的 Python 直接拉起控制台服务（不经 `uv run` 的中间进程，
   进程号就是服务本体，重启不留孤儿），监听 `127.0.0.1:<端口>`，等 `/api/health` 通过。

`global-teardown.ts` 收尾：停服务 → 清残留沙箱 → 删测试镜像 → 清运行期目录。

---

## 三、控制台 UI 改造后的新口径

控制台是**单页工作台**，验收脚本的定位方式跟着变了：

| 口径 | 含义 | 对验收脚本的影响 |
|---|---|---|
| **单页工作台** | 左侧边栏是沙箱列表，右侧工作区是选中沙箱的摘要与终端；新建沙箱 / 沙箱详情 / 代理设置 / 删除确认都是弹窗或抽屉 | 页面之间不再整页跳转，改成「开弹窗 / 开抽屉」的动作：`openCreateDialog` / `openDetailDialog` / `openDeleteDialog` / `openStopDialog` |
| **两层哈希路由** | 只有 `#/` 与 `#/sandboxes/<名>[/<会话标识>]` 两层，没有「列表页 / 详情页 / 终端页」之分 | 导航只有两个动作：`gotoWorkbench`（回工作台）与 `gotoDetail`（进沙箱工作区）；刷新与粘贴链接落到同一个位置 |
| **三个大面板是右侧抽屉** | 新建沙箱 / 沙箱详情 / 代理设置都是右侧滑出、宽度可拖拽的抽屉 | 关闭一律用「点 × / Esc」，**不写滑动关闭**（阈值是面板宽的 50%，很难触发）；抽屉宽度可拖拽且刷新后保持 |
| **删除一次确认** | 点「确认删除」就直接发 `DELETE`（删除前不再预取回收清单，弹窗里只有后果说明与「不受影响」提示） | 删除一律走 `confirmDelete`：点一次确认 + 等删除请求 |
| **停止一次确认** | 工作区头部的「停止」只开确认弹窗，确认后才发 `POST …/stop`；弹窗里有「同时停止依赖容器」勾选（默认勾选） | 停止一律走 `openStopDialog` + `confirmStop` |
| **创建不再自动选中** | 创建成功后抽屉关掉 + 弹成功 toast，不自动选中新建的沙箱 | 选中改走 `selectCreatedSandbox`（从侧栏选中新沙箱） |
| **标签 = 会话** | 终端标签条的数据源就是后端会话表，一个标签一个会话；点标签即附着到该会话（服务端回放现场缓冲） | 没有第二份「后端保留的会话」列表；重新附着用 `reattachTerminal`（点已有标签） |

**helper 与实现标识的对应关系**（helper 里的标识一律照 README 的标识表，不另造名字）：

| helper | 动作 | 落到的标识 |
|---|---|---|
| `gotoWorkbench` | 回工作台首页 | `#/` → `page-sandbox-list-title` |
| `openCreateDialog` | 开新建沙箱抽屉 | `page-sandbox-list-create-button`（**双挂载，取第一个**）→ `page-sandbox-create-dialog` |
| `gotoDetail` | 进某个沙箱的工作区 | `#/sandboxes/<名>` → `page-sandbox-detail-title` |
| `selectSandbox` | 在侧栏里选中沙箱 | `page-sandbox-list-item` → `page-sandbox-detail-title` |
| `selectCreatedSandbox` | 创建成功后选中新沙箱（创建不自动选中） | `page-sandbox-list-item` → `page-sandbox-detail-title` |
| `openDetailDialog` / `detailField` | 开详情抽屉 / 读详情字段 | `page-sandbox-detail-detail-button` → `page-sandbox-detail-dialog` |
| `closeDetailDialog` | 关详情抽屉（Esc） | `page-sandbox-detail-dialog` → 隐藏 |
| `openDeleteDialog` / `confirmDelete` | 开删除弹窗 / 一次点确认即删 | `page-sandbox-detail-delete-button` → `page-sandbox-detail-delete-dialog` → `page-sandbox-detail-delete-confirm-button` |
| `openStopDialog` / `confirmStop` | 开停止确认弹窗 / 确认停止 | `page-sandbox-detail-stop-button` → `page-sandbox-detail-stop-dialog` → `page-sandbox-detail-stop-confirm-button` |
| `openTerminal` | 新建一个终端会话 | `page-sandbox-detail-terminal-new-button` → `page-sandbox-detail-terminal-tab` |
| `reattachTerminal` | 附着到已有会话（点已有标签） | `page-sandbox-detail-terminal-tab[data-session-id=…]` → `page-sandbox-detail-terminal-tab-select` |

**同页双挂载的标识**：`page-sandbox-list-create-button` 在侧栏顶部与右侧空态引导块各挂一个（同页同时存在），取第一个即可：

```ts
await page.getByTestId('page-sandbox-list-create-button').first().click();
```

---

## 四、用例覆盖

| 用例文件 | 覆盖的验收标准 |
|---|---|
| `01-lifecycle` | 抽屉里下拉选镜像 → 创建（带挂载声明）→ 侧栏选中后核对详情 → 终端执行命令断言回显 → 停止（确认弹窗）→ 再启动 → 删除（确认弹窗先取消、再一次点确认）→ 回空态；镜像列表刷新；详情刷新后字段一致；抽屉宽度可拖拽且刷新后保持；停止确认框取消时后端没收到停止请求 |
| `02-local-image` | 本地构建镜像出现在网页下拉里；选中后创建成功；沙箱守护进程里确实拿到了它（注入路径走通）；宿主没有的镜像按契约报错，不降级直连 |
| `03-terminal` | 同一沙箱两个终端并行可用且互不串扰；终端聚焦时 Ctrl+C 真的到达容器内的 shell（提示符回归 + 退出码 130）；断开浏览器后重连（点已有标签重新附着），终端现场（已输出内容与仍在运行的进程）不丢；重启服务后旧会话失效且页面明确提示 |
| `04-equivalence` | 同一沙箱：网页与命令行的列表字段、挂载清单、容器状态、回收清单逐项一致；参数相同的两个沙箱（网页建 / 命令行建）挂载与状态流转等价（网页停走确认弹窗） |
| `05-reclaim` | 经工作台删除（侧栏选中 → 头部删除 → 确认弹窗点一次即删），回收清单通过接口直取逐项核对（沙箱容器、依赖容器、守护进程、systemd 单元、用户与家目录、子 UID/GID 段、平台元数据）；用户声明挂载的外部目录原样存在、内容未变；重复删除幂等 |
| `06-boundary` | 沙箱内依赖镜像拉取统一经镜像代理（代理访问日志 + 守护进程单元环境变量取证）；服务只监听回环、不做认证、不暴露接口文档 |

---

## 五、断言口径

- **终端内容**：xterm.js 用 DOM 渲染器，屏幕文本在 `.xterm-rows` 里，用 `textContent()` 读
  （`innerText()` 对隐藏元素返回空串，切换终端标签时会踩坑）。
- **状态标签**：「已连接」这类文案在面板的状态标签上，不在终端屏幕里，别混。
- **回收清单**：网页接口与命令行打印的清单是同一份数据，逐项 `toEqual` 比对（同一个沙箱应当一字不差）。删除确认弹窗里**不再列清单**（页面不再预取），清单一律用接口直取核对。
- **外部挂载目录**：删除前后各取一次目录内容指纹（文件清单 + 每个文件的 sha256）比对，指纹一致才算「内容未变」。
- **宿主状态**：系统用户、家目录、`/etc/subuid`、`/etc/subgid`、平台元数据、守护进程进程都直接查宿主，不看平台的自我报告。

---

## 六、产物

失败现场与全部用例的截图、trace 都留在 `tests/artifacts/`：

| 路径 | 内容 |
|---|---|
| `artifacts/test-results/` | 每条用例的截图与 `trace.zip`（失败用例可直接 `npx playwright show-trace` 回放） |
| `artifacts/results.json` | 机器可读的判定结果 |
| `artifacts/html-report/` | HTML 报告 |

`tests/.runtime/` 是运行期状态（服务进程信息、镜像引用、服务日志），验收结束即清空，不进版本库。
