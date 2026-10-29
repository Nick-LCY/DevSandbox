---
prd: prds/sandbox-platform.md
status: todo
---
# 任务：平台基础镜像

## 目标
构建平台基础镜像 `sandbox-platform/base`：只含 docker 客户端、纯 bash 入口脚本与套接字默认路径约定，并随镜像分发常用依赖镜像的离线包与首次自动加载脚本。它是所有沙箱镜像的唯一底座。

## 完成标准
- [ ] `platform/base-image/Dockerfile` 可构建出 `sandbox-platform/base:<tag>`，构建过程在无外网条件下完成（构建命令显式带 `--network=none`，或所有下载步骤在有网阶段预置后用离线镜像验证）。
- [ ] 镜像内含 docker 客户端：`docker --version` 有版本输出，且客户端可与外部守护进程通信。
- [ ] 镜像内含纯 bash 入口脚本 `/entrypoint.sh`，脚本只依赖 bash 与 docker 两个命令，静态检查通过（无 python3 / node / curl / jq 调用）。
- [ ] 入口行为固定：`docker` 命令存在则 exec 交互式 bash；不存在则打印一行含「docker client missing」的错误并以退出码 127 退出。
- [ ] 镜像**不内置任何 volume 挂载点**：Dockerfile 无 `VOLUME` 指令，`docker image inspect` 的 `Volumes` 字段为空；镜像内不存在会话目录、代码目录等预置的宿主机挂载目标。
- [ ] 镜像内存在便捷空目录 `/workspace` 且对沙箱运行用户可写；它是容器层目录（非 volume），不落到宿主机，随容器删除而消失，README 中明确注明这一点。
- [ ] README 写明套接字默认路径约定：Docker 套接字固定挂到容器内 `/var/run/docker.sock`，docker 客户端默认可见，用户无需声明。
- [ ] 依赖镜像离线包随镜像分发：`/opt/deps/images/` 下存在 postgres、minio、logto 三个离线镜像包（tar 或等价离线格式），`docker load` 可离线导入成功。
- [ ] `load-deps.sh` 实现首次自动加载：逐个检查 `docker images` 是否已有对应镜像，缺失才 `docker load`；重复执行不重复加载（日志显示 skip），并输出加载前后的镜像列表。
- [ ] `platform/base-image/verify.sh` 断言基础镜像内**不存在** `node`、`pnpm`、`python3`、`psql`、`mc` 等业务运行时命令，且存在 `docker`、`bash`。
- [ ] `platform/base-image/README.md` 写明构建命令、镜像标签规则、套接字默认路径与 `/workspace` 临时目录的含义、依赖离线包的来源与更新方式。
- [ ] 实测数据记录在 `platform/base-image/RESULTS.md`：`docker image inspect` 输出的镜像体积（MB）、离线包总体积（MB）、首次加载耗时（秒）。

## 依赖
- 依赖 [[tasks/sandbox-platform/01-rootless-probe.md|01 免 root 打样验证]]（免 root 守护进程的可行性结论与脚本是本任务的前置）。
