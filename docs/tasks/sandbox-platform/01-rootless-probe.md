---
prd: prds/sandbox-platform.md
status: done
---
# 任务：免 root 沙箱模式打样验证

> 实测结论：主链路成立，14 项技术判定全部通过。实测记录见 `platform/probe/rootless/RESULTS.md`，环境前置见 `platform/probe/rootless/README.md`。
>
> 口径修正一处：`/proc/<pid>/uid_map` 由内核按**区间**存储，恒为 2 行，不可能出现 65536 行；实测覆盖 UID 总数 65537（`0 1001 1` + `1 165536 65536`）。本文「子 ID 段判定」一项按等价的语义口径（覆盖 ≥ 65536 个 UID）判定为通过，原文措辞待后续修订。

## 目标
在真实宿主机上用脚本化清单验证一期最关键的技术前提——「每沙箱专属 Linux 用户 + 独立子 UID/GID 段 + systemd 用户级 rootless Docker 守护进程 + 套接字挂载进容器 + 同网桥按容器名互访」这条主链路确实可行。本任务必须最先完成；结论不成立时，后续镜像与生命周期实现都要改方案。

## 完成标准
- [x] 探针脚本目录 `platform/probe/rootless/` 建成，包含 `00-create-user.sh`、`01-start-dockerd.sh`、`02-run-containers.sh`、`03-network-check.sh`、`04-cleanup.sh`、`run-all.sh`；每个脚本幂等，连续执行两次不报错、不留残留。
- [x] `00-create-user.sh` 创建探针用户 `sandboxprobe`，并在 `/etc/subuid`、`/etc/subgid` 登记一段连续子 ID 段（长度 ≥ 65536，起点 ≥ 100000）；脚本输出该段的起止数值。
- [x] `01-start-dockerd.sh` 以 systemd 用户单元启动 rootless dockerd，单元文件写在探针用户的 `~/.config/systemd/user/` 下，并通过 `loginctl enable-linger` 保活。
- [x] 判定：探针用户身份下 `systemctl --user is-active docker` 输出 `active`；`docker info` 的 `Root Dir` 落在该用户家目录内。
- [x] 判定：探针用户身份下 `docker ps` 只显示本次探针创建的容器（脚本先记录基线，结束时对比容器集合）。
- [x] 子 ID 段判定：容器内 `id` 显示 UID 为 0，宿主侧 `ls -n` 显示文件属主为映射后的高位 UID，且 `/proc/<pid>/uid_map` 行数为 65536。（行数一项按区间映射等价口径判定，见文首口径修正）
- [x] 套接字判定：把宿主 `/run/user/<uid>/docker.sock` 挂进容器后，容器内 `docker ps` 能看到守护进程管理的容器，`docker version` 的 client 与 server 版本号一致。
- [x] 网络判定：两个容器接入同一自定义网络后，容器 A 内 `getent hosts <容器B名>` 解析成功，且能连通容器 B 暴露的端口（用 bash `/dev/tcp` 或 `nc -z` 判定）。
- [x] 端口发布判定：宿主 `ss -ltn` 输出中不出现由探针容器新增的监听端口。
- [x] cgroup 委托判定：`systemctl --user show docker --property=Delegate` 输出 `Delegate=yes`（必要时在单元中显式设置 `Delegate=yes` 后重启守护进程），且容器进程的 cgroup 路径位于该用户 cgroup 之下。
- [x] `04-cleanup.sh` 执行后：探针用户不存在、`/etc/subuid` 与 `/etc/subgid` 中无该用户条目、探针用户级 systemd 单元已禁用并删除、探针网络已删除。
- [x] 实测记录写入 `platform/probe/rootless/RESULTS.md`：逐条给出上述每项判据的**实际命令与关键输出片段**，并标注通过 / 不通过；不通过项给出调整方案。
- [x] 前置条件写入 `platform/probe/rootless/README.md`：本机内核版本、发行版、systemd 版本、Docker 版本、`uidmap` / `fuse-overlayfs` / `slirp4netns` 是否已安装，以及缺失时的安装命令。

## 依赖
- 无。本任务阻塞 [[tasks/sandbox-platform/02-base-image.md|02 平台基础镜像]] 与 [[tasks/sandbox-platform/04-lifecycle-core-cli.md|04 生命周期核心模块与 CLI]]，必须最先完成。
