# 免 root 沙箱模式打样探针

本目录验证一期最关键的技术前提：**每沙箱专属 Linux 用户 + 独立子 UID/GID 段 + systemd 用户级免 root Docker 守护进程 + 套接字挂载进容器 + 同网桥按容器名互访**。

## 目录内容

| 文件 | 作用 |
|------|------|
| `00-create-user.sh` | 创建探针用户 `sandboxprobe`，登记子 UID/GID 段 |
| `01-start-dockerd.sh` | 写 systemd 用户单元并启动免 root dockerd（linger 保活） |
| `02-run-containers.sh` | 准备镜像、探针网络与三个探针容器 |
| `03-network-check.sh` | 逐条执行任务判定，输出 通过 / 不通过 |
| `04-cleanup.sh` | 回收探针创建的全部宿主资源 |
| `run-all.sh` | 顺序执行 00 → 01 → 02 → 03，可选 `--cleanup` 跑完自动回收 |
| `common.sh` | 公共常量与辅助函数（被其他脚本引用，不单独执行） |
| `RESULTS.md` | 实测记录：每条判定的真实命令与关键输出 |

## 运行方式

```bash
cd platform/probe/rootless
./run-all.sh                # 建用户 → 起守护进程 → 起容器 → 跑判定
./run-all.sh --cleanup      # 同上，跑完自动执行 04 回收
./04-cleanup.sh             # 单独回收
```

脚本需要免密 `sudo`（建用户、写 `/etc/subuid`、写用户单元、启 linger、删用户）。
所有脚本幂等：连续执行两次不报错、不留残留；`02` 会先删除同名探针容器再重建，`01` 在单元内容未变时不会重启守护进程。

环境变量可覆盖默认值：`PROBE_USER`、`PROBE_HOME`、`PROBE_NET`、`STATE_DIR`、`IMG_BUSYBOX`、`IMG_DOCKER_CLI`、`SUBID_LEN`。

## 环境前置

### 本机实测环境（2026-10-29）

| 项 | 值 |
|----|----|
| 发行版 | Ubuntu 26.04 LTS（resolute） |
| 内核 | 7.0.0-38-generic |
| systemd | 259（259.5-0ubuntu3.4） |
| cgroup | v2（`/sys/fs/cgroup` 为 `cgroup2fs`） |
| Docker | 客户端 + 服务端 29.6.2（`docker-ce 5:29.6.2-1~ubuntu.26.04~resolute`） |
| RootlessKit | 3.0.2（随 `docker-ce-rootless-extras` 安装） |
| `uidmap`（newuidmap/newgidmap） | 1:4.17.4-2ubuntu3 ✅ 已安装（需 setuid 位） |
| `slirp4netns` | 1.3.3-1 ✅ 已安装 |
| `fuse-overlayfs` | 1.14-1build2 ✅ 已安装（本次实测未走到，守护进程用原生 `overlayfs` 快照器） |
| `kernel.unprivileged_userns_clone` | 1 |
| `user.max_user_namespaces` | 34760 |
| `kernel.apparmor_restrict_unprivileged_userns` | 1（Ubuntu 26.04 默认值；实测未阻断普通用户创建 user namespace，免 root Docker 正常） |

### 缺失依赖的安装命令

```bash
sudo apt-get update
sudo apt-get install -y uidmap        # 提供 newuidmap / newgidmap，映射子 ID 段必需
sudo apt-get install -y slirp4netns   # 免 root 网络栈（rootlesskit 默认网络驱动）
sudo apt-get install -y fuse-overlayfs # 备选存储驱动（本机未实际使用）
```

免 root 守护进程本身由 `docker-ce-rootless-extras` 提供（`/usr/bin/dockerd-rootless.sh`、`/usr/bin/rootlesskit`），本机已安装：

```bash
sudo apt-get install -y docker-ce-rootless-extras
```

若 `slirp4netns` 不可用，RootlessKit 会退回 `pasta` / `gvisor-tap-vsock`（后者不支持端口驱动）。Ubuntu 26.04 的等价包名为 `passt`：

```bash
sudo apt-get install -y passt
```

### 其它前置

- **子 ID 段**：探针用户必须在 `/etc/subuid`、`/etc/subgid` 各登记一段连续子 ID，长度 ≥ 65536、起点 ≥ 100000。本机 `sandboxprobe` 使用 `165536:65536`。
- **linger**：`loginctl enable-linger sandboxprobe` 必须先执行，否则 `/run/user/<uid>` 不存在，用户级 systemd 单元无法启动。
- **宿主须有 root 守护进程在跑**：本探针用宿主 root 守护进程做镜像离线注入的兜底路径。
- **磁盘**：`/tmp` 为 5.5G tmpfs，镜像离线注入会临时占用数百 MB，打样前请确认空间。

## 关键约定

- 探针用户：`sandboxprobe`；套接字：`/run/user/<uid>/docker.sock`（`/run/user/<uid>` 权限 0700，仅探针用户可读）。
- 探针容器：`probe-main`（busybox 客户端）、`probe-peer`（busybox httpd，监听 8080）、`probe-client`（`docker:<版本>-cli`，挂载宿主套接字）。
- 探针网络：`probe-net`；容器之间用容器名互访，不发布任何宿主端口。
- 状态目录：`/tmp/rootless-probe`（存基线容器列表与宿主监听端口基线，回收时清空）。
