# 网页终端主链路探针

验证二期任务 03 的核心判据：**宿主侧伪终端承载容器内的交互式 shell，容器内进程拿到真实 TTY，
窗口大小实时同步**。

## 跑法

```bash
cd platform
uv run python probe/terminal/01-pty-tty-probe.py
```

前置条件：宿主有 docker 与一个可用镜像（脚本默认用 `alpine:latest`）。
脚本会起一个一次性容器 `pty-probe-terminal`，跑完（无论成败）都会删掉，不碰平台的沙箱与数据目录。

## 判据

| # | 判据 | 探针里的验证方式 |
|---|---|---|
| 1 | 容器内进程拿到真实 TTY | 容器内跑 `tty`，输出应为 `/dev/pts/N` |
| 2 | 初始窗口大小进了容器 | 宿主伪终端设 100×30，容器内 `stty size` 应回 `30 100` |
| 3 | 窗口大小变化实时同步 | 宿主改 132×43，容器内 `stty size` 应回 `43 132` |
| 4 | Ctrl-C 生效 | 容器内 `sleep 30` 后发 `^C`，随后 `echo $?` 应为 130 |
| 5 | 断线不影响容器内进程 | 宿主 exec 进程仍存活 |

## 实测输出（2026-10-30，宿主 Debian 12 + docker 客户端 29.6.2）

```
伪终端已起：进程号 3713057
初始输出： b'/ # \x1b[6n'
tty 输出： b'tty; echo rc=$?\r\n/dev/pts/0\r\nrc=0\r\n/ # \x1b[6n'
初始 stty： b'stty size\r\n30 100\r\n/ # \x1b[6n'
调整后 stty： b'\r/ # \x1b[Jstty size\r\n43 132\r\n/ # \x1b[6n'
Ctrl-C 后： b'sleep 30\r\n^C\r\n/ # \x1b[6necho alive=$?\r\nalive=130\r\n/ # \x1b[6n'
宿主 exec 进程是否还活着： True
探针通过
```

## 踩过的坑（别再踩）

**窗口大小同步依赖「控制终端」，不是只靠 ioctl。**
容器客户端（docker CLI）靠终端的 `SIGWINCH` 感知窗口大小变化，再调 exec resize 把新尺寸
转发到容器内的 TTY。宿主侧如果只 `openpty` + `setsid`（子进程没有控制终端），内核不知道该把
`SIGWINCH` 发给谁，容器内的尺寸会永远停在初始值——`TIOCSWINSZ` 改了也没用。
所以宿主伪终端的子进程必须把从端设为自己的控制终端（`TIOCSCTTY`）。

**Ctrl-C 不能由宿主伪终端生成。**
宿主侧伪终端设为 raw 模式（关 `ISIG`/`ICANON`/`ECHO`），`^C` 字节原样送进容器，
由容器内的 TTY 生成 `SIGINT`；否则宿主侧会先把 `^C` 吃掉并给自己的进程组发 `SIGINT`，
把容器客户端自己打死。
