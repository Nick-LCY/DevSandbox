//! 端口转发的桌面侧实现：**本机 TCP 监听 + 隧道 WebSocket 桥接**。
//!
//! 口径来源：`docs/tasks/phase3-desktop/06-port-forward-desktop.md`、
//! `apps/web/backend/API.md` 第 15 章（隧道协议权威口径）、
//! `docs/architecture/decisions/0014-端口转发机制选型.md` 第 4/5 节。
//!
//! ## 监听模型（**任务 06 的落点口径**）
//!
//! - **一个「开启的转发」= 一个本机 `TcpListener`**（`127.0.0.1:<本机端口>`）。
//! - **监听器活到用户 `stop_forward` 为止**：单条隧道断开**不关监听**——
//!   只关掉那一条本机连接，并上报**连接级**状态（`forward://connection`）。
//!   （任务文件里「隧道 WS 断开 → 关本机监听」一句按本口径落实：监听器不因
//!   单连接失败而关；连接断了可以在下次连接时重新建隧道。）
//! - **每条 accept 到的 TCP 连接各开一条隧道 WS**：服务端支持并发隧道，
//!   天然满足「同一转发的多条并发连接互不串扰」。
//! - **转发级的致命失败**（后端不可达、令牌无效、转发不存在/已停止……，
//!   都发生在**隧道建立阶段**）→ 上报**转发级**状态（`forward://state`），
//!   监听器仍然保留（用户可以再发起一次连接重试）。
//! - **停止转发 = 关监听 + 关全部连接**：取消信号覆盖每条连接的桥接 future
//!   （`accept_loop` 里整条 `bridge` 挂在 `tokio::select!` 的取消分支上），
//!   取消即 drop future、两个 socket 随之关闭——对端不读时卡在写操作里的
//!   连接不会变成关不掉的僵尸连接。
//! - **`stopped` 状态事件只发一次**（在 `stop()` 里发，监听循环退出时不再重复发）。
//!
//! ## 本机端口规则（ADR 0014 第 4 节）
//!
//! - **默认 = 容器端口**（前端可改，改动经 IPC 传进来）；
//! - **不可为空**（空值在表单层就拦掉，Rust 侧也拒）；
//! - **被占自动换空闲端口**：目标端口绑不上时自动改用空闲端口
//!   （从 `18000` 起扫），**返回并显示实际生效的端口**；
//! - **允许 <1024**（低端口）：Windows 可绑、macOS 现代版可绑；
//!   **Linux 上非 root 绑不了**——那种情况**明确报错**，不静默失败。
//!
//! ## 令牌
//!
//! **Rust 侧不落盘令牌**：令牌每次由前端经 IPC 传入，只活在内存里
//! （进程退出即失效）。落盘的只有后端**基址**（`csp.rs` 的 `CspState`）。

use std::collections::HashMap;
use std::io::ErrorKind;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Url};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::{HeaderValue, Request};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

/// 本机监听的绑定地址：**只绑回环**，不出本机（ADR 0014 第 1 节）。
pub const LOCAL_BIND_ADDR: &str = "127.0.0.1";

/// 目标端口被占时，**自动换空闲端口**的扫描起点。
pub const FALLBACK_PORT_START: u16 = 18000;

/// 端口候选的最大尝试次数（首选端口 + 若干个空闲端口）。
const MAX_PORT_CANDIDATES: usize = 64;

/// 隧道协议：服务端 accept 后**首帧必为文本 hello 帧**。
const CLIENT_HELLO_FRAME: &str = r#"{"type":"hello"}"#;

/// 转发级状态事件名。
pub const STATE_EVENT: &str = "forward://state";

/// 连接级状态事件名。
pub const CONNECTION_EVENT: &str = "forward://connection";

/// 隧道关闭码：正常收敛。
pub const CLOSE_NORMAL: u16 = 1000;
/// 隧道关闭码：没有状态码（对端只发了关闭帧，没带原因码）。
pub const CLOSE_NO_STATUS: u16 = 1005;
/// 隧道关闭码：异常收场（连接被中断，没有完成关闭握手）。
pub const CLOSE_ABNORMAL: u16 = 1006;
/// 隧道关闭码：服务退出（客户端据此重连）。
pub const CLOSE_SERVICE_EXIT: u16 = 1001;
/// 隧道关闭码：策略违规（令牌无效 / 转发不存在 / 已停止）——**不可重试**。
pub const CLOSE_POLICY: u16 = 1008;
/// 隧道关闭码：字节泵异常结束——**可重试**。
pub const CLOSE_PUMP_FAILED: u16 = 1011;

/// 隧道收场的分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunnelOutcome {
    /// 正常收敛（1000）。
    Normal,
    /// 服务退出（1001）：可重连。
    ServiceExit,
    /// 策略违规（1008）：**不可重试**，提示去检查配置或转发状态。
    Policy,
    /// 字节泵异常结束（1011）：可重试。
    PumpFailed,
    /// 其它关闭码（网络中断等）。
    Unknown,
}

/// 按关闭码分类（协议口径见 API.md 15.4）。
pub fn classify_close_code(code: u16) -> TunnelOutcome {
    match code {
        CLOSE_NORMAL => TunnelOutcome::Normal,
        CLOSE_SERVICE_EXIT => TunnelOutcome::ServiceExit,
        CLOSE_POLICY => TunnelOutcome::Policy,
        CLOSE_PUMP_FAILED => TunnelOutcome::PumpFailed,
        _ => TunnelOutcome::Unknown,
    }
}

/// 关闭码分类对应的中文说明（**固定文案**，界面直接展示）。
///
/// `code` 是原始关闭码：**未知关闭码要带进文案**（如「隧道已断开（关闭码 1006）」）——
/// 只写「隧道已断开」的话，用户分不清是正常收场还是网络中断。
pub fn describe_close_outcome(outcome: TunnelOutcome, code: Option<u16>) -> String {
    match outcome {
        TunnelOutcome::Normal => "隧道已正常关闭".to_string(),
        TunnelOutcome::ServiceExit => "后端服务已退出，隧道断开（可重连）".to_string(),
        TunnelOutcome::Policy => {
            "转发不可用：令牌无效、转发不存在或已停止（不可重试，请检查配置或转发状态）".to_string()
        }
        TunnelOutcome::PumpFailed => "字节泵异常结束，隧道断开（可重试）".to_string(),
        TunnelOutcome::Unknown => match code {
            Some(code) => format!("隧道已断开（关闭码 {code}）"),
            None => "隧道已断开".to_string(),
        },
    }
}

/// 端口候选序列：**第一个是期望端口**（用户指定 / 默认 = 容器端口），
/// 之后从 [`FALLBACK_PORT_START`] 起逐个递增（被占时自动换空闲端口）。
pub fn port_candidates(preferred: u16, limit: usize) -> Vec<u16> {
    let mut candidates: Vec<u16> = Vec::new();
    if preferred > 0 {
        candidates.push(preferred);
    }
    for offset in 0..limit {
        if candidates.len() >= limit {
            break;
        }
        let candidate = FALLBACK_PORT_START.saturating_add(offset as u16);
        if candidate == 0 || candidates.contains(&candidate) {
            continue;
        }
        candidates.push(candidate);
    }
    candidates
}

/// 后端基址 → 隧道 WebSocket 地址。
///
/// - `http` → `ws`，`https` → `wss`（`ws` / `wss` 原样保留）；
/// - 路径固定 `/api/forward/tunnel/{forward_id}`（**REST 是复数、隧道是单数**）。
pub fn tunnel_ws_url(backend_base_url: &str, forward_id: &str) -> Result<String, String> {
    let text = backend_base_url.trim();
    if text.is_empty() {
        return Err("后端地址为空，无法建立隧道".to_string());
    }
    let parsed = Url::parse(text).map_err(|_| "后端地址格式不对，无法建立隧道".to_string())?;
    let scheme = match parsed.scheme() {
        "http" => "ws",
        "https" => "wss",
        "ws" => "ws",
        "wss" => "wss",
        other => return Err(format!("后端地址的协议不支持隧道：{other}")),
    };
    let Some(host) = parsed.host_str() else {
        return Err("后端地址缺少主机名，无法建立隧道".to_string());
    };
    // 基址只表示「后端在哪个主机的哪个端口」：**路径 / 参数 / # 一律拒绝**
    // （与前端 `validateBaseUrl` 一个口径）。隧道地址的路径是固定的
    // `/api/forward/tunnel/{id}`，带着基址里的路径拼出来的地址必然对不上——
    // 不静默忽略，直接报错让用户改基址。
    if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(
            "后端地址不要带路径、参数或 #（隧道地址固定为 /api/forward/tunnel/{id}）".to_string(),
        );
    }
    // IPv6 字面量：`host_str()` 返回的**已经带方括号**（`[::1]`），别再包一层。
    let authority = match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    Ok(format!(
        "{scheme}://{authority}/api/forward/tunnel/{}",
        forward_id.trim()
    ))
}

/// 端口转发失败的原因。
#[derive(Debug, Clone)]
pub enum ForwardError {
    /// 期望端口与回退端口都绑不上（带最后一次绑定失败的原因）。
    NoFreePort(String),
    /// 低端口（<1024）在当前系统上绑不了（Linux 非 root）。
    LowPortDenied(u16),
    /// 绑定失败（其它原因）。
    BindFailed(u16, String),
    /// 这条转发没有开启本机监听。
    NotListening(String),
    /// 后端地址不合法 / 隧道建立失败。
    Tunnel(String),
}

impl ForwardError {
    /// 面向用户的中文说明（**固定文案**，界面直接展示）。
    pub fn message(&self) -> String {
        match self {
            ForwardError::NoFreePort(reason) => format!(
                "本机端口都被占用了，没有找到空闲端口（最后一次绑定失败：{reason}）"
            ),
            ForwardError::LowPortDenied(port) => format!(
                "本机端口 {port} 小于 1024，当前系统不允许普通用户绑定低端口（Linux 需要管理员权限）"
            ),
            ForwardError::BindFailed(port, reason) => {
                format!("本机端口 {port} 绑定失败：{reason}")
            }
            ForwardError::NotListening(forward_id) => {
                format!("转发 {forward_id} 没有开启本机监听")
            }
            ForwardError::Tunnel(message) => message.clone(),
        }
    }
}

impl std::fmt::Display for ForwardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for ForwardError {}

/// 转发级状态事件载荷（`forward://state`）。
#[derive(Clone, Debug, Serialize)]
pub struct ForwardStateEvent {
    /// 转发标识。
    pub forward_id: String,
    /// 状态：`listening`（本机监听中）/ `stopped`（已关）/ `error`（致命失败）。
    pub state: String,
    /// 容器端口（转发目标端口）。
    pub container_port: u16,
    /// 实际生效的本机端口（未开启时为 null）。
    pub local_port: Option<u16>,
    /// 面向用户的中文说明。
    pub message: String,
}

/// 连接级状态事件载荷（`forward://connection`）。
#[derive(Clone, Debug, Serialize)]
pub struct ForwardConnectionEvent {
    /// 转发标识。
    pub forward_id: String,
    /// 状态：`connected` / `closed` / `error`。
    pub state: String,
    /// 容器端口（转发目标端口）。
    pub container_port: u16,
    /// 本机端口。
    pub local_port: u16,
    /// 面向用户的中文说明。
    pub message: String,
}

/// 一条转发的本机监听状态（前端挂载时据此回填「已开启」的行）。
#[derive(Clone, Debug, Serialize)]
pub struct ForwardListener {
    /// 转发标识。
    pub forward_id: String,
    /// 容器端口（转发目标端口）。
    pub container_port: u16,
    /// **实际生效**的本机端口。
    pub local_port: u16,
    /// 状态：`listening`。
    pub state: String,
}

/// 一条转发的运行期会话。
struct ForwardSession {
    /// 容器端口（转发目标端口）。
    container_port: u16,
    /// 实际生效的本机端口。
    local_port: u16,
    /// 停止信号：一次性收掉监听与全部连接。
    cancel: CancellationToken,
    /// 监听协程。
    task: tokio::task::JoinHandle<()>,
}

/// 端口转发的管理器（本机监听 + 隧道桥接）。
///
/// **进程内单例**（由 `main.rs` 以 `Arc<ForwardManager>` 挂到 Tauri 状态上）。
#[derive(Default)]
pub struct ForwardManager {
    sessions: Mutex<HashMap<String, ForwardSession>>,
}

impl ForwardManager {
    /// 新建一个空的管理器。
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// 开启一条转发的本机监听。
    ///
    /// - **幂等**：同一条转发重复开启 → 直接返回现有端口（不重复起监听）。
    /// - **端口规则**：优先用 `local_port`（缺省 = 容器端口）；绑不上时
    ///   **自动换空闲端口**并返回**实际生效的端口**。
    pub async fn start(
        &self,
        app: AppHandle,
        forward_id: String,
        backend_base_url: String,
        token: String,
        container_port: u16,
        local_port: Option<u16>,
    ) -> Result<u16, ForwardError> {
        let forward_id = forward_id.trim().to_string();
        if forward_id.is_empty() {
            return Err(ForwardError::Tunnel("转发标识为空".to_string()));
        }
        if token.trim().is_empty() {
            return Err(ForwardError::Tunnel(
                "访问令牌为空，无法建立隧道（请在设置里填好令牌）".to_string(),
            ));
        }

        // 幂等：已经在监听就直接返回现有端口。
        {
            let guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(session) = guard.get(&forward_id) {
                return Ok(session.local_port);
            }
        }

        // 端口规则：用户指定 / 默认 = 容器端口。
        let preferred = local_port.filter(|port| *port > 0).unwrap_or(container_port);
        let (listener, actual_port) = bind_local_listener(preferred).await?;

        let cancel = CancellationToken::new();
        let task = tokio::spawn(accept_loop(
            app.clone(),
            forward_id.clone(),
            backend_base_url,
            token,
            container_port,
            actual_port,
            listener,
            cancel.clone(),
        ));

        {
            let mut guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            // 竞态兜底：另一路已经把同一条转发开起来了 → 收掉自己这一路。
            if let Some(existing) = guard.get(&forward_id) {
                let port = existing.local_port;
                drop(guard);
                cancel.cancel();
                task.abort();
                return Ok(port);
            }
            guard.insert(
                forward_id.clone(),
                ForwardSession {
                    container_port,
                    local_port: actual_port,
                    cancel: cancel.clone(),
                    task,
                },
            );
        }

        emit_state(
            &app,
            &forward_id,
            "listening",
            container_port,
            Some(actual_port),
            &format!("本机监听已开启：http://{LOCAL_BIND_ADDR}:{actual_port}"),
        );
        Ok(actual_port)
    }

    /// 关闭一条转发的本机监听（**关监听 + 关全部连接**）。
    ///
    /// 这条转发没有开启本机监听时**明确报错**（不回显内部细节）。
    ///
    /// **等监听协程真正退出再返回**：监听 socket 是随那个协程一起释放的——
    /// 不等它退出，紧接着的「用新凭据重启」（同端口重开）就可能撞上
    /// 「端口还没释放」，被当成「端口被占」而自动换端口（用户拿到的地址就变了）。
    ///
    /// **`stopped` 状态事件只在这里发一次**（监听循环退出时不再重复发）——
    /// 重复发会让前端把同一次停止当成两次。
    pub async fn stop(&self, app: &AppHandle, forward_id: &str) -> Result<(), ForwardError> {
        let forward_id = forward_id.trim();
        let session = {
            let mut guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            guard.remove(forward_id)
        };
        let Some(session) = session else {
            return Err(ForwardError::NotListening(forward_id.to_string()));
        };
        // 停止信号 → 监听循环与全部连接一次性收掉。
        // 取消信号同时覆盖每条连接的桥接 future（见 `accept_loop` 的注释）：
        // 对端不读时卡在写操作里的连接也会被 drop，两个 socket 随之关闭。
        session.cancel.cancel();
        // 等监听协程退出（它退出时监听 socket 随之关闭，端口才真正空出来）。
        let _ = session.task.await;
        emit_state(
            app,
            forward_id,
            "stopped",
            session.container_port,
            Some(session.local_port),
            "本机监听已关闭",
        );
        Ok(())
    }

    /// 当前所有「已开启本机监听」的转发（前端挂载时回填用）。
    pub fn listeners(&self) -> Vec<ForwardListener> {
        let guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let mut items: Vec<ForwardListener> = guard
            .iter()
            .map(|(forward_id, session)| ForwardListener {
                forward_id: forward_id.clone(),
                container_port: session.container_port,
                local_port: session.local_port,
                state: "listening".to_string(),
            })
            .collect();
        items.sort_by(|a, b| a.forward_id.cmp(&b.forward_id));
        items
    }
}

/// 绑本机监听：**绑不上就自动换空闲端口**。
///
/// - `AddrInUse`（端口被占）→ 试下一个候选端口（从 `18000` 起）；
/// - `PermissionDenied` 且端口 < 1024 → **明确报错**（Linux 非 root 绑不了低端口）；
/// - 其它错误 → 直接失败（不静默换端口，避免掩盖真问题）。
pub async fn bind_local_listener(preferred: u16) -> Result<(TcpListener, u16), ForwardError> {
    let candidates = port_candidates(preferred, MAX_PORT_CANDIDATES);
    let mut last_reason = String::new();
    for candidate in candidates {
        match TcpListener::bind((LOCAL_BIND_ADDR, candidate)).await {
            Ok(listener) => return Ok((listener, candidate)),
            Err(err) => {
                if err.kind() == ErrorKind::PermissionDenied && candidate < 1024 {
                    return Err(ForwardError::LowPortDenied(candidate));
                }
                if err.kind() != ErrorKind::AddrInUse {
                    return Err(ForwardError::BindFailed(candidate, err.to_string()));
                }
                last_reason = err.to_string();
            }
        }
    }
    // 最后一次失败的原因**拼进报错文案**（不静默丢）：用户能看出是端口被占
    // 还是别的 bind 失败。
    Err(ForwardError::NoFreePort(last_reason))
}

/// 监听循环：每 accept 到一条本机连接，就开一条隧道 WS 做字节桥接。
async fn accept_loop(
    app: AppHandle,
    forward_id: String,
    backend_base_url: String,
    token: String,
    container_port: u16,
    local_port: u16,
    listener: TcpListener,
    cancel: CancellationToken,
) {
    loop {
        let accepted = tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            result = listener.accept() => result,
        };
        let (stream, _peer) = match accepted {
            Ok(pair) => pair,
            Err(err) => {
                // accept 失败（连接数超限等瞬时错误）：退避一下继续接。
                eprintln!("[forward] 转发 {forward_id} 接受本机连接失败：{err}");
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
        };

        let app = app.clone();
        let forward_id = forward_id.clone();
        let backend_base_url = backend_base_url.clone();
        let token = token.clone();
        let cancel = cancel.clone();
        // 选取消用的那一份克隆（`bridge` 自己也要拿同一个 token）。
        let cancel_for_select = cancel.clone();
        tokio::spawn(async move {
            // **整条连接的桥接都挂在取消信号下**：取消即 drop 掉这个 future，
            // 本机 `TcpStream` 与隧道 WS 两个 socket 随之关闭。
            //
            // 为什么要这么包：桥接里的 `sink.send`（往隧道写）与
            // `local_write.write_all`（往本机写）都可能因为**对端不读**而
            // 永久阻塞，它们不在 select 的取消分支里——不这么做的话，
            // 停止转发之后这些本机连接会一直挂着（僵尸连接），端口也一直占着。
            //
            // 验证口径：停止转发后，本机上那条连着的 socket 应当被关闭
            //（对端随即读到 EOF / 「连接被重置」），而不是继续挂着。
            tokio::select! {
                biased;
                _ = cancel_for_select.cancelled() => {}
                _ = bridge(
                    app,
                    forward_id,
                    backend_base_url,
                    token,
                    container_port,
                    local_port,
                    stream,
                    cancel,
                ) => {}
            }
        });
    }
    // **这里不再发 `stopped` 事件**：`stop()` 已经发过一次（只发一次，不重复）。
}

/// 一条本机连接 ↔ 一条隧道 WS 的字节桥接。
async fn bridge(
    app: AppHandle,
    forward_id: String,
    backend_base_url: String,
    token: String,
    container_port: u16,
    local_port: u16,
    local: TcpStream,
    cancel: CancellationToken,
) {
    let ws_url = match tunnel_ws_url(&backend_base_url, &forward_id) {
        Ok(url) => url,
        Err(message) => {
            report_tunnel_failure(&app, &forward_id, container_port, local_port, &message);
            return;
        }
    };
    let request = match build_request(&ws_url, &token) {
        Ok(request) => request,
        Err(message) => {
            report_tunnel_failure(&app, &forward_id, container_port, local_port, &message);
            return;
        }
    };

    let connect = tokio_tungstenite::connect_async(request);
    let connected = tokio::select! {
        biased;
        _ = cancel.cancelled() => return,
        result = connect => result,
    };
    let (mut ws, _response) = match connected {
        Ok(pair) => pair,
        Err(err) => {
            let message = format!("隧道建立失败：{err}");
            report_tunnel_failure(&app, &forward_id, container_port, local_port, &message);
            return;
        }
    };

    // 客户端握手帧（服务端会回一条 hello；协议里有这一帧）。
    // **握手帧的发送也纳入取消覆盖**：发送可能卡在写操作里（对端不读），
    // 不被取消覆盖就会留下一条关不掉的本机连接。
    let sent = tokio::select! {
        biased;
        _ = cancel.cancelled() => return,
        result = ws.send(Message::text(CLIENT_HELLO_FRAME)) => result,
    };
    if sent.is_err() {
        report_tunnel_failure(
            &app,
            &forward_id,
            container_port,
            local_port,
            "隧道建立失败：握手帧发不出去",
        );
        return;
    }

    // **首帧必为服务端的 hello 帧**：不是 hello（或直接是错误帧）→ 按错误帧
    // 的固定文案上报并关掉这条本机连接。
    let first = tokio::select! {
        biased;
        _ = cancel.cancelled() => return,
        message = ws.next() => message,
    };
    let Some(Ok(message)) = first else {
        report_tunnel_failure(
            &app,
            &forward_id,
            container_port,
            local_port,
            "隧道建立失败：服务端没有给出握手帧",
        );
        return;
    };
    match parse_control(&message) {
        ControlFrame::Hello => {}
        ControlFrame::Error(text) => {
            report_tunnel_failure(&app, &forward_id, container_port, local_port, &text);
            return;
        }
        ControlFrame::Unknown => {
            report_tunnel_failure(
                &app,
                &forward_id,
                container_port,
                local_port,
                "隧道建立失败：服务端的首帧不是 hello 帧",
            );
            return;
        }
    }

    emit_connection(
        &app,
        &forward_id,
        "connected",
        container_port,
        local_port,
        "本机连接已接入隧道",
    );

    let (mut sink, mut stream) = ws.split();
    let (mut local_read, mut local_write) = local.into_split();
    let mut buffer = vec![0u8; 16 * 1024];
    let outcome: TunnelOutcome;
    let mut reason: Option<String> = None;
    // 原始关闭码（收场时带进文案：未知关闭码要告诉用户是哪个码）。
    let mut close_code: Option<u16> = None;

    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                // 用户停止转发：正常收场（不算故障）。
                outcome = TunnelOutcome::Normal;
                reason = Some("本机监听已关闭".to_string());
                break;
            }
            read = local_read.read(&mut buffer) => {
                match read {
                    Ok(0) => {
                        // 本机侧 EOF：把隧道正常关掉。
                        let _ = sink.send(Message::Close(None)).await;
                        outcome = TunnelOutcome::Normal;
                        reason = Some("本机连接已关闭".to_string());
                        break;
                    }
                    Ok(size) => {
                        if sink.send(Message::binary(buffer[..size].to_vec())).await.is_err() {
                            outcome = TunnelOutcome::Unknown;
                            reason = Some("隧道写入失败".to_string());
                            break;
                        }
                    }
                    Err(err) => {
                        outcome = TunnelOutcome::Unknown;
                        reason = Some(format!("读取本机连接失败：{err}"));
                        break;
                    }
                }
            }
            message = stream.next() => {
                match message {
                    Some(Ok(Message::Binary(data))) => {
                        if local_write.write_all(&data).await.is_err() {
                            outcome = TunnelOutcome::Unknown;
                            reason = Some("写入本机连接失败".to_string());
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        // 服务端的文本帧只做控制：错误帧的文案是固定中文，直接展示。
                        if let ControlFrame::Error(message) = parse_control_text(text.as_str()) {
                            reason = Some(message);
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        // 关闭帧带状态码：按协议分类；没有状态码（1005）等价于异常收场。
                        let code = frame.map(|item| u16::from(item.code)).unwrap_or(CLOSE_NO_STATUS);
                        close_code = Some(code);
                        outcome = classify_close_code(code);
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(err)) => {
                        outcome = TunnelOutcome::Unknown;
                        reason = Some(format!("隧道读取失败：{err}"));
                        break;
                    }
                    None => {
                        // 流结束但没有关闭帧：**不等同于正常收场**（1000）——
                        // 按异常收场（1006）算，文案与 1000 拉开区分度。
                        close_code = Some(CLOSE_ABNORMAL);
                        outcome = TunnelOutcome::Unknown;
                        break;
                    }
                }
            }
        }
    }

    // 连接级收场：只关这一条本机连接，**不动监听器**。
    let message = match reason {
        Some(text) => match (outcome, close_code) {
            // 未知关闭码：把码值带进文案（用户能看出是网络中断还是别的）。
            (TunnelOutcome::Unknown, Some(code)) => format!("{text}（关闭码 {code}）"),
            _ => text,
        },
        None => describe_close_outcome(outcome, close_code),
    };
    let state = match outcome {
        TunnelOutcome::Normal => "closed",
        _ => "error",
    };
    emit_connection(
        &app,
        &forward_id,
        state,
        container_port,
        local_port,
        &message,
    );
    if outcome == TunnelOutcome::Policy {
        // 策略违规（令牌无效 / 转发不存在 / 已停止）：不可重试，提示去检查
        // 配置或转发状态。**监听器保留**（用户可以改完配置再来一次连接）。
        emit_state(
            &app,
            &forward_id,
            "error",
            container_port,
            Some(local_port),
            &describe_close_outcome(outcome, close_code),
        );
    }
}

/// 隧道建立失败：**转发级**上报（后端不可达 / 令牌无效 / 转发不存在……）。
fn report_tunnel_failure(
    app: &AppHandle,
    forward_id: &str,
    container_port: u16,
    local_port: u16,
    message: &str,
) {
    emit_state(
        app,
        forward_id,
        "error",
        container_port,
        Some(local_port),
        message,
    );
    emit_connection(app, forward_id, "error", container_port, local_port, message);
}

/// 构造带 `Authorization: Bearer <令牌>` 的握手请求。
fn build_request(url: &str, token: &str) -> Result<Request<()>, String> {
    let mut request = url
        .into_client_request()
        .map_err(|err| format!("隧道地址不合法：{err}"))?;
    let value = format!("Bearer {}", token.trim());
    let header = HeaderValue::from_str(&value).map_err(|_| "访问令牌含非法字符".to_string())?;
    request.headers_mut().insert(AUTHORIZATION, header);
    Ok(request)
}

/// 服务端的文本控制帧。
#[derive(Debug, Clone)]
enum ControlFrame {
    /// 握手帧（`{"type":"hello"}`）。
    Hello,
    /// 错误帧（`{"type":"error","message":"…"}`）：**文案是固定中文**。
    Error(String),
    /// 其它 / 无法识别的帧。
    Unknown,
}

/// 解析一帧控制消息（文本帧）。
fn parse_control(message: &Message) -> ControlFrame {
    match message {
        Message::Text(text) => parse_control_text(text.as_str()),
        _ => ControlFrame::Unknown,
    }
}

/// 解析控制帧的文本载荷。
fn parse_control_text(text: &str) -> ControlFrame {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return ControlFrame::Unknown;
    };
    let Some(kind) = value.get("type").and_then(|item| item.as_str()) else {
        return ControlFrame::Unknown;
    };
    match kind {
        "hello" => ControlFrame::Hello,
        "error" => ControlFrame::Error(
            value
                .get("message")
                .and_then(|item| item.as_str())
                .unwrap_or("隧道错误")
                .to_string(),
        ),
        _ => ControlFrame::Unknown,
    }
}

/// 发转发级状态事件。
fn emit_state(
    app: &AppHandle,
    forward_id: &str,
    state: &str,
    container_port: u16,
    local_port: Option<u16>,
    message: &str,
) {
    let payload = ForwardStateEvent {
        forward_id: forward_id.to_string(),
        state: state.to_string(),
        container_port,
        local_port,
        message: message.to_string(),
    };
    if let Err(err) = app.emit(STATE_EVENT, payload) {
        eprintln!("[forward] 转发 {forward_id} 的状态事件发不出去：{err}");
    }
}

/// 发连接级状态事件。
fn emit_connection(
    app: &AppHandle,
    forward_id: &str,
    state: &str,
    container_port: u16,
    local_port: u16,
    message: &str,
) {
    let payload = ForwardConnectionEvent {
        forward_id: forward_id.to_string(),
        state: state.to_string(),
        container_port,
        local_port,
        message: message.to_string(),
    };
    if let Err(err) = app.emit(CONNECTION_EVENT, payload) {
        eprintln!("[forward] 转发 {forward_id} 的连接事件发不出去：{err}");
    }
}

/// 便捷别名：管理器的共享句柄（`main.rs` 挂到 Tauri 状态上）。
pub type SharedForwardManager = Arc<ForwardManager>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 端口候选先给期望端口再从_18000_起扫() {
        assert_eq!(port_candidates(8080, 3), vec![8080, 18000, 18001]);
        // 期望端口本身就在回退区间里：跳过重复的那个。
        assert_eq!(port_candidates(18000, 3), vec![18000, 18001, 18002]);
        // 端口 0 不合法（调用方已拦），这里不产出候选里的 0。
        assert!(!port_candidates(0, 4).contains(&0));
    }

    #[test]
    fn 后端基址推导出隧道地址() {
        assert_eq!(
            tunnel_ws_url("http://127.0.0.1:8000", "abc123").unwrap(),
            "ws://127.0.0.1:8000/api/forward/tunnel/abc123"
        );
        assert_eq!(
            tunnel_ws_url("https://sandbox.example", "abc123").unwrap(),
            "wss://sandbox.example/api/forward/tunnel/abc123"
        );
        // 已经是 ws / wss 的原样保留。
        assert_eq!(
            tunnel_ws_url("ws://10.0.0.5:9000/", "abc123").unwrap(),
            "ws://10.0.0.5:9000/api/forward/tunnel/abc123"
        );
        // IPv6 主机：方括号只带一层。
        assert_eq!(
            tunnel_ws_url("http://[::1]:8000", "abc123").unwrap(),
            "ws://[::1]:8000/api/forward/tunnel/abc123"
        );
    }

    #[test]
    fn 后端地址不合法时明确报错() {
        assert!(tunnel_ws_url("", "abc123").is_err());
        assert!(tunnel_ws_url("   ", "abc123").is_err());
        assert!(tunnel_ws_url("不是地址", "abc123").is_err());
        assert!(tunnel_ws_url("ftp://host", "abc123").is_err());
    }

    #[test]
    fn 后端地址带路径时明确报错不静默忽略() {
        // 隧道地址的路径是固定的：基址带路径 / 参数 / # 都拼不出正确地址。
        let err = tunnel_ws_url("http://127.0.0.1:8000/api", "abc123").unwrap_err();
        assert!(err.contains("路径"), "报错要说清是路径的问题：{err}");
        assert!(tunnel_ws_url("http://127.0.0.1:8000/?x=1", "abc123").is_err());
        assert!(tunnel_ws_url("http://127.0.0.1:8000/#top", "abc123").is_err());
        // 末尾一个斜杠不算带路径。
        assert_eq!(
            tunnel_ws_url("http://127.0.0.1:8000/", "abc123").unwrap(),
            "ws://127.0.0.1:8000/api/forward/tunnel/abc123"
        );
    }

    #[test]
    fn 关闭码按协议分类() {
        assert_eq!(classify_close_code(1000), TunnelOutcome::Normal);
        assert_eq!(classify_close_code(1001), TunnelOutcome::ServiceExit);
        assert_eq!(classify_close_code(1008), TunnelOutcome::Policy);
        assert_eq!(classify_close_code(1011), TunnelOutcome::PumpFailed);
        assert_eq!(classify_close_code(1006), TunnelOutcome::Unknown);
        assert_eq!(classify_close_code(1005), TunnelOutcome::Unknown);
    }

    #[test]
    fn 策略违规的文案提示去检查配置或转发状态() {
        let text = describe_close_outcome(TunnelOutcome::Policy, None);
        assert!(text.contains("令牌无效"));
        assert!(text.contains("不可重试"));
        // 可重试的两类文案里带「可重连 / 可重试」。
        assert!(describe_close_outcome(TunnelOutcome::ServiceExit, None).contains("可重连"));
        assert!(describe_close_outcome(TunnelOutcome::PumpFailed, None).contains("可重试"));
    }

    #[test]
    fn 未知关闭码的文案带码值且与正常收场区分开() {
        let unknown = describe_close_outcome(TunnelOutcome::Unknown, Some(1006));
        assert!(unknown.contains("1006"), "未知关闭码要带码值：{unknown}");
        // 与 1000 的文案拉开区分度。
        let normal = describe_close_outcome(TunnelOutcome::Normal, Some(1000));
        assert_eq!(normal, "隧道已正常关闭");
        assert_ne!(unknown, normal);
        // 没有码值时也要有文案（不出现空的括号）。
        assert_eq!(describe_close_outcome(TunnelOutcome::Unknown, None), "隧道已断开");
    }

    #[test]
    fn 端口都被占时报错带最后一次失败原因() {
        let err = ForwardError::NoFreePort("Address already in use (os error 98)".to_string());
        let message = err.message();
        assert!(message.contains("空闲端口"));
        assert!(
            message.contains("Address already in use"),
            "最后一次失败的原因要拼进文案：{message}"
        );
    }

    #[test]
    fn 控制帧解析() {
        assert!(matches!(
            parse_control_text(r#"{"type":"hello"}"#),
            ControlFrame::Hello
        ));
        match parse_control_text(r#"{"type":"error","message":"端口转发不存在或已失效"}"#) {
            ControlFrame::Error(message) => assert_eq!(message, "端口转发不存在或已失效"),
            _ => panic!("应当解析成错误帧"),
        }
        assert!(matches!(
            parse_control_text("不是 JSON"),
            ControlFrame::Unknown
        ));
        assert!(matches!(
            parse_control_text(r#"{"type":"别的"}"#),
            ControlFrame::Unknown
        ));
    }

    #[test]
    fn 握手请求带_bearer_令牌() {
        let request =
            build_request("ws://127.0.0.1:8000/api/forward/tunnel/abc", "tok-123").unwrap();
        let value = request
            .headers()
            .get(AUTHORIZATION)
            .and_then(|item| item.to_str().ok())
            .unwrap();
        assert_eq!(value, "Bearer tok-123");
    }

    #[tokio::test]
    async fn 绑监听用实际端口并只绑回环() {
        // 先占一个端口，再让 bind_local_listener 换空闲端口。
        let taken = TcpListener::bind((LOCAL_BIND_ADDR, 0)).await.unwrap();
        let taken_port = taken.local_addr().unwrap().port();
        let (listener, port) = bind_local_listener(taken_port).await.unwrap();
        assert_ne!(port, taken_port, "被占的端口应当自动换掉");
        assert!(port >= FALLBACK_PORT_START);
        let addr = listener.local_addr().unwrap();
        assert!(addr.ip().is_loopback(), "监听只绑回环");
        drop(listener);
        drop(taken);
    }

    #[tokio::test]
    async fn 低端口在普通用户下绑不了时明确报错() {
        // 只在「确实是权限问题」时断言（root 或 Windows 上能绑低端口）。
        match bind_local_listener(80).await {
            Ok((_listener, port)) => assert_eq!(port, 80),
            Err(ForwardError::LowPortDenied(port)) => assert_eq!(port, 80),
            Err(other) => panic!("低端口失败时应当明确报错：{other}"),
        }
    }
}
