---
prd: prds/phase2-console.md
status: done
---
# 任务：控制面服务骨架与沙箱管理接口

> 实测结论：全部完成标准通过。新增服务层子包 `platform/src/sandbox_platform/server/`（应用工厂、依赖注入、请求与响应模型、沙箱管理路由、错误映射、启动入口），核心包新增可选字段 `CreateRequest.image_source`（`auto` 默认 / `host` 强制宿主注入），命令行 `platform/cli/sandboxctl.py` 源码一行未改。测试：208 项 pytest 全通过（一期既有 158 项全绿，服务层 51 项）。
>
> 审查修复轮（2026-10-30）：reviewer 结论「需修复后合并」，已按清单修完 1 项严重 + 8 项中等 + 12 项采纳建议。最重的一条是**同名沙箱并发创建互相拆台**：核心包 `SandboxService` 加按名互斥（进程内锁字典）与原子占用名字（`<平台数据根>/locks/<名>.lock`，`O_EXCL` 落占位文件），创建 / 启动 / 停止 / 删除对同名串行化，占位文件创建失败回收、删除沙箱时释放。其余：命令引号不配对改 400、回收清单对不存在沙箱改 404、500 分支改固定文案（原文只进日志）、宿主无此镜像改 400、测试用临时目录夹具隔离真实数据根、分层契约检测补 `subprocess` / `os.system` / `os.popen` / `docker` / `sudo` 禁令、镜像注入中转文件改用镜像引用摘要命名。采纳建议含：请求模型 `extra="forbid"`、创建返回 201、镜像来源显式三分支、host 模式创建与启动两条判定路径分开、详情接口环境变量值脱敏、健康接口不回显平台数据根路径、接口文档默认关闭（`SANDBOX_CONSOLE_DOCS` 显式开启）。
>
> 关键实现约定：服务端与命令行共用同一 `SandboxService`，路由只做编排与转译，宿主交互一律经核心包（服务层源码不出现 `argparse`、`print(`，也不直接调 `command.run`）；错误映射固定为入参非法 400 / 不存在 404 / 已存在 409 / 其余平台异常 500，响应体统一 `{"detail": "中文消息"}`。
>
> 衔接点：终端会话表本体与遗留 exec 进程终止属二期任务 03，本任务只在 `server/sessions.py` 留了「目录准备 + 清理遗留记录」的钩子位；宿主镜像枚举与代理状态接口属二期任务 02；前端构建产物目录 `platform/console/dist` 属二期任务 04（目录不存在时跳过静态托管并记日志）。

## 目标
在一期控制面核心包之上加一层 FastAPI 服务：应用工厂、依赖注入、错误映射、沙箱管理路由。服务只做编排与转译，全部生命周期逻辑仍调用一期已落地的 `SandboxService`，行为与命令行等价；同时给核心包补一个「镜像强制从宿主注入」的入参开关，供网页创建使用（命令行不传该开关，行为零变化）。

## 完成标准
- [x] `platform/pyproject.toml` 增加服务依赖（`fastapi`、`uvicorn`），用 uv 管理：`uv add` 后 `uv lock` 同步，`uv sync` 可装齐；`uv run pytest` 全绿。
- [x] 新增服务层子包 `platform/src/sandbox_platform/server/`：`__init__.py`、`app.py`（应用工厂）、`deps.py`（依赖注入）、`schemas.py`（请求与响应模型）、`routes/__init__.py`、`routes/sandboxes.py`、`__main__.py`（启动入口）。
- [x] `app.py` 提供 `create_app()` 工厂：注册 `/api` 路由前缀、挂载 `platform/console/dist` 静态目录（目录不存在时跳过并记日志，不报错）、lifespan 内准备平台数据目录并清理上次遗留的终端会话。
- [x] 启动方式落地：`uv run python -m sandbox_platform.server` 可起服务，默认绑定 `127.0.0.1:8000`，监听地址与端口由 `SANDBOX_CONSOLE_HOST` / `SANDBOX_CONSOLE_PORT` 覆盖；随附 systemd 单元模板 `platform/server/sandbox-console.service`（不自动安装）。
- [x] 服务以宿主特权身份运行（root 或免密 sudo），与一期命令行权限要求一致；平台配置仍走 `PlatformConfig.from_env`。
- [x] 服务层源码沿用一期分层契约：不得出现 `argparse` 与 `print(`，一律用日志；把 `server/` 目录纳入现有分层契约测试的断言范围。
- [x] 沙箱路由与一期语义一一对应，且不重复实现任何生命周期逻辑：`POST /api/sandboxes` → `SandboxService.create`；`GET /api/sandboxes` → `list`（含停止态，字段：名字 / 状态 / 镜像 / 创建时间）；`GET /api/sandboxes/{name}` → `get`；`POST /api/sandboxes/{name}/start` → `start`；`POST /api/sandboxes/{name}/stop` → `stop`；`GET /api/sandboxes/{name}/reclaim` → `reclaim_plan`；`DELETE /api/sandboxes/{name}` → `delete`。
- [x] 错误映射固定：入参非法 → 400；沙箱不存在 → 404；沙箱已存在 → 409；其余平台异常 → 500；响应体统一 `{"detail": "中文消息"}`，消息取平台异常原文，不吞异常。
- [x] 核心包 `CreateRequest` 增加可选字段 `image_source`（取值 `auto` / `host`，默认 `auto`）：`auto` 完全保持一期行为；`host` 表示强制从宿主导出注入（宿主无此镜像直接报错，不经代理拉取）。`platform/cli/sandboxctl.py` 源码一行不改。
- [x] `host` 模式的注入路径复用 `ImageManager.inject_from_host`，在创建第 ⑤ 步准备镜像时执行；沙箱启动镜像不经镜像代理。
- [x] 单元测试 `platform/tests/test_server_api.py`：用 FastAPI `TestClient` 覆盖创建 / 列表 / 详情 / 停止 / 启动 / 回收清单 / 删除与错误映射（桩掉 `SandboxService`，不触碰宿主）；断言服务端不直接拼宿主命令（源码检索断言 `server/` 内不出现 `command.run` 的直接调用）。
- [x] 接口文档 `platform/src/sandbox_platform/API.md` 增补「二期 HTTP 接口」章节：路由表、请求与响应字段、错误码映射，并注明「命令行与服务端共用同一 `SandboxService`，行为等价」。
- [x] `platform/README.md` 增补「控制台服务启动方式」小节：安装依赖、启动命令、环境变量、只绑回环地址的提醒。

## 依赖
- 无。依赖一期已完成的控制面核心包与命令行（[[tasks/sandbox-platform/04-lifecycle-core-cli.md|04 生命周期核心模块与 CLI]]）。
- 02、03 两个任务以本任务的应用骨架与路由注册约定为准，建议等本任务定型后合并；其路由模块与单元测试可先行开工。
