// 沙箱控制台桌面端（Tauri v2）——最小骨架。
//
// 桌面壳是「纯连接器」：装载前端静态产物、按连接配置设定 CSP、维护端口转发的
// 本机监听与隧道桥接。本期（打样轮）只保留最小骨架：
//   - 前端产物来自 `../../web/frontend/dist`（与网页形态同一份，不复制第二份）；
//   - 端口转发的 Rust 侧监听与隧道桥接在后续任务里补。
// Windows 下发布版不弹控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("沙箱控制台启动失败");
}
