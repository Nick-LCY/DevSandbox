---
prd: prds/phase2-console.md
status: todo
---
# 任务：宿主镜像枚举与代理状态管理接口

## 目标
补齐网页创建与设置页所需的两组宿主侧能力：一是实时枚举宿主 Docker 本地镜像（供创建页下拉选择，含任何用户本地构建的镜像）；二是镜像代理的状态查询与重启（容器运行与健康状态、缓存目录占用大小、证书就绪状态）。两组能力都落在核心包内（宿主交互一律收敛在 `images.py` / `proxy.py`），服务层只暴露路由。

## 完成标准
- [ ] `ImageManager` 新增 `list_host_images() -> list[HostImage]`：经宿主 root 守护进程实时枚举本地镜像，每项含镜像引用（`repo:tag`）、镜像 ID、体积（字节）、创建时间；悬空镜像（`<none>:<none>`）不进入可选列表；返回结果按镜像引用排序。
- [ ] `RegistryProxyManager` 新增三项只读查询：`cache_size_bytes()`（缓存目录占用字节数）、`certificate_ready()`（代理 CA 证书存在且可读）、`container_status()`（容器是否存在 / 是否运行中）。
- [ ] `RegistryProxyManager` 新增 `restart(timeout: int = 120) -> bool`：容器存在则重启，不存在则先拉起，随后轮询健康检查直到通过；失败返回 `False` 并给出原因，**不做降级直连**。
- [ ] 重启代理后比对代理 CA 指纹：指纹与重启前不一致时，自动为已有沙箱用户重装合并 CA 束（复用 `install_ca_bundle`），并把「CA 已变更」这一事实回传给调用方。
- [ ] 新增路由 `platform/src/sandbox_platform/server/routes/images.py` 与 `routes/proxy.py`：`GET /api/images`、`GET /api/proxy/status`、`POST /api/proxy/restart`；路由注册到 `app.py` 的 `/api` 前缀下。
- [ ] `GET /api/proxy/status` 返回：容器运行状态、健康状态（端口可连 / 能取到证书 / 明细）、缓存目录占用大小、证书就绪状态、代理访问地址。
- [ ] 不提供任何清理代理缓存的接口：只增不减现状维持，页面只展示占用大小。
- [ ] 不提供网页拉取镜像的接口：创建沙箱时只从宿主本地镜像下拉选择，不做远程拉取。
- [ ] 单元测试 `platform/tests/test_server_images_proxy.py`：桩掉命令执行层，覆盖镜像枚举字段与排序、悬空镜像过滤、代理状态四项字段、重启成功与失败两条路径、CA 指纹变化触发重装与未变化不重装两条分支。
- [ ] 接口文档 `platform/src/sandbox_platform/API.md` 增补两个接口的字段表与「代理不可达不降级」的口径说明。

## 依赖
- 依赖 [[tasks/phase2-console/01-service-core-api.md|01 控制面服务骨架与沙箱管理接口]]（路由注册约定、依赖注入与错误映射沿用本任务）。
- 依赖一期已落地的 `ImageManager` 与 `RegistryProxyManager`（[[tasks/sandbox-platform/04-lifecycle-core-cli.md|04 生命周期核心模块与 CLI]]）。
