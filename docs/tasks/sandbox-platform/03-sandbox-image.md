---
prd: prds/sandbox-platform.md
status: todo
---
# 任务：默认全栈沙箱镜像

## 目标
在平台基础镜像之上构建官方默认全栈沙箱镜像 `sandbox-platform/sandbox-default`，内含 pi、git、uv、nvm + node、pnpm 与 Playwright 浏览器，并打通依赖镜像离线包的首次自动加载流程；用户可在其上自由叠加自己的层。

## 完成标准
- [ ] `platform/sandbox-image/Dockerfile` 基于 `sandbox-platform/base` 构建，产物标签 `sandbox-platform/sandbox-default:<tag>`。
- [ ] 工具链齐备且可验证：`pi --version`、`git --version`、`uv --version`、`node --version`、`pnpm --version` 在容器内均输出版本号；node 与 pnpm 由 nvm 管理（容器内存在 nvm 目录，`nvm --version` 有输出）。
- [ ] Playwright 浏览器随镜像安装：容器内 `npx playwright --version` 有输出；**默认只安装 chromium**（镜像体积优先，firefox / webkit 不默认安装，README 写明需要时如何扩展安装）；chromium 位于 `PLAYWRIGHT_BROWSERS_PATH` 指向的浏览器目录下。
- [ ] 离线可运行判据：容器以 `--network=none` 启动后，Playwright 能拉起 chromium 并对 `data:text/html,<h1>ok</h1>` 截图成功，产物 PNG 落在容器可写目录。
- [ ] 依赖镜像首次自动加载：容器启动流程中自动检测并加载 `/opt/deps/images/` 下的离线包；首次启动日志出现加载记录，第二次启动日志显示跳过（幂等）。
- [ ] 加载后镜像核对：以沙箱守护进程身份执行 `docker images` 能看到 postgres、minio、logto 三个镜像，tag 与本任务约定一致。
- [ ] 凭证不落镜像：镜像内不存在 `.env` 文件或含密码字样的环境变量（用 `docker image inspect` 的 `Env` 字段 + 镜像内文件清单双重断言）。
- [ ] `platform/sandbox-image/README.md` 写明：构建命令、标签规则、如何在默认镜像上叠加用户自己的层、依赖离线包更新流程、镜像体积实测（给出具体 MB 数）。
- [ ] 实测记录 `platform/sandbox-image/RESULTS.md`：镜像总体积（MB）、chromium 浏览器体积（MB）、依赖离线包加载耗时（秒）、镜像冷启动到 bash 可用的耗时（秒）。

## 依赖
- 依赖 [[tasks/sandbox-platform/02-base-image.md|02 平台基础镜像]]（基础镜像与依赖离线包由该任务提供）。
