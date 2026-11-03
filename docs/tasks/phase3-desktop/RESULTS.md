# 三期留档（打样与实测结论）

> **留档说明**
> - 本文件是三期（桌面端打包 + 端口转发）的**打样与实测结论**留档，由 [[tasks/phase3-desktop/01-prototype-and-spike.md|任务 01]] 打样轮与 [[tasks/phase3-desktop/09-acceptance-and-docs.md|任务 09]] 收口轮填写。
> - **当前状态（2026-11-03）**：打样轮已在本机（Linux）完成 **P1 / P3** 两项实测并成文；**P2 / P4 / P5** 三项依赖 Windows 真机，留「待 Windows 实测」占位（判定标准已写死，见第五、七、八节）。
> - **首轮用户反馈（2026-11-03）已入档**：P4 的路径②部分闭合、P2 外观初测通过（详见第五、七、八节的「首轮反馈」小段）；P2 的三项控制台判定与 xterm 真渲染、P5 均未闭合。
> - 打样轮的产物：Tauri v2 工程骨架在 [[architecture/decisions/0015-桌面壳与连接配置抽象.md|ADR 0015]] 约定的位置 `apps/desktop/`；操作指引见 `apps/desktop/README.md`。
> - 关联页面：[[tasks/phase3-desktop/README.md|三期任务集]]、[[prds/phase3-desktop.md|三期 PRD]]、[[architecture/decisions/0014-端口转发机制选型.md|0014 端口转发机制选型]]、[[current-state.md|当前状态]]。

## 一、打样结论（任务 01 填）

| 编号 | 前置项 | 结论 | 关键输出 / 裁决 |
|---|---|---|---|
| **P1** | 免 root 守护进程 `-p` 发布宿主回环 | **通过（本机实测）** | 宿主 `ss -ltn` 出现 `127.0.0.1:18000`（属主 `rootlesskit` 进程），`curl 127.0.0.1:18000` 拿到容器内服务响应体 → **主路径成立**，04/05/06 按主路径实现 |
| **P2** | Tauri v2 + WebView2 三项冒烟（`oklch` / xterm.js / `navigator.clipboard`） | **待 Windows 实测** | 判定标准已写死（见第五节）；操作步骤见 `apps/desktop/README.md` |
| **P3** | 转发镜像经统一镜像代理可拉 | **通过（本机实测）** | `alpine/socat:1.8.1.3@sha256:466c8a0383e16463fabdb7df01008292fb78d07da60224a46cb5d3142ce122ed` 经统一镜像代理拉进免 root 守护进程成功，二次拉取的访问日志全部命中代理缓存（计数口径与局限见第六节） |
| **P4** | Windows 出包路径 | **待 Windows 实测** | 候选两条：GitHub Actions `windows-latest`（需先有远端）/ 用户自有 Windows 机；判定标准见第七节 |
| **P5** | Windows 目标机器的 WebView2 运行时策略 | **待 Windows 实测** | `webviewInstallMode` 三选一（Evergreen 静默 / 离线随包 / 提示自装）；判定标准见第八节 |

## 二、验收数字（任务 09 填）

| 项目 | 结果 | 基线 |
|---|---|---|
| 核心包 pytest | 待填 | — |
| 核心包 root 级用例 | 待填 | — |
| 服务端 pytest | 待填 | — |
| ruff（E4/E7/E9/F） | 待填 | — |
| 前端 vitest | 待填 | — |
| 前端 typecheck / typecheck:tests / build | 待填 | — |
| Playwright 真机 | 待填 | 既有 9 条 + 认证用例 + 端口转发用例 |
| Windows 冒烟结论 | 待填 | — |

## 三、已知边界

- **宿主回环这一跳不受令牌保护**：后端宿主上的任意本地进程都能直连被发布的端口（回环上的本地访问不需要凭据）。本期接受并写进文档；收紧方向（端口只在隧道建立期间短暂开启 / 加平台内部口令）留作后续。
- **端口发布只绑回环**：实测确认 `-p 127.0.0.1:<宿主端口>:<容器端口>` 在宿主上只出现 `127.0.0.1:<端口>` 的监听（不是 `0.0.0.0`），不出本机、不出局域网。
- **多路复用推迟**：一条 WebSocket 对一条 TCP 连接；高并发场景每条连接多一次握手。
- **令牌轮换无 UI**：泄漏后只能删文件重启，本期接受。
- **前端 `base` 仍是绝对路径**：`apps/web/frontend/dist/index.html` 里资源引用形如 `/assets/xxx.js`。Tauri 自定义协议（Windows 上是 `http://tauri.localhost` 根路径）能解析，但改成 `base: './'` 是任务 03 的既定改动，届时必须重跑既有验收（PRD R12）。
- **桌面壳本期只设 `csp: null`**：PRD 要求的「按连接配置动态设置 CSP」属任务 03/06 的范围；打样轮保持最小骨架，避免静态 CSP 误伤前端产物里的内联防闪烁脚本。

---

## 四、P1 实测留档：免 root 守护进程 `-p` 端口发布（本机实测，通过）

> 结论一句话：**主路径成立**——免 root 守护进程下 `docker run -p 127.0.0.1:<端口>:<容器端口>` 会在宿主回环真的产生监听，且宿主能通过它连到容器内服务；ADR 0014 的「Fallback B」备案路径**不需要被采纳**（但作为备用路径也一并验过，成立）。

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

- **主路径（`-p`）成立**：04/05/06 按主路径实现——转发容器用 `-p 127.0.0.1:<宿主端口>:<内部端口>` 发布到宿主回环。
- ADR 0014 第 3 节的「Fallback B」**不被采纳**（外层契约不变，切换成本低，保留备案）。
- 风险 R11（宿主端口被占）仍需在实现里处理：分配端口前做「可绑定」探测，绑定失败换端口重试。
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

## 五、P2 待 Windows 实测：Tauri v2 + WebView2 三项冒烟

> **状态：待 Windows 实测**（本机是 Linux，没有 WebView2；**不接受「在桌面版 Chromium 里过了就算过」**）。
> 操作步骤与判定方法见 `apps/desktop/README.md`「WebView2 三项冒烟（P2 真机操作步骤）」。

判定标准（逐项记「通过 / 不通过 + 现象截图或输出」）：

| 项 | 判定标准 | 不通过时的备案路径 |
|---|---|---|
| **① `oklch()` 配色** | 界面**有颜色**（不是整页灰白/黑）；DevTools 里 `CSS.supports('color', 'oklch(0.7 0.15 200)') === true` | 令牌层补一条 `rgb()` 回退色（只改 `globals.css` 的 `:root` / `.dark` 与 `@theme` 映射，不在组件里写裸色值） |
| **② xterm.js** | 1) **渲染**：终端出字符、能敲命令回显；2) **fit**：拖动窗口改变宽度时**列数跟着变**且与可视区域匹配；3) **表面不溢出**：右边缘无原生滚动条、字符不裁切 | 调整终端测量盒与字体度量（注意既有坑：自托管字体 swap 晚到会让列数失配，前端已有 `document.fonts.ready` 后补 `fit` 的处理，要在 WebView2 下复验） |
| **③ `navigator.clipboard`** | 1) `window.isSecureContext === true`（**这是预期值，不是已证事实；具体取值待 Windows 实测**）；2) `typeof navigator.clipboard !== 'undefined'`；3) **读写双向成功**（终端内 `Ctrl+Shift+C` 复制 → 外部粘贴；外部复制 → 终端 `Ctrl+Shift+V` 粘贴） | 剪贴板快捷键改走 Tauri 侧剪贴板能力（改 `src/lib/terminal-shortcuts.ts` 的分类口径与单元测试）。既有约定：非安全上下文下接口不存在，走失败路径弹提示，**不做降级**——判定重点是接口在不在 |

打样轮已为本项准备好的东西：Tauri v2 工程骨架（`apps/desktop/`）、Windows 构建指引（`apps/desktop/README.md`「Windows 构建指引」）、`pnpm tauri dev` 冒烟路径。

### 5.1 首轮反馈（2026-11-03）

> 本节只追加用户首轮实测反馈，不改上文判定标准。**本项尚未闭合**：外观初测通过，三项控制台判定与 xterm 真渲染仍待验。

- **外观初测通过**：配色正常，未见 `oklch` 掉色（界面有颜色，不是整页灰白/黑）。
- **正式版构建打不开开发者工具 —— 正常现象**：开发者工具只在调试构建（`pnpm tauri dev`）下提供，正式版构建（`pnpm tauri build`）不含 DevTools 入口，不是构建失败。
- **控制台三项待复验**：正式版拿不到 DevTools，`CSS.supports('color', 'oklch(0.7 0.15 200)')`、`window.isSecureContext`、`navigator.clipboard` 读写这三项**尚未判定**，待用户以调试构建（`pnpm tauri dev`）复验后逐项记「通过 / 不通过 + 输出」。
- **xterm 真渲染待 03 后端连通后验**：终端真渲染依赖后端连通，而 02（连接层后端改造）尚未与 03（前端连接层改造）同批发布（前端不带 `Authorization` 头时后端全线 `401`），因此 xterm 的「渲染 / fit / 表面不溢出」判定待 03 落地、后端连通后再做。

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

## 七、P4 待 Windows 实测：Windows 出包路径

> **状态：待 Windows 实测**（本机是 Linux，Tauri v2 **不支持从 Linux 交叉编译出 Windows 安装包**）。

判定标准：至少一条路径**可重复执行**，并记录「所需环境 / 耗时 / 产物形态」。

| 候选路径 | 所需环境 | 代价 / 前提 |
|---|---|---|
| **① GitHub Actions `windows-latest`（推荐）** | 仓库先有远端（当前**无远端、无 `.github`**，PRD R6）+ 一个可推送的分支 | 产物不在本机、构建日志在远端；需先建远端 |
| **② 用户自有 Windows 机器本地构建** | Rust stable(MSVC) + Visual Studio Build Tools（含 Windows SDK）+ WebView2 SDK + Node ≥ 22 + pnpm 10 | 依赖用户配合，每次出包都占用那台机器 |
| ③ 从 Linux 交叉编译 | — | **Tauri v2 不支持，不作为选项** |

记录模板（Windows 侧实测时填）：

- 环境：Windows 版本 / Rust 版本 / Node 与 pnpm 版本 / Build Tools 版本 / WebView2 运行时版本；
- 耗时：`pnpm install` / 前端 `pnpm build` / `pnpm tauri build` 各自墙钟耗时；
- 产物形态：`apps\desktop\src-tauri\target\release\bundle\nsis\沙箱控制台_<版本>_x64-setup.exe`（NSIS 安装包）+ cargo 原始产物 `apps\desktop\src-tauri\target\release\sandbox-console-desktop.exe`（**按 Cargo 包名 `sandbox-console-desktop` 命名，不是中文**；只有 NSIS 安装完成后的「开始菜单 / 桌面快捷方式」指向的 `沙箱控制台.exe` 才用中文名）；
- 结论：选哪条路径、另一条是否保留。

### 7.1 首轮反馈（2026-11-03）

> 本节只追加用户首轮实测反馈，不改上文记录模板。**路径②已部分闭合**，模板里的细节待正式补记。

- **路径②（用户自有 Windows 机器本地构建）可行**：用户在自有 Windows 机器上本地构建**通过**——「至少一条路径可重复执行」这条判定**已闭合**。
- **待正式记录**：上文「记录模板」的三项细节——环境（Windows / Rust / Node / pnpm / Build Tools / WebView2 运行时版本）、耗时（`pnpm install` / 前端 `pnpm build` / `pnpm tauri build` 各自墙钟耗时）、产物形态（NSIS 安装包与 cargo 原始产物的实际文件名与路径）——首轮反馈未给出数值，待补记。
- **路径①（GitHub Actions `windows-latest`）本轮未验**：仓库当前无远端、无 `.github`，是否保留为备份路径待定。

---

## 八、P5 待 Windows 实测：WebView2 运行时策略

> **状态：待 Windows 实测**（需要在「没有 WebView2 运行时」的机器上试安装包才能定）。

Tauri v2 的 `bundle.windows.webviewInstallMode` 取值与 PRD 的三选一对应：

| PRD 口径 | Tauri v2 取值 | 体积代价 | 离线可用 |
|---|---|---|---|
| Evergreen 静默安装 | `{"type": "downloadBootstrapper", "silent": true}` | 小 | **否**（要连网拉运行时） |
| 离线安装包随包分发 | `{"type": "offlineInstaller", "silent": true}` | **+约 127MB** | 是 |
| 提示用户自装 | `{"type": "skip"}`（安装包检测缺失后给指引） | 无 | 需人工 |
| （备选）内嵌 bootstrapper | `{"type": "embedBootstrapper", "silent": true}` | +约 1.8MB | 否 |
| （备选）固定运行时 | `{"type": "fixedRuntime", "path": "..."}` | **+约 180MB** | 是 |

当前骨架里的取值是 **`downloadBootstrapper`（Evergreen 静默安装）**——它是 Tauri v2 的默认值，也是体积最小的选择；**最终取值待 Windows 实测后定**。

判定标准：

1. 在一台**未装 WebView2 运行时**的 Windows 机器上运行安装包；
2. 安装能自动完成（静默）或给出明确的人工指引；
3. 安装后首次启动能正常打开界面（不报「WebView2 运行时缺失」）；
4. 若选离线随包分发：断网状态下重跑一遍上述 1~3；
5. 无论选哪条，README 与安装引导都要写明**最低 WebView2 版本**。

### 8.1 首轮反馈（2026-11-03）

- **无新信息**：本轮用户反馈未涉及 WebView2 运行时策略（未装运行时的机器上的安装行为），P5 维持「待 Windows 实测」，上文的取值表与判定标准照旧。

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
- **未完成的**：Windows 上的运行行为、NSIS 出包、WebView2 三项冒烟（见第五、七、八节）。

**Linux 侧的限制**：本机无 WebView2，也无显示环境（`DISPLAY` 为空、无 Xvfb），因此**无法在 Linux 上启动应用做真机冒烟**；三项冒烟必须在 Windows 真机上做。
