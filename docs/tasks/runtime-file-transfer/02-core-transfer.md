---
prd: prds/runtime-file-transfer.md
status: done
---
# 任务：核心包传输能力（`transfer.py`）

> 需求见 [[prds/runtime-file-transfer.md|运行期文件传输 PRD]]。**依赖 01 的机制验证结论**。
>
> **本任务的实现口径已按 01 轮实测修正**（2026-11-09）：路径 argv 直传、探测分层设计、`stat -c %s` 首选大小、错误分类按 stderr 关键词子串、目标为目录前置拒绝、临时名同目录。逐条依据见 [[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018]] 第 7 节。

## 目标

在核心包新增与 `forwarding.py` **平级**的 `transfer.py`，把运行期文件传输的**能力本体**落下来：路径校验、上传（临时名 + `mv` 覆盖）、探测、下载字节泵、目录列表。**零新增第三方依赖**——`spawn_stream` + `BytePump` 直接复用转发轮已生产验证的资产（**stderr 排空、短写循环、进程组回收**三个坑照抄）。

服务端（03）只是薄壳，转译层在服务端；命令行与创建时注入通道**零改动**。

## 涉及文件

- 新增 `apps/core/src/sandbox_platform/transfer.py` — 传输能力本体
- 改 `apps/core/src/sandbox_platform/__init__.py` — 导出新入口
- 新增 `apps/core/tests/test_transfer.py` — 单测
- `apps/core/src/sandbox_platform/forwarding.py` — **只读复用**（若需极小调整须单列说明，不得改变转发轮已验证的语义）

## 能力口径

### 路径校验

- 容器内路径必须**绝对路径**；
- **词法校验**（不解析符号链接、不跟随）；
- **无黑名单、全部允许**（用户拍板口径）：不设路径黑名单，容器内权限由容器自身的用户与文件系统决定；
- 校验失败抛 `TransferError`（携带**固定中文文案**）。

### 上传（upload）

- 字节流写入容器内**临时名** → `mv` **原子替换**目标；
- **临时名必须与目标同目录**：跨设备 `mv` 走 copy + unlink，**非原子、中途失败留半截文件**；
- **路径一律 argv 直传**（`docker exec … cat -- <path>`），**禁止**拼进 `sh -c` 脚本文本；`sh -c` 只用于固定脚本，路径经 `"$1"` 位置参数传入。**清理临时名的 `rm` 同样 argv 直传**；
- **目标已存在 = 覆盖**（用户拍板）；
- **目标为「已存在目录」前置拒绝**：探测阶段发现目标是目录即报错（实测 `mv` 对目录目标 rc=0 假成功）；**不依赖 `mv -T`**（busybox 不支持）；
- **目标文件自身只读（`0444`）不报错**：父目录可写时被静默覆盖（实测 root 与非 root 同）；
- 失败 → **平台侧显式清理临时文件**（不留残骸）：实测 exec 被杀时容器内会留下半截临时文件，`cat` 不会自清理；
- **不主动创建父目录**：缺失即报错引导；
- 返回写入的**字节数**。

### 探测（probe）

- **分层判定**（实测 GNU 与 busybox 均可区分）：`-d` 目录 → **拒**；`-f` 普通文件 → **放行**；`-p` / `-c` / `-b` / `-S`（FIFO / 字符设备 / 块设备 / 套接字）→ **拒**；`-e`（以上都不成立）→ **特殊文件，拒**；兜底 → 不存在。**PRD 草案的 `test -d` / `test -f` / `else missing` 口径达不到目的**（FIFO / 设备 / socket 与「不存在」同落 `missing`）；
- **特殊文件一律拒是硬要求**：FIFO 会**挂死 `cat`**（GNU 与 busybox 都挂），`/dev/null` 会静默返回 0 字节的空下载；
- **大小首选 `stat -c %s`**（O(1)），`wc -c < file` 为备选（要读完整个文件）；`ls -ln` 解析**不采用**（GNU 与 busybox 列宽不同）；
- **只允许普通文件**供下载；目录与**管道 / 设备 / 套接字**一律拒（**类型检查，不是路径限制**）。

### 错误分类

- **只按 stderr 关键词子串**分类，**不按整句、不按退出码**（dash 与 busybox ash 的措辞与退出码都不同：父目录缺失 dash rc=2 / busybox rc=1）：
  - 父目录缺失 → `nonexistent` / `Directory nonexistent`（大小写不敏感）；
  - 权限不足 → `Permission denied`；
  - 只读挂载 → `Read-only file system`；
  - 目录 → `Is a directory`；
  - 不存在 → `No such file or directory`；
- **报错文本里的临时名要换成用户的目标路径**再拼文案（shell 报错指向的是临时名）；
- **stderr 原文只进日志**，不进错误文案。

### 下载（download）

- `cat` 流出字节；复用字节泵（短写循环 + stderr 排空 + 进程组回收）；
- **客户端断开 → 关泵 + 清临时文件**；
- 内存**有界**（不整文件进内存）。

### 列表（list）

- 返回条目：**名称 / 内部类型 / 大小 / 修改时间**；
- **隐藏文件（`.` 开头）包含在内**；
- 底层命令用 **`find <dir> -maxdepth 1 -mindepth 1 -exec sh -c '…' sh {} +` 单次 exec 产出 NUL 结尾的记录**（**4 个字段、3 个 TAB**，解析用 `split("\t", 3)` **只按前 3 个 TAB 切**——余下的全归文件名，文件名里的 TAB 保真）；**禁用** `find -printf`（busybox 不支持）、`find -print0` + `read -d` 循环（dash / busybox ash 都无 `read -d`）、`ls -l` / `ls -A` 列解析（换行名被劈开、列宽不通用）；
- **兼容不同镜像**（busybox / GNU）：实测两者输出格式**完全一致**，解析侧只需一套代码；**正确处理换行 / 空格 / 中文 / 引号 / 反斜杠等名字**（不走「按空白切列」的写法）。

## 完成标准

- [x] 新增 `apps/core/src/sandbox_platform/transfer.py`，与 `forwarding.py` **平级**；核心包**零新增第三方依赖**（依赖树与轮前一致）。
- [x] `spawn_stream` + `BytePump` **直接复用**转发轮资产；`forwarding.py` 未被改动，或改动仅限**新增不破坏既有语义**且有说明。
- [x] 路径校验：绝对路径、词法校验、**无黑名单**；非法路径抛 `TransferError` 且文案固定中文。
- [x] **路径 argv 直传**（含换行 / 引号 / `-` 开头的路径不拆碎）；**不拼进 `sh -c`**；`rm` 清理命令同样 argv 直传。
- [x] 上传：临时名（**与目标同目录**）→ `mv` 覆盖；**同名即覆盖**；**目标为已存在目录 → 前置拒绝**；**目标文件自身 `0444` 不报错**；失败清临时文件；**不创建父目录**；返回字节数。
- [x] 探测：**分层判定**，目录 / 普通文件 / **FIFO·设备·套接字·其他特殊文件**可区分；**特殊文件一律拒**；字节数取 **`stat -c %s`**（`wc -c` 兜底）。
- [x] 错误分类**只按 stderr 关键词子串**（不按整句、不按退出码）；三类失败（父目录缺失 / 父目录不可写 / 只读挂载）各有固定中文文案；**临时名已换成用户目标路径**。
- [x] 下载：字节流式流出、**内存有界**；**客户端断开 → 关泵 + 清临时文件**（不留挂死进程、不留残骸）。
- [x] 列表：名称 / 类型 / 大小 / 修改时间；**隐藏文件包含**；**`find` 单次 exec 产出 NUL 分隔记录**；busybox 与 GNU 两种镜像下都正确；**含换行 / 空格 / 中文的名字**不乱。
- [x] `TransferError` 与**固定中文文案常量**集中在核心包；容器内 **stderr 原文只进日志**，不进错误文案。
- [x] `__init__.py` 导出新入口；核心包单测覆盖上述各条。
- [x] 门禁：核心包 **pytest 全绿**、**ruff（`E4/E7/E9/F`）退出码 0**。
- [x] **命令行零改动**；**创建时注入通道零改动**。

> **逐条核销与证据见文末「进展（2026-11-09）」**。其中三条的口径在实现中被收窄或加严（探测取大小统一用 `stat -L`、下载侧不产生临时文件、两个新分类码暂未进包导出），已在核销表内逐条说明。

## 依赖

- 依赖 [[tasks/runtime-file-transfer/01-prototype-and-mechanism.md|01 打样与机制验证]]（**硬前置**：命令形态、错误归类、降级口径均来自 01 轮结论）。
- 复用依据：[[architecture/decisions/0014-端口转发机制选型.md|0014 端口转发机制选型]]、[[tasks/phase3-desktop/04-port-forward-core.md|三期任务 04]]（字节泵的三个坑）。
- 机制与口径依据：[[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018 运行期文件传输机制选型]]（第 7 节「实测修正的设计口径」）。

## 进展（2026-11-09）

> **本轮状态：done。** 核心包传输能力已落地，并经**一轮审查修复**后合入（审查结论「需修复后合入」，**7 项必修全部完成**）。以下数字与结论均以本轮门禁输出与代码实况为准。

### 关键数字

| 项 | 数值 |
|---|---|
| 核心包单测（**非 root** 运行） | **362 passed**（轮前基线 292 → 本轮 **+70**；其中 `test_transfer.py` **93 项**） |
| 核心包单测（**root** 运行） | **23 passed**（耗时 **11m38s**） |
| ruff（`E4/E7/E9/F`） | **退出码 0** |
| 服务端基线 | **287 passed**——本轮**未动**服务端代码，基线保持 |
| 本轮测试规模 | `test_transfer.py`：**61 个测试函数 → 93 项**（审查轮从 61 补强到 93） |
| 审查轮次 | **1 轮**（结论「需修复后合入」→ 修复 → 复验通过） |
| 本轮改动面 | `transfer.py`（新增）/ `errors.py`（docstring）/ `__init__.py`（导出）/ `test_transfer.py`（新增）——**`forwarding.py` 零改动**、CLI 与创建时注入通道零改动 |

### 完成标准逐条核销

| # | 完成标准 | 结论 | 证据 |
|---|---|---|---|
| 1 | `transfer.py` 与 `forwarding.py` **平级**；核心包**零新增第三方依赖** | ✅ | 新增 `apps/core/src/sandbox_platform/transfer.py`；核心包依赖树与轮前一致（本轮未新增任何第三方依赖） |
| 2 | `spawn_stream` + `BytePump` **直接复用**转发轮资产；`forwarding.py` 未改动 | ✅ | `transfer.py` 直接 `from .forwarding import BytePump`、经 `daemon.spawn_stream` 起 exec；**`forwarding.py` 本轮零改动**（保持「转发轮已验证语义不动」标准） |
| 3 | 路径校验：绝对路径 / 词法校验 / **无黑名单**；非法路径抛 `TransferError` 且文案固定中文 | ✅ | `test_relative_path_is_rejected` / `test_empty_path_is_rejected` / `test_path_with_nul_is_rejected` / `test_path_validation_accepts_absolute_paths` / `test_invalid_path_never_reaches_the_container` |
| 4 | **路径 argv 直传**；**不拼进 `sh -c`**；`rm` 清理同样 argv 直传 | ✅ | `test_probe_passes_path_as_positional_argument` / `test_upload_passes_paths_as_argv_not_shell_text`；三个脚本结构被钉死（`test_probe_script_structure_is_pinned` / `test_upload_script_structure_is_pinned` / `test_list_script_structure_is_pinned`）——路径只经 `"$1"` / `"$2"` 位置参数传入 |
| 5 | 上传：同目录临时名 → `mv` 覆盖；同名即覆盖；目录目标前置拒绝；`0444` 不报错；失败清临时文件；不建父目录；返回字节数 | ✅ | `test_upload_writes_bytes_and_counts_them` / `test_upload_overwrites_an_existing_file` / `test_upload_rejects_a_directory_target` / `test_upload_rejects_a_missing_parent_directory` / `test_upload_never_creates_the_parent_directory` / `test_upload_failure_cleans_the_temp_file` / `test_upload_temp_name_sits_in_the_target_directory` / `test_upload_temp_name_uses_a_long_random_segment` / `test_upload_temp_name_collision_is_classified_and_not_removed`。**`0444` 口径**：模块**不读目标权限、不做任何基于权限的拒绝** ⇒ 覆盖语义天然成立（01 轮真机已实测 `mv` 静默覆盖成功） |
| 6 | 探测：**分层判定**；特殊文件一律拒；字节数取 `stat`（`wc -c` 兜底） | ✅（口径统一） | `test_probe_distinguishes_the_four_branches` / `test_probe_maps_every_layer_to_a_distinct_kind` / `test_probe_script_keeps_the_special_file_branches` / `test_probe_rejects_unparsable_output`。实现取 **`stat -L -c %s`**（**跟随**符号链接，与同一段脚本里的 `test` 系列跟随口径对齐）——ADR §3 字面写的是 `stat -c %s`，见下方「口径说明」 |
| 7 | 错误分类**只按 stderr 关键词子串**；三类失败各有固定中文文案；临时名换成用户目标路径 | ✅（并**新增两类**） | `test_error_classification_only_uses_stderr_keywords` / `test_error_classification_is_case_insensitive` / `test_unknown_stderr_falls_back_to_a_fixed_message` / `test_upload_error_message_uses_the_target_path_not_the_temp_name` / `test_docker_daemon_failures_are_not_misread_as_directory_errors`。**新增**「守护进程不可达」与「临时名已存在」两类，见下方审查轮第 5 / 6 项 |
| 8 | 下载：字节流式流出、**内存有界**；客户端断开 → 关泵 + 清临时文件 | ✅（口径收窄） | `test_download_starts_a_cat_pump` / `test_download_rejects_a_directory` / `test_download_rejects_special_files` / `test_download_rejects_a_symlink_that_does_not_resolve` / `test_download_failure_waits_for_the_stderr_drain` / `test_download_status_gives_up_when_the_process_never_exits`。**下载侧不产生容器内临时文件**（`cat` 直出），故「清临时文件」一条**只对上传成立**；断开时的关泵与进程组回收由 `DownloadStream.close()` 负责 |
| 9 | 列表：名称 / 类型 / 大小 / 修改时间；隐藏文件包含；`find` 单次 exec NUL 分隔；两种镜像正确；怪名字不乱 | ✅ | `test_list_keeps_awkward_names` / `test_list_marks_special_entries` / `test_list_uses_a_single_find_exec` / `test_list_empty_directory_is_an_empty_list` / `test_list_skips_malformed_records` / `test_list_rejects_a_path_that_is_not_a_directory`；busybox / GNU 输出格式一致沿用 01 轮实测（脚本结构被钉死） |
| 10 | `TransferError` 与固定中文文案常量集中在核心包；stderr 原文只进日志 | ✅ | `test_transfer_error_lives_in_errors_module`（`TransferError` 住在 `errors.py`，`reason` 属性承载分类码）；文案常量 `MSG_*` 集中在 `transfer.py`；`test_unknown_stderr_falls_back_to_a_fixed_message` 断言文案**不含** stderr 原文 |
| 11 | `__init__.py` 导出新入口；单测覆盖上述各条 | ✅（**两处例外**） | `test_package_exports_the_transfer_entry_points`。**例外**：新增的 `REASON_DAEMON_UNREACHABLE` / `REASON_TEMP_NAME_EXISTS` **暂未进包导出**（住在 `sandbox_platform.transfer` 模块内）——03 轮从 `sandbox_platform.transfer` 取，或届时顺带补 `__init__.py` 导出 |
| 12 | 门禁：核心包 **pytest 全绿**、**ruff 退出码 0** | ✅ | 非 root **362 passed** / root **23 passed**（11m38s）/ **ruff rc=0** |
| 13 | **命令行零改动**；**创建时注入通道零改动** | ✅ | 本轮改动仅限核心包四个文件（见上表「本轮改动面」）；CLI 与创建时注入通道未触碰 |

### 审查一轮：7 项必修全部完成（合计 9 处修复）

审查结论是「**需修复后合入**」。7 项必修逐条如下（第 4、5 项各含 2 处修复，合计 **9 处**）：

| # | 必修项 | 修了什么 | 落点与用例 |
|---|---|---|---|
| 1 | **stderr 排空竞态** | stdout 的 EOF 与 stderr 排空线程收尾**几乎同时发生**——立刻取尾部会拿到**空串**，失败被降级成通用文案，`not_found` / `readonly` 等**分类码丢失**（服务端据此映射 HTTP 状态码，丢了就映射错）。改为取尾部前**短等**排空线程（默认 0.5 s、10 ms 一轮），且**只在「排空线程还活着且尾部还是空」时等** | `transfer.py::_stderr_tail_with_drain`；`test_download_failure_waits_for_the_stderr_drain` |
| 2 | **看门狗跨线程竞态** | 看门狗线程 `pump.close()` 关掉 stdout，主线程阻塞在 `pump.read()` 上会撞 `ValueError: read of closed file`——**裸异常漏出**（不是 `TransferError` 形态）。改为读的那一步**单独包住** `OSError` / `ValueError`：看门狗已置位即收口成「命令执行超时」，未置位也收口成传输失败——本方法**只抛 `TransferError`** | `transfer.py::_exec_capture`；`test_exec_timeout_is_reported_by_the_watchdog` / `test_exec_timeout_survives_the_watchdog_close_race` |
| 3 | **`errors.py` docstring 纠偏** | `TransferError` 的 docstring 原把「分类码 ⇄ 文案」写成一一对应——实际**同一个分类码可能对应两条场景文案**（上传侧与下载侧的「目标是目录」措辞不同），调用方**不能反推**。改为写死「**只按分类码映射状态码，文案按场景取**」 | `apps/core/src/sandbox_platform/errors.py`；`test_transfer_error_lives_in_errors_module` |
| 4 | **临时名防写穿**（**2 处**） | ① 容器内上传脚本加 **`set -C`**（noclobber，重定向走 **O_EXCL**）：临时名被**预先放个符号链接**时**写不进去**，而不是顺着链接**写穿**到链接目标——**真机实测验证**（dash 与 busybox ash 都挡住；不加 noclobber 时实测会写穿，链接指向的文件被写脏）；② 临时名随机段从 **8 位加长到 16 位十六进制**（64 bit，碰撞概率 1/2³² → 1/2⁶⁴），与 `set -C` 构成**双保险** | `transfer.py::UPLOAD_SCRIPT` / `_temp_name`；`test_upload_temp_name_uses_a_long_random_segment` / `test_upload_temp_name_collision_is_classified_and_not_removed` / `test_upload_script_structure_is_pinned` |
| 5 | **宿主守护进程侧 stderr 新分类**（**2 处**） | docker 客户端连不上守护进程时报的 `permission denied while trying to connect to the Docker daemon socket` 里**也带 `permission denied`**——按容器内关键词归类会把**宿主侧故障误报成「目标目录不可写」**（分类码与文案全错，还把用户的排查方向带偏）。① 新增分类码 `REASON_DAEMON_UNREACHABLE` + 固定中文文案「守护进程无法连接 Docker，容器内命令未执行」；② 宿主侧关键词**排在容器内关键词之前**（`cannot connect to the docker daemon` / `docker daemon socket` / `is the docker daemon running` / `error during connect`） | `transfer.py::_ERROR_KEYWORDS`；`test_docker_daemon_failures_are_not_misread_as_directory_errors` |
| 6 | **撞名新分类** | `set -C` 撞名（临时名已存在）原先落进通用失败路径——**看不出是「临时名被占用」**。新增分类码 `REASON_TEMP_NAME_EXISTS` + 固定中文文案「目标目录里的临时文件名已被占用，请重试」；撞名时**不清理**那个路径（**不是平台建的**，没有资格替用户删） | `transfer.py::_ERROR_KEYWORDS` / `upload`；`test_upload_temp_name_collision_is_classified_and_not_removed` |
| 7 | **测试补强 61 → 93** | 补齐竞态、撞名、守护进程误分类、脚本结构钉死、怪名字、路径透传等路径 | `apps/core/tests/test_transfer.py` |

### 5 条未做的 Suggestion（显式记录）

| # | Suggestion | 本轮 | 理由 / 现状 |
|---|---|---|---|
| 1 | **短写循环下沉 `BytePump`** | **不做** | 下沉就要改 `forwarding.py`——本轮保持「**`forwarding.py` 零改动**」标准（转发轮已验证的语义不动）。短写循环留在 `transfer.py` 侧（`test_upload_loops_over_short_writes`） |
| 2 | **`BytePump.returncode` 属性** | **不做** | 同上：加属性要改 `forwarding.py`。当前退出码经 `pump.process.wait()` 取 |
| 3 | **`__init__.py` 导出重排** | **不做** | 已写进代码 docstring 待办。导出顺序不影响功能，不与「导出新入口」混做，避免无谓 diff |
| 4 | **`chmod --reference` 保留属主** | **不做** | 已写进 `transfer.py::upload` docstring 待办：**busybox 无 `--reference`**，跨镜像不可用。当前上传**不保留原目标的属主 / 权限**（`mv` 换的是文件本身，权限随临时名走） |
| 5 | **探测长度与实际流长一致性核对** | **不做** | 已写进 `transfer.py::download` docstring 待办：探测到的字节数**只是提示、不是契约**（文件在探测与 `cat` 之间被改写就会不一致）；严格一致得在流里核对长度，本轮不做 |

### 偏离与理由

1. **撞名不重试**——`set -C` 撞名走**既有错误路径**、**不重试**：字节流是**流式**的（内存有界、不整文件进内存），已写出去的字节**无法重放**，重试就得整份缓冲，与「大文件不占内存」的硬前提冲突；同时**也不删**那个路径（不是平台建的）。
2. **`list()` 多一次探测 exec**——`find <普通文件> -maxdepth 1 -mindepth 1` **静默返回空**（rc=0、无输出），调用方会把「列了一个文件」误读成「目录是空的」⇒ `list()` 先做一次「目标必须是目录」的**前置探测 exec**。**ADR 0018 §4 的「单次 exec」现义为「单次 `find` exec」**，已在 ADR 记修订。
3. **两个新分类码暂未进 `__init__.py` 导出**——`REASON_DAEMON_UNREACHABLE` / `REASON_TEMP_NAME_EXISTS` 住在 `sandbox_platform.transfer` 模块内，**未进包导出**；03 轮从 `sandbox_platform.transfer` 取，或届时顺带补 `__init__.py` 导出（已写进 [[tasks/runtime-file-transfer/03-server-file-endpoints.md|任务 03]]）。
4. **口径说明（非行为偏离）**：探测取大小统一用 **`stat -L -c %s`**（跟随符号链接）——ADR §3 字面写 `stat -c %s`（不跟随），但同节 §7 第 9 条要求「跟随」。本轮取**跟随**：`test` 系列本来就跟随，`stat` 不带 `-L` 会取到**链接自身**的大小与时间戳；模块 docstring 已写明取舍（保留 O(1) 属性的前提下的口径统一）。

### 文档漂移（本轮补）

| # | 漂移 | 位置 | 本轮处置 |
|---|---|---|---|
| ① | 错误分类表**缺两类**——「守护进程不可达」「临时名已存在」 | [[architecture/decisions/0018-运行期文件传输机制选型.md\|ADR 0018]] 第 8 节 | 已在 ADR 补两行（含触发条件 / 关键词 / 文案口径）+ **关键词匹配顺序即优先级**的说明 + 修订行 |
| ② | 「解析只按**前 2 个 TAB** 切」与实现不符——实测格式是 **4 字段 3 个 TAB**，实现 `split("\t", 3)`，**文件名里的 TAB 保真** | ADR 0018 第 4 节 | 已在 ADR 勘误 + 修订行；本任务文件「能力口径」里的同一句一并更正 |

### 留给 03 轮

- 从 `sandbox_platform.transfer` 取 `REASON_DAEMON_UNREACHABLE` / `REASON_TEMP_NAME_EXISTS`（或届时补 `__init__.py` 导出），并按 ADR 第 8 节的「建议错误码」映射 HTTP 状态码。
- 落地 Traefik `sandbox-api-service` 的 `transport.respondingTimeouts.readTimeout` 调整（ADR 第 6 节的部署侧硬要求）。

