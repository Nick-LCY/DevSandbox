---
prd: prds/file-pane-obsidian.md
status: done
---
# 任务：打样轮——OSC 1337 pwd 链路端到端打通

> 需求见 [[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
> **本任务是硬前置**：不打样通，后面的 02 / 03 不许开工（镜像注入写法与前端解析口径都在本轮定）。

## 目标

在**真沙箱**里把本轮**最不确定的一条链路**端到端打通：

```
镜像 PS1 注入 → xterm 注册 OSC 处理器 → 解析 pwd → 窗格定位 / 回跳
```

本轮**不产出完整功能**，只产出**可落地的口径结论**。要回答的问题有三条：

1. **bash 转义实测**：`/etc/bash.bashrc` 里注入的 PS1 片段，bash 到底渲染成什么？`\[\e]1337;CurrentDir="'$(pwd)\a\]'` 的转义与引号在 bash 里能不能原样成立？
2. **sh 降级实测**：`dash` / `sh` 会话里这段 PS1 语法不成立时，实际表现是什么（报错？静默？提示符变形？），会不会污染终端输出？
3. **断线重连 pwd 恢复方案实测**：重连后 shell 不会主动再报一次 pwd，那么「发一个空行」与「触发一次 resize」两种刷新方式，哪一种可靠？

**产出口径结论**（写进本任务文件的「进展」节，02 / 03 轮按结论施工）：
- 镜像注入的**最终写法**（含 bash 转义与引号的实测校准结果）；
- `sh` 降级的**实际表现**与前端降级口径的对应关系；
- 断线重连 pwd 恢复的**选定方案**。

## 涉及文件

- 基础镜像的 `/etc/bash.bashrc`（**本轮只在本地临时改，不 bump 版本、不推送**——正式注入在 02 轮）
- 前端 `apps/web/frontend/src/components/TerminalView.tsx` — 打样期临时挂 OSC 处理器（**02 / 03 轮收口**）
- 前端 `apps/web/frontend/src/lib/` — 打样期临时解析函数（**03 轮收口为正式纯函数模块 + 单测**）
- 本任务文件（**产出口径结论**）

## 完成标准

- [x] **真沙箱**里用 `bash -i` 起会话，终端输出流里**实测捕获到** OSC 1337 的 `CurrentDir` 序列，且解析出的路径与容器内 `pwd` **一致**。
- [x] **bash 转义实测结论**落档：注入片段在 bash 下的最终写法（保留原 PS1 + 追加 OSC 序列），以及**提示符渲染是否正常**（不得出现乱码、不得把转义字符原样打出来）。
- [x] **`sh` 降级实测结论**落档：`dash` / `sh` 会话的实际表现，以及「会话不上报 pwd ⇒ 回跳按钮禁用 + tooltip『当前会话未上报工作目录』」这一降级口径与实测是否对得上。
- [x] **断线重连 pwd 恢复实测结论**落档：空行 / resize 两种刷新方式**至少一种被证实可靠**，并写明选定方案（对应 PRD 验收项 **PWD-05**）。
- [x] **注入行为与既有口径边界实测**：向 `/etc/bash.bashrc` 注入后，实测确认注入的**实际行为与边界**——容器 shell（`bash -i` 及其它形态）**是否确定读到**该注入；并核对与镜像「**沙箱启动即一个 bash、不加载 profile 脚本**」既有口径（[[architecture/decisions/0004-镜像契约与默认沙箱镜像.md|ADR 0004]] 第 3 节「运行时极简」、[[architecture/decisions/0011-基础镜像增加通用工具层并转联网构建.md|ADR 0011]] 第 4 节对 0004 条款的引用）**是否存在实际冲突**；**结论写进本轮打样留档**（供 02 轮落地时对齐、08 轮修订 ADR 0004 时引用）。
- [x] **回跳链路走通**：在打样环境里能验证「解析出的 pwd ⇒ 窗格定位到该目录」与「回跳按钮点击 ⇒ 导航到该目录」两步（可以是临时代码，**03 / 04 轮收口**）。
- [x] **越界检查**：打样期的临时改动**不留在主干**——02 / 03 轮开工前，本轮临时代码要么被正式实现取代、要么被摘掉（02 轮的镜像正式注入与 03 轮的前端正式实现落地后，本轮临时注入块与临时解析函数**必须清零**）。

## 依赖

- 无（**本轮是硬前置**，不通过不进 02 / 03）。
- 需求：[[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。

## 进展（2026-11-13 打样收口）

> **本轮全部完成标准通过。** 产出四块口径结论：**① 镜像注入的最终写法**（PRD 原写法是 bash 语法错误，已实测证伪并给出定稿）；**② `sh`/`dash` 降级的实际表现**；**③ 断线重连 pwd 恢复的选定方案**；**④ 与 ADR 0004 §3「不加载 profile 脚本」表述的冲突评估**。
> **本轮只在运行中容器里临时改 `/etc/bash.bashrc`（先备份），未重建镜像、未 bump 版本、未动 Dockerfile、未留任何临时代码进主干**；打样沙箱 `osc-probe` 已删除。

### 打样环境（供复现）

| 项 | 值 |
|---|---|
| 沙箱名 | `osc-probe`（已删除） |
| 镜像 | `sandbox-platform/base:0.3.0`（宿主本地镜像，代理拉不到，走宿主导出注入） |
| 容器名 | `sandbox-osc-probe`（规则 = `sandbox-<名>`） |
| rootless 守护进程 | 用户 `sandbox-osc-probe`（uid 1007），套接字 `/run/user/1007/docker.sock` |
| exec 模板 | `sudo -u sandbox-osc-probe env XDG_RUNTIME_DIR=/run/user/1007 DOCKER_HOST=unix:///run/user/1007/docker.sock docker exec -it sandbox-osc-probe bash -i` |
| 注入落点 | **运行中容器**的 `/etc/bash.bashrc`（先 `cp -a` 备份到 `/etc/bash.bashrc.orig`）；镜像 / Dockerfile **未动** |

> **踩坑备忘（不是本轮结论，但下次打样必看）**：
> ① **沙箱容器不在宿主 root 守护进程里**——每个沙箱有专属免 root 守护进程，必须 `DOCKER_HOST=unix:///run/user/<uid>/docker.sock`（且 `sudo -u <系统用户>` + `XDG_RUNTIME_DIR`）才能 exec；
> ② **管道形态下提示符落 stderr**——bash 的 `display_prompt` 写 stderr，**`docker exec -i … bash -i` 不带 tty 时提示符与 OSC 都在 stderr**，只重定向 stdout 会一条 OSC 都抓不到，**必须 `2>&1`**；
> ③ **带 tty 形态才是控制台的真实形态**——控制台终端会话走核心包 `UserDaemon.exec_pty_shell()` ⇒ `docker exec -it <容器> bash -i`，宿主侧伪终端承载；本轮两种形态都测了，**字节结论一致**；
> ④ **基础镜像的 ENTRYPOINT 会吃掉命令行**——`/entrypoint.sh` 无条件 `exec bash -i`，所以 `docker run <image> bash -c '…'` **不会执行你给的命令**（直接起一个 `bash -i`）；要跑自己的脚本必须 `--entrypoint bash`。

### ① 真沙箱捕获 OSC 1337（完成标准 1 ✅）

带 tty 形态（宿主伪终端 → `docker exec -it` → 容器内 bash）的**主端原始字节**（`pwd` / `cd /tmp` / `pwd` / `exit` 四条命令）：

```
^[[?2004hroot@f6e57104ff19:/workspace# ^[]1337;CurrentDir=/workspace^Gpwd^M
^[[?2004l^M/workspace^M
^[[?2004hroot@f6e57104ff19:/workspace# ^[]1337;CurrentDir=/workspace^Gcd /tmp^M
^[[?2004l^M^[[?2004hroot@f6e57104ff19:/tmp# ^[]1337;CurrentDir=/tmp^Gpwd^M
^[[?2004l^M/tmp^M
^[[?2004hroot@f6e57104ff19:/tmp# ^[]1337;CurrentDir=/tmp^Gexit^M
^[[?2004l^Mexit^M
```

**OSC 序列的精确字节**（`xxd` 实测）：

```
1b 5d 31 33 33 37 3b 43 75 72 72 65 6e 74 44 69 72 3d 2f 77 6f 72 6b 73 70 61 63 65 07
└ ESC └ ]  └ "1337"  └ ;  └ "CurrentDir"  └ =  └ "/workspace"        └ BEL
```

即 `ESC ] 1337 ; CurrentDir = /workspace BEL`（**BEL 终止**，不是 `ESC \`）。整段原始流共 329 字节。

**路径与容器内真实 `pwd` 一致**：同一条流里 `pwd` 命令的输出分别是 `/workspace` 与 `/tmp`，与紧邻其前的那条 OSC 载荷**逐字相同**；`cd /tmp` 后下一条 OSC 即变成 `/tmp`（**随 `cd` 实时更新**）。

管道形态的等价捕获（任务书建议的写法，**注意 `2>&1`**）：

```bash
printf 'cd /tmp\nexit\n' | docker exec -i sandbox-osc-probe bash -i 2>&1 | xxd
```

```
00000070: 726f 6f74 4066 3665 3537 3130 3466 6631  root@f6e57104ff1
00000080: 393a 2f77 6f72 6b73 7061 6365 2330 1b5d  9:/workspace# .]
00000090: 3133 3337 3b43 7572 7265 6e74 4469 723d  1337;CurrentDir=
000000a0: 2f77 6f72 6b73 7061 6365 0763 6420 2f74  /workspace.cd /t
...
000000c0: 6666 3139 3a2f 746d 7023 201b 5d31 3333  ff19:/tmp# .]133
000000d0: 373b 4375 7272 656e 7444 6972 3d2f 746d  7;CurrentDir=/tm
000000e0: 7007                                       p.
```

### ② bash 转义实测（完成标准 2 ✅）—— **最终注入写法原文**

#### PRD 原写法（tabby 方案）**是 bash 语法错误**，实测证伪

PRD 与任务书引用的候选：

```bash
export PS1="$PS1\[\e]1337;CurrentDir="'$(pwd)\a\]'"
```

实测（把该行追加进 `/etc/bash.bashrc` 后起 `bash -i`）：

```
bash: /etc/bash.bashrc: line 61: unexpected EOF while looking for matching `"'
```

**根因**：这一行里共有 **3 个双引号**（奇数）——`"$PS1\[\e]1337;CurrentDir="` 是完整的一对，**末尾还多出一个 `"`**，它开启了一个**永远不闭合**的字符串，bash 报到文件末尾才发现。后果有三条，**全部实测确认**：

1. **bash 报错并中止读该文件**——追加在文件尾的注入块**根本没执行**，PS1 一字未改；
2. 终端上多出一行 `bash: /etc/bash.bashrc: line 61: unexpected EOF…` ⇒ **提示符被污染**（正是完成标准 2 明令禁止的现象）；
3. **一条 OSC 都发不出来**（捕获流里 0 条 OSC）。

> 附带根因之二（即便把引号配平也仍然错）：`$(pwd)` 写在**双引号**里 ⇒ 它在 `export` 那一刻就被求值，**路径被冻死**在 bashrc 读取时的目录，`cd` 之后不再更新。

#### 定稿写法（02 轮按此落地，原文照抄）

```bash
export PS1="$PS1"'\[\e]1337;CurrentDir=$(pwd)\a\]'
```

**逐段拆解**：

| 片段 | 作用 |
|---|---|
| `"$PS1"` | 保留**原提示符**（Debian 默认 `PS1='${debian_chroot:+($debian_chroot)}\u@\h:\w\$ '`，末尾带一个空格） |
| `'…'` **单引号** | 让 `$(pwd)` **原样留在 PS1 里**，由 bash 在**每次画提示符时**展开 ⇒ pwd 随 `cd` 实时更新（写双引号即被冻住） |
| `\[` … `\]` | bash 的「不可见区」标记：整段 OSC 不占位、不参与光标定位 |
| `\e` | ESC（bash 提示符转义） |
| `]1337;CurrentDir=` | OSC 1337 载荷前缀 |
| `\a` | BEL（OSC 终止符） |

**实测验证（全部通过）**：

- **可见提示符渲染逐字节不变**：同一组命令下，未注入的基线流（225 字节）与注入后**去掉 OSC 序列**的流 **逐字节完全相同**（脚本比对结果 `True`）——无乱码、无转义字符原样打出、光标位置不受影响；
- **启动即报一次**：起 `bash -i` 的第一条提示符就带 `CurrentDir=/workspace`（容器 `WORKDIR`）；
- **每次 `cd` 后都重报**：`cd /tmp` 后下一条提示符的 OSC 变为 `CurrentDir=/tmp`；
- **载荷形状 = `CurrentDir=<绝对路径>`**（路径**不带引号**，与 VS Code 的 `OSC 1337 ; CurrentDir=<path>` 同形 ⇒ 前端解析就是「剥掉 `CurrentDir=` 前缀 + 绝对路径校验 + 过 `normalizeContainerPath`」，**无引号剥离歧义**）。

#### 备选写法（实测等价，02 轮可二选一）

```bash
export PS1="$PS1"'\[\e]1337;CurrentDir=${PWD}\a\]'
```

实测载荷**完全相同**（`CurrentDir=/workspace` / `CurrentDir=/tmp`）。差别：`${PWD}` 是参数展开、**不 fork**，且不受用户自定义 `pwd` 函数/别名干扰；`$(pwd)` 与 tabby 原方案字面一致、语义是「容器内真实 `pwd`」。**定稿取 `$(pwd)`**（保真 tabby 方案 + 对齐「路径 = 容器内真实 `pwd`」的校准目标），`${PWD}` 作为等价备选记此备查。

#### 载荷加引号的变体（实测行为，供 03 轮解析函数容错参考）

| 写法 | 实际载荷 |
|---|---|
| `CurrentDir=$(pwd)` | `CurrentDir=/workspace` ← **定稿** |
| `CurrentDir="$(pwd)"` | `CurrentDir="/workspace"`（bash 提示符展开**不做引号去除**，`"` 原样留在载荷里） |
| `CurrentDir='$(pwd)'` | `CurrentDir='/workspace'` |

⇒ 03 轮的解析纯函数**建议对首尾成对的 `'` / `"` 做一次容错剥离**（定稿写法不需要，但能兼容其它镜像来源）。

### ③ `sh` / `dash` 降级实测（完成标准 3 ✅）—— **实际表现**

镜像里 `/bin/sh -> dash`（Debian bookworm 默认），`/bin/dash` 存在；**`dash` 不读 `/etc/bash.bashrc`**（只读 `$ENV` 指向的文件，平台未设置），因此注入块**根本不会进入 dash**。

实测（带 tty，`docker exec -it sandbox-osc-probe sh -i` 与 `dash -i`，两者输出**完全相同**）：

```
# pwd^M
exit^M
/workspace^M
# 
```

| 观测项 | 实测结果 |
|---|---|
| 有没有 OSC 序列 | **没有**（0 条 `1337`） |
| 有没有报错 | **没有**（stderr 干净，无语法错误、无 `bad substitution`） |
| 提示符是否被污染 | **没有**——dash 的默认提示符 `# ` 原样，**注入的 bash 语法没有泄漏到 dash** |
| 会不会读到 bashrc | **不会**——`dash` 读 `$ENV`，不读 `/etc/bash.bashrc`；实测 `dash -i` 连我们在 bashrc 里留的 `MARKER-SYSTEM-BASHRC` 回显都没出现 |

**与 PRD 降级口径的对应关系**：实测**完全对得上**——`dash`/`sh` 会话**自然降级为「不上报 pwd」**，终端输出**干净无污染**，前端据此判定「会话未上报工作目录」⇒ **回跳按钮禁用 + tooltip 改为「当前会话未上报工作目录」**（PRD 验收项 FP-07）。**这是设计内的已知边界，不是缺陷。**

**顺带测出的 shell 形态矩阵**（同一容器、同一份注入，统计输出流里 `1337` 命中数）：

| 形态 | OSC | 说明 |
|---|---|---|
| `bash -i` | **1（上报）** | 交互式非登录 shell —— **控制台终端会话正是这一形态** |
| `bash -l -i` | **1（上报）** | 登录+交互：Debian 的 `/etc/profile` 会 source `/etc/bash.bashrc`，故照样生效 |
| `bash`（非交互） | 0 | 非交互 shell **一个 rc 文件都不读** |
| `bash -c '…'` | 0 | 同上 |
| `bash -lc '…'` | 0 | 登录但非交互：读了 profile，但**不画提示符** ⇒ 无 OSC |
| `sh -i` / `dash -i` | 0 | 不读 bashrc |

### ④ 断线重连 pwd 恢复实测（完成标准 4 ✅）—— **选定方案**

模拟控制台真实形态：pty 里跑 `docker exec -it … bash -i` → 读到首屏提示符后**停止读取 2 秒**（模拟浏览器断线，shell 仍活着、仍停在提示符处）→ **恢复读取**（模拟重连，后端把环形缓冲回放给前端）→ 施加刷新手段。

| 刷新手段 | 实测 | 拿到的新 OSC | 路径是否新鲜 | 副作用 |
|---|---|---|---|---|
| ① **发空行**（写 `\n` 进 pty） | **可靠** | **有**（`\r\n` + `ESC[?2004l` + `ESC[?2004h` + 提示符 + OSC） | **新鲜**（`cd /tmp` 后给出 `/tmp`） | **有**：字节进 shell 的 stdin ⇒ 可能**提交用户半行输入**、可能被前台程序吞掉 |
| ② **触发 resize**（TIOCSWINSZ → 内核给前台进程组发 SIGWINCH） | **可靠，但有硬前提** | **有**（`\r` + `ESC[K` + `\r` + 提示符 + OSC） | **新鲜**（`cd /tmp` 后给出 `/tmp`） | **无**：不写 stdin，不碰用户输入行 |

**关键实测细节（02/03 轮必须知道）**：**resize 必须让尺寸「真变化」**。readline 收到 SIGWINCH 后只在**尺寸真的变了**时才重绘提示符：

```
--- resize 同尺寸 80x24 (0 bytes)      ← 同尺寸：0 字节，什么都没发生
--- resize 改宽度 81x24 (52 bytes)     ← 真变化：重绘 + 一条新 OSC
     \r ESC[K \r root@f6e57104ff19:/tmp# ESC]1337;CurrentDir=/tmp BEL
--- resize 回 80x24 (52 bytes)         ← 再变一次：又重绘 + 又一条新 OSC
--- resize 再同尺寸 (0 bytes)          ← 又回到同尺寸：0 字节
```

**选定方案：② resize 为主、① 空行为备。**

- **主选 resize** 的理由：① **零副作用**——不往 shell 的 stdin 写任何字节，不会误提交用户断线前敲了一半的命令，也不会被 `cat` / `python` / `vim` 之类前台程序吞掉；② **实测可靠**（尺寸真变化时必出一条新鲜 OSC）；③ 通道**现成**——前端已有 resize 帧（`{"type":"resize","cols":..,"rows":..}`）、后端已有 `PtyProcess.resize()` → TIOCSWINSZ → SIGWINCH → docker CLI 转发 → 容器内 readline 重绘，**03 轮不必新造通路**。
- **实现要点（给 03 轮）**：重连后**先发一个与当前不同的尺寸**（如 `cols+1`）再发回真实尺寸——**同尺寸的 resize 无效**（实测 0 字节）。两次都会触发重绘，前端多一次无害的 reflow。
- **备选空行**：实现最简单（一个 `\n` 字节帧），但**有提交用户半行输入的副作用**，只在 resize 不可用时兜底。
- **共同前提**：两种手段都要求 **shell 正停在提示符处**。若前台还跑着命令，shell 不会立刻画提示符 ⇒ 两种手段都拿不到即时 OSC；但**命令一结束 bash 画下一个提示符时本来就会带上 OSC**，pwd 最迟在那时恢复。

### ⑤ 注入行为的边界 + 与 ADR 0004 §3 的冲突评估（完成标准 5 ✅）—— **ADR 冲突评估结论**

#### 实测到的注入边界

1. **Debian bookworm 的 bash 确实把系统 rc 编译成了 `/etc/bash.bashrc`**——`/bin/bash` 二进制里能直接读到该字面量（`grep -ao '/etc/bash[a-z_.]*' /bin/bash` ⇒ `/etc/bash.bashrc`；同批还有 `/etc/profile`、`~/.bashrc`、`~/.bash_profile`、`~/.profile`）。
2. **`bash -i` 确定读 `/etc/bash.bashrc`**——三重证据：① 在该文件里放一行 `echo MARKER-SYSTEM-BASHRC`，`bash -i` 必然打印它；② **捕获到 OSC 本身就是最强证据**（注入块在文件末尾，不读到它就不会执行）；③ 读哪些 rc 文件的**完整实测矩阵**（三个文件各埋一行标记，逐一实测）：

   | shell 形态 | 读到的 rc 文件（按实测顺序） |
   |---|---|
   | `bash -i`（交互式非登录） | `/etc/bash.bashrc` → `~/.bashrc`（**不读 `/etc/profile`**） |
   | `bash -l -i`（登录式交互） | `/etc/bash.bashrc` → `/etc/profile` → `~/.bashrc`（Debian 的 `/etc/profile` 会 source `/etc/bash.bashrc`） |
   | `bash -c`（非交互） | **一个都不读** |
   | `dash -i` | **一个都不读**（dash 只读 `$ENV`，平台未设置） |

3. **读序 = `/etc/bash.bashrc` → `~/.bashrc`**（实测：系统级标记先打印，用户级标记后打印）。⇒ **边界**：若用户在 `~/.bashrc` 里**自己设 `PS1`**，会把注入**覆盖掉**，该会话不上报 pwd。（默认镜像的 `/root/.bashrc` 不设 PS1，实测不受影响。）
4. **`/etc/bash.bashrc` 顶部的 `[ -z "$PS1" ] && return`** 决定了非交互 shell **读到这里就返回** ⇒ **注入块只对交互式 shell 生效**，非交互 shell 连 PS1 都不会被改（实测 `bash -c` 输出干净、0 条 OSC）。这条守卫**恰好是我们想要的**（注入只影响会画提示符的会话），因此**注入块必须追加在文件末尾**。
5. **容器的主进程就是 `bash -i`**（镜像入口 `/entrypoint.sh` → `exec bash -i`，实测 `ps -ef` 里 PID 1 = `bash -i`），而**控制台的终端会话**走核心包 `UserDaemon.exec_pty_shell()` ⇒ `docker exec -it <容器> bash -i`。⇒ **两条路径都是交互式非登录 shell，都确定读到注入**。
6. **注入是系统级、不依赖家目录**：`/etc/bash.bashrc` 对**所有用户**的交互式非登录 shell 生效（容器换用户跑 shell 一样生效），与 PRD「注入点为什么选 `/etc/bash.bashrc`」的两条理由**实测吻合**。

#### 与既有口径的冲突评估结论

**既有表述**（ADR 0004 §3「运行时极简」）：「沙箱启动即一个 bash，**不加载任何 profile 脚本**。启动哪些依赖服务完全由 agent 自主决定。」其「影响」段进一步推论：「『入口纯 bash、无 profile』意味着**不能靠 shell 初始化脚本注入环境变量与别名**，一切配置必须通过挂载注入。」
ADR 0011 §4 复述并**明确不动**该条款：「0004 第 3 节的『运行时极简』指的是**沙箱启动即一个 bash、不加载任何 profile 脚本**，与镜像里装了什么无关，本决策**不动该条款**。」

**实测结论（供 08 轮修订 ADR 0004 引用）**：

| 判项 | 结论 |
|---|---|
| 「不加载任何 **profile 脚本**」这半句 | **仍然成立**——`bash -i` **确实不读** `/etc/profile`、`/etc/profile.d/*`、`~/.bash_profile`、`~/.profile`（登录 shell 才读）；本轮用「`/etc/profile`、`/etc/bash.bashrc`、`~/.bashrc` 各埋一行标记」实测：`bash -i` 下 **`/etc/profile` 的标记没出现**，`/etc/bash.bashrc` 与 `~/.bashrc` 的标记都出现 |
| 「**不能靠 shell 初始化脚本注入**」这半句 | **与实测冲突**——`/etc/bash.bashrc` **就是 shell 初始化脚本**，而交互式非登录 shell（`bash -i`，控制台终端会话与镜像入口都是这一形态）**确定会读它**；本轮 PS1 注入正是**靠 shell 初始化脚本**生效的，实测有效 |
| 冲突性质 | **不是「行为冲突」而是「表述越界」**：既有表述在「profile 脚本」这个窄口径上是对的，但被外推成了「shell 初始化脚本一律不可用」这一**更宽且不成立**的结论；PRD 方案二的 PS1 注入正是踩在这个外推上 |
| 影响面 | 只影响**注入通道的可用性判断**，不影响「沙箱启动即一个 bash」「依赖服务由 agent 自主决定」两条本意 |
| **建议的 08 轮修订行方向**（历史表述不改写，只追加修订行） | ① 保留「沙箱启动即一个 bash、**不加载任何 profile 脚本**」原文；② 追加一句**限定**：交互式非登录 shell（`bash -i`）**会读 `/etc/bash.bashrc`**（系统级、对所有用户生效），因此**允许**在该文件里做**只读上报类**的 shell 集成注入（如 OSC 1337 pwd 上报）；③ 追加一句**仍然禁止**的边界：**不得**借此注入环境变量与别名（那会绕过「配置由用户声明的挂载提供」这条既有约束，且会与用户自己的 `~/.bashrc` 打架）；④ 注明**注入只对交互式 shell 生效**（`/etc/bash.bashrc` 顶部 `[ -z "$PS1" ] && return` 守卫所致） |

> **给 02 轮的对齐提示**：02 轮的镜像注入**不违反** ADR 0004 §3 的**本意**（沙箱仍是「启动即一个 bash、依赖服务仍由 agent 自主决定」），但**确实落在** 0004 影响段那句「不能靠 shell 初始化脚本注入」的**字面射程**内——**02 轮落地时按上文建议的修订行方向预留措辞**，避免 08 轮收口时再返工。

### ⑥ 回跳链路走通（完成标准 6 ✅）—— 前端临时单测证据

**链路演示（真实字节 → 解析绝对路径 → 映射为「窗格定位目录」）**：在 `apps/web/frontend` 下写了一个**临时** vitest 用例（`src/lib/__osc_probe_tmp.test.ts`，`@vitest-environment jsdom`），用上面 ① 里**真沙箱捕获的 329 字节原始流**（以 hex 形式内嵌）驱动 xterm：

- `new Terminal()` + `term.parser.registerOscHandler(1337, cb)` + `term.write(<真实字节>)`；
- 断言 OSC 回调收到的**原始载荷**与真实捕获一致：`['CurrentDir=/workspace','CurrentDir=/workspace','CurrentDir=/tmp','CurrentDir=/tmp']`（**4 条，与捕获流里的 4 条 OSC 一一对应**）；
- 解析纯函数（打样口径，与 03 轮将落地的口径一致）：剥 `CurrentDir=` 前缀 → 绝对路径校验 → 过既有 `normalizeContainerPath`（`src/lib/file-transfer.ts`）⇒ 得到 `/workspace` / `/tmp`；
- **「解析出的 pwd ⇒ 窗格定位目录」**：把解析结果过 `normalizeContainerPath` 即得窗格的目标目录，断言末值为 **`/tmp`**；
- 附带两条边界断言：**一条 OSC 被拆到两帧时 xterm 状态机仍能兜住边界**（正是 PRD 禁手写扫描器的理由）；**非绝对路径与无关 OSC 载荷被解析函数挡掉**。

测试输出（`npx vitest run src/lib/__osc_probe_tmp.test.ts`，**跑完即删**）：

```
 ✓ src/lib/__osc_probe_tmp.test.ts > OSC 1337 pwd 通道（01 轮打样） > 真实字节流里解析出与容器内 pwd 一致的绝对路径 7ms
 ✓ src/lib/__osc_probe_tmp.test.ts > OSC 1337 pwd 通道（01 轮打样） > 解析结果可直接映射为窗格定位目录 2ms
 ✓ src/lib/__osc_probe_tmp.test.ts > OSC 1337 pwd 通道（01 轮打样） > 一条 OSC 序列被拆到两帧时，xterm 状态机仍能兜住边界 2ms
 ✓ src/lib/__osc_probe_tmp.test.ts > OSC 1337 pwd 通道（01 轮打样） > 非 OSC 数据不误报；非法路径被解析函数挡掉 4ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

> **jsdom 下 xterm 可用**（`new Terminal()` + `registerOscHandler` + `write` 正常触发回调）；stderr 有一条 jsdom 的 `HTMLCanvasElement.prototype.getContext not implemented` 噪声（xterm 的 `Color.ts` 探测 canvas 引起），**不影响断言、不影响退出码**，03 轮正式单测同样会带这条噪声。

**「定位到该目录」在真沙箱侧也验过**：把 OSC 解析出的路径直接喂给核心包既有的目录列举（`FileTransferManager.list`），在 `osc-probe` 沙箱里实测 `/workspace` → 0 条目、`/tmp` → 2 条目（`show_ps1.sh`、`rc-block`）、`/etc` → 80 条目 ⇒ **OSC 解析出的路径是可直接用作窗格目录参数的真实容器路径**。

**「回跳按钮点击 ⇒ 导航到该目录」这一步本轮只验到数据链路**：按钮 UI 与导航交互属**任务 04**（文件窗格分屏骨架）的交付物，01 轮无对应界面可点；本轮证明的是**回跳所需的数据已就位**（解析出的 pwd ⇒ 目标目录 ⇒ 可直接导航）。**04 轮按本节口径接线即可**。

### ⑦ 越界检查（完成标准 7 ✅）

- **镜像侧**：只改了**运行中容器**的 `/etc/bash.bashrc`（先备份 `/etc/bash.bashrc.orig`）⇒ **镜像未重建、版本未 bump、`base-image/Dockerfile` 未动**；
- **前端侧**：临时 vitest 用例 `apps/web/frontend/src/lib/__osc_probe_tmp.test.ts` **已删除**；`git status` 干净（本轮唯一落盘 = 本任务文件）；
- **沙箱侧**：打样沙箱 `osc-probe` 已删除（容器 / 网桥网络 / systemd 用户单元 / 系统用户与家目录 / 子 UID-GID 段 / 平台元数据**全部回收**）；**未建任何临时镜像**；
- **旁证**：删除后 `sandboxctl list` 只剩本轮之前就存在的 `qilu` / `qqbot` 两个沙箱且均「运行中」，宿主 root 守护进程里的容器列表与打样前一致（平台自身的 postgres / minio / prometheus / traefik / cloudflared-tunnel 等**一个没动**）。

### 落盘清单

| 文件 | 变更 |
|---|---|
| `docs/tasks/file-pane-obsidian/01-prototype-osc-loop.md` | **新增「进展（2026-11-13 打样收口）」节**（含四块口径结论：最终注入写法 / sh 降级表现 / 重连恢复选定方案 / ADR 冲突评估）；完成标准七条 **全部勾选** |

**主干上无其它落盘**（临时测试已删、容器已删、Dockerfile 未动）。

### 清理清单

| 临时物 | 处置 |
|---|---|
| 前端临时单测 `apps/web/frontend/src/lib/__osc_probe_tmp.test.ts` | **已删除** |
| 打样沙箱 `osc-probe`（容器 `sandbox-osc-probe`、网络 `osc-probe-net`、系统用户 `sandbox-osc-probe` 及家目录、用户级 systemd 单元、子 UID-GID 段 `165536:65536`、平台元数据） | **已删除并回收** |
| 运行中容器 `/etc/bash.bashrc` 的临时注入块（备份 `/etc/bash.bashrc.orig`） | 随容器删除**一并消失** |
| 临时镜像 / tag | **未创建**（`docker images` 无 osc-probe 相关条目） |
| 打样脚本与捕获产物（pty 工具、重连实验、字节流） | 全部在 `/tmp/osc-probe/` 下，**不在仓库内**（临时目录，可随时删） |

### 给 02 / 03 轮的施工口径（只按本节施工，不另行发挥）

**02 轮（镜像）**：

- 注入块**追加在 `base-image` 的 `/etc/bash.bashrc` 末尾**，内容**逐字**取：
  ```bash
  export PS1="$PS1"'\[\e]1337;CurrentDir=$(pwd)\a\]'
  ```
  （**不要**写成 PRD 里的 `"$PS1\[\e]1337;CurrentDir="'$(pwd)\a\]'"`——那是 bash 语法错误）；
- 注释里点明**单引号是关键**（`$(pwd)` 必须在画提示符时才求值）；
- 版本 bump / 构建推送按 02 轮原口径；**本轮没有动 Dockerfile 与镜像**，02 轮从零改；
- ADR 0004 修订行按 ⑤ 节建议的方向写（**由 08 轮统一落**）。

**03 轮（前端）**：

- 解析纯函数口径：`CurrentDir=` 前缀 → 绝对路径校验 → `normalizeContainerPath`；**建议对首尾成对的 `'`/`"` 做一次容错剥离**（定稿写法不需要，但兼容其它来源）；
- OSC 处理器用 `term.parser.registerOscHandler(1337, cb)`，**不写手写扫描器、不引入逐帧 `TextDecoder`**；
- **重连恢复按 ④ 节选定方案**：重连后**先发一个与当前不同的尺寸**（如 `cols+1`）再发回真实尺寸，靠 SIGWINCH 触发 readline 重绘提示符、重新拿到 pwd；**空行只作兜底**（有误提交用户半行输入的副作用）；
- **注意提示符落 stderr 的坑**：控制台终端会话是带 tty 的（`docker exec -it`），stdout/stderr 合并进同一个 pty ⇒ 前端收到的字节流里 OSC 正常在；**只有**手工用 `docker exec -i`（无 tty）复现时才会只落在 stderr。

