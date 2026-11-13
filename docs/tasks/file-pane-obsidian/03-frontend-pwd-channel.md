---
prd: prds/file-pane-obsidian.md
status: done
---
# 任务：前端 pwd 通道（OSC 解析与按会话缓存）

> 需求见 [[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
> **依赖 01 的实测结论**（注入写法 / 降级表现 / 重连恢复方案）与 **02 的镜像注入**（真沙箱要能收到上报才能端到端复验；**实现层面与 02 可并行**）。

## 目标

在前端把 OSC 1337 的 `CurrentDir` 序列接成一条**可靠的 pwd 通道**，供文件窗格定位与回跳使用。

- **解析**：用 xterm.js 的 `term.parser.registerOscHandler(1337, cb)` 接管，**不手写字节流扫描器**——xterm 的状态机负责跨帧序列边界；
- **纯函数化**：解析逻辑收敛为 `src/lib` 下的**独立纯函数模块**并配**单元测试**（解析 `1337;CurrentDir=<path>`、校验绝对路径、过一遍既有 `normalizeContainerPath`）；
- **不引入新的解码口径**：终端帧处理**不得**引入逐帧 `TextDecoder`（既有 TODO「终端中文间歇乱码」点名的正是这一片区域）；
- **生命周期**：pwd 是**纯前端产物**——按会话在前端内存缓存，**后端会话记录不加字段**；断线重连后触发一次**提示符刷新**（空行或 resize，方案按 01 轮实测结论）恢复 pwd。

## 涉及文件

- `apps/web/frontend/src/components/TerminalView.tsx` — 注册 OSC 处理器、把解析结果送进会话级缓存
- `apps/web/frontend/src/lib/`（新增）— pwd 解析纯函数模块 + 单元测试
- 前端会话状态层 — 按会话 id 缓存 pwd（内存），**不落后端、不入 localStorage**
- `docs/prds/file-pane-obsidian.md` — 复核「方案」节措辞

## 完成标准

- [x] OSC 1337 由 **`term.parser.registerOscHandler(1337, cb)`** 接管，代码里**没有手写字节流扫描器**（跨帧序列边界交给 xterm 状态机）（对应 PRD 验收项 **PWD-03**）。
- [x] pwd 解析收敛为 `src/lib` 下的**独立纯函数模块**，**单元测试齐备**且逐条钉死：解析 `1337;CurrentDir=<path>`、**拒绝非绝对路径**、过一遍既有 `normalizeContainerPath`（对应 PRD 验收项 **PWD-04**）。
- [x] 终端帧处理**未引入逐帧 `TextDecoder`**，既有解码路径**零改动**（对应 PRD 验收项 **PWD-03**）。
- [x] pwd **按会话**在前端内存缓存；**后端会话记录零改动**（无新增字段、无新增接口）（对应 PRD 验收项 **PWD-05**）。
- [x] **断线重连后**触发一次提示符刷新（空行或 resize，方案按 01 轮实测结论）**能恢复 pwd**，且刷新动作**不产生多余的可见输出**。
- [x] 真沙箱里 `bash -i` 会话能收到上报并**解析出正确路径**；`dash` / `sh` 会话**无上报**且前端**不报错**（静默保持无 pwd 状态）。

## 依赖

- 依赖 [[tasks/file-pane-obsidian/01-prototype-osc-loop.md|01 打样轮]]（实测结论——**硬前置**）；与 [[tasks/file-pane-obsidian/02-image-ps1-injection.md|02 镜像注入]] **可并行**（03 的实现只等 01 的结论，端到端复验要等 02 的镜像就绪）。
- 需求：[[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。

## 进展（2026-11-13 前端 pwd 通道收口）

> **本轮全部完成标准通过。** 产出四块：① `src/lib/terminal-pwd.ts` 纯函数模块（解析 + 会话级内存缓存）+ 单元测试；② `TerminalView.tsx` 的 OSC 1337 接线；③ 断线重连的**「cols+1 → 还原」两步 resize** 提示符刷新；④ xterm 集成测试（jsdom）+ 组件层接线测试。
> **只动前端**（`apps/web/frontend/`）+ 本任务文件：**`base-image/` / `apps/core/` / `apps/web/backend/` 零改动**（02 轮镜像侧与核心包侧的未提交改动属另一任务，本轮不碰、不提交）。**不引入新依赖**（xterm 是既有依赖 `@xterm/xterm@5.5.0`）。

### 一、模块 API 形态（`apps/web/frontend/src/lib/terminal-pwd.ts`，新增）

**纯函数区（解析口径）**：

| 导出 | 形态 | 说明 |
|---|---|---|
| `OSC_CURRENT_DIR_IDENT` | `const number` = `1337` | OSC 标识符（注册 xterm 处理器用） |
| `CURRENT_DIR_KEY` | `const string` = `'CurrentDir='` | 载荷键名 |
| `parseCurrentDirPayload(payload)` | `(string) => string \| null` | 解析载荷 → 容器内绝对路径；**不合法返回 `null`（不抛异常）** |

**会话级内存缓存区（pwd 存取）**：

| 导出 | 形态 | 说明 |
|---|---|---|
| `setSessionPwd(sessionId, path)` | `(string, string) => void` | 记下某会话的工作目录；非法路径直接忽略；**后到的覆盖先到的** |
| `getSessionPwd(sessionId)` | `(string) => string \| null` | 取某会话的工作目录；**`null` = 该会话未上报**（回跳按钮禁用口径的信号） |
| `clearSessionPwd(sessionId)` | `(string) => void` | 清掉某会话的工作目录（**会话真的结束**时调用：`exit` 帧 / 确认关闭会话；审查修复轮补上生产调用点，见下节） |
| `subscribeSessionPwd(sessionId, listener)` | `(string, () => void) => () => void` | 订阅某会话的 pwd 变化（04 轮窗格消费用），返回退订函数 |

**缓存口径**：模块级 `Map`（**只在内存里**）——**后端会话记录零改动**、**不入 localStorage** ⇒ 页面刷新即失（PRD「pwd 是纯前端产物」）。

**解析口径（逐条钉死，单测逐条覆盖）**：

1. 载荷的**前导**空白按**协议噪声**去掉（**尾部空白不动**——路径里可能真的有尾部空格，与 `normalizeContainerPath` 的「条目名保真」同口径；审查修复轮改，见下节）；
2. 剥掉可选的 `1337;` 前缀——**xterm 实测已经把标识符吃掉了**（回调收到的是 `CurrentDir=/workspace`），两种形态都收；
3. 必须以 `CurrentDir=` 开头——别的键、别的标识符（`1338;…`）一律不认；
4. 路径值剥掉**前导**空白与首尾**成对**的引号（01 轮实测：bash 展开提示符时**不剥**引号，`CurrentDir="$(pwd)"` 的载荷就是带引号的）；
5. **必须是绝对路径**（相对路径、`..` 段一律不认）；
6. 过一遍既有 `normalizeContainerPath`（`src/lib/file-transfer.ts`）——归一 + 拒 NUL + 拒 `.` / `..` 段。

### 二、接线位置（`apps/web/frontend/src/components/TerminalView.tsx`）

| 位置（文件:行） | 内容 |
|---|---|
| `TerminalView.tsx:28-32` | 引入 `OSC_CURRENT_DIR_IDENT` / `parseCurrentDirPayload` / `setSessionPwd` |
| `TerminalView.tsx:126` | `attachedOnceRef`：**握过几次手**的标记（重连 / 重新附着的判定依据；用 ref，effect 重跑不丢） |
| `TerminalView.tsx:168-190` | **`term.parser.registerOscHandler(1337, cb)`**——唯一接 OSC 的地方；回调调纯函数，成功则 `setSessionPwd(sessionId, path)`；不认识的载荷**静默忽略**（返回 `false`，不报错） |
| `TerminalView.tsx:340-345` | `sendResize(cols = term.cols, rows = term.rows)`：既有 resize 逻辑**融入**（加了可选参数，既有调用点不变） |
| `TerminalView.tsx:348-367` | `refreshPwdByResize()`：**「cols+1 → 还原」两步刷新**（依据 01 轮实测；基准 = `hello` 帧带的**会话真实尺寸**，审查修复轮改） |
| `TerminalView.tsx:519-535` | `hello` 帧处理：判定 `reattaching`（首次握手 vs 重新附着）⇒ 重新附着时走 `refreshPwdByResize(frame.cols, frame.rows)` |
| `TerminalView.tsx:637` | 清理时 `oscDisposable.dispose()` |

**为什么接在 `hello` 帧**：服务端 `_serve_session` 的顺序是 **先 `hello` → 再回放缓冲 → 再接实时流**（`apps/web/backend/src/sandbox_console/routes/terminal.py:146-175`）——回放里可能带着**断线前**的旧 OSC，而 resize 的新提示符走**实时流**，**必然晚于**回放 ⇒ 刷新拿到的 pwd 一定是新鲜的，不会被旧值盖回去。

### 三、断线重连的 pwd 刷新实现

**选定方案 = 01 轮实测的 resize 两步法**（「同尺寸 resize 不出字节」⇒ 必须让尺寸**真变化**）：

```
重新附着（第二次握手）⇒ sendResize(hello.cols+1, hello.rows) ⇒ sendResize(hello.cols, hello.rows)
```

- **通道是现成的**：前端 resize 帧 → 后端 `session.resize()` → `PtyProcess.resize()` → TIOCSWINSZ → SIGWINCH → 容器内 readline 重绘提示符并重新带一条 OSC 1337（**不新造通路**）；
- **零副作用**：不往 shell 的 stdin 写任何字节 ⇒ 不会误提交用户断线前敲了一半的命令，也不会被前台程序吞掉（**「发空行」方案被否**，01 轮实测的副作用清单）；
- **净效果**：尺寸回到原值（两步的基准是**会话真实尺寸**）、提示符被**重画了两次**（01 轮实测：bump 与还原各触发一次重画 + 各带一条 OSC）⇒ 重新拿到当前 pwd，**不产生多余的可见输出**（没有往终端里写任何字符）；
- **基准**：取 `hello` 帧带的 `cols` / `rows`（**会话真实尺寸**），不是前端视宽 `term.cols`——标签不可见 / 重建终端时两者可能不等，拿视宽当基准等于「刷 pwd」顺带改了 pty 尺寸（审查修复轮改，见下节）；
- **边界**：① 顶到后端列数上限（1000）时往下挪一格，同样能「真变化」；② 前台还跑着命令时 shell 不会立刻画提示符 ⇒ 拿不到即时 OSC，但**命令一结束 bash 画下一个提示符时本来就会带上 OSC**（01 轮口径）；
- **重试路径同样覆盖**：`retryToken` 变化 ⇒ 同一组件实例里 effect 重跑 ⇒ `attachedOnceRef` 仍是 `true` ⇒ 同样判定为「重新附着」。

### 四、测试清单与结果

| 测试文件 | 环境 | 用例数 | 覆盖 |
|---|---|---|---|
| `src/lib/terminal-pwd.test.ts` | node | **23** | 真实字节序列（01 轮 `xxd` 实测的 29 个字节，转成 JS 常量）、非 1337 前缀、键名不对、相对路径、空串、**前导**空白与**尾部空白保真**、成对引号容错、NUL / `.` / `..` 段、多余斜杠归一、**多次触发取最新值**、**同值不通知**、**退订不误删后来者**、会话级读写与清理、订阅 / 退订 |
| `src/lib/terminal-pwd-xterm.test.ts` | **jsdom** | **5** | 真 `new Terminal()` + `registerOscHandler` + `term.write()`：**01 轮真沙箱捕获的整段字节流**（4 条 OSC ⇒ 回调收到 4 条 `CurrentDir=…`、缓存取最新值 `/tmp`）、**序列拆成两次 write（回调只在补齐后触发一次）**、无 OSC 的 `dash`/`sh` 会话（不上报 / 不报错）、别的 OSC 标识符不误触发、非法路径不落缓存（终端实例由 `afterEach` 统一 dispose） |
| `src/components/TerminalView.test.tsx` | **jsdom** | **5** | 组件层接线：字节流里的 OSC ⇒ **按会话记进 pwd 缓存**；**重新附着（第二次握手）⇒ 整条 resize 序列 `[80, 81, 80]`**（两步法，基准取 hello 帧尺寸）；首次握手**整条序列 `[80, 80]`**（不多发 ±1 帧）；**`exit` 帧后缓存清空**；**组件卸载（切标签）不清缓存** |
| `src/components/TerminalPanel.test.tsx` | **jsdom** | **38**（+1） | 面板侧新增：**确认关闭会话 ⇒ 这条会话的 pwd 缓存一并清空** |

**全量结果**（`npx vitest run`，**含审查修复轮**）：

```
 Test Files  44 passed (44)
      Tests  699 passed (699)
   Duration  6.11s
```

（基线 665 → 收口轮 **693** → **审查修复轮 699**：收口轮净增 28 条 = 20 + 5 + 3；审查修复轮净增 **6** 条 = 3（pwd 单测）+ 2（组件测试）+ 1（面板测试）。）

**类型检查**：`npx tsc --noEmit` **零错**；`npx tsc --noEmit -p tests/tsconfig.json` **零错**；`npx vite build` 通过。

**已知噪声**：jsdom 下 xterm 探测 canvas 会打一条 `HTMLCanvasElement.prototype.getContext not implemented` 的 stderr（01 轮同样有），**不影响断言与退出码**。

### 五、红线与越界检查

- **PWD-03 红线**：代码里**没有手写字节流扫描器**（跨帧边界交给 xterm 状态机，拆帧用例已钉死）；**全仓 `apps/web/frontend/src/` 内 `TextDecoder` 命中数 = 0**（既有解码路径零改动，`term.write(new Uint8Array(...))` 原样保留）；
- **PWD-05 口径**：pwd 只进前端内存（模块级 `Map`）——**后端会话记录零改动**（`apps/web/backend/` 与 `apps/core/` 本轮**一行未改**）；**不入 localStorage**；
- **越界**：`base-image/`、`apps/core/`、`apps/web/backend/` **全部未碰**（工作区里那几处改动是 02 轮的未提交内容，本轮不碰、不提交）；**未 `git commit`**；
- **PRD 复核**：方案二节的措辞（「bash 转义与引号按实现校准——最终写法由 01 打样轮实测定稿，02 轮按其落地」）**已经把最终写法交给 01/02 轮**，本轮复核后**无需改 PRD**（PRD 不在本轮改动范围内）。

### 六、端到端复验的现状与待办

- **镜像侧已就绪**（02 轮）：`0.3.1` 镜像真沙箱实测 `bash -i` 上报的 OSC 字节与 01 轮捕获**逐字节同形**（`1b 5d 31 33 33 37 3b … 07`），`sh` 命中数 **0** 且输出无污染 ⇒ 本轮前端解析函数**就是对着这串真实字节**写单测与集成测试的；
- **前端侧已就绪**（本轮）：真实字节 → `parseCurrentDirPayload` → 容器内绝对路径 → 按会话缓存，全链路有单测 + 集成测试 + 组件测试三层覆盖；
- **待办（不属本轮）**：浏览器端的**真沙箱端到端**（新镜像 + 真实会话 + 窗格定位 / 回跳按钮）要等**存量沙箱重建到 `0.3.1`**（02 轮已登记：存量沙箱不会自动拿到新镜像）与 **04 轮的文件窗格**落地后才能点；本轮**不含**任何界面（回跳按钮 / tooltip 属 04 轮）。

### 七、落盘清单

| 文件 | 变更 |
|---|---|
| `apps/web/frontend/src/lib/terminal-pwd.ts` | **新增**：OSC 1337 解析纯函数 + 会话级内存缓存 |
| `apps/web/frontend/src/lib/terminal-pwd.test.ts` | **新增**：纯函数与缓存的单测（20 条） |
| `apps/web/frontend/src/lib/terminal-pwd-xterm.test.ts` | **新增**：xterm 集成测试（jsdom，5 条，含拆帧用例） |
| `apps/web/frontend/src/components/TerminalView.test.tsx` | **新增**：组件层接线测试（jsdom，3 条，含重连两步 resize） |
| `apps/web/frontend/src/components/TerminalView.tsx` | 注册 OSC 1337 处理器 + 按会话缓存 pwd；重连/重新附着时的「cols+1 → 还原」两步 resize 刷新 |
| `docs/tasks/file-pane-obsidian/03-frontend-pwd-channel.md` | **新增「进展（2026-11-13 前端 pwd 通道收口）」节**；完成标准六条 **全部勾选**；frontmatter `status` 改 `done` |

**主干上无其它落盘**（`base-image/` / `apps/core/` / `apps/web/backend/` 未碰；**未 `git commit`**）。

> 收口后的**审查修复轮**（2026-11-13）另有落盘，见本节末尾的「审查修复（2026-11-13）」小节。

### 审查修复（2026-11-13）

> 收口后的代码审查给出若干 **Warning / Suggestion**，**全部拍板采纳**，本小节逐条记录修了什么（其中「路径尾部空白保真」与「退订函数误删后来者订阅」两条是**真实缺陷**）。
> **改动范围**：只在 `apps/web/frontend/`（前端）+ 本任务文件；**`base-image/` / `apps/core/` / `apps/web/backend/` 依旧零改动**（工作区里那几处是 02 轮的未提交内容，不碰、不提交）；**不引入新依赖**；**未 `git commit`**。

#### 一、路径尾部空白保真（真实缺陷）

- **问题**：`parseCurrentDirPayload` 里的 `payload.trim()` 与 `body.slice(...).trim()` 会把路径**尾部**的空格吃掉——与既有 `normalizeContainerPath` 的「**条目名保真**」策略相悖（`/work space ` 与 `/work space` 是两个东西）。
- **改法**：解析只剥**前导**空白（协议噪声），**尾部交给 `normalizeContainerPath` 判定**；引号剥离改成「剥引号本身、收尾引号之后的空白照留」；新增 `stripLeadingWhitespace` 纯函数。
- **用例**：`CurrentDir=/work space ` ⇒ `/work space `；`CurrentDir="/work space "` ⇒ `/work space `；`CurrentDir="/workspace" ` ⇒ `/workspace `。

#### 二、退订函数不误删后来者订阅（真实缺陷）

- **问题**：`subscribeSessionPwd` 的退订函数在 `listeners.size === 0` 时**无校验**直接 `listenersBySession.delete(sessionId)`——序列「subscribe(A) → 退订(A) → subscribe(B) → 旧退订函数再跑一次」会把 **B 一起删掉**（B 的订阅凭空失效）。
- **改法**：删表项前先校验 `listenersBySession.get(sessionId) === listeners`（同一份集合才删）。
- **用例**：新增回归用例（后来者的订阅在旧退订函数重复调用后仍能收到通知）。

#### 三、`clearSessionPwd` 接上生产调用点（建议）

- **问题**：`clearSessionPwd` **没有任何生产调用** ⇒ pwd 缓存**只增不减**（会话没了，旧目录还占着前端内存）。
- **改法**：在**会话真正结束**处调用（**不是组件卸载**——切标签会卸载终端视图但会话还活着）：
  - `TerminalView.tsx` 的 **`exit` 帧分支**（容器内进程退出）；
  - `TerminalPanel.tsx` 的 **`confirmClose`**（后端关掉这条会话，删成功即清）。
- **用例**：组件层新增「`exit` 帧后缓存清空」+「组件卸载（切标签）**不**清缓存」两条；面板层新增「确认关闭会话 ⇒ 缓存一并清空」一条。

#### 四、resize 两步法的基准修正 + 口径改正（建议 · 含口径修正）

- **问题**：bump / 还原当前取 `term.cols`（**前端视宽**）——标签不可见或重建终端时它可能 **≠ pty 真实宽度**，等于「刷 pwd」顺带把 pty 尺寸改了。
- **改法**：基准改为 **`hello` 帧携带的 `frame.cols` / `frame.rows`**（**会话真实尺寸**，字段名以 `src/lib/terminal.ts` 的 `parseTerminalFrame` 为准）：`sendResize(cols+1, rows)` ⇒ `sendResize(cols, rows)`；「把前端视宽同步给 pty」的 `safeFit()` **挪到刷新之后**（否则「还原」会把前端视宽又抹回去）。
- **口径改正**：01 轮实测是「**两次重绘**」——bump 与还原**各**触发一次提示符重画、**各**带一条 OSC 1337（**不是一次**）；代码注释与本文档的「净效果」表述同步改正。
- **用例**：重新附着用例改成**整条序列**断言 `[80, 81, 80]`（建立连接同步 80 → bump 81 → 还原 80）；首次握手改成整条断言 `[80, 80]`（不多发 ±1 帧）。

#### 五、`attachedOnceRef` 复位加固（建议）

- **问题**：「握过几次手」的判定原先隐含依赖调用方用 `key={activeId}` **强制重挂载**——将来换一种渲染方式（同一实例里切 `sessionId`）时，新会话的**首次**握手会被误判成「重新附着」，白跑一次两步 resize。
- **改法**：新增 `lastSessionIdRef`，在 **effect 内**按「上一个 sessionId」复位 `attachedOnceRef`（会话变了 ⇒ 复位；同一会话重试连接 ⇒ 不复位，仍算重新附着）。

#### 六、值不变不通知（建议）

- **问题**：`setSessionPwd` 每次上报都通知——shell **每画一次提示符就报一次 pwd**，会让 04 轮的文件窗格**每条命令刷一次目录**，与 PRD「**无自动跟随**」（shell 里 `cd` 时窗格绝不联动）的口径相悖。
- **改法**：`setSessionPwd` 先比旧值，归一后**新值 ≠ 旧值**才通知（同值只更新缓存）。
- **用例**：新增「同一个值重复上报：不通知；值变了才通知」。

#### 七、测试断言加固（建议）

- `TerminalView.test.tsx`：首握手用例改**整条精确序列**断言（`[80, 80]`），重连用例断言**整条序列**（`[80, 81, 80]`，不再只看末两帧）；
- `terminal-pwd.test.ts`：抛错监听器用例**用完退订**（不留残余订阅给后面的用例）；
- `terminal-pwd-xterm.test.ts`：终端实例改由 **`afterEach` 统一 dispose**（用例里不再各写一遍）。

#### 八、审查修复轮的门禁

```
 Test Files  44 passed (44)
      Tests  699 passed (699)      ← 基线 693 → 699（本轮净增 6 条）
```

- `npx tsc --noEmit` **零错**；`npx tsc --noEmit -p tests/tsconfig.json` **零错**；`npx vite build` **通过**；
- **不引入新依赖**（xterm 仍是既有依赖 `@xterm/xterm@5.5.0`）；**未 `git commit`**；
- 已知噪声不变：jsdom 下 xterm 探测 canvas 的 `getContext not implemented` stderr（不影响断言与退出码）。

#### 九、审查修复轮的落盘清单

| 文件 | 变更 |
|---|---|
| `apps/web/frontend/src/lib/terminal-pwd.ts` | 解析只剥前导空白（尾部保真）+ 引号剥离保留尾部空白；`setSessionPwd` 同值不通知；退订函数删表项前校验集合身份；`clearSessionPwd` 补上调用点说明 |
| `apps/web/frontend/src/lib/terminal-pwd.test.ts` | 尾部空白保真用例 + 同值不通知用例 + 退订不误删后来者用例；抛错监听器用例改为用完退订（20 → **23** 条） |
| `apps/web/frontend/src/lib/terminal-pwd-xterm.test.ts` | 终端实例改 `afterEach` 统一 dispose（5 条不变） |
| `apps/web/frontend/src/components/TerminalView.tsx` | `exit` 帧清 pwd 缓存；resize 两步基准改为 `hello` 帧尺寸 + `safeFit` 顺序调整；`attachedOnceRef` 按 sessionId 复位；注释口径改正（两次重绘） |
| `apps/web/frontend/src/components/TerminalView.test.tsx` | 整条 resize 序列断言 + `exit` 帧清缓存 + 卸载不清缓存（3 → **5** 条） |
| `apps/web/frontend/src/components/TerminalPanel.tsx` | `confirmClose` 里清掉这条会话的 pwd 缓存 |
| `apps/web/frontend/src/components/TerminalPanel.test.tsx` | 新增「确认关闭会话 ⇒ pwd 缓存一并清空」（37 → **38** 条） |
| `docs/tasks/file-pane-obsidian/03-frontend-pwd-channel.md` | 进展节追加本小节；同步改正「两次重绘」口径与测试数字 |
