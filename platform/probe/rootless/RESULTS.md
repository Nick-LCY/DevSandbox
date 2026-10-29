# 免 root 沙箱模式打样验证 · 实测记录

- 执行日期：2026-10-29
- 执行人：一期任务 01 执行者
- 宿主机：Ubuntu 26.04 LTS / 内核 7.0.0-38-generic / systemd 259 / cgroup v2 / Docker 29.6.2
- 探针用户：`sandboxprobe`（uid 1001），子 UID/GID 段 `165536:65536`
- 完整复现：`cd platform/probe/rootless && ./run-all.sh`（末尾可加 `--cleanup` 自动回收）

## 总体结论

主链路成立：专属用户 + 独立子 UID/GID 段 + systemd 用户级免 root Docker 守护进程 + 套接字挂载进容器 + 同网桥按容器名互访，全部在真实宿主机上跑通。14 项技术判定全部通过，其中 1 项（`uid_map` 行数）为任务原文口径与内核实际行为不一致，已按语义等价口径判定通过并附调整方案。

---

## 一、逐条判定

### 判定 1：探针用户身份下 `systemctl --user is-active docker` 输出 `active`

命令：

```bash
sudo -u sandboxprobe env XDG_RUNTIME_DIR=/run/user/1001 \
  systemctl --user is-active docker.service
```

输出：

```
active
```

**结论：通过**

---

### 判定 2：`docker info` 的 `Root Dir` 落在该用户家目录内

命令：

```bash
sudo -u sandboxprobe env XDG_RUNTIME_DIR=/run/user/1001 \
  DOCKER_HOST=unix:///run/user/1001/docker.sock \
  docker info --format 'ServerVersion={{.ServerVersion}} RootDir={{.DockerRootDir}} Driver={{.Driver}} CgroupDriver={{.CgroupDriver}} CgroupVersion={{.CgroupVersion}} SecurityOptions={{.SecurityOptions}}'
```

输出：

```
ServerVersion=29.6.2 RootDir=/home/sandboxprobe/.local/share/docker Driver=overlayfs CgroupDriver=systemd CgroupVersion=2 SecurityOptions=[name=seccomp,profile=builtin name=rootless name=cgroupns]
```

**结论：通过**（`Root Dir` 在 `/home/sandboxprobe` 内；`SecurityOptions` 含 `rootless`，确认是免 root 模式）

---

### 判定 3：探针用户身份下 `docker ps` 只显示本次探针创建的容器

命令（基线在 `02-run-containers.sh` 建容器**之前**记录，检查在 `03` 里做集合对比）：

```bash
# 基线
sudo -u sandboxprobe env ... docker ps -a --format '{{.ID}}\t{{.Names}}' | sort > /tmp/rootless-probe/baseline-containers.txt
# 当前
sudo -u sandboxprobe env ... docker ps -a --format '{{.Names}}' | sort
# 宿主 root 守护进程的容器（作对照）
sudo docker ps -a --format '{{.Names}}'
```

输出：

```
基线容器：（空，探针守护进程初始无任何容器）
当前容器：probe-client probe-main probe-peer
宿主 root 守护进程的容器（探针内不可见）：clash-ui cloudflared-tunnel compose_test-api-1 filebrowser
  formulai-demo-decimer-runner-1 formulai-demo-frontend-1 formulai-demo-runner-1 formulai-demo-web-1
  litellm minio minio-minio-init-1 postgres postgres-postgres-init-1 prometheus test-api-1
  tmp-api-1 traefik
```

集合对比：`当前集合 == 基线集合 ∪ {probe-main, probe-peer, probe-client}`，无多出项。

**结论：通过**（宿主 root 守护进程上有 11 个运行中容器，探针守护进程一个都看不到）

---

### 判定 4：容器内 `id` 显示 UID 为 0

命令：

```bash
sudo -u sandboxprobe env ... docker exec probe-main id
```

输出：

```
uid=0(root) gid=0(root) groups=0(root),10(wheel)
```

**结论：通过**

---

### 判定 5：宿主侧 `ls -n` 显示文件属主为映射后的高位 UID

命令（在宿主目录 `/home/sandboxprobe/share` 挂进容器，分别以容器内 root 与容器内 uid 1000 建文件）：

```bash
sudo -u sandboxprobe env ... docker exec --user 1000:1000 probe-main sh -c 'echo probe > /share/owned-by-1000'
sudo -u sandboxprobe env ... docker exec probe-main sh -c 'echo probe > /share/owned-by-root'
sudo ls -n /home/sandboxprobe/share
```

输出：

```
total 8
-rw-rw-rw- 1 166535 166535 6 Oct 29 05:51 owned-by-1000
-rw-rw-rw- 1 1001   1001   6 Oct 29 05:51 owned-by-root
```

子 ID 段起点 165536，容器内 uid 1000 的宿主属主 = `165536 + 999 = 166535`，落在 `[165536, 231071]` 区间内。

**结论：通过**（注意语义分层：容器内 root 的宿主属主是守护进程用户 1001，**只有容器内的非 root 用户**才映射到子 ID 段高位 UID；见下方「口径修正」）

---

### 判定 6：`/proc/<pid>/uid_map` 覆盖 65536 个 UID

命令：

```bash
PID=$(sudo -u sandboxprobe env ... docker inspect -f '{{.State.Pid}}' probe-main)
sudo cat /proc/$PID/uid_map
```

输出：

```
         0       1001          1
         1     165536      65536
uid_map 行数 = 2；映射覆盖的 UID 总数 = 65537
```

**结论：通过（口径修正）**

内核把 UID 映射存成**区间**而不是逐个展开，所以文件恒为 2 行，不可能出现 65536 行。任务原文「行数为 65536」按字面判定不成立；按等价的语义口径「映射覆盖 ≥ 65536 个 UID」判定成立：第二行 `1 165536 65536` 一次性映射了 65536 个高位 UID（加上 rootown 的 1 个，实际覆盖 65537）。

**调整方案（建议修订任务文件措辞）**：

- 把「`/proc/<pid>/uid_map` 行数为 65536」改为「`/proc/<pid>/uid_map` 覆盖的 UID 总数 ≥ 65536（区间映射，文件为 2 行）」；
- 同时把判定 5 拆成两句：容器内 root 的宿主属主 = 守护进程用户 uid；容器内非 root 用户的宿主属主 = 子 ID 段内高位 UID。

---

### 判定 7：套接字挂载后容器内 `docker ps` 能看到守护进程管理的容器

命令（`probe-client` 以 `-v /run/user/1001/docker.sock:/var/run/docker.sock` 启动）：

```bash
sudo -u sandboxprobe env ... docker exec probe-client docker ps -a --format '{{.Names}}'
```

输出：

```
probe-client probe-main probe-peer
```

**结论：通过**

---

### 判定 8：容器内 `docker version` 的 client 与 server 版本号一致

命令：

```bash
sudo -u sandboxprobe env ... docker exec probe-client \
  docker version --format '{{.Client.Version}}'
sudo -u sandboxprobe env ... docker exec probe-client \
  docker version --format '{{.Server.Version}}'
```

输出：

```
client = 29.6.2
server = 29.6.2
```

**结论：通过**

> 首次实测不通过：`docker:cli` 标签指向 29.9.2（client 29.9.2 / server 29.6.2）。改为按宿主守护进程版本锁定镜像 `docker:29.6.2-cli` 后一致。`02-run-containers.sh` 已自动按宿主版本选标签，取不到时退回 `docker:cli`。

---

### 判定 9：同网桥按容器名解析

命令：

```bash
sudo -u sandboxprobe env ... docker exec probe-client getent hosts probe-peer
sudo -u sandboxprobe env ... docker exec probe-main nslookup probe-peer
```

输出：

```
getent hosts probe-peer：172.18.0.2        probe-peer  probe-peer
busybox 侧 nslookup：Name:	probe-peer Address: 172.18.0.2
```

**结论：通过**（`busybox:latest` 不带 `getent`，故在 `docker:cli`（Alpine）容器里用 `getent`，busybox 侧用 `nslookup` 交叉验证）

---

### 判定 10：连通对端暴露的端口

命令：

```bash
sudo -u sandboxprobe env ... docker exec probe-main nc -z probe-peer 8080
sudo -u sandboxprobe env ... docker exec probe-main wget -qO- http://probe-peer:8080/
```

输出：

```
[通过] nc -z probe-peer 8080 连通
HTTP 取回内容：<h1>probe-peer ok</h1>
```

**结论：通过**

---

### 判定 11：宿主 `ss -ltn` 无探针容器新增的监听端口

命令（基线在 `02` 建容器前记录，`03` 里做差集）：

```bash
sudo ss -ltnH | awk '{print $4}' | sort > /tmp/rootless-probe/ss-before.txt   # 02
sudo ss -ltnH | awk '{print $4}' | sort > /tmp/rootless-probe/ss-after.txt    # 03
comm -13 ss-before.txt ss-after.txt
```

输出：

```
基线监听端口数：28；当前：28
新增监听：（无）
```

**结论：通过**

---

### 判定 12：cgroup 委托 `Delegate=yes`

命令：

```bash
sudo -u sandboxprobe env ... systemctl --user show docker --property=Delegate --value
```

输出：

```
yes
```

单元文件中已显式写入 `Delegate=yes`（见 `01-start-dockerd.sh` 生成的 `/home/sandboxprobe/.config/systemd/user/docker.service`）。

**结论：通过**

---

### 判定 13：容器进程的 cgroup 路径位于该用户 cgroup 之下

命令：

```bash
sudo cat /proc/$PID/cgroup
```

输出：

```
0::/user.slice/user-1001.slice/user@1001.service/user.slice/docker-f959d56bc2f3920cf319fe82afa05b3a0d8cfea3a4a8d2d5991e2290fb283aa0.scope
```

守护进程自身所在 cgroup：`/user.slice/user-1001.slice/user@1001.service/app.slice/docker.service`。

**结论：通过**

---

### 判定 14：`04-cleanup.sh` 执行后资源全部回收

命令：

```bash
./04-cleanup.sh
```

输出：

```
[04] 已删除容器 probe-main
[04] 已删除容器 probe-peer
[04] 已删除容器 probe-client
[04] 已删除网络 probe-net
[04] 已禁用用户级单元 docker.service
[04] 已停止用户级守护进程
[04] 已关闭 linger 保活
[04] 已终止用户 sandboxprobe 的登录会话与用户级管理器
[04] 已删除用户 sandboxprobe（含家目录）
[04] 已清理状态目录 /tmp/rootless-probe

===== 清理结果校验 =====
  [通过] 用户 sandboxprobe 不存在 — 已删除
  [通过] /etc/subuid 无该用户条目 — 已清除
  [通过] /etc/subgid 无该用户条目 — 已清除
  [通过] 用户级 systemd 单元已删除 — 已删除
  [通过] 探针家目录已删除 — 已删除
  [通过] 运行时目录已回收 — 已回收
```

**结论：通过**

---

## 二、脚本与幂等性

| 脚本 | 幂等做法 | 连续执行两次的结果 |
|------|----------|--------------------|
| `00-create-user.sh` | 用户存在则跳过创建；子 ID 段合规则沿用，不合规则重算一段不重叠的空闲段 | 第二次输出「已存在，跳过创建 / 沿用已有子 UID 段」，`/etc/subuid`、`/etc/subgid` 各只有一条条目 |
| `01-start-dockerd.sh` | 单元内容比对后决定是否重启；`enable --now` 幂等 | 第二次不重启守护进程（内容未变），`is-active` 仍为 `active` |
| `02-run-containers.sh` | 先删同名探针容器再重建；镜像已存在则跳过拉取 | 第二次基线仍为空（不含探针容器），判定 3 依旧通过 |
| `03-network-check.sh` | 只读检查 + 写两个探针文件 | 连续执行结论一致 |
| `04-cleanup.sh` | 资源不存在则跳过；先停单元再删用户 | 第一次删用户失败（用户级管理器仍占用）→ 已补 `loginctl terminate-user`；第二次补齐并全部回收 |
| `run-all.sh` | 串行调用上述脚本 | 全新一轮（删完用户后从零跑）14 项判定全部通过 |

---

## 三、踩坑清单（实测踩到，已在脚本里规避）

1. **dockerd 必须显式加 `--rootless`**。`dockerd-rootless.sh` 自己不会加；不加时报 `rootless mode needs to be enabled for running with RootlessKit`，守护进程起不来。任务里提到的 `--force-non-root` 在 dockerd 29.6.2 上不存在，以实际环境为准用 `--rootless`。
2. **`/run/user/<uid>` 是 0700**。脚本里用 `[ -S "$RUNTIME_DIR/docker.sock" ]` 判断会因无权限而恒为假；必须以探针用户身份（或 sudo）检查。
3. **`systemctl --user enable` 要求 `~/.config/systemd/user` 属主是探针用户**。用 `sudo mkdir -p` 建目录会留下 root 属主，报 `Unit .../default.target.wants/docker.service does not exist`。脚本改用 `install -d -o <探针用户>` 并 `chown -R`。
4. **`userdel` 报 `user is currently used by process`**。用户的 systemd 用户管理器还活着；必须先 `loginctl terminate-user <用户>`（或停 `user@<uid>.service`）再删用户。
5. **`docker:cli` 标签是 latest，与宿主守护进程版本不一致**，导致 `docker version` 的 client ≠ server。必须按宿主版本锁定 `docker:<守护进程版本>-cli`。
6. **UID 映射分两层**：容器内 root → 宿主守护进程用户 uid（1001）；容器内非 root 用户 → 子 ID 段高位 UID（165536+）。判定「宿主侧高位 UID」必须用容器内非 root 用户来验证。
7. **`uid_map` 是区间映射**，`--group` 参数传宿主 gid（165536）会 `chown: invalid argument`——RootlessKit 命名空间里子 ID 段占的是 namespace id 1..65536，不是宿主 gid。
8. **套接字属组是 `docker` 组**（守护进程命名空间 gid 983，宿主视图 gid 166518），模式 0660。容器内 root 靠**属主**身份（宿主 uid 1001）访问；若沙箱容器以非 root 用户运行，则无权访问套接字，需要把套接字放开到 0666 或另做组映射。
9. **`fuse-overlayfs` 实际用不上**：本机守护进程直接用原生 `overlayfs` 快照器（Docker 29 默认 containerd snapshotter），但保留安装以防别的宿主机回落。

---

## 四、对后续任务的影响

| 任务 | 影响 |
|------|------|
| 02 平台基础镜像 | 基础镜像里的 docker 客户端要与宿主守护进程**同版本**，否则套接字挂载后 `docker version` 对不上。基础镜像的 docker CLI 应按宿主版本构建，或统一由平台固定版本。 |
| 02 平台基础镜像 | 沙箱容器若以**非 root** 用户运行，则访问不了挂载进来的套接字（属组不匹配）。基础镜像需保持 root 运行，或平台在挂载后把套接字放开到 0666。 |
| 04 生命周期核心模块与 CLI | 建用户流程要固化三件事：`loginctl enable-linger` → 写用户单元（含 `Delegate=yes` 与 `--rootless`）→ 登记子 ID 段；删用户流程必须先 `loginctl terminate-user`。 |
| 04 生命周期核心模块与 CLI | 子 ID 段必须**动态分配不重叠**的空闲段（脚本里已有 `pick_free_start` 逻辑），不能让所有沙箱共用一段。 |
| 04 生命周期核心模块与 CLI | cgroup 委托已验证成立，`Delegate=yes` + `CgroupDriver=systemd` + cgroup v2，二期/三期的每沙箱资源配额（2 核 / 4GB）有实现基础。 |
| 全部 | 免 root 网络走 RootlessKit + slirp4netns 用户态网络栈，吞吐与延迟不如宿主原生栈；容器名互访与不发布端口两条要求均已满足。 |
