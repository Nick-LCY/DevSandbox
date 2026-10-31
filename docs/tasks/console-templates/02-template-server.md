---
prd: prds/console-templates.md
status: done
---
# 任务：模板服务端

> 实测结论：全部完成标准通过。新增 `platform/src/sandbox_platform/server/templates.py`（模板库读写、内置种子与墓碑）与 `platform/src/sandbox_platform/server/routes/templates.py`（四条路由），`schemas.py` 补模板模型与 `~` 展开，`deps.py` 补 `get_template_store`，`app.py` 的 lifespan 准备模板目录并注入种子（失败只记日志不阻断启动）。
>
> 接口：`GET /api/templates`（裸数组，带完整配置体）、`POST /api/templates`（201，名称零限制）、`POST /api/templates/{id}/rename`（只改名称，不存在 404）、`DELETE /api/templates/{id}`（不存在 404；删内置模板写墓碑）。
>
> 落盘：模板库在 `<平台数据根>/templates/`，一个模板一个 JSON 文件，写入走「写临时文件 → 改权限 0600 → 原子替换」；枚举只扫顶层 `*.json`（内置状态子目录 `.builtin` 天然不参与）。模板标识由服务端生成（`tpl_` + 12 位十六进制），与名称解耦，重命名不动标识。
>
> 字段口径：落盘用 `model_dump(exclude_unset=True)`——「字段缺失」与「字段填了空值」不混同（模板应用语义是「出现字段整体替换、缺失字段保持现状」）。内置种子常量本期为空（只落地机制），同标识已存在不覆盖，墓碑落 `templates/.builtin/state.json`，删了不复活；列表读取时也补一次注入。
>
> `~` 展开：只展开挂载声明的宿主路径段（`~` 与 `~/` 前缀 → 服务运行用户的家目录），`~other` 不展开，容器路径 / 环境变量 / 命令 / 工作目录一律不展开。
>
> 验收：后端 pytest **344 项全绿**（基线 306 项，新增 38 项：模板 33 项 + `~` 展开 5 项）；ruff 基线 55 → 57（新增 6 处与既有路由同源的 `B008` / `I001`，同时修掉 `schemas.py` 4 处 F 级既有告警），ruff 经典默认规则集（E4/E7/E9/F）全绿。
>
> 零改动：核心包（`server/` 目录之外）与命令行 `platform/cli/` 一行未改。
>
> 口径出入（待复核）：本任务完成标准原文写「名称零限制（只拒绝空名）」，PRD 也写「只做空串拒绝」；本轮按执行指令实现为「空串也收」（不 strip、不限长、不校验字符集）。两者有出入，已在下方「实施要点 · 模板名」处标注。

## 目标
在控制台服务层落地「启动模板」的服务端能力：模板库落盘到平台数据根的 `templates/` 目录，提供列表、创建、重命名、删除四条接口；沙箱创建请求里的挂载宿主路径支持 `~` 展开；内置模板提供种子注入机制（本期种子列表为空，机制先跑通）。核心包与命令行零改动。

## 完成标准
- [x] 新建 `platform/src/sandbox_platform/server/templates.py`：模板库读写，每模板一个 JSON 文件，写入采用原子替换、文件权限 0600。
- [x] 模板记录结构为 `TemplateRecord`，含 `id`、`name`、`config`、`created_at`、`updated_at` 五个字段。
- [x] 内置模板种子列表以常量形式定义在服务端，本期该常量内容为空（只落地机制，不预置真实模板内容）。
- [x] 墓碑文件落 `templates/.builtin/state.json`，记录已被删除的内置模板标识；内置模板被删除后不再重新注入。
- [x] 用户模板枚举只扫 `templates/` 顶层的 `*.json`，不递归子目录。
- [x] `schemas.py` 新增 `TemplateConfig`（镜像、挂载、命令、工作目录、环境变量、网络六项全部选填），模型开启 `extra="forbid"`。
- [x] `schemas.py` 新增模板的请求与响应模型；落盘时用 `model_dump(exclude_unset=True)`，保留「字段是否出现过」的信息。
- [x] `schemas.py` 新增 `~` 展开函数并接入 `CreateSandboxRequest.to_core_request()`：只展开挂载声明里的宿主路径，`~` 与 `~/` 前缀展开为服务运行用户的家目录，`~other` 不展开；容器路径、环境变量值、命令一律不展开。
- [x] `deps.py` 新增 `get_template_store` 依赖。
- [x] `app.py` 的 lifespan 准备模板目录并注入内置种子；注入失败只记日志，不阻断服务启动。
- [x] 新建 `platform/src/sandbox_platform/server/routes/templates.py` 并注册路由，四条接口行为如下。
  - `GET /api/templates`：返回模板裸数组（不包在对象里）。
  - `POST /api/templates`：创建模板，状态码 201，名称零限制（不 strip、不限长、不校验字符集，空串也收——与完成标准原文「只拒绝空名」有出入，见文首说明）。
  - `POST /api/templates/{id}/rename`：只改名称，不改模板标识与其余字段。
  - `DELETE /api/templates/{id}`：删除模板；删的是内置模板时写墓碑。
- [x] 新建 `platform/tests/test_server_templates.py`，并在 `platform/tests/test_server_api.py` 补 `~` 展开用例。
- [x] `platform/src/sandbox_platform/API.md` 新增第 13 节，写清四条接口的入参、出参与错误口径。
- [x] 后端 pytest 全绿（344 项）。
- [x] 控制面核心包（`platform/src/sandbox_platform/server/` 目录之外）与命令行 `platform/cli/` 零改动。
- [x] 分层契约测试红线不触发：新增服务端源码不得出现带空格的 git、小写独立 docker、`print(`、`subprocess`、`sudo`、`os.system`、`os.popen`。

## 依赖
- 无前置任务依赖，可与 [[tasks/console-templates/01-base-image-0.3.0.md|01 基础镜像 0.3.0]] 并行开工。
- 服务层骨架、依赖注入与错误映射约定见 [[tasks/phase2-console/01-service-core-api.md|二期任务 01]]；接口文档体例见 `platform/src/sandbox_platform/API.md`。
- 需求来源见 [[prds/console-templates.md|控制台模板轮 PRD]] 的工作包二。

## 实施要点

### 模板库落盘
- 每个模板一个 JSON 文件，写入走「写临时文件 + 原子替换」，避免进程中断留下半截文件；文件权限 0600，与平台其他元数据口径一致。
- 模板标识由服务端生成，与名称解耦，因此重命名不影响标识，前端也不必处理标识变化。
- 墓碑落在 `templates/.builtin/state.json`：内置模板被删除时记下标识，后续启动的种子注入跳过这些标识，实现「删了不复活」。墓碑目录是点开头的隐藏目录，不参与用户模板枚举。

### 字段出现与否是语义的一部分
- 模板应用语义是「出现字段整体替换、缺失字段保持现状」，因此落盘必须保留「这个字段用户填过没有」。`model_dump(exclude_unset=True)` 是实现这一点的关键，不能改成默认全量导出，否则「缺失」与「填了空值」无法区分。
- `TemplateConfig` 六项全选填并开 `extra="forbid"`：多传字段直接 400，不静默吞掉。

### `~` 展开
- 展开只发生在挂载声明的宿主路径上，`~` 展开为服务运行用户的家目录、`~/` 前缀同理，`~other` 形式不展开（原样交给核心包）。
- 容器路径、环境变量值、命令、工作目录一律不展开——展开会让用户难以预期命令与变量内容被改写。
- **边界口径**：服务以 root 身份运行时，`~` 展开为 `/root`，会命中核心包的宿主敏感目录拒绝清单并返回 400。这是既有契约的自然结果，不是缺陷，文档与接口说明里写明，避免后续被当成 bug 排查。

### 模板名
- 名称零限制：不做长度、字符集、保留字校验，也不 strip；**空串同样接受**（本轮按执行指令落地的口径：空串也收）。与本文件完成标准原文「只拒绝空名」及 PRD 的「只做空串拒绝」有出入，已在文首「实测结论」处标注待复核。

## 留档指引
- 四条接口的入参、出参与错误口径：`platform/src/sandbox_platform/API.md` 第 13 节。
- 服务层整体口径与既有接口对照同文件第 11 节。
- 需求与边界口径：[[prds/console-templates.md|控制台模板轮 PRD]]。
