---
prd: prds/phase2-console.md
status: done
---
# 任务：宿主镜像枚举与代理状态管理接口

> 实测结论：全部完成标准通过。新增 `ImageManager.list_host_images()` 与 `RegistryProxyManager` 的三项只读查询（缓存占用 / 证书就绪 / 容器状态）与 `restart()`；新增路由 `platform/src/sandbox_platform/server/routes/images.py` 与 `routes/proxy.py`（`GET /api/images`、`GET /api/proxy/status`、`POST /api/proxy/restart`）。接口文档 `platform/src/sandbox_platform/API.md` 增补两个接口的字段表与「代理不可达不降级」的口径说明。命令行 `platform/cli/sandboxctl.py` 源码一行未改。
>
> 审查修复轮（2026-10-30）：reviewer 结论「需修复后合并」，已按清单修完 2 项严重问题 + 6 项中等问题 + 9 项采纳建议。最重的一条是**状态 / 重启接口的 500 漏口**：宿主命令缺失、超时、证书不是 UTF-8、代理返回截断响应都会顶成 500。现在 `status()` 外层兜住异常并降级为「不健康 + 明细」，`_restart_locked` 整体兜住 `CommandError` 并写 `last_error`，重启接口稳定返回 200 + `restarted=false`。另一条是**CA 指纹口径自相矛盾 + 误报已修复**：口径收敛为「变更前后都读得到证书才算变了」，并新增 `ca_reinstalled` 字段——CA 变了但新 CA 读不到时如实说「未能重装合并证书链」，不把未修复报成已修复。其余：重启成功路径补挂载一致性校验（不一致则删除后按首次启动路径重建）、锁语义文档对齐（创建流程阻塞等待代理锁，重启结束后再判定可达性）、`docker restart` 超时跟 `restart(timeout)` 挂钩、失败分支消息追加 CA 状态、单个用户 CA 重装失败只记日志并回传 `failed_users`、接口文档标注重启端点是未认证特权端点、测试不再污染全局 `time.sleep`。
>
> 关键实现约定：宿主交互一律收敛在核心包（`images.py` / `proxy.py`），服务层只做编排与转译；缓存只增不减（不提供任何清理入口）；不做网页远程拉取镜像（创建页下拉只来自宿主本地镜像实时枚举）。

## 目标
补齐网页创建与设置页所需的两组宿主侧能力：一是实时枚举宿主 Docker 本地镜像（供创建页下拉选择，含任何用户本地构建的镜像）；二是镜像代理的状态查询与重启（容器运行与健康状态、缓存目录占用大小、证书就绪状态）。两组能力都落在核心包内（宿主交互一律收敛在 `images.py` / `proxy.py`），服务层只暴露路由。

## 完成标准
- [x] `ImageManager` 新增 `list_host_images() -> list[HostImage]`：经宿主 root 守护进程实时枚举本地镜像，每项含镜像引用（`repo:tag`）、镜像 ID、体积（字节）、创建时间；悬空镜像（`<none>:<none>`）不进入可选列表；返回结果按镜像引用排序。
- [x] `RegistryProxyManager` 新增三项只读查询：`cache_size_bytes()`（缓存目录占用字节数）、`certificate_ready()`（代理 CA 证书存在且可读）、`container_status()`（容器是否存在 / 是否运行中）。
- [x] `RegistryProxyManager` 新增 `restart(timeout: int = 120) -> bool`：容器存在则重启，不存在则先拉起，随后轮询健康检查直到通过；失败返回 `False` 并给出原因，**不做降级直连**。
- [x] 重启代理后比对代理 CA 指纹：指纹与重启前不一致时，自动为已有沙箱用户重装合并 CA 束（复用 `install_ca_bundle`），并把「CA 已变更」这一事实回传给调用方。
- [x] 新增路由 `platform/src/sandbox_platform/server/routes/images.py` 与 `routes/proxy.py`：`GET /api/images`、`GET /api/proxy/status`、`POST /api/proxy/restart`；路由注册到 `app.py` 的 `/api` 前缀下。
- [x] `GET /api/proxy/status` 返回：容器运行状态、健康状态（端口可连 / 能取到证书 / 明细）、缓存目录占用大小、证书就绪状态、代理访问地址。
- [x] 不提供任何清理代理缓存的接口：只增不减现状维持，页面只展示占用大小。
- [x] 不提供网页拉取镜像的接口：创建沙箱时只从宿主本地镜像下拉选择，不做远程拉取。
- [x] 单元测试 `platform/tests/test_server_images_proxy.py`：桩掉命令执行层，覆盖镜像枚举字段与排序、悬空镜像过滤、代理状态四项字段、重启成功与失败两条路径、CA 指纹变化触发重装与未变化不重装两条分支。
- [x] 接口文档 `platform/src/sandbox_platform/API.md` 增补两个接口的字段表与「代理不可达不降级」的口径说明。

## 依赖
- 依赖 [[tasks/phase2-console/01-service-core-api.md|01 控制面服务骨架与沙箱管理接口]]（路由注册约定、依赖注入与错误映射沿用本任务）。
- 依赖一期已落地的 `ImageManager` 与 `RegistryProxyManager`（[[tasks/sandbox-platform/04-lifecycle-core-cli.md|04 生命周期核心模块与 CLI]]）。
