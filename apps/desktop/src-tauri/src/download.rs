//! 运行期文件传输的**桌面下载落盘**：原生「保存为」选路径 → 带令牌流式 GET →
//! 写用户所选路径。
//!
//! 口径来源：`docs/tasks/runtime-file-transfer/05-desktop-download.md`、
//! `apps/web/backend/API.md` 第 16 章（下载端点）、ADR 0015（桌面壳与 CSP）。
//!
//! ## 为什么桌面形态不沿用 web 的 blob 下载
//!
//! 桌面壳的 CSP 只在 `img-src` 放行 `blob:`，**导航 `blob:` URL 会被拦**；而且桌面
//! 形态要的是**原生保存框**，不是浏览器下载条。因此桌面形态 = 保存框（`dialog`
//! 插件）选路径 + Rust 侧带令牌把字节流写到那个路径。
//!
//! ## 令牌
//!
//! **Rust 侧不落盘令牌**（与 `forward.rs` / `commands.rs` 同款口径）：令牌每次由
//! 前端经 IPC 传入（`token` 参数），只活在这一次命令的栈上，用完即弃；进程退出
//! 自然失效。落盘的只有用户自己选的**目标文件**。
//!
//! ## 原子写
//!
//! 先写**同目录**的临时名（`.sandbox-download-<pid>-<序号>.part`，`create_new` 防撞名），
//! 全部写完并 `flush` 之后再 `rename` 成目标名——**半截文件不会冒充完成**。
//! 失败 / 取消 / future 被 drop 时由 [`TempGuard`] 删掉临时名（Drop 里尽力而为）。
//!
//! ## 取消
//!
//! 任务书没把「界面上的下载取消按钮」列为必做（web 形态也没有），但**关闭抽屉 /
//! 切换沙箱**必须把在途下载收干净：不留半截文件、不留挂死任务。因此命令层提供
//! `cancel_download`（`CancellationToken` 挂在进程内管理器上），由前端在抽屉关闭
//! 时调用；取消后临时文件立即删除。
//!
//! **取消可能早于登记**：前端订阅事件是 IPC 往返，抽屉在这段窗口里关掉时，
//! `cancel_download` 可能比 `download_to_disk` 先到。管理器因此保留一个**短期、
//! 有界**的「已取消但未登记」集合：后来的 `register` 命中它就直接以
//! [`CANCELLED_MESSAGE`] 收口，取消不会静默丢失。
//!
//! **登记本身用 RAII 守卫**：[`DownloadRegistration`] 在 Drop 里收掉登记，命令
//! future 被 drop（关窗 / 进程退出）也不会留下挂死的登记；退出路径另外调
//! [`DownloadManager::cancel_all`] 一次性取消全部在途任务。
//!
//! ## 事件协议
//!
//! 事件名：`download://<沙箱作用域>/<下载标识>`——**带沙箱与下载维度**，多文件
//! 并行下载互不串扰（文件名不进事件名：容器内文件名可以带空格 / 点号 / 斜杠，
//! 而 Tauri 的事件名只接受字母数字与 `-` `/` `:` `_`；文件维度由载荷里的
//! `path` 携带）。
//!
//! 载荷（[`DownloadEvent`]，蛇形命名，与 `forward.rs` 的事件载荷同款）：
//!
//! | 字段 | 说明 |
//! |---|---|
//! | `download_id` | 下载标识（前端生成，同一次下载的命令 / 事件共用一个） |
//! | `sandbox` / `path` | 沙箱名与容器内路径（文件维度） |
//! | `phase` | `progress` / `done` / `error` / `cancelled` |
//! | `loaded` / `total` | 已写字节 / 总字节（总字节取 `Content-Length`，缺省为 `null`） |
//! | `message` | 固定中文说明（`progress` 为空串） |
//! | `target_path` | 落盘路径（`done` 时给） |
//!
//! ## 错误
//!
//! 错误一律 `Result` 收口，**面向用户的文案固定中文**（前端 toast 直接展示）；
//! 状态码 / 网络错误 / IO 错误的原文只进日志（`eprintln!`，入日志前把换行压成
//! 空格，防止用户给的路径伪造日志行）。**不落盘令牌、不把令牌写日志**。
//!
//! release 是 `panic = "abort"`：本模块**零 unwrap / 零越界索引**，锁中毒时
//! 也只取回内部数据继续用。

use std::collections::{HashMap, VecDeque};
use std::io::ErrorKind as IoErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use reqwest::header::{HeaderValue, AUTHORIZATION, CONTENT_LENGTH};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State, Url};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

/// 下载进度事件名的前缀（完整名见 [`event_name`]）。
pub const DOWNLOAD_EVENT_PREFIX: &str = "download://";

/// 进度事件的最小发送间隔（大文件按块到达，逐块 emit 会把 WebView 的消息队列打满）。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// 建立连接的超时（**不设总时长超时**：大文件只要还在传就该继续跑）。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// 失败响应的错误体最多读这么多字节（后端 `detail` 是小 JSON；防异常大响应吃内存）。
const MAX_ERROR_BODY: usize = 8 * 1024;

/// 读失败响应体的整体时限（超时就不读了，按状态码固定文案收口）。
///
/// 错误体只是「让文案更具体」的锦上添花：不能因为对端慢慢吐 body 把命令挂死。
const ERROR_BODY_TIMEOUT: Duration = Duration::from_secs(8);

/// 「已取消但尚未登记」集合的容量上限（短期记忆，不随取消次数无限增长）。
const EARLY_CANCEL_CAPACITY: usize = 64;

/// 用户取消时返回给前端的固定文案（前端据此**静默收口**，不弹失败 toast）。
pub const CANCELLED_MESSAGE: &str = "下载已取消";

/// 临时名撞名时的重试次数。
const TEMP_NAME_ATTEMPTS: usize = 5;

/// 一次下载的进度 / 收场事件载荷（前端按 `download_id` 与 `path` 对到行上）。
#[derive(Clone, Debug, Serialize)]
pub struct DownloadEvent {
    /// 下载标识（前端生成，命令与事件共用）。
    pub download_id: String,
    /// 沙箱名。
    pub sandbox: String,
    /// 容器内路径（文件维度）。
    pub path: String,
    /// 阶段：`progress` / `done` / `error` / `cancelled`。
    pub phase: String,
    /// 已写字节数。
    pub loaded: u64,
    /// 总字节数（取 `Content-Length`；没有长度头时为 `null`）。
    pub total: Option<u64>,
    /// 面向用户的中文说明（`progress` 为空串）。
    pub message: String,
    /// 落盘路径（`done` 时给；其余为 `null`）。
    pub target_path: Option<String>,
}

/// 下载成功的返回值。
#[derive(Clone, Debug, Serialize)]
pub struct DownloadResult {
    /// 实际落盘的路径（用户所选路径）。
    pub target_path: String,
    /// 实际写入的字节数。
    pub bytes: u64,
}

/// 管理器内部状态（一把锁保护两组数据，避免两把锁的加锁顺序问题）。
#[derive(Default)]
struct ManagerState {
    /// 已在途下载 → 取消信号。
    cancels: HashMap<String, CancellationToken>,
    /// 取消早于登记的下载标识（短期、有界；见 `DownloadManager::cancel`）。
    early_cancels: VecDeque<String>,
}

/// 下载任务的管理器（进程内单例）：只存**取消信号**，不存令牌。
#[derive(Default)]
pub struct DownloadManager {
    state: Mutex<ManagerState>,
}

impl DownloadManager {
    /// 新建一个空的管理器。
    pub fn new() -> Self {
        Self::default()
    }

    /// 取锁：锁中毒时拿回内部数据继续用（本模块零 panic 口径）。
    fn lock(&self) -> std::sync::MutexGuard<'_, ManagerState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 登记一次下载并拿到它的取消信号（同一个标识重复登记 = 明确报错）。
    ///
    /// 返回的 [`DownloadRegistration`] 是 **RAII 守卫**：Drop 时自动收掉登记，
    /// 命令 future 被 drop 也不会泄漏。
    ///
    /// 若同一标识在登记之前就被取消过（`cancel_download` 先到），这里直接以
    /// [`CANCELLED_MESSAGE`] 收口，并把那条「早到的取消」消费掉。
    pub fn register(self: &Arc<Self>, download_id: &str) -> Result<DownloadRegistration, String> {
        let mut state = self.lock();
        if let Some(index) = state
            .early_cancels
            .iter()
            .position(|id| id == download_id)
        {
            state.early_cancels.remove(index);
            return Err(CANCELLED_MESSAGE.to_string());
        }
        if state.cancels.contains_key(download_id) {
            return Err("下载任务标识重复，请重试".to_string());
        }
        let token = CancellationToken::new();
        state.cancels.insert(download_id.to_string(), token.clone());
        Ok(DownloadRegistration {
            manager: Arc::clone(self),
            download_id: download_id.to_string(),
            cancel: token,
        })
    }

    /// 收掉登记（由 [`DownloadRegistration`] 的 Drop 调用）。
    fn finish(&self, download_id: &str) {
        let mut state = self.lock();
        state.cancels.remove(download_id);
    }

    /// 取消一次在途下载（**幂等**）。
    ///
    /// 找不到标识时**不静默丢弃**：记进短期集合，等对应的 `register` 到达时
    /// 直接以取消收口（订阅 IPC 往返窗口里关抽屉就是这条路径）。集合有容量上限，
    /// 满了就丢最旧的一条——它只用于「马上要开始的那一次下载」。
    fn cancel(&self, download_id: &str) {
        let mut state = self.lock();
        if let Some(token) = state.cancels.get(download_id) {
            token.cancel();
            return;
        }
        if download_id.is_empty() || state.early_cancels.iter().any(|id| id == download_id) {
            return;
        }
        if state.early_cancels.len() >= EARLY_CANCEL_CAPACITY {
            state.early_cancels.pop_front();
        }
        state.early_cancels.push_back(download_id.to_string());
    }

    /// 取消并清空**全部**在途下载（窗口 Destroyed / 应用退出时调用）。
    pub fn cancel_all(&self) {
        let mut state = self.lock();
        for token in state.cancels.values() {
            token.cancel();
        }
        state.cancels.clear();
        state.early_cancels.clear();
    }
}

/// 一次已登记下载的凭据：持有取消信号，Drop 时把登记收掉。
///
/// 命令里不要手动 `finish`——Drop 覆盖成功 / 失败 / 取消 / future 被 drop 全部路径。
pub struct DownloadRegistration {
    manager: Arc<DownloadManager>,
    download_id: String,
    cancel: CancellationToken,
}

impl DownloadRegistration {
    /// 本次下载的取消信号（只读）。
    pub fn cancel_token(&self) -> &CancellationToken {
        &self.cancel
    }
}

impl Drop for DownloadRegistration {
    fn drop(&mut self) {
        self.manager.finish(&self.download_id);
    }
}

/// 管理器的共享句柄（`main.rs` 挂到 Tauri 状态上）。
pub type SharedDownloadManager = Arc<DownloadManager>;

/// 下载标识的合法字符集（它要进事件名，必须过 Tauri 的事件名校验）。
pub fn is_valid_download_id(raw: &str) -> bool {
    !raw.is_empty()
        && raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 沙箱名的合法字符集：只接受 ASCII 字母数字与 `-` `_`（它要进 URL 路径段）。
///
/// 容器内路径有严格的 `/` 前缀校验；沙箱名同样必须在**拼 URL 之前**拒掉 `.`、`..`、
/// `/`、空格等字符，避免被解释成别的路径段。
pub fn is_valid_sandbox_name(raw: &str) -> bool {
    !raw.is_empty()
        && raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 沙箱名在事件名里的作用域：只保留字母数字与 `-` `_`，其余替换成 `_`。
///
/// 前端 `src/lib/desktop-file.ts` 的 `downloadEventScope` 必须与本函数逐字符一致。
///
/// **作用域只做事件名合法性过滤，不承担隔离**：不同沙箱名可能折叠到同一个作用域
/// （如 `a.b` 与 `a_b`）。多下载之间的隔离靠事件名里的 `download_id`（前端生成、
/// 单调递增且带会话随机前缀），载荷里还有 `download_id` 再兜一层。
pub fn event_scope(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 一次下载的事件名：`download://<沙箱作用域>/<下载标识>`。
pub fn event_name(sandbox: &str, download_id: &str) -> String {
    format!(
        "{DOWNLOAD_EVENT_PREFIX}{}/{}",
        event_scope(sandbox),
        download_id
    )
}

/// 后端基址 + 沙箱名 + 容器内路径 → 下载端点 URL。
///
/// 形态：`<基址>/api/sandboxes/<沙箱>/files/download?path=<百分号编码>`。
/// 基址只表示「后端在哪个主机的哪个端口」——路径 / 参数 / `#` 一律拒绝
/// （与前端 `validateBaseUrl`、`forward.rs::tunnel_ws_url` 一个口径）。
pub fn build_download_url(
    backend_base_url: &str,
    sandbox: &str,
    path: &str,
) -> Result<String, String> {
    let text = backend_base_url.trim();
    if text.is_empty() {
        return Err("后端地址为空，无法下载".to_string());
    }
    let sandbox = sandbox.trim();
    if sandbox.is_empty() {
        return Err("沙箱名为空，无法下载".to_string());
    }
    if !is_valid_sandbox_name(sandbox) {
        return Err("沙箱名含非法字符，无法下载".to_string());
    }
    if path.trim().is_empty() {
        return Err("容器内路径不能为空".to_string());
    }
    if !path.starts_with('/') {
        return Err("容器内路径必须是绝对路径".to_string());
    }

    let mut url = Url::parse(text).map_err(|_| "后端地址格式不对，无法下载".to_string())?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err("后端地址只支持 http 与 https".to_string()),
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("后端地址不要带路径、参数或 #（下载接口在根路径下）".to_string());
    }

    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "后端地址格式不对，无法下载".to_string())?;
        segments.pop_if_empty();
        segments.extend(["api", "sandboxes", sandbox, "files", "download"]);
    }
    url.query_pairs_mut().append_pair("path", path);
    Ok(url.to_string())
}

/// 从响应头取 `Content-Length`（非法值 / 缺失 → `None`，进度按「总长未知」处理）。
pub fn content_length(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let raw = headers.get(CONTENT_LENGTH)?.to_str().ok()?.trim();
    if raw.is_empty() {
        return None;
    }
    raw.parse::<u64>().ok()
}

/// 从后端的错误体里取 `detail`（固定中文文案）。
///
/// 取不到（不是 JSON / 没有 `detail` / 空串）→ `None`。过长的文案截断到 500 字符，
/// 避免异常响应把 toast 撑爆。
pub fn parse_detail(body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let detail = value.get("detail")?.as_str()?.trim();
    if detail.is_empty() {
        return None;
    }
    Some(detail.chars().take(500).collect())
}

/// 失败响应的固定中文文案。
///
/// 401 统一成「令牌无效」（后端对缺失与错误不区分）；其余状态优先用后端 `detail`
/// （后端承诺是固定中文、不含宿主信息），取不到才用状态码兜底。
pub fn status_message(status: u16, detail: Option<String>) -> String {
    if status == 401 {
        return status_fallback_message(status);
    }
    detail.unwrap_or_else(|| status_fallback_message(status))
}

/// 没有错误体可用时的固定文案（只按状态码，不含任何响应内容）。
fn status_fallback_message(status: u16) -> String {
    if status == 401 {
        "访问令牌无效，请检查连接配置".to_string()
    } else {
        format!("下载失败（HTTP {status}）")
    }
}

/// 声明的总长度与实际写入是否不一致（两个方向都算「不完整」）。
///
/// 服务端可能按声明长度裁剪、文件也可能在传输中变小：**不拿半截内容冒充完成**。
pub fn length_mismatch(loaded: u64, total: Option<u64>) -> bool {
    total.is_some_and(|expected| loaded != expected)
}

/// 临时文件路径：**与目标同目录**（rename 才能原子替换）+ 带 pid / 序号。
///
/// 名字以点开头：在 Unix 下会被 `ls` 默认当成隐藏文件，**Windows 下不是隐藏属性**
/// （这里只是命名约定，不保证不可见）。名字**不重复目标文件名**：Windows 的路径
/// 上限是 260 字符，用户选的路径已经很长时再叠一份文件名就可能直接打不开；短名字
/// 只多出固定的一小段（pid + 序号保证唯一）。
pub fn temp_path_for(target: &Path, seq: u64) -> Result<PathBuf, String> {
    if target.file_name().is_none() {
        return Err("保存路径不是文件".to_string());
    }
    Ok(target.with_file_name(format!(
        ".sandbox-download-{}-{seq:x}.part",
        std::process::id()
    )))
}

/// 入日志前单行化（用户给的容器内路径可以带换行 / 制表符，原样入日志就是日志伪造）。
///
/// 用 `char::is_control()` 覆盖全部控制字符（不只是 `\n` `\r`），把它们压成空格。
fn single_line(detail: &str) -> String {
    detail
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// 打一条单行日志（`context` 是我们自己写的固定文本，`detail` 可能来自用户 / 对端）。
fn log_line(context: &str, detail: &str) {
    eprintln!("[download] {context}：{}", single_line(detail));
}

/// 发一条下载事件；发不出去只记日志（进度是辅助信息，不能反过来打断下载）。
fn emit_event(app: &AppHandle, event: &str, payload: DownloadEvent) {
    if let Err(err) = app.emit(event, payload) {
        log_line("下载事件发不出去", &err.to_string());
    }
}

/// 组装一条事件载荷（字段太多，统一在这里填，免得各分支漏字段）。
fn make_event(
    sandbox: &str,
    path: &str,
    download_id: &str,
    phase: &str,
    loaded: u64,
    total: Option<u64>,
    message: &str,
    target_path: Option<&str>,
) -> DownloadEvent {
    DownloadEvent {
        download_id: download_id.to_string(),
        sandbox: sandbox.to_string(),
        path: path.to_string(),
        phase: phase.to_string(),
        loaded,
        total,
        message: message.to_string(),
        target_path: target_path.map(|text| text.to_string()),
    }
}

/// 临时名的 Drop 守卫：没 `commit` 就删掉（失败 / 取消 / future 被 drop 都走这里）。
struct TempGuard {
    path: PathBuf,
    committed: bool,
}

impl TempGuard {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    /// rename 成功之后调用：临时名已经成为目标名，别再删了。
    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        if let Err(err) = std::fs::remove_file(&self.path) {
            if err.kind() != IoErrorKind::NotFound {
                log_line("清理临时文件失败", &err.to_string());
            }
        }
    }
}

/// 建临时文件（同目录、`create_new` 防撞名；撞名就换下一个序号重试）。
async fn create_temp_file(target: &Path) -> Result<(tokio::fs::File, PathBuf), String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let mut last_reason = String::new();
    for _ in 0..TEMP_NAME_ATTEMPTS {
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let temp = temp_path_for(target, seq)?;
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .await
        {
            Ok(file) => return Ok((file, temp)),
            Err(err) if err.kind() == IoErrorKind::AlreadyExists => {
                last_reason = err.to_string();
            }
            Err(err) => {
                log_line("创建临时文件失败", &err.to_string());
                return Err("写入文件失败，请检查所选路径是否可写".to_string());
            }
        }
    }
    log_line("临时文件名一直撞名", &last_reason);
    Err("写入文件失败，请检查所选路径是否可写".to_string())
}

/// 读失败响应体的结果。
///
/// 超时 / 取消时**放弃读 body**（调用方按状态码固定文案收口），绝不让错误体
/// 把命令挂死。
enum ErrorBody {
    /// 读到的内容（最多 [`MAX_ERROR_BODY`] 字节；中途读失败也返回已读部分）。
    Body(Vec<u8>),
    /// 整体时限用尽，放弃读 body。
    TimedOut,
    /// 任务已被取消。
    Cancelled,
}

/// 读失败响应的 body（最多 [`MAX_ERROR_BODY`] 字节）。
///
/// - 每读一块都挂 `cancel.cancelled()`：取消能立刻打断慢 body；
/// - 整体限时 `timeout`：对端慢慢吐 body 时放弃（超时不是取消，按状态码收口）。
async fn read_error_body(
    response: reqwest::Response,
    cancel: &CancellationToken,
    timeout: Duration,
) -> ErrorBody {
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let mut response = response;
    let mut body: Vec<u8> = Vec::new();
    while body.len() < MAX_ERROR_BODY {
        let chunk = tokio::select! {
            biased;
            _ = cancel.cancelled() => return ErrorBody::Cancelled,
            _ = &mut deadline => {
                log_line(
                    "读取错误响应体超时",
                    &format!("已读 {} 字节", body.len()),
                );
                return ErrorBody::TimedOut;
            }
            next = response.chunk() => next,
        };
        match chunk {
            Ok(Some(chunk)) => {
                let room = MAX_ERROR_BODY.saturating_sub(body.len());
                if room == 0 {
                    break;
                }
                let take = chunk.len().min(room);
                body.extend_from_slice(&chunk[..take]);
            }
            Ok(None) => break,
            Err(err) => {
                log_line("读取错误响应体失败", &err.to_string());
                break;
            }
        }
    }
    ErrorBody::Body(body)
}

/// HTTP 客户端单例（连接超时 + **不跟随跳转**）。
///
/// 下载端点是固定路由：后端返回 3xx 时应当如实当失败处理，不能悄悄跟到别的主机
/// 去（那会把 `Authorization` 头带到跳转目标）。
static HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    match reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            log_line("构建 HTTP 客户端失败，退回默认客户端", &err.to_string());
            reqwest::Client::new()
        }
    }
});

/// 下载前的前置检查：目标是**已存在的目录**时直接拒绝（不白跑一趟下载）。
///
/// 其余 `metadata` 错误不拦（路径可能还不存在 / 父目录权限交给真正的写盘去报）。
async fn ensure_target_is_file(target: &Path) -> Result<(), String> {
    match tokio::fs::metadata(target).await {
        Ok(meta) if meta.is_dir() => Err("保存路径是一个目录，无法保存文件".to_string()),
        Ok(_) => Ok(()),
        Err(err) => {
            if err.kind() != IoErrorKind::NotFound {
                log_line("检查保存路径失败（继续尝试）", &err.to_string());
            }
            Ok(())
        }
    }
}

/// `rename` 失败时的可读文案（Windows 上目标文件被占用是最常见的失败）。
fn rename_failure_message(err: &std::io::Error) -> &'static str {
    if err.kind() == IoErrorKind::PermissionDenied {
        "目标文件可能正被其它程序占用，请关闭后重试"
    } else {
        "保存文件失败，请检查所选路径是否可用"
    }
}

/// 下载落盘命令（前端经 `window.__TAURI_INTERNALS__.invoke` 调用）。
///
/// - `sandbox` / `path`：下载哪个沙箱里的哪个容器内文件；
/// - `target_path`：**用户所选**的保存路径（保存框返回值，不由前端拼）；
/// - `backend_base_url` / `token`：后端基址与访问令牌（令牌**不落盘**）；
/// - `download_id`：前端生成的任务标识（命令与事件共用，事件名带沙箱 + 它）。
#[tauri::command]
pub async fn download_to_disk(
    app: AppHandle,
    manager: State<'_, SharedDownloadManager>,
    sandbox: String,
    path: String,
    target_path: String,
    backend_base_url: String,
    token: String,
    download_id: String,
) -> Result<DownloadResult, String> {
    let sandbox = sandbox.trim().to_string();
    let path = path.trim().to_string();
    let download_id = download_id.trim().to_string();

    if !is_valid_download_id(&download_id) {
        return Err("下载任务标识不合法".to_string());
    }
    if token.trim().is_empty() {
        return Err("访问令牌为空，无法下载（请在设置里填好令牌）".to_string());
    }
    // 只把「全空白」当空；路径首尾的空格可能是合法文件名的一部分，不 trim。
    if target_path.trim().is_empty() {
        return Err("保存路径为空".to_string());
    }
    let target = target_path.as_str();
    let url = build_download_url(&backend_base_url, &sandbox, &path)?;
    let event = event_name(&sandbox, &download_id);

    let manager = manager.inner().clone();
    // 登记守卫：Drop 时收掉登记（命令 future 被 drop 也不漏）。
    let registration = manager.register(&download_id)?;
    run_download(
        &app,
        &event,
        &sandbox,
        &path,
        Path::new(target),
        &url,
        token.trim(),
        &download_id,
        registration.cancel_token(),
    )
    .await
}

/// 取消一次在途下载（**幂等**：已经结束 / 不存在的标识静默忽略）。
///
/// 取消后：流式读取立即停下、临时文件被删除、命令返回 [`CANCELLED_MESSAGE`]。
#[tauri::command]
pub fn cancel_download(manager: State<'_, SharedDownloadManager>, download_id: String) {
    manager.cancel(download_id.trim());
}

/// 下载的主体：GET → 临时文件 → rename → 事件上报。
#[allow(clippy::too_many_arguments)]
async fn run_download(
    app: &AppHandle,
    event: &str,
    sandbox: &str,
    path: &str,
    target: &Path,
    url: &str,
    token: &str,
    download_id: &str,
    cancel: &CancellationToken,
) -> Result<DownloadResult, String> {
    let header = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "访问令牌含非法字符".to_string())?;

    // 目标已是目录：先拒掉，不发请求、不白下载。
    if let Err(message) = ensure_target_is_file(target).await {
        emit_event(
            app,
            event,
            make_event(sandbox, path, download_id, "error", 0, None, &message, None),
        );
        return Err(message);
    }

    let client = &*HTTP_CLIENT;

    let response = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            emit_event(
                app,
                event,
                make_event(sandbox, path, download_id, "cancelled", 0, None, CANCELLED_MESSAGE, None),
            );
            return Err(CANCELLED_MESSAGE.to_string());
        }
        result = client.get(url).header(AUTHORIZATION, header).send() => match result {
            Ok(response) => response,
            Err(err) => {
                log_line("下载请求失败", &err.to_string());
                let message = "无法连接后端服务，请确认后端已启动".to_string();
                emit_event(
                    app,
                    event,
                    make_event(sandbox, path, download_id, "error", 0, None, &message, None),
                );
                return Err(message);
            }
        }
    };

    let status = response.status();
    if !status.is_success() {
        let message = match read_error_body(response, cancel, ERROR_BODY_TIMEOUT).await {
            ErrorBody::Body(body) => {
                log_line(
                    &format!("下载请求返回 HTTP {}", status.as_u16()),
                    &String::from_utf8_lossy(&body),
                );
                status_message(status.as_u16(), parse_detail(&body))
            }
            ErrorBody::TimedOut => {
                // 不读了：按状态码固定文案收口（不猜后端 detail）。
                let message = status_fallback_message(status.as_u16());
                log_line(
                    &format!("下载请求返回 HTTP {}（错误体超时未读完）", status.as_u16()),
                    &message,
                );
                message
            }
            ErrorBody::Cancelled => {
                emit_event(
                    app,
                    event,
                    make_event(sandbox, path, download_id, "cancelled", 0, None, CANCELLED_MESSAGE, None),
                );
                return Err(CANCELLED_MESSAGE.to_string());
            }
        };
        emit_event(
            app,
            event,
            make_event(sandbox, path, download_id, "error", 0, None, &message, None),
        );
        return Err(message);
    }

    let total = content_length(response.headers());
    if cancel.is_cancelled() {
        emit_event(
            app,
            event,
            make_event(sandbox, path, download_id, "cancelled", 0, total, CANCELLED_MESSAGE, None),
        );
        return Err(CANCELLED_MESSAGE.to_string());
    }

    let (file, temp) = match create_temp_file(target).await {
        Ok(pair) => pair,
        Err(message) => {
            emit_event(
                app,
                event,
                make_event(sandbox, path, download_id, "error", 0, total, &message, None),
            );
            return Err(message);
        }
    };
    let mut guard = TempGuard::new(temp.clone());
    let mut writer = tokio::io::BufWriter::new(file);
    let mut response = response;
    let mut loaded: u64 = 0;
    let mut last_emit = Instant::now()
        .checked_sub(PROGRESS_INTERVAL)
        .unwrap_or_else(Instant::now);

    loop {
        let chunk = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                drop(writer);
                emit_event(
                    app,
                    event,
                    make_event(sandbox, path, download_id, "cancelled", loaded, total, CANCELLED_MESSAGE, None),
                );
                return Err(CANCELLED_MESSAGE.to_string());
            }
            next = response.chunk() => next,
        };

        match chunk {
            Ok(Some(bytes)) => {
                if let Err(err) = writer.write_all(&bytes).await {
                    log_line("写入临时文件失败", &err.to_string());
                    drop(writer);
                    let message = "写入文件失败，请检查所选路径是否可写".to_string();
                    emit_event(
                        app,
                        event,
                        make_event(sandbox, path, download_id, "error", loaded, total, &message, None),
                    );
                    return Err(message);
                }
                loaded = loaded.saturating_add(bytes.len() as u64);
                if last_emit.elapsed() >= PROGRESS_INTERVAL {
                    last_emit = Instant::now();
                    emit_event(
                        app,
                        event,
                        make_event(sandbox, path, download_id, "progress", loaded, total, "", None),
                    );
                }
            }
            Ok(None) => break,
            Err(err) => {
                log_line("读取下载流失败", &err.to_string());
                drop(writer);
                let message = "下载中断，请重试".to_string();
                emit_event(
                    app,
                    event,
                    make_event(sandbox, path, download_id, "error", loaded, total, &message, None),
                );
                return Err(message);
            }
        }
    }

    if let Err(err) = writer.flush().await {
        log_line("刷新临时文件失败", &err.to_string());
        drop(writer);
        let message = "写入文件失败，请检查所选路径是否可写".to_string();
        emit_event(
            app,
            event,
            make_event(sandbox, path, download_id, "error", loaded, total, &message, None),
        );
        return Err(message);
    }
    drop(writer);

    // 服务端按声明长度裁剪、文件在传输中变小时 body 会短于声明值：两种方向都当
    // 「不完整」处理（**不拿半截内容冒充完成**）。判定收敛在纯函数里。
    if length_mismatch(loaded, total) {
        log_line(
            "下载长度与声明不一致",
            &format!("已写 {loaded} 字节，声明 {total:?} 字节"),
        );
        let message = "下载不完整，请重试".to_string();
        emit_event(
            app,
            event,
            make_event(sandbox, path, download_id, "error", loaded, total, &message, None),
        );
        return Err(message);
    }

    if cancel.is_cancelled() {
        emit_event(
            app,
            event,
            make_event(sandbox, path, download_id, "cancelled", loaded, total, CANCELLED_MESSAGE, None),
        );
        return Err(CANCELLED_MESSAGE.to_string());
    }

    // 原子替换：同目录临时名 → 目标名。Windows 的 `rename` 语义是「替换已有文件」
    // （std 用 MoveFileEx + MOVEFILE_REPLACE_EXISTING），保存框已经问过是否覆盖。
    if let Err(err) = tokio::fs::rename(&temp, target).await {
        log_line("替换目标文件失败", &err.to_string());
        let message = rename_failure_message(&err).to_string();
        emit_event(
            app,
            event,
            make_event(sandbox, path, download_id, "error", loaded, total, &message, None),
        );
        return Err(message);
    }
    guard.commit();

    let target_text = target.to_string_lossy().to_string();
    emit_event(
        app,
        event,
        make_event(
            sandbox,
            path,
            download_id,
            "done",
            loaded,
            total,
            "下载完成",
            Some(&target_text),
        ),
    );
    Ok(DownloadResult {
        target_path: target_text,
        bytes: loaded,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 后端基址拼出下载端点且路径做百分号编码() {
        let url = build_download_url(
            "http://10.0.0.5:8000",
            "demo-01",
            "/home/用户/a b.txt",
        )
        .expect("应能拼出 URL");
        assert!(url.starts_with("http://10.0.0.5:8000/api/sandboxes/demo-01/files/download?path="));
        assert!(url.contains("%E7%94%A8%E6%88%B7"));
        assert!(url.contains("a+b.txt") || url.contains("a%20b.txt"));
        // 路径作为查询参数编码，不会变成真的路径段。
        assert!(!url.contains("/home/"));
    }

    #[test]
    fn 后端基址带路径参数或片段一律拒绝() {
        assert!(build_download_url("http://h:8000/api", "s", "/a").is_err());
        assert!(build_download_url("http://h:8000?x=1", "s", "/a").is_err());
        assert!(build_download_url("http://h:8000#frag", "s", "/a").is_err());
        assert!(build_download_url("ftp://h:8000", "s", "/a").is_err());
        assert!(build_download_url("", "s", "/a").is_err());
        assert!(build_download_url("http://h:8000", "  ", "/a").is_err());
    }

    #[test]
    fn 容器内路径必须是绝对路径() {
        assert!(build_download_url("http://h:8000", "s", "relative").is_err());
        assert!(build_download_url("http://h:8000", "s", "  ").is_err());
    }

    #[test]
    fn 事件名带沙箱作用域与下载标识() {
        assert_eq!(
            event_name("demo-01", "dl-1"),
            "download://demo-01/dl-1"
        );
        // 文件名 / 沙箱名里的空格与点号会被替换（Tauri 事件名不接受它们）。
        assert_eq!(event_name("my box.v2", "dl-2"), "download://my_box_v2/dl-2");
        // 中文按「非 ASCII 字母数字」替换（事件名只放行 ASCII 的字母数字与 - / : _）。
        assert_eq!(event_name("沙箱一", "dl-3"), "download://___/dl-3");
    }

    #[test]
    fn 下载标识只接受字母数字与短横线下划线() {
        assert!(is_valid_download_id("dl-1"));
        assert!(is_valid_download_id("a_b"));
        assert!(!is_valid_download_id(""));
        assert!(!is_valid_download_id("dl/1"));
        assert!(!is_valid_download_id("dl 1"));
        assert!(!is_valid_download_id("下载"));
    }

    #[test]
    fn 临时名与目标同目录且带_pid() {
        let target = Path::new("/tmp/报告.txt");
        let temp = temp_path_for(target, 7).expect("应有临时名");
        assert_eq!(temp.parent(), target.parent());
        let name = temp
            .file_name()
            .and_then(|item| item.to_str())
            .expect("临时名应是合法文本");
        assert!(name.starts_with(".sandbox-download-"));
        assert!(name.ends_with("-7.part"));
        // 目标没有文件名（比如根目录）→ 明确报错，不 panic。
        assert!(temp_path_for(Path::new("/"), 1).is_err());
    }

    #[test]
    fn content_length_只认合法数字() {
        let mut headers = reqwest::header::HeaderMap::new();
        assert_eq!(content_length(&headers), None);
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("123"));
        assert_eq!(content_length(&headers), Some(123));
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static(" 456 "));
        assert_eq!(content_length(&headers), Some(456));
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("-1"));
        assert_eq!(content_length(&headers), None);
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("abc"));
        assert_eq!(content_length(&headers), None);
    }

    #[test]
    fn 从错误体里取后端_detail() {
        assert_eq!(
            parse_detail("{\"detail\":\"文件不存在\"}".as_bytes()).as_deref(),
            Some("文件不存在")
        );
        assert_eq!(parse_detail("{\"detail\":\"  \"}".as_bytes()), None);
        assert_eq!(parse_detail(b"{\"other\":1}"), None);
        assert_eq!(parse_detail(b"not json"), None);
        assert_eq!(parse_detail(b""), None);
    }

    #[test]
    fn 失败状态码映射成固定中文文案() {
        assert_eq!(
            status_message(401, Some("别的说法".to_string())),
            "访问令牌无效，请检查连接配置"
        );
        assert_eq!(
            status_message(404, Some("文件不存在".to_string())),
            "文件不存在"
        );
        assert_eq!(status_message(500, None), "下载失败（HTTP 500）");
    }

    #[test]
    fn 管理器登记与取消是幂等的() {
        let manager = Arc::new(DownloadManager::new());
        let registration = manager.register("dl-1").expect("首次登记应成功");
        // 同一标识重复登记：明确报错（不悄悄替换正在跑的那一个）。
        assert!(manager.register("dl-1").is_err());
        manager.cancel("dl-1");
        assert!(registration.cancel_token().is_cancelled());
        // 取消一个不存在的标识：不报错（记入短期集合，见下面的用例）。
        manager.cancel("dl-x");
        drop(registration);
        // 收掉之后可以复用同一标识。
        assert!(manager.register("dl-1").is_ok());
    }

    #[test]
    fn 取消早于登记时以取消收口而不是静默丢失() {
        let manager = Arc::new(DownloadManager::new());
        // 订阅 IPC 往返窗口里关抽屉：取消先到，命令还没登记。
        manager.cancel("dl-early");
        let message = manager
            .register("dl-early")
            .err()
            .expect("应直接以取消收口");
        assert_eq!(message, CANCELLED_MESSAGE);
        // 命中即消费：同一标识随后还能重新登记。
        assert!(manager.register("dl-early").is_ok());
    }

    #[test]
    fn 命令_future_被_drop_时登记被清理() {
        let manager = Arc::new(DownloadManager::new());
        let for_future = Arc::clone(&manager);
        let future = async move {
            let _registration = for_future.register("dl-drop").expect("登记应成功");
            std::future::pending::<()>().await;
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("应能建测试运行时");
        // 超时 = future 在「已登记」状态被 drop（模拟命令 future 被丢弃）。
        let outcome = runtime.block_on(async {
            tokio::time::timeout(Duration::from_millis(20), future).await
        });
        assert!(outcome.is_err());
        // 如果 Drop 没收掉登记，这里会报「标识重复」。
        assert!(manager.register("dl-drop").is_ok());
    }

    #[test]
    fn 退出时取消全部在途下载() {
        let manager = Arc::new(DownloadManager::new());
        let first = manager.register("dl-a").expect("登记应成功");
        let second = manager.register("dl-b").expect("登记应成功");
        manager.cancel_all();
        assert!(first.cancel_token().is_cancelled());
        assert!(second.cancel_token().is_cancelled());
        drop(first);
        drop(second);
        assert!(manager.register("dl-a").is_ok());
    }

    #[test]
    fn 长度不符判定两个方向都算不完整() {
        assert!(!length_mismatch(10, None));
        assert!(!length_mismatch(10, Some(10)));
        assert!(!length_mismatch(0, Some(0)));
        assert!(length_mismatch(9, Some(10)));
        assert!(length_mismatch(11, Some(10)));
    }

    #[test]
    fn 沙箱名只接受字母数字短横线下划线() {
        assert!(is_valid_sandbox_name("demo-01"));
        assert!(is_valid_sandbox_name("a_b"));
        assert!(!is_valid_sandbox_name(""));
        assert!(!is_valid_sandbox_name("a/b"));
        assert!(!is_valid_sandbox_name("a b"));
        assert!(!is_valid_sandbox_name("沙箱"));
    }

    #[test]
    fn 沙箱名里的_点点_在拼_url_之前就被拒掉() {
        let message = build_download_url("http://h:8000", "..", "/a")
            .err()
            .expect("`..` 应被拒绝");
        assert_eq!(message, "沙箱名含非法字符，无法下载");
        assert!(build_download_url("http://h:8000", ".", "/a").is_err());
        assert!(build_download_url("http://h:8000", "a/b", "/a").is_err());
        assert!(build_download_url("http://h:8000", "a%2fb", "/a").is_err());
        // 合法名字照常拼。
        assert!(build_download_url("http://h:8000", "demo_01-x", "/a").is_ok());
    }

    #[test]
    fn 日志单行化把控制字符压成空格() {
        assert_eq!(single_line("a\nb\rc\td"), "a b c d");
        assert_eq!(single_line("正常路径/a.txt"), "正常路径/a.txt");
    }

    #[test]
    fn 重命名失败按错误类型给可读文案() {
        let denied = std::io::Error::from(IoErrorKind::PermissionDenied);
        assert_eq!(
            rename_failure_message(&denied),
            "目标文件可能正被其它程序占用，请关闭后重试"
        );
        let other = std::io::Error::from(IoErrorKind::AlreadyExists);
        assert_eq!(
            rename_failure_message(&other),
            "保存文件失败，请检查所选路径是否可用"
        );
    }

    /// 每个用例独占的临时目录（不引额外 crate）。
    fn unique_temp_dir() -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "sandbox-download-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("应能建临时目录");
        dir
    }

    #[test]
    fn 临时文件守卫_drop_删除_commit_保留() {
        let dir = unique_temp_dir();

        let dropped = dir.join("drop.part");
        std::fs::write(&dropped, b"x").expect("应能写临时文件");
        {
            let _guard = TempGuard::new(dropped.clone());
        }
        assert!(!dropped.exists(), "没 commit 的临时文件应在 Drop 时删掉");

        let kept = dir.join("kept.part");
        std::fs::write(&kept, b"x").expect("应能写临时文件");
        {
            let mut guard = TempGuard::new(kept.clone());
            guard.commit();
        }
        assert!(kept.exists(), "commit 之后的临时文件（已改名）应保留");

        std::fs::remove_dir_all(&dir).expect("应能清理临时目录");
    }

    #[tokio::test]
    async fn 目标是已存在目录时前置拒绝() {
        let dir = unique_temp_dir();
        let message = ensure_target_is_file(&dir)
            .await
            .err()
            .expect("目录应被拒绝");
        assert_eq!(message, "保存路径是一个目录，无法保存文件");

        let file = dir.join("f.txt");
        std::fs::write(&file, b"x").expect("应能写文件");
        assert!(ensure_target_is_file(&file).await.is_ok());
        // 不存在的路径交给后面的写盘去报，不在这里拦。
        assert!(ensure_target_is_file(&dir.join("missing.txt")).await.is_ok());

        std::fs::remove_dir_all(&dir).expect("应能清理临时目录");
    }

    /// 起一个只服务一次的本机 HTTP 服务：先回响应头，再按 `(chunk, delay)` 逐段写 body。
    async fn one_shot_response(
        head: &'static str,
        chunks: Vec<(Vec<u8>, Duration)>,
    ) -> reqwest::Response {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("应能绑定本机端口");
        let addr = listener.local_addr().expect("应能取到实际端口");
        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            // 读掉请求头（不读很可能让对端在 close 时吃 RST）。
            let mut request = Vec::new();
            loop {
                let mut buf = [0u8; 512];
                match socket.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        request.extend_from_slice(&buf[..n]);
                        if request.windows(4).any(|window| window == b"\r\n\r\n") {
                            break;
                        }
                    }
                    Err(_) => return,
                }
            }
            if socket.write_all(head.as_bytes()).await.is_err() {
                return;
            }
            for (bytes, delay) in chunks {
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                if socket.write_all(&bytes).await.is_err() {
                    return;
                }
            }
            let _ = socket.shutdown().await;
        });
        HTTP_CLIENT
            .get(format!("http://{addr}/"))
            .send()
            .await
            .expect("应能拿到响应")
    }

    #[tokio::test]
    async fn 错误体最多读_8kib_且慢_body_与取消都能打断() {
        // ① 超过上限：只留前 MAX_ERROR_BODY 字节。
        let payload = vec![b'a'; MAX_ERROR_BODY + 4096];
        let response = one_shot_response(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 12288\r\n\r\n",
            vec![(payload, Duration::ZERO)],
        )
        .await;
        match read_error_body(response, &CancellationToken::new(), Duration::from_secs(5)).await {
            ErrorBody::Body(body) => assert_eq!(body.len(), MAX_ERROR_BODY),
            _ => panic!("应读到错误体"),
        }

        // ② 慢 body：整体时限到了就放弃。
        let response = one_shot_response(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 100\r\n\r\n",
            vec![(vec![b'b'; 100], Duration::from_secs(2))],
        )
        .await;
        assert!(matches!(
            read_error_body(response, &CancellationToken::new(), Duration::from_millis(100)).await,
            ErrorBody::TimedOut
        ));

        // ③ 已取消：立刻返回 Cancelled（不等 body）。
        let response = one_shot_response(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 100\r\n\r\n",
            vec![(vec![b'c'; 100], Duration::from_secs(2))],
        )
        .await;
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(matches!(
            read_error_body(response, &cancel, Duration::from_secs(5)).await,
            ErrorBody::Cancelled
        ));
    }
}
