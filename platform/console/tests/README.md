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

## 三、用例覆盖

| 用例文件 | 覆盖的验收标准 |
|---|---|
| `01-lifecycle` | 下拉选镜像 → 创建（带挂载声明）→ 终端执行命令断言回显 → 停止 → 再启动 → 删除（走回收清单确认弹窗，先取消再确认）；镜像列表刷新；详情刷新后字段一致 |
| `02-local-image` | 本地构建镜像出现在网页下拉里；选中后创建成功；沙箱守护进程里确实拿到了它（注入路径走通）；宿主没有的镜像按契约报错，不降级直连 |
| `03-terminal` | 同一沙箱两个终端并行可用且互不串扰；断开浏览器后重连，终端现场（已输出内容与仍在运行的进程）不丢；重启服务后旧会话失效且页面明确提示 |
| `04-equivalence` | 同一沙箱：网页与命令行的列表字段、挂载清单、容器状态、回收清单逐项一致；参数相同的两个沙箱（网页建 / 命令行建）挂载与状态流转等价 |
| `05-reclaim` | 按一期回收清单逐项核对（沙箱容器、依赖容器、守护进程、systemd 单元、用户与家目录、子 UID/GID 段、平台元数据）；用户声明挂载的外部目录原样存在、内容未变；重复删除幂等 |
| `06-boundary` | 沙箱内依赖镜像拉取统一经镜像代理（代理访问日志 + 守护进程单元环境变量取证）；服务只监听回环、不做认证、不暴露接口文档 |

---

## 四、断言口径

- **终端内容**：xterm.js 用 DOM 渲染器，屏幕文本在 `.xterm-rows` 里，用 `textContent()` 读
  （`innerText()` 对隐藏元素返回空串，切换终端标签时会踩坑）。
- **状态标签**：「已连接」这类文案在面板的状态标签上，不在终端屏幕里，别混。
- **回收清单**：网页接口与命令行打印的清单是同一份数据，逐项 `toEqual` 比对（同一个沙箱应当一字不差）。
- **外部挂载目录**：删除前后各取一次目录内容指纹（文件清单 + 每个文件的 sha256）比对，指纹一致才算「内容未变」。
- **宿主状态**：系统用户、家目录、`/etc/subuid`、`/etc/subgid`、平台元数据、守护进程进程都直接查宿主，不看平台的自我报告。

---

## 五、产物

失败现场与全部用例的截图、trace 都留在 `tests/artifacts/`：

| 路径 | 内容 |
|---|---|
| `artifacts/test-results/` | 每条用例的截图与 `trace.zip`（失败用例可直接 `npx playwright show-trace` 回放） |
| `artifacts/results.json` | 机器可读的判定结果 |
| `artifacts/html-report/` | HTML 报告 |

`tests/.runtime/` 是运行期状态（服务进程信息、镜像引用、服务日志），验收结束即清空，不进版本库。
