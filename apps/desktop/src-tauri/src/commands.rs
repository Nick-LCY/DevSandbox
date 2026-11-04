//! 端口转发的 Tauri 命令（前端经 `window.__TAURI_INTERNALS__.invoke` 调用）。
//!
//! 三个命令：
//!
//! | 命令 | 作用 | 返回 |
//! |---|---|---|
//! | `start_forward` | **开启本机监听**（幂等：同一条转发重复开启返回现有端口） | 实际生效的本机端口 |
//! | `stop_forward` | **关闭本机监听**（关监听 + 关全部连接） | 无 |
//! | `forward_listeners` | 当前所有「已开启本机监听」的转发（前端挂载时回填用） | 监听状态数组 |
//!
//! **令牌不落盘**：令牌每次由前端经 IPC 传入（`token` 参数），只活在内存里，
//! 进程退出即失效。Rust 侧只把**后端基址**落进 `csp.rs` 的 `CspState`。
//!
//! 参数名走 Tauri 的 camelCase 约定（`forward_id` → `forwardId`）。

use tauri::{AppHandle, State};

use crate::forward::{ForwardListener, SharedForwardManager};

/// 开启一条转发的本机监听。
///
/// - `forward_id`：转发标识（后端 `ForwardModel.id`）；
/// - `backend_base_url`：后端基址（`http(s)://<host>[:port]`）；
/// - `token`：访问令牌（`Authorization: Bearer <token>`，**不落盘**）；
/// - `container_port`：容器端口（转发目标端口）；
/// - `local_port`：本机端口（缺省 = 容器端口；**被占时自动换空闲端口**）。
///
/// 返回**实际生效**的本机端口（界面必须显示它，不得显示用户输入值）。
#[tauri::command]
pub async fn start_forward(
    app: AppHandle,
    manager: State<'_, SharedForwardManager>,
    forward_id: String,
    backend_base_url: String,
    token: String,
    container_port: u16,
    local_port: Option<u16>,
) -> Result<u16, String> {
    manager
        .start(
            app,
            forward_id,
            backend_base_url,
            token,
            container_port,
            local_port,
        )
        .await
        .map_err(|err| err.message())
}

/// 关闭一条转发的本机监听（关监听 + 关全部连接）。
///
/// 这条转发没有开启本机监听时**明确报错**。
///
/// **等监听真的退出了才返回**（监听 socket 随之释放）——紧接着的「同端口重开」
/// 才不会撞上「端口还没释放」。
#[tauri::command]
pub async fn stop_forward(
    app: AppHandle,
    manager: State<'_, SharedForwardManager>,
    forward_id: String,
) -> Result<(), String> {
    manager
        .stop(&app, &forward_id)
        .await
        .map_err(|err| err.message())
}

/// 当前所有「已开启本机监听」的转发。
///
/// 前端挂载时据此回填「已开启」的行（桌面进程的内存态跨页面刷新仍在）。
#[tauri::command]
pub fn forward_listeners(manager: State<'_, SharedForwardManager>) -> Vec<ForwardListener> {
    manager.listeners()
}
