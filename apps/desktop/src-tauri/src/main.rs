// 沙箱控制台桌面端（Tauri v2）——纯连接器。
//
// 桌面壳是「纯连接器」：装载前端静态产物、按连接配置设定 CSP、维护端口转发的
// 本机监听与隧道桥接。三件事：
//   - 前端产物来自 `../../web/frontend/dist`（与网页形态同一份，不复制第二份）；
//   - **CSP 由 Rust 侧在主文档被请求时注入**（见 `csp` 模块）：静态策略枚举
//     不完用户运行期才配出来的后端地址，`connect-src` 因此按**当前后端主机**
//     放行（host 级，不是 scheme 级）。
//   - **端口转发**（见 `forward` 模块）：本机 `127.0.0.1` 监听 + 隧道 WS 桥接。
//     隧道 WS 走的是 `ws(s)://<后端host>:*`，**已经在动态 CSP 的放行范围内**，
//     不需要再改 CSP 口径。
// Windows 下发布版不弹控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod csp;
mod forward;

use std::sync::{Arc, Mutex};

use tauri::http::HeaderValue;
use tauri::webview::WebviewWindowBuilder;
use tauri::WebviewUrl;

use csp::{
    apply_dynamic_csp, connect_sources, needs_csp_reload, normalize_base_url, BASE_CSP,
};
use forward::ForwardManager;

/// 主窗口的标签（与 `tauri.conf.json` 里原来的窗口配置同名同义）。
const MAIN_WINDOW_LABEL: &str = "main";

/// CSP 的运行期状态。
///
/// - `desired`：**下一次**主文档加载要用的后端基址（前端经 IPC 送进来）。
/// - `loaded`：当前主文档的 CSP 实际是按哪个基址生成的（主文档被请求时记下）。
///
/// 两者不一致 = 当前这一版主文档的 CSP 没跟上 → 前端据此重载主文档。
/// 详见 `csp` 模块的「时序契约」。
#[derive(Default)]
struct CspState {
    desired: Option<String>,
    loaded: Option<String>,
}

/// CSP 状态的共享句柄（命令闭包与 webview 钩子都要用）。
type SharedCspState = Arc<Mutex<CspState>>;

/// 取锁：锁 poisoned 时也不要把整个应用带崩（拿回内部数据继续用）。
fn lock_state(state: &Arc<Mutex<CspState>>) -> std::sync::MutexGuard<'_, CspState> {
    state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 前端把后端基址送进来：CSP 的 `connect-src` 跟着连接配置走。
///
/// 前端在保存连接配置时调用（`src/lib/connection.ts` 的 `syncDesktopBackend`），
/// 走 `window.__TAURI_INTERNALS__.invoke`，不引 `@tauri-apps/api`。
///
/// **只更新状态**：幂等（同样的值重复送进来，结果一样）。
/// 主文档的重载由前端决定（它要知道「状态更新完成」再重载，顺序不能反）。
#[tauri::command]
fn set_backend_base_url(state: tauri::State<'_, SharedCspState>, backend_base_url: String) {
    let desired = normalize_base_url(Some(&backend_base_url));
    lock_state(state.inner()).desired = desired;
}

/// 当前主文档的 CSP 跟前端要的后端主机一致吗？
///
/// 不一致 = 当前这一版主文档的 `connect-src` 里没有后端主机 → 前端要重载
/// 主文档（重载后新的一版 CSP 才带得上）。一致 = 不用重载。
///
/// **dev 构建恒返回 false**（`tauri::is_dev()`，编译期常量）：dev 下 webview 直接
/// 导航到 devUrl，主文档不经协议提供 → 「已加载 CSP」的状态机不适用（`loaded`
/// 永远是 `None`）。此时若照常判定就会永远「不一致」，前端陷入无限整页刷新。
/// 判定逻辑收敛在 `csp::needs_csp_reload`（纯函数，有单元测试）。
#[tauri::command]
fn csp_needs_reload(state: tauri::State<'_, SharedCspState>) -> bool {
    let guard = lock_state(state.inner());
    needs_csp_reload(
        tauri::is_dev(),
        guard.loaded.as_deref(),
        guard.desired.as_deref(),
    )
}

fn main() {
    // rustls 的进程级 crypto provider：只能装一次，且必须在任何 TLS 使用之前。
    // TLS 只在 forward.rs::bridge() 建 wss 隧道时才用到（tokio-tungstenite →
    // tokio-rustls → rustls::ClientConfig::builder()）。
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    let csp_state: SharedCspState = Arc::new(Mutex::new(CspState::default()));
    // 端口转发的本机监听管理器（进程内单例）。
    let forward_manager: forward::SharedForwardManager = Arc::new(ForwardManager::new());

    tauri::Builder::default()
        .manage(csp_state.clone())
        .manage(forward_manager.clone())
        .invoke_handler(tauri::generate_handler![
            set_backend_base_url,
            csp_needs_reload,
            commands::start_forward,
            commands::stop_forward,
            commands::forward_listeners
        ])
        .setup(move |app| {
            let csp_state = csp_state.clone();
            // 窗口在 Rust 侧建（不走 `tauri.conf.json` 的 `app.windows`）：
            // `on_web_resource_request` 只能在 webview 创建时挂上，
            // 运行期没有「给已有 webview 换 CSP」的接口。
            WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::default())
                .title("沙箱控制台")
                .inner_size(1280.0, 800.0)
                .min_inner_size(1024.0, 640.0)
                .resizable(true)
                .fullscreen(false)
                .on_web_resource_request(move |request, response| {
                    // 只改主文档的 CSP：其余资源（js/css/字体）不带头，改了也没意义。
                    let path = request.uri().path();
                    if path != "/" && path != "/index.html" {
                        return;
                    }
                    // 这一版主文档的 CSP 按「期望的基址」生成，并把它记成 loaded：
                    // 前端据此判断要不要再重载（时序契约见 `csp` 模块）。
                    let sources = {
                        let mut guard = lock_state(&csp_state);
                        let desired = guard.desired.clone();
                        guard.loaded = desired.clone();
                        connect_sources(desired.as_deref())
                    };
                    let headers = response.headers_mut();
                    match headers.get_mut("Content-Security-Policy") {
                        Some(header) => {
                            let Ok(policy) = header.to_str() else {
                                return;
                            };
                            let next = apply_dynamic_csp(policy, &sources);
                            if let Ok(value) = HeaderValue::from_str(&next) {
                                *header = value;
                            }
                        }
                        None => {
                            // **兜底分支，正常路径走不到**：Tauri 总会给主文档写 CSP 头
                            // （配置里的基线策略 + 构建期注入的 script 内容 hash）。
                            // 真走到这里，说明头被别的东西吃掉了。
                            //
                            // 补的是基线策略：**它不含 script 内容 hash**——hash 是构建期
                            // 由 tauri-codegen 按产物里的内联脚本算出来注入响应头的，
                            // 这里算不出来（写死会与产物脱节）。后果是内联防闪烁脚本被拦
                            // （首帧可能闪一下白），但连接不会被拦死。
                            //
                            // 发布版（Windows）没有控制台，这条提示只在开发态与终端里可见。
                            eprintln!(
                                "[csp] 主文档响应上没有 CSP 头，补一条基线策略（不含 script 内容 hash）"
                            );
                            let next = apply_dynamic_csp(BASE_CSP, &sources);
                            if let Ok(value) = HeaderValue::from_str(&next) {
                                headers.insert("Content-Security-Policy", value);
                            }
                        }
                    }
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("沙箱控制台启动失败");
}
