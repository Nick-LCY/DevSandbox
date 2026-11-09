# 三期留档（打样与实测结论）

> **PRD 验收清单核销（2026-11-04）**：[[prds/phase3-desktop.md|三期 PRD]] 的「验收标准」**39 条**已逐条比对实现与测试证据——**已全部核销（2026-11-04，38 勾选 + 本条补勾 = 39/39），原唯一留白项（根 README 目录结构表）已补齐**。**第二节「验收数字」表已按各任务当轮门禁留档回填**（此前多处为「待填」），数字来源见各任务文件的「门禁」段。
>
> **留档说明**
> - 本文件是三期（桌面端打包 + 端口转发）的**打样与实测结论**留档，由 [[tasks/phase3-desktop/01-prototype-and-spike.md|任务 01]] 打样轮与 [[tasks/phase3-desktop/09-acceptance-and-docs.md|任务 09]] 收口轮填写。
> - **当前状态（2026-11-04）**：**P1~P5 五项全部有结论**——P1 / P3 是本机（Linux）实测（见第四、六节）；**P2 / P4 / P5 已于 2026-11-04 在 Windows 11 真机上实测闭合**（见第五、七、八节）。
> - **09 收口轮回填（2026-11-04）**：全量验收回归 **48 passed / 0 failed / 0 flaky**，约 **9.3 分钟**（Playwright，串行，含前端构建 + 真机沙箱 + 固定测试令牌），**连续两轮全绿**；较 07 轮基线（46 条）**无回归**，新增 `11-forward-web-notice.spec.ts` **2 条** web 形态端口转发用例。**桌面形态的完整管理 Playwright 覆盖不到**（要 Tauri IPC），**已由 Windows 真机验收替代**。
> - **2026-11-03 决策 C 追加说明**：P1 的**实测结论依然成立**（`-p` 在本平台**可用**），但**该路径不再采用**——端口转发链路两点化、**后端宿主零端口**，Fallback B（`docker exec -i` 字节泵）升为**唯一路径**（[[architecture/decisions/0014-端口转发机制选型.md|ADR 0014]] 第二次修订）。本文件中「04/05/06 按主路径实现」一类的**执行指向**已失效，**实测数据与命令留档一律保留**。
> - **首轮用户反馈（2026-11-03）已入档**：P4 的路径②部分闭合、P2 外观初测通过（详见第五、七、八节的「首轮反馈」小段）；P2 的三项控制台判定与 xterm 真渲染、P5 均未闭合。
> - **正式回填（2026-11-04，Windows 11 真机 + 真后端）**：**P2 三项逐项通过**；**P4 路径②正式可交付**（NSIS `setup.exe` 约 3.7 MB，**构建耗时未统计**）；**P5 无提装动作、直接可用**（Win11 自带 WebView2 运行时）；**06 真机连通同轮通过**（结论见 [[tasks/phase3-desktop/06-port-forward-desktop.md|任务 06]]）。**03 全链路的远端形态通过、本机形态（连同机后端）本轮未单独实测**，口径待用户拍板（[[tasks/phase3-desktop/03-frontend-connection-layer.md|任务 03]] 状态仍为 doing）。**（状态更新 2026-11-04：用户已拍板——03 按方案 A「偏离记录」闭合，任务状态置 done；本机形态不单独实测，留待该场景实际出现时再验证。）**
> - **收口后缺陷修复（2026-11-09）**：三期收口（2026-11-04）后暴露一条**潜伏缺陷**——`https://` 后端下的 **wss 隧道建连即 panic**（根因：`rustls` 缺进程级 crypto provider）。**已修复**（提交 `da36940`）并经 **Windows 真机复测通过**；定性为**潜伏缺陷、非回归**（验收盲区：三期只测过 `http://` 后端的 ws 明文路径，wss 路径从未被测）。结论与证据见**第十节**。
> - 打样轮的产物：Tauri v2 工程骨架在 [[architecture/decisions/0015-桌面壳与连接配置抽象.md|ADR 0015]] 约定的位置 `apps/desktop/`；操作指引见 `apps/desktop/README.md`。
> - 关联页面：[[tasks/phase3-desktop/README.md|三期任务集]]、[[prds/phase3-desktop.md|三期 PRD]]、[[architecture/decisions/0014-端口转发机制选型.md|0014 端口转发机制选型]]、[[current-state.md|当前状态]]。

## 一、打样结论（任务 01 填）

| 编号 | 前置项 | 结论 | 关键输出 / 裁决 |
|---|---|---|---|
| **P1** | 免 root 守护进程 `-p` 发布宿主回环 | **通过（本机实测）** | 宿主 `ss -ltn` 出现 `127.0.0.1:18000`（属主 `rootlesskit` 进程），`curl 127.0.0.1:18000` 拿到容器内服务响应体 → **主路径成立** ~~04/05/06 按主路径实现~~ **（2026-11-03 决策 C：`-p` 路径不再采用，Fallback B 升为唯一路径；实测结论本身仍成立）** |
| **P2** | Tauri v2 + WebView2 三项冒烟（`oklch` / xterm.js / `navigator.clipboard`） | **通过（Windows 11 真机，2026-11-04）** | 三项逐项通过：① `oklch()` 配色正常；② xterm.js 渲染 / fit / 表面不溢出正常（随 03 远端形态全链路实测一并验过）；③ `window.isSecureContext === true`、`navigator.clipboard` 读写双向成功（详见第五节） |
| **P3** | 转发镜像经统一镜像代理可拉 | **通过（本机实测）** | `alpine/socat:1.8.1.3@sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed` 经统一镜像代理拉进免 root 守护进程成功，二次拉取的访问日志全部命中代理缓存（计数口径与局限见第六节） |
| **P4** | Windows 出包路径 | **通过（Windows 11 真机，2026-11-04）** | **路径②（用户自有 Windows 机器本地构建）正式可交付**：产出 NSIS `setup.exe` 约 **3.7 MB**；环境 / 产物形态已正式记录，**构建耗时未统计**（详见第七节） |
| **P5** | Windows 目标机器的 WebView2 运行时策略 | **通过（Windows 11 真机，2026-11-04）** | **无提装动作、直接可用**——Win11 系统自带 WebView2 运行时，属预期行为（详见第八节） |

## 二、验收数字（任务 09 填）

| 项目 | 结果 | 基线 |
|---|---|---|
| 核心包 pytest | **292 passed**（05 门禁；09 收口轮核对，含 root 级用例） | 04 轮 288 passed → 05 轮 292 passed（增量 = `BytePump` stderr 排空 4 条） |
| 核心包 root 级用例 | **含在 292 passed 内**（09 完成标准口径：核心包 pytest「含 root 级用例」；`-m root` 子集同批跑，**未单独单列数字**） | — |
| 服务端 pytest | **289 passed**（05 门禁；含新增 44 条转发 / 鉴权用例） | 02 轮 245 passed → 05 轮 289 passed |
| ruff（E4/E7/E9/F） | **退出码 0**（02 / 04 / 05 各轮门禁） | — |
| 前端 vitest | **585 passed**（2026-11-04 端口转发区 UI 重构轮） | 03 轮 493 → 06 轮 527 → UI 重构轮 585 |
| 前端 typecheck / typecheck:tests / build | **typecheck 与 typecheck:tests 双零错；build 成功**（UI 重构轮） | — |
| Rust cargo test（桌面壳） | **26 passed**（2026-11-04 桌面壳 dev 刷新修复轮） | 06 实现轮基线 20 passed |
| 分层契约测试（代码分层红线） | **10 passed**，红线不触发（05 门禁） | — |
| Playwright 真机 | **48 passed / 0 failed / 0 flaky**（约 **9.3 分钟**，2026-11-04，09 收口轮：既有 9 条 + 认证 10 条 + **web 形态端口转发 2 条**；**连续两轮全绿**，此前基线 46 条无回归） | 既有 9 条 + 认证用例 + 端口转发用例（web 形态已补 2 条；桌面形态完整管理由 Windows 真机验收替代） |
| Windows 冒烟结论 | **P2 三项全过**（`oklch` 配色正常 / `window.isSecureContext === true` / 剪贴板读写可用，用户原话「其他测试也都成功通过」）；**P4 路径②正式可交付**（Windows 11，NSIS `setup.exe` 约 3.7 MB，**构建耗时未统计**）；**P5 无提装**（Win11 自带 WebView2 运行时，直接可用）；**06 真机连通通过**（2026-11-04，桌面端开启转发后本机端口可访问沙箱服务）；**08 Windows 打包与冒烟已闭合**（2026-11-04，用户确认冒烟通过：安装 / 启动 / 连接 / 使用均无问题；产物默认路径、不入库；未签名告警属预期） | P1~P5 逐项有结论 |

## 三、已知边界

- **宿主回环这一跳不受令牌保护**：~~后端宿主上的任意本地进程都能直连被发布的端口（回环上的本地访问不需要凭据）。本期接受并写进文档；收紧方向（端口只在隧道建立期间短暂开启 / 加平台内部口令）留作后续。~~ **（2026-11-03 决策 C：本条作废——后端宿主不再发布任何转发端口，宿主上不存在可被本机进程直连的转发端口。）**
- **端口发布只绑回环**：实测确认 `-p 127.0.0.1:<宿主端口>:<容器端口>` 在宿主上只出现 `127.0.0.1:<端口>` 的监听（不是 `0.0.0.0`），不出本机、不出局域网。
- **多路复用推迟**：一条 WebSocket 对一条 TCP 连接；高并发场景每条连接多一次握手。
- **令牌轮换无 UI**：泄漏后只能删文件重启，本期接受。
- **前端 `base` 已改为相对路径**（03 落地）：`apps/web/frontend/vite.config.ts` 现为 `base: './'`，`apps/web/frontend/dist/index.html` 里资源引用形如 `./assets/xxx.js`。相对引用在 Tauri 自定义协议（Windows 上是 `http://tauri.localhost` 根路径）与后端 `StaticFiles` 托管两种形态下都能解析；但这是一次**全量产物变更**，既有验收需重跑（PRD R12）——**状态更新（2026-11-03）：这 9 条 spec 的过渡态红已由 07（[[tasks/phase3-desktop/07-acceptance-tokenization.md|验收套件 token 化]]）恢复**，含认证负向用例与带票正向对照；**状态更新（2026-11-04，09 收口轮）：全量 **48 passed / 0 failed / 0 flaky**（约 9.3 分钟，连续两轮全绿；新增 `11-forward-web-notice.spec.ts` 2 条 web 形态端口转发用例）**。
- **桌面壳 CSP 不再是 `csp: null`**（03 落地）：已按 [[architecture/decisions/0015-桌面壳与连接配置抽象.md|ADR 0015]] 第 6 节收敛为「配置基线 + Rust 运行期 host 级动态生成」——`tauri.conf.json` 存基线策略（`connect-src` 只留 `'self'`），Rust 侧按当前后端主机动态补 `http(s)://<host>:*` 与 `ws(s)://<host>:*`；时序契约为「保存连接配置 → 同步 Rust 状态 → 按需重载主文档」。端口转发侧（任务 06）的同款闸门**已闭合**（06 完成标准已勾选）。

---

## 四、P1 实测留档：免 root 守护进程 `-p` 端口发布（本机实测，通过）

> 结论一句话：**主路径成立**——免 root 守护进程下 `docker run -p 127.0.0.1:<端口>:<容器端口>` 会在宿主回环真的产生监听，且宿主能通过它连到容器内服务；ADR 0014 的「Fallback B」备案路径**不需要被采纳**（但作为备用路径也一并验过，成立）。

> **2026-11-03 决策 C 追加**：本节的**实测结论与命令全部保留**（`-p` 在本平台确实可用）；但**执行指向已反转**——`-p` 路径与宿主端口区间分配整体废除，Fallback B 升为唯一路径，后端宿主零端口。

### 4.1 探针环境

探针完全复用核心包既有机制（`apps/core/src/sandbox_platform/`）：

| 机制 | 用途 |
|---|---|
| `UserSpaceManager.ensure_user` | 建探针用户 `fwdprobe`（uid=1003） |
| `UserSpaceManager.allocate_subid_range` | 登记子 UID/GID 段 `296608:65536`（296608~362143） |
| `RegistryProxyManager.ensure_running` / `install_ca_bundle` | 拉起统一镜像代理并装「系统 CA + 代理 CA」合并 CA 束 |
| `UserSpaceManager.write_docker_unit` | 渲染并写入 systemd 用户单元（内容与平台沙箱守护进程**逐字一致**，同一份 `render_unit`） |
| `UserSpaceManager.enable_linger` | `loginctl enable-linger fwdprobe` 保活 |
| `UserDaemon` | 以探针用户身份操作守护进程（`docker` / `systemctl --user`） |

探针脚本落盘在 `apps/desktop/scripts/probe_rootless_port_forward.py`（子命令：`setup` / `env` / `p1` / `p3` / `fallback-b` / `teardown`），可原样复跑。

**2026-11-03 复核**：探针脚本按审查意见加固后（`docker network create` / `docker run` 查退出码并断言容器确实在运行、teardown 走核心包 `Privilege.wrap`、超时转成「不成立 + 现象」裁决而不是 traceback、代理日志按时间窗增量计数），`setup` → `p1` → `p3` → `fallback-b` → `teardown` 全流程在本机重跑一遍，**结论与下文一致**（P1 主路径成立、Fallback B 备案路径成立、P3 拉取与缓存命中成立、回收零残留）。

### 4.2 版本与环境记录

```
宿主 docker version（server）  29.6.2
rootlesskit 版本              rootlesskit version 3.0.2
dockerd-rootless.sh           Docker version 29.6.2, build 3d80467
免 root 守护进程 server 版本   29.6.2
```

**守护进程单元环境变量**（`systemctl --user show docker --property=Environment`，以下为折行展示，原文是单行）：

```
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  HOME=/home/fwdprobe
  DOCKER_HOST=unix:///run/user/1003/docker.sock
  HTTPS_PROXY=http://127.0.0.1:3128
  HTTP_PROXY=http://127.0.0.1:3128
  NO_PROXY=localhost,127.0.0.1,::1
  SSL_CERT_FILE=/home/fwdprobe/.config/sandbox-platform/registry-proxy-ca-bundle.crt
  DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS=true
```

单元关键属性：`Delegate=yes`、`SubState=running`、`FragmentPath=/home/fwdprobe/.config/systemd/user/docker.service`。

**`docker info` 网络相关字段**（免 root 守护进程视角）：

```
 Server Version: 29.6.2
 Storage Driver: overlayfs
 Cgroup Driver: systemd
 Cgroup Version: 2
  Network: bridge host ipvlan macvlan null overlay
  cgroupns
 Docker Root Dir: /home/fwdprobe/.local/share/docker
 HTTP Proxy: http://127.0.0.1:3128
 HTTPS Proxy: http://127.0.0.1:3128
 No Proxy: localhost,127.0.0.1,::1
  EnableUserlandProxy: true
  UserlandProxyPath: /usr/bin/docker-proxy
```

**免 root 守护进程的实际命令行**（`ps` 摘录，注意 `--port-driver=builtin` 与 `--detach-netns`）：

```
fwdprobe 2316663 2312329 rootlesskit --state-dir=/run/user/1003/dockerd-rootless
  --net=slirp4netns --mtu=65520 --slirp4netns-sandbox=auto --slirp4netns-seccomp=auto
  --disable-host-loopback --port-driver=builtin --copy-up=/etc --copy-up=/run
  --propagation=rslave --detach-netns /usr/bin/dockerd-rootless.sh --rootless
fwdprobe 2316712 2316675 dockerd --rootless
```

### 4.3 拓扑与命令

与 ADR 0014 描述的真实拓扑一致（**转发容器接入沙箱网络，沙箱容器零改动**）：

- 网络 `probe-fwd-net`；
- 容器 `probe-sandbox`：模拟「沙箱容器」，容器内 8080 端口跑一个 HTTP 服务（响应体固定为 `probe-ok`）；
- 容器 `probe-fwd`：模拟「平台自建转发容器」，命令 `socat TCP-LISTEN:8080,fork,reuseaddr TCP:probe-sandbox:8080`，并发布 `-p 127.0.0.1:18000:8080`。

```
$ docker run -d --name probe-sandbox --network probe-fwd-net --entrypoint sh <镜像> -c "..."
64d0901230db712982caf9e0665ef1bb79c9dfce6286c0d0358834ac20e585ca

$ docker exec probe-sandbox wget -qO- http://127.0.0.1:8080/
probe-ok

$ docker run -d --name probe-fwd --network probe-fwd-net -p 127.0.0.1:18000:8080 \
    --entrypoint socat <镜像> TCP-LISTEN:8080,fork,reuseaddr TCP:probe-sandbox:8080
a79c8ac66c1ce227170a398572166d2b695a91ed4417102798e1077301877db1

$ docker port probe-fwd
8080/tcp -> 127.0.0.1:18000
```

### 4.4 判定一：宿主 `ss -ltn` 是否出现该端口

```
$ ss -ltn | grep 18000
LISTEN 0      4096       127.0.0.1:18000      0.0.0.0:*

$ sudo ss -ltnp | grep 18000
LISTEN 0      4096       127.0.0.1:18000      0.0.0.0:*    users:(("rootlesskit",pid=2316663,fd=15))
```

**判定：通过。** 宿主回环上确实出现了 `127.0.0.1:18000` 的监听；监听进程是**该沙箱守护进程的 rootlesskit 父进程**（rootlesskit 的 `builtin` 端口驱动在宿主网络命名空间里绑定端口，再经 slirp4netns 转发进容器的 netns）。**只绑回环，没有 `0.0.0.0`**。

### 4.5 判定二：宿主 `curl 127.0.0.1:<端口>` 是否连通容器内服务

```
$ curl -sS http://127.0.0.1:18000/
probe-ok
```

**判定：通过。** 宿主回环 → rootlesskit 端口驱动 → slirp netns → 转发容器 `probe-fwd`（socat）→ 沙箱容器 `probe-sandbox` 的整条链路通，返回的正是容器内服务的响应体。

### 4.6 P1 裁决

- **主路径（`-p`）成立**：~~04/05/06 按主路径实现——转发容器用 `-p 127.0.0.1:<宿主端口>:<内部端口>` 发布到宿主回环。~~ **（2026-11-03 决策 C：该执行指向作废——`-p` 路径与宿主端口区间分配整体废除，04/05/06 按 Fallback B（`docker exec -i` 字节泵）实现，后端宿主零端口；本节实测结论本身仍成立。）**
- ~~ADR 0014 第 3 节的「Fallback B」**不被采纳**（外层契约不变，切换成本低，保留备案）。~~ **（决策 C 后：Fallback B **升为唯一路径**。）**
- ~~风险 R11（宿主端口被占）仍需在实现里处理：分配端口前做「可绑定」探测，绑定失败换端口重试。~~ **（决策 C 后：R11 改为「用户机本机端口被占 → 自动换空闲端口并显示实际值」。）**
- **复核重跑（2026-11-03）**：加固后的探针脚本重跑，结论一致——`ss -ltn` 出现 `127.0.0.1:18000`、`curl` 拿到 `probe-ok`，裁决仍为「主路径成立」。

### 4.7 附加验证：Fallback B 备案路径（不采纳，但成立）

即使主路径成立，备案路径也一并验过（万一后续 rootlesskit / Docker 行为变化，备案仍可用）：

```
$ docker run -d --name probe-fwd --network probe-fwd-net --entrypoint socat <镜像> \
    TCP-LISTEN:8080,fork,reuseaddr TCP:probe-sandbox:8080      # 注意：没有 -p

$ ss -ltn | grep 18000        # 未出现（符合预期）
（未出现 127.0.0.1:18000 —— 符合预期）

$ printf 'GET / HTTP/1.0\r\nHost: probe-sandbox\r\n\r\n' \
    | docker exec -i probe-fwd socat - TCP:probe-sandbox:8080
HTTP/1.1 200 OK
Content-Type: text/plain
Content-Length: 8
Connection: close

probe-ok
```

**备案路径成立**（双向字节流能拿到容器内服务的完整 HTTP 响应）。代价与 ADR 0014 记载一致：每条连接一个 exec 进程、管道非 TTY 需额外分帧与超时处理。

### 4.8 收尾清理（零残留）

回收动作：删除探针容器 `probe-fwd` / `probe-sandbox` 与网络 `probe-fwd-net` → `systemctl --user disable --now docker.service` → 删除单元文件 → 关闭 linger → 清除 `/etc/subuid` 与 `/etc/subgid` 条目 → `userdel -r fwdprobe`（含家目录）。

脚本内校验（6 项全通过）：

```
  [通过] 探针用户不存在
  [通过] /etc/subuid 无探针条目
  [通过] /etc/subgid 无探针条目
  [通过] 探针家目录已删除
  [通过] 用户运行时目录已回收
  [通过] 用户级 systemd 单元已删除
```

独立复核（回收后另起一条命令复查）：

```
$ id fwdprobe                     → id: 'fwdprobe': no such user
$ cat /etc/subuid                 → sankabox / probeuser1 / sandbox-formulationpbpk（无 fwdprobe）
$ cat /etc/subgid                 → 同上（无 fwdprobe）
$ ls -d /home/fwdprobe            → No such file or directory
$ ls -d /run/user/1003            → No such file or directory
$ ps -ef | grep fwdprobe          → （空）
$ docker ps -a --filter name=probe- → （空，宿主 root 守护进程里也没有探针容器）
$ ss -ltn | grep 18000            → （空，端口已释放）
```

---

## 五、P2 实测留档：Tauri v2 + WebView2 三项冒烟（Windows 11 真机，通过）

> **状态：通过（2026-11-04，Windows 11 真机 + 真后端）**——三项逐项通过（结论见 5.3）。**不接受「在桌面版 Chromium 里过了就算过」**这条约束照旧成立：本次判定是在真机 Windows 11 + WebView2 上做的。
> 操作步骤与判定方法见 `apps/desktop/README.md`「WebView2 三项冒烟（P2 真机操作步骤）」。

判定标准（逐项记「通过 / 不通过 + 现象截图或输出」）：

| 项 | 判定标准 | 不通过时的备案路径 |
|---|---|---|
| **① `oklch()` 配色** | 界面**有颜色**（不是整页灰白/黑）；DevTools 里 `CSS.supports('color', 'oklch(0.7 0.15 200)') === true` | 令牌层补一条 `rgb()` 回退色（只改 `globals.css` 的 `:root` / `.dark` 与 `@theme` 映射，不在组件里写裸色值） |
| **② xterm.js** | 1) **渲染**：终端出字符、能敲命令回显；2) **fit**：拖动窗口改变宽度时**列数跟着变**且与可视区域匹配；3) **表面不溢出**：右边缘无原生滚动条、字符不裁切 | 调整终端测量盒与字体度量（注意既有坑：自托管字体 swap 晚到会让列数失配，前端已有 `document.fonts.ready` 后补 `fit` 的处理，要在 WebView2 下复验） |
| **③ `navigator.clipboard`** | 1) `window.isSecureContext === true`（**这是预期值，不是已证事实；具体取值待 Windows 实测** → **2026-11-04 真机实测为 `true`，已证实**）；2) `typeof navigator.clipboard !== 'undefined'`；3) **读写双向成功**（终端内 `Ctrl+Shift+C` 复制 → 外部粘贴；外部复制 → 终端 `Ctrl+Shift+V` 粘贴） | 剪贴板快捷键改走 Tauri 侧剪贴板能力（改 `src/lib/terminal-shortcuts.ts` 的分类口径与单元测试）。既有约定：非安全上下文下接口不存在，走失败路径弹提示，**不做降级**——判定重点是接口在不在 |

打样轮已为本项准备好的东西：Tauri v2 工程骨架（`apps/desktop/`）、Windows 构建指引（`apps/desktop/README.md`「Windows 构建指引」）、`pnpm tauri dev` 冒烟路径。

### 5.1 首轮反馈（2026-11-03）

> 本节只追加用户首轮实测反馈，不改上文判定标准。**本项尚未闭合**：外观初测通过，三项控制台判定与 xterm 真渲染仍待验。**（2026-11-04 已闭合，见 5.3。）**

- **外观初测通过**：配色正常，未见 `oklch` 掉色（界面有颜色，不是整页灰白/黑）。
- **正式版构建打不开开发者工具 —— 正常现象**：开发者工具只在调试构建（`pnpm tauri dev`）下提供，正式版构建（`pnpm tauri build`）不含 DevTools 入口，不是构建失败。
- **控制台三项待复验**：正式版拿不到 DevTools，`CSS.supports('color', 'oklch(0.7 0.15 200)')`、`window.isSecureContext`、`navigator.clipboard` 读写这三项**尚未判定**，待用户以调试构建（`pnpm tauri dev`）复验后逐项记「通过 / 不通过 + 输出」。
- **xterm 真渲染待 03 后端连通后验**：终端真渲染依赖后端连通，而 02（连接层后端改造）尚未与 03（前端连接层改造）同批发布（前端不带 `Authorization` 头时后端全线 `401`），因此 xterm 的「渲染 / fit / 表面不溢出」判定待 03 落地、后端连通后再做。

### 5.2 03 落地后的可测性变化（2026-11-03）

03（连接层前端改造）已落地，桌面壳可按连接配置（后端地址 + 令牌）**连上真后端**，因此 **xterm 真渲染（渲染 / fit / 表面不溢出）与剪贴板读写现在可以在真机上做端到端验证**——不再受「前端拿不到数据」的阻塞。该复验窗口与 P2 的控制台三项**合并成一次 Windows 真机复验**（见 [[current-state.md|当前状态]] 的 TODO 条目）。

### 5.3 真机复验结论（2026-11-04，Windows 11 + 真后端）

> **本项已闭合**：三项逐项通过。用户在 Windows 11 真机上复验，原话「其他测试也都成功通过」。

| 项 | 判定 | 实测现象 |
|---|---|---|
| **① `oklch()` 配色** | **通过** | 界面**有颜色**、未掉色（不是整页灰白 / 黑）；其余测试项一并通过 |
| **② xterm.js（渲染 / fit / 表面不溢出）** | **通过** | 随 03 的**远端形态**全链路实测一并验过——桌面壳按连接配置连上**远端后端**后终端实际可用（终端、转发等功能实际使用无问题） |
| **③ `navigator.clipboard`** | **通过** | `window.isSecureContext === true`（**预期值已证实**）；`navigator.clipboard` 可用；**读写双向成功** |

**口径说明**：

- ①与③的控制台判定取自真机（调试构建 `pnpm tauri dev`）的 DevTools；②的真渲染依赖后端连通，与 03 的**远端形态**全链路实测合并完成（见 [[tasks/phase3-desktop/03-frontend-connection-layer.md|任务 03]]）。
- **03 的本机形态（连同机后端）本轮未单独实测**，口径待用户拍板——**该缺口不影响 P2 的判定**（P2 判的是 WebView2 的三项能力本身，不判后端部署形态）。**（状态更新 2026-11-04：用户已拍板按「偏离记录」闭合 03——远端形态真机通过即闭合，本机形态在目标部署中不存在，留待该场景实际出现时再验证。）**


---

## 六、P3 实测留档：转发镜像钉版与代理拉取（本机实测，通过）

> 结论一句话：**成立**——`alpine/socat:1.8.1.3` 已钉死 digest，能经统一镜像代理拉进沙箱的免 root 守护进程，二次拉取的访问日志全部命中代理缓存（计数口径与局限见 6.3）。

### 6.1 镜像钉版

| 项 | 值 |
|---|---|
| 镜像 | `alpine/socat` |
| tag | `1.8.1.3`（与 `latest` 同 digest） |
| digest（钉版值） | `sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed` |
| 完整引用 | `alpine/socat:1.8.1.3@sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed` |

digest 核对方式（registry API 权威口径，`Accept` 带 OCI index 与 manifest list）：

```
$ curl -sS -o /dev/null -D - -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json" \
    https://registry-1.docker.io/v2/alpine/socat/manifests/1.8.1.3
HTTP/2 200
docker-content-digest: sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed
```

> 镜像特性备忘（对 04/05/06 有用）：该镜像 **ENTRYPOINT 是 `socat`**，且其 busybox **没有编译 `httpd`**。转发容器的启动命令要显式处理 entrypoint（如 `--entrypoint socat`），不能想当然地假设 `/bin/sh` 是默认入口。

### 6.2 代理管理（核心包 API）

统一镜像代理用核心包 `RegistryProxyManager` 管理（本机已有实例，`ensure_running` 幂等拉起）：

```
代理容器：sandbox-platform-registry-proxy
代理健康：True（tcp=True ca=True）
代理明细：CA 证书可取（http://127.0.0.1:3128/ca.crt，2130 字节）
代理地址：http://127.0.0.1:3128
证书就绪：True
合并 CA 束已安装：/home/fwdprobe/.config/sandbox-platform/registry-proxy-ca-bundle.crt
```

守护进程单元里的 `HTTPS_PROXY` / `HTTP_PROXY` / `SSL_CERT_FILE` 指向上面这三项（见 4.2），因此**沙箱侧 `docker pull` 无需任何额外操作即自动经代理**。

### 6.3 拉取结果与代理命中情况

**首次拉取（干净拉取）**：

```
$ docker pull alpine/socat:1.8.1.3@sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed
docker.io/alpine/socat@sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed: Pulling from alpine/socat
8bcc5c0e78e5: Pulling fs layer
7b229517ed22: Pulling fs layer
8bcc5c0e78e5: Download complete
7b229517ed22: Download complete
8bcc5c0e78e5: Pull complete
7b229517ed22: Pull complete
Digest: sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed
Status: Downloaded newer image for alpine/socat@sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed
```

镜像详情（守护进程内，`docker image inspect`；2026-11-03 复核重跑的真实输出）：

```
Id=sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed
RepoDigests=["alpine/socat@sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed"]
Size=4405810
```

> **两点说明**：
> - **换行用 `{{println}}`**：探针脚本原来的 `--format` 里写的是 `\n`，而 Docker 的 `--format` 是 Go template，**不认 `\n`**（会原样打印字面量），已改成 `{{println}}`（脚本已修）。
> - **`Id` 这一行不作 digest 佐证**：本机（Docker 29.6.2）取到的 `Id` 恰好就是钉版的 manifest digest；**但别的 Docker 版本 / 存储驱动下 `Id` 可能是 config digest**，与 manifest digest 不是一回事。digest 的权威口径取上面 `docker pull` 输出的 `Digest:` 行与 6.1 节的 registry API `docker-content-digest` 响应头（两处互相印证）。

代理缓存占用（打样轮原始的冷缓存首次拉取）：拉取前 `2282584` 字节 → 拉取后 `6693324` 字节（**增量 4410740 字节**）。复核重跑时缓存已是热的，增量为 `0` 字节（`6693324` → `6693324`）。

**代理访问日志（证明流量确实走了统一镜像代理）** —— 计数口径见本节末尾「代理命中条数的口径」。

冷缓存首次拉取窗口（打样轮原始，2026-11-03 10:31 时间窗）共 **8 条访问日志**：**7 条 `MISS`（回源，其中 2 条是 registry 的 401 认证挑战）+ 1 条 `HIT`**（HEAD 请求把 manifest 写入缓存后，同一秒的 GET 直接命中）。原文：

```
{"access_time":"03/Nov/2026:10:31:16 +0000","upstream_cache_status":"MISS","method":"HEAD","uri":"/v2/alpine/socat/manifests/sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed","request_type":"manifest-by-digest","status":"401","bytes_sent":"0","upstream_response_time":"0.980","host":"registry-1.docker.io","proxy_host":"registry-1.docker.io","upstream":"157.240.2.14:443"}
{"access_time":"03/Nov/2026:10:31:18 +0000","upstream_cache_status":"MISS","method":"HEAD","uri":"/v2/alpine/socat/manifests/sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed","request_type":"manifest-by-digest","status":"200","bytes_sent":"0","upstream_response_time":"1.274","host":"registry-1.docker.io","proxy_host":"registry-1.docker.io","upstream":"208.43.237.140:443"}
{"access_time":"03/Nov/2026:10:31:18 +0000","upstream_cache_status":"HIT","method":"GET","uri":"/v2/alpine/socat/manifests/sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed","request_type":"manifest-by-digest","status":"200","bytes_sent":"1777","upstream_response_time":"","host":"registry-1.docker.io","proxy_host":"registry-1.docker.io","upstream":""}
{"access_time":"03/Nov/2026:10:31:19 +0000","upstream_cache_status":"MISS","method":"GET","uri":"/v2/alpine/socat/manifests/sha256:f99efbac7d08cb97dc98c5b336fac195c58da9b2804eeec2d4a841365411eeba","request_type":"manifest-by-digest","status":"401","bytes_sent":"155","upstream_response_time":"0.792","host":"registry-1.docker.io","proxy_host":"registry-1.docker.io","upstream":"208.43.237.140:443"}
{"access_time":"03/Nov/2026:10:31:21 +0000","upstream_cache_status":"MISS","method":"GET","uri":"/v2/alpine/socat/manifests/sha256:f99efbac7d08cb97dc98c5b336fac195c58da9b2804eeec2d4a841365411eeba","request_type":"manifest-by-digest","status":"200","bytes_sent":"671","upstream_response_time":"0.992","host":"registry-1.docker.io","proxy_host":"registry-1.docker.io","upstream":"208.43.237.140:443"}
{"access_time":"03/Nov/2026:10:31:22 +0000","upstream_cache_status":"MISS","method":"GET","uri":"/v2/alpine/socat/blobs/sha256:4d7c241675826e9f05e4f8ced1d97258043665459835c9ff4ff60c1f05d11305","request_type":"blob-by-digest","status":"200","bytes_sent":"983","upstream_response_time":"0.000, 0.818 : 0.244","host":"registry-1.docker.io","proxy_host":"production.cloudfront.docker.com","upstream":"[2a03:2880:f10f:83:face:b00c:0:25de]:443, 208.43.237.140:443 : 3.169.5.59:443"}
{"access_time":"03/Nov/2026:10:31:24 +0000","upstream_cache_status":"MISS","method":"GET","uri":"/v2/alpine/socat/blobs/sha256:8bcc5c0e78e5fd8de1aa384e73a80374f57624e63ca5b3155c414632f0e78042","request_type":"blob-by-digest","status":"200","bytes_sent":"549270","upstream_response_time":"1.201 : 1.055","host":"registry-1.docker.io","proxy_host":"production.cloudfront.docker.com","upstream":"208.43.237.140:443 : 3.169.5.90:443"}
{"access_time":"03/Nov/2026:10:31:25 +0000","upstream_cache_status":"MISS","method":"GET","uri":"/v2/alpine/socat/blobs/sha256:7b229517ed222597277036d94892173207d01a731ab3a88eeb1de2e963a2c788","request_type":"blob-by-digest","status":"200","bytes_sent":"3853109","upstream_response_time":"1.340 : 1.522","host":"registry-1.docker.io","proxy_host":"production.cloudfront.docker.com","upstream":"208.43.237.140:443 : 3.169.5.118:443"}
```

（同一时间窗内另有 2 行 nginx 的上游连接告警，不是访问日志条目，**不计入条数**。）

**二次拉取（`docker rmi` 后再拉）**：2026-11-03 复核重跑的时间窗内 **6 条访问日志全部 `upstream_cache_status=HIT`**，`upstream` 为空（没走上游）：

```
二次拉取时间窗内的代理条目数：6
二次拉取命中代理缓存（upstream_cache_status=HIT）的条目数：6
```

命中行原文（同一窗口逐条贴出）：

```
{"access_time":"03/Nov/2026:10:57:24 +0000","upstream_cache_status":"HIT","method":"HEAD","uri":"/v2/alpine/socat/manifests/sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed","request_type":"manifest-by-digest","status":"200","bytes_sent":"0","upstream_response_time":"","host":"registry-1.docker.io","proxy_host":"registry-1.docker.io","upstream":""}
{"access_time":"03/Nov/2026:10:57:24 +0000","upstream_cache_status":"HIT","method":"GET","uri":"/v2/alpine/socat/manifests/sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed","request_type":"manifest-by-digest","status":"200","bytes_sent":"1777","upstream_response_time":"","host":"registry-1.docker.io","proxy_host":"registry-1.docker.io","upstream":""}
{"access_time":"03/Nov/2026:10:57:24 +0000","upstream_cache_status":"HIT","method":"GET","uri":"/v2/alpine/socat/manifests/sha256:f99efbac7d08cb97dc98c5b336fac195c58da9b2804eeec2d4a841365411eeba","request_type":"manifest-by-digest","status":"200","bytes_sent":"671","upstream_response_time":"","host":"registry-1.docker.io","proxy_host":"registry-1.docker.io","upstream":""}
{"access_time":"03/Nov/2026:10:57:24 +0000","upstream_cache_status":"HIT","method":"GET","uri":"/v2/alpine/socat/blobs/sha256:4d7c241675826e9f05e4f8ced1d97258043665459835c9ff4ff60c1f05d11305","request_type":"blob-by-digest","status":"200","bytes_sent":"983","upstream_response_time":"","host":"registry-1.docker.io","proxy_host":"registry-1.docker.io","upstream":""}
{"access_time":"03/Nov/2026:10:57:24 +0000","upstream_cache_status":"HIT","method":"GET","uri":"/v2/alpine/socat/blobs/sha256:8bcc5c0e78e5fd8de1aa384e73a80374f57624e63ca5b3155c414632f0e78042","request_type":"blob-by-digest","status":"200","bytes_sent":"549270","upstream_response_time":"","host":"registry-1.docker.io","proxy_host":"registry-1.docker.io","upstream":""}
{"access_time":"03/Nov/2026:10:57:24 +0000","upstream_cache_status":"HIT","method":"GET","uri":"/v2/alpine/socat/blobs/sha256:7b229517ed222597277036d94892173207d01a731ab3a88eeb1de2e963a2c788","request_type":"blob-by-digest","status":"200","bytes_sent":"3853109","upstream_response_time":"","host":"registry-1.docker.io","proxy_host":"registry-1.docker.io","upstream":""}
```

#### 代理命中条数的口径（复核后更正）

- **按时间窗取日志增量**：以「二次拉取」动作发生的时刻为窗口起点，用 `docker logs --since <窗口起点>` 取增量，**不在整段历史日志上数**；
- **纳入 blobs 请求**：过滤条件覆盖 `manifest` 与 `blobs` 两类请求——拉一个镜像除了 manifest 还要逐个取 layer（blobs），只数 manifest 会漏掉大部分条目；
- **只取 JSON 访问日志行**：代理的 nginx 错误 / 告警行里也会出现镜像名与请求路径，混进来会把条数算虚。

> **口径更正**：本节原先写的「二次拉取命中代理缓存（upstream_cache_status=HIT）的条目数：9」是**在整段日志上计数、且过滤条件把 blobs 排除掉**的口径——数字不可复现、结论「全 HIT」也过强，**已作废**。按上面的口径复核（2026-11-03 重跑 `p3`，探针脚本已按新口径实现），二次拉取窗口内 6 条访问日志全部命中缓存。
>
> **局限**：代理缓存跨轮次存活，所以复核重跑时缓存已是热的——重跑窗口里「首次拉取」也是 6 条全 HIT，「首次 MISS 回源」只在冷缓存窗口（上面 10:31 那组）出现。二次拉取不走上游这一结论不受影响（命中行的 `upstream` 字段为空）。

### 6.4 P3 裁决

- **通过**：转发镜像可经统一镜像代理拉进沙箱守护进程，代理缓存有效（冷缓存首次拉取 MISS 回源、二次拉取的访问日志全部命中缓存）。
- **不需要走备案路径**（PRD 的备案是「宿主导出注入 + `image_source=host`」，本次未触发）。
- 落定口径：转发镜像引用**一律写全 `tag@digest`**（`alpine/socat:1.8.1.3@sha256:466c8a…`），平台在拉取时用该引用，保证跨机器一致。

---

## 七、P4 实测留档：Windows 出包路径（Windows 11 真机，通过）

> **状态：通过（2026-11-04）**——**路径②（用户自有 Windows 机器本地构建）正式可交付**（正式记录见 7.2）。本机是 Linux，Tauri v2 **不支持从 Linux 交叉编译出 Windows 安装包**，故出包只能在 Windows 侧完成。

判定标准：至少一条路径**可重复执行**，并记录「所需环境 / 耗时 / 产物形态」。

| 候选路径 | 所需环境 | 代价 / 前提 |
|---|---|---|
| **① GitHub Actions `windows-latest`（推荐）** | 仓库先有远端（当前**无远端、无 `.github`**，PRD R6）+ 一个可推送的分支 | 产物不在本机、构建日志在远端；需先建远端 |
| **② 用户自有 Windows 机器本地构建** | Rust stable(MSVC) + Visual Studio Build Tools（含 Windows SDK）+ WebView2 SDK + Node ≥ 22 + pnpm 10 | 依赖用户配合，每次出包都占用那台机器 |
| ③ 从 Linux 交叉编译 | — | **Tauri v2 不支持，不作为选项** |

记录模板（Windows 侧实测时填——**已按 7.2 回填**）：

- 环境：Windows 版本 / Rust 版本 / Node 与 pnpm 版本 / Build Tools 版本 / WebView2 运行时版本；
- 耗时：`pnpm install` / 前端 `pnpm build` / `pnpm tauri build` 各自墙钟耗时；
- 产物形态：`apps\desktop\src-tauri\target\release\bundle\nsis\沙箱控制台_<版本>_x64-setup.exe`（NSIS 安装包）+ cargo 原始产物 `apps\desktop\src-tauri\target\release\sandbox-console-desktop.exe`（**按 Cargo 包名 `sandbox-console-desktop` 命名，不是中文**；只有 NSIS 安装完成后的「开始菜单 / 桌面快捷方式」指向的 `沙箱控制台.exe` 才用中文名）；
- 结论：选哪条路径、另一条是否保留。

### 7.1 首轮反馈（2026-11-03）

> 本节只追加用户首轮实测反馈，不改上文记录模板。**路径②已部分闭合**，模板里的细节待正式补记。**（2026-11-04 已正式补记，见 7.2。）**

- **路径②（用户自有 Windows 机器本地构建）可行**：用户在自有 Windows 机器上本地构建**通过**——「至少一条路径可重复执行」这条判定**已闭合**。
- **待正式记录**：上文「记录模板」的三项细节——环境（Windows / Rust / Node / pnpm / Build Tools / WebView2 运行时版本）、耗时（`pnpm install` / 前端 `pnpm build` / `pnpm tauri build` 各自墙钟耗时）、产物形态（NSIS 安装包与 cargo 原始产物的实际文件名与路径）——首轮反馈未给出数值，待补记。
- **路径①（GitHub Actions `windows-latest`）本轮未验**：仓库当前无远端、无 `.github`，是否保留为备份路径待定。

### 7.2 正式记录（2026-11-04，Windows 11 真机）

> **本项已闭合**：路径②**正式可交付**（结论与首轮打样结论一致，见 7.1）。上方「记录模板」的三项细节按本次实测回填。

- **路径**：② 用户自有 Windows 机器本地构建（`pnpm tauri build`，骨架的 `bundle.targets` 为 `["nsis"]`）。
- **环境**：**Windows 11**；Rust / Node / pnpm / Visual Studio Build Tools / WebView2 运行时**各版本号本轮未统计**（本次正式记录只给出了 Windows 版本）。
- **耗时**：**未统计**——本轮**未采集** `pnpm install` / 前端 `pnpm build` / `pnpm tauri build` 各自的墙钟耗时，**留空待补**；不影响「至少一条路径可重复执行」这条判定。
- **产物形态**：**NSIS 安装包 `setup.exe`，约 3.7 MB**（落在 `apps\desktop\src-tauri\target\release\bundle\nsis\`）；cargo 原始产物 `apps\desktop\src-tauri\target\release\sandbox-console-desktop.exe`（**按 Cargo 包名 `sandbox-console-desktop` 命名，不是中文**；只有 NSIS 安装完成后的「开始菜单 / 桌面快捷方式」指向的 `沙箱控制台.exe` 才用中文名）。
- **结论**：**路径②正式可交付**——出包口径与首轮打样结论一致，08 的出包方式按此走。
- **未做**：路径①（GitHub Actions `windows-latest`）本轮未验——仓库仍**无远端、无 `.github`**；保留为备份路径，是否补做待定。

---

## 八、P5 实测留档：WebView2 运行时策略（Windows 11 真机，通过）

> **状态：通过（2026-11-04）**——真机上**无提装动作、直接可用**（Win11 系统自带 WebView2 运行时），属预期行为（结论见 8.2）。

Tauri v2 的 `bundle.windows.webviewInstallMode` 取值与 PRD 的三选一对应：

| PRD 口径 | Tauri v2 取值 | 体积代价 | 离线可用 |
|---|---|---|---|
| Evergreen 静默安装 | `{"type": "downloadBootstrapper", "silent": true}` | 小 | **否**（要连网拉运行时） |
| 离线安装包随包分发 | `{"type": "offlineInstaller", "silent": true}` | **+约 127MB** | 是 |
| 提示用户自装 | `{"type": "skip"}`（安装包检测缺失后给指引） | 无 | 需人工 |
| （备选）内嵌 bootstrapper | `{"type": "embedBootstrapper", "silent": true}` | +约 1.8MB | 否 |
| （备选）固定运行时 | `{"type": "fixedRuntime", "path": "..."}` | **+约 180MB** | 是 |

当前骨架里的取值是 **`downloadBootstrapper`（Evergreen 静默安装）**——它是 Tauri v2 的默认值，也是体积最小的选择；**2026-11-04 真机实测后取值不变**（目标机器自带 Evergreen 运行时，安装与启动全程不触发提装，见 8.2）。

判定标准：

1. 在一台**未装 WebView2 运行时**的 Windows 机器上运行安装包；
2. 安装能自动完成（静默）或给出明确的人工指引；
3. 安装后首次启动能正常打开界面（不报「WebView2 运行时缺失」）；
4. 若选离线随包分发：断网状态下重跑一遍上述 1~3；
5. 无论选哪条，README 与安装引导都要写明**最低 WebView2 版本**。

### 8.1 首轮反馈（2026-11-03）

- **无新信息**：本轮用户反馈未涉及 WebView2 运行时策略（未装运行时的机器上的安装行为），P5 维持「待 Windows 实测」，上文的取值表与判定标准照旧。**（2026-11-04 已验，见 8.2。）**

### 8.2 真机复验结论（2026-11-04，Windows 11 真机）

> **本项已闭合**：**无提装动作，直接可用**。

- **实测现象**：在 Windows 11 真机上安装并启动桌面端，**没有任何 WebView2 运行时提装动作**（不弹安装、不触发下载），**直接可用**。
- **原因**：**Windows 11 系统自带 WebView2 运行时**（Evergreen）——属**预期行为**，不是构建缺陷。
- **取值结论**：骨架里的 `downloadBootstrapper`（Evergreen 静默安装）**保持不变**；目标机器自带运行时，本轮**不会触发**该 bootstrapper。
- **口径边界（如实记录）**：上文判定标准第 1 条「在一台**未装 WebView2 运行时**的 Windows 机器上试安装包」本轮**未覆盖**（本轮机器自带运行时），因此「离线随包分发 / 提示自装」等**缺运行时场景下的行为未验**；目标机器的 WebView2 版本不由我们控制，最低版本口径按 [[architecture/decisions/0015-桌面壳与连接配置抽象.md|ADR 0015]] 的对应条款保留。

---

## 九、本轮（打样轮）产出的文件

| 文件 | 说明 |
|---|---|
| `apps/desktop/package.json` | 桌面工程 JS 侧（私有包，`@tauri-apps/cli` ^2，scripts.tauri = `tauri`） |
| `apps/desktop/pnpm-lock.yaml` | JS 侧依赖锁 |
| `apps/desktop/.gitignore` | 忽略 `node_modules/`、`src-tauri/target/` |
| `apps/desktop/README.md` | Windows 构建指引 + P2 三项冒烟逐步操作与判定方法 |
| `apps/desktop/scripts/probe_rootless_port_forward.py` | 打样探针脚本（P1 / P3 / Fallback B，可复跑） |
| `apps/desktop/src-tauri/Cargo.toml` / `build.rs` / `src/main.rs` | Rust 侧最小骨架（`tauri = "2"` + `tauri-build`） |
| `apps/desktop/src-tauri/tauri.conf.json` | 桌面壳配置（`frontendDist` → `../../web/frontend/dist`、`devUrl` → `http://localhost:5173`、`bundle.targets` → `["nsis"]`、窗口 1280×800） |
| `apps/desktop/src-tauri/icons/*` | 图标（`source.png` 是源图，其余由 `pnpm tauri icon` 生成） |
| `docs/tasks/phase3-desktop/RESULTS.md` | 本文件 |

**本轮骨架校验状态（Linux）**：

- `cargo check` —— **通过**（补装 `libwebkit2gtk-4.1-dev` 等系统开发库后无错编译）；
- `pnpm tauri build --debug` —— **通过**，产物 `apps/desktop/src-tauri/target/debug/sandbox-console-desktop`；
- `tauri.conf.json` 对 **官方 schema（`https://schema.tauri.app/config/2`）校验 0 错误**；
- `beforeBuildCommand` 的工作目录经验证是 `apps/desktop`（相对路径 `../web/frontend` 正确解析，前端构建被自动触发）；
- 前端产物已重建（`apps/web/frontend`：`pnpm install --frozen-lockfile` + `pnpm build`，产物落在 `apps/web/frontend/dist`，**没有第二份前端**）。
- **未完成的（截至 2026-11-03 打样轮）**：Windows 上的运行行为、NSIS 出包、WebView2 三项冒烟（见第五、七、八节）——**已于 2026-11-04 在 Windows 11 真机上全部闭合**（P2 三项通过 / P4 路径②正式可交付 / P5 无提装；06 真机连通同轮通过）。

**Linux 侧的限制**：本机无 WebView2，也无显示环境（`DISPLAY` 为空、无 Xvfb），因此**无法在 Linux 上启动应用做真机冒烟**；三项冒烟必须在 Windows 真机上做。

---

## 十、收口后缺陷修复（2026-11-09）：https 后端下的 wss 隧道建连即 panic

> **定性：潜伏缺陷、非回归。** 三期真机验收（2026-11-04）只覆盖了后端地址为 `http://` 的转发路径（隧道走 **ws 明文**），**`https://` 后端（wss）路径从未被测过**。2026-11-05 控制台迁至 `https://sandbox-api.sankabox.com`（traefik → 28642）后，该路径**首次被真实使用**，缺陷随之暴露（2026-11-09 排障确认）。

### 10.1 现象

- 桌面端**监听绿灯正常**（本机 `127.0.0.1:<port>` 确实起来了），但**本机连接被接受后秒级 reset**，**没有任何失败提示**，**后端零隧道痕迹**（服务端看不到任何隧道接入）。
- **环境干扰项（同期真实存在，排障的主要弯路）**：Windows 上 **VS Code 的自动端口转发**以**地址重用方式双绑** `127.0.0.1:8000`——**绑定不报错**，但**连接被编辑器抢走**。换到 **9000** 端口后排除该干扰，**真因才暴露**。此项**不是本缺陷的成因**，但必须留档：它与真缺陷的现象高度相似（都是「连上就被重置」），排障时须先排除。

### 10.2 根因

`tokio-tungstenite` 0.30 以 `default-features = false` 引 `rustls` / `tokio-rustls`，**整棵依赖树上不带任何 crypto provider**（`ring` 与 `aws-lc-rs` **均未启用**）；**dev 与 release 的特性集一致**（不是「只在发布版缺 provider」）。

wss 建连时，`rustls` 0.23.46 在 **`ClientConfig::builder()`** 处 panic（`crypto/mod.rs:249`）。**桥接任务 panic → 失败上报（`report_tunnel_failure`）不执行 → 全部症状闭环**（静默 reset、无失败提示、后端零痕迹）。

> **独立风险点（本次未发生）**：release profile 配了 **`panic = "abort"`**，若**打包版**命中同类 panic，会**整进程闪退**（不是只挂那一条桥接）。本次**未发生**——复现走的是 dev 构建、**未触达打包版的 TLS 路径**；但该风险独立存在，处置**待拍板**（见 10.8 与 [[current-state.md|当前状态]] 的 TODO 条目）。

### 10.3 修复

- **提交**：`da36940` —— `fix(desktop): 显式安装 rustls ring provider——修复 https 后端下 wss 隧道建连即 panic`
- **改动规模**：**3 文件 +15 行**
  - `apps/desktop/src-tauri/Cargo.toml`：显式声明 `rustls = { version = "0.23", default-features = false, features = ["ring", "std", "tls12"] }`；
  - `apps/desktop/src-tauri/src/main.rs`：`main()` 顶部装 provider——`get_default()` 为 `None` 时才 `install_default()`（进程级 provider **只能装一次**，且必须**早于任何 TLS 使用**；TLS 只在 `forward.rs::bridge()` 建 wss 隧道时才用到）；
  - `apps/desktop/src-tauri/Cargo.lock`：随上述依赖声明新增 **2 行依赖边**（包数不变）。
- **选 ring 的理由**：① **锁文件零新增包**（`ring` 0.17.14 已在依赖树里）；② **Windows MSVC 走预汇编目标文件**，**无需 NASM / CMake**。

### 10.4 验证证据

| 项 | 结果 |
|---|---|
| `cargo tree`（默认形态 / `--no-default-features` 形态） | 两棵树上均出现 rustls feature **`"ring"`** |
| `Cargo.lock` 差异 | 仅 **+2 行**预期依赖边（rustls deps 加 ring、根包 deps 加 rustls）；包数 **453 → 453**（**零新增包**） |
| `cargo check`（默认形态 / `--no-default-features` 形态） | 均**通过** |
| `cargo test` | **26 passed**，与基线一致（**无回归**） |
| 临时运行时探针 | 确认 `ClientConfig::builder()` **不再 panic**（探针**已删**，不入库） |

### 10.5 真机复测（2026-11-09 02:00 前后，Windows dev + 真后端）

- 用户改用本地端口 **9000** 后测试通过（换端口同时排除了 VS Code 抢占干扰）。
- **服务端日志完整证据**：
  - `WebSocket /api/forward/tunnel/f11a398299e1` **[accepted] ×2**；
  - 已登记转发隧道 **`tun-000001` / `tun-000002`**；
  - 字节泵 **`docker exec -i formulationpbpk-fwd-8000 socat - TCP:sandbox-formulationpbpk:8000`** **随每条连接拉起**。

### 10.6 修复后行为

**panic 路径消除后，隧道失败恢复正常上报**——行内**红字** + **error toast**，**不再静默 reset**。

### 10.7 新确认的已知边界

1. **桌面端 TLS 只认公共根证书**：桌面端 TLS 的信任根是 **webpki-roots**（公共根证书集），**私有 CA / 自签证书的后端走不了 wss 隧道**（建连失败）。后端公网入口现为 **Let's Encrypt** 证书，**不受影响**。
2. **后端地址必须带 `https://` 前缀**：**裸域名会被前端补成 `http://`**（归一化规则见 `apps/web/frontend/src/lib/connection.ts` 的 `normalizeBaseUrl`）；此时 webview 侧的 **REST / 终端照常工作**（它们走 https），但**隧道会以明文 `ws` 打 443，必败**——**极具迷惑性**。

### 10.8 遗留风险指针（均**待拍板**，不阻断使用）

- **`release` 的 `panic = "abort"` 处置**：桥接任务 panic 在**发布版会闪退整个应用**（本次未发生，见 10.2）。候选方案：**去掉 abort**（改回 unwind，panic 只挂当前任务），或**对桥接任务做 panic 兜底转失败上报**。
- **绿灯语义**：界面上的**监听绿灯只表示「本机监听已建立」，不表示「隧道可用」**——隧道可用性要等首条连接真正打通才知道；叠加 VS Code 端口抢占（绑定不报错、连接被抢走）后，界面上分不出「已就绪 / 端口被抢 / 隧道不通」。候选方案：**监听开启后做自连探测**，在 UI 上区分这三种状态。

两条的登记与状态见 [[current-state.md|当前状态]] 的「TODO / 阻塞」区；操作层面的坑（端口抢占、公共根证书、scheme 前缀）见 `apps/desktop/README.md` 的「环境注意」与「已知边界」小节。
