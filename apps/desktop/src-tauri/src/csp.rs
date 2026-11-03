//! 桌面壳的 CSP（内容安全策略）：基线策略与运行期改写。
//!
//! 三条口径（依据：ADR 0015 第 6 节 + 三期 PRD「工作包五」+ 任务 03 的完成标准）：
//!
//! 1. **`connect-src` 只放行「当前后端主机」**（host 级，不是 scheme 级）。
//!    形态是 `http(s)://<后端host>:*` 与 `ws(s)://<后端host>:*`（端口用通配：
//!    连的是「这台主机上的后端」，端口由用户自己填）。
//!    **不放行 `http:` / `https:` / `ws:` / `wss:` 这类 scheme 通配**——
//!    那等于「页面能往任意主机连」，CSP 就失去意义了。
//!    真正的准入边界是**令牌与一次性票据**（后端侧校验），CSP 只管「页面能往哪台主机连」。
//!
//! 2. **`script-src` 不放行 `unsafe-inline`**。
//!    前端产物里有一段内联的防闪烁脚本（`index.html` 的主题脚本），它靠
//!    **内容 hash**（`'sha256-...'`）放行：hash 由 Tauri 在**构建期**按产物
//!    `index.html` 里的内联脚本内容算出来并注入策略（tauri-codegen 的
//!    `inject_script_hashes`）。因此配置里只写 `script-src 'self'`——hash 是
//!    构建期算的，永远跟着产物走，不会因为改了脚本就失效。
//!
//! 3. **`style-src` 放行 `unsafe-inline`**。
//!    xterm.js 与 React 都会写**行内样式**（xterm 的终端表面定位、toast 的
//!    倒计时圆环变量等），行内 `style` 属性在 CSP 下归 `style-src` 管，
//!    不放行就整片样式失效。这条是如实放行，不是遗漏。
//!
//! ## 时序契约（CSP 与主文档重载）
//!
//! 主文档的 CSP **只在主文档被请求时**生成（`on_web_resource_request` 挂在
//! webview 创建时，运行期没有「给已有 webview 换 CSP」的接口）。因此：
//!
//! 1. 应用刚起来时，后端主机还不知道（前端还没跑），这一版主文档的
//!    `connect-src` 里只有 `'self'`——**跨主机请求会被 CSP 拦死**。
//! 2. 前端跑起来后把后端基址经 IPC 送给桌面壳（`set_backend_base_url`），
//!    桌面壳据此更新状态。
//! 3. 前端接着问桌面壳「当前主文档的 CSP 跟我要的后端主机一致吗」
//!    （`csp_needs_reload`）：不一致就 `location.reload()`，
//!    **重载后主文档重新被请求 → 这一版 CSP 就带上了后端主机**。
//!
//! 顺序是硬要求：**状态更新完成 → 主文档重新请求**。中间不能插别的动作，
//! 否则重载拿到的还是旧 CSP。

use tauri::Url;

/// 基线策略。
///
/// 与 `tauri.conf.json` 的 `app.security.csp` 保持一致（那份是**兜底**：
/// 即使运行期改写没跑到，连接也不会被拦死）。改一处要改两处。
///
/// **不含 script 内容 hash**：hash 是构建期由 tauri-codegen 算出来注入到
/// 响应头里的，基线策略里写不出来（写死了就会与产物脱节）。
pub const BASE_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

/// 归一后端基址：空串与 `None` 等价（= 没有主机，`connect-src` 只留 `'self'`）。
pub fn normalize_base_url(raw: Option<&str>) -> Option<String> {
    let text = raw.unwrap_or_default().trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// 当前主文档的 CSP 是不是已经按「期望的后端基址」生成。
///
/// - `loaded`：当前主文档的 CSP 实际是按哪个基址生成的（主文档被请求时记下）；
/// - `desired`：前端经 IPC 送来的、期望下次生效的基址。
///
/// 两者不一致 = 当前这一版主文档的 CSP 没跟上 → 需要重载主文档。
pub fn csp_matches_backend(loaded: Option<&str>, desired: Option<&str>) -> bool {
    normalize_base_url(loaded) == normalize_base_url(desired)
}

/// 依据后端基址算出要补进 `connect-src` 的来源。
///
/// 形态照 ADR 0015 第 6 节：`http(s)://<后端host>:*` 与 `ws(s)://<后端host>:*`。
///
/// 解析不了或 scheme 不认识时返回空列表：不认识的地址不放行（用户填错地址
/// 时由后端去报错，策略不必替它开口）。
pub fn connect_sources(backend_base_url: Option<&str>) -> Vec<String> {
    let Some(raw) = backend_base_url else {
        return Vec::new();
    };
    let text = raw.trim();
    if text.is_empty() {
        return Vec::new();
    }
    let Ok(parsed) = Url::parse(text) else {
        return Vec::new();
    };
    let scheme = match parsed.scheme() {
        "http" => "http",
        "https" => "https",
        "ws" => "ws",
        "wss" => "wss",
        _ => return Vec::new(),
    };
    let Some(host) = parsed.host_str() else {
        return Vec::new();
    };
    // IPv6 字面量：`url::Url::host_str()` 返回的**已经带方括号**（`[::1]`），
    // 别再包一层（会变成 `[[::1]]`，那条来源在 CSP 里不合法）。
    let host = host.to_string();
    let ws_scheme = if scheme == "https" || scheme == "wss" {
        "wss"
    } else {
        "ws"
    };
    vec![
        format!("{scheme}://{host}:*"),
        format!("{ws_scheme}://{host}:*"),
    ]
}

/// 改写策略里的 `connect-src`。
///
/// - **只补当前后端主机**（动态部分，ADR 0015 第 6 节）：不放行 scheme 通配，
///   也不放行用户没配的主机；
/// - 指令顺序保持不变（不重新排序）：策略字符串逐条比对更省事；
/// - 已有的来源不重复添加（重复改写幂等）；
/// - 策略里没有 `connect-src` 时补一条（带 `'self'`）。
pub fn apply_dynamic_csp(policy: &str, extra_sources: &[String]) -> String {
    let mut directives: Vec<String> = Vec::new();
    let mut seen_connect_src = false;

    for directive in policy.split(';') {
        let text = directive.trim();
        if text.is_empty() {
            continue;
        }
        let mut parts = text.split_whitespace();
        let name = parts.next().unwrap_or_default();
        let mut sources: Vec<String> = parts.map(|item| item.to_string()).collect();
        if name.eq_ignore_ascii_case("connect-src") {
            seen_connect_src = true;
            for extra in extra_sources {
                if !sources.iter().any(|item| item == extra) {
                    sources.push(extra.clone());
                }
            }
        }
        directives.push(format!("{name} {}", sources.join(" ")));
    }

    if !seen_connect_src {
        let mut sources: Vec<String> = vec!["'self'".to_string()];
        for extra in extra_sources {
            if !sources.iter().any(|item| item == extra) {
                sources.push(extra.clone());
            }
        }
        directives.push(format!("connect-src {}", sources.join(" ")));
    }

    directives.join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 取出策略里 `connect-src` 的来源列表（按空白切分）。
    fn connect_src_sources(policy: &str) -> Vec<String> {
        policy
            .split(';')
            .map(|directive| directive.trim())
            .find(|directive| {
                directive
                    .split_whitespace()
                    .next()
                    .is_some_and(|name| name.eq_ignore_ascii_case("connect-src"))
            })
            .map(|directive| {
                directive
                    .split_whitespace()
                    .skip(1)
                    .map(|source| source.to_string())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// scheme 通配来源（`http:` 这种「放行整条协议」的写法）。
    const SCHEME_WILDCARDS: [&str; 4] = ["http:", "https:", "ws:", "wss:"];

    #[test]
    fn 基线策略里没有_script_的_unsafe_inline() {
        assert!(!BASE_CSP.contains("script-src 'self' 'unsafe-inline'"));
        assert!(BASE_CSP.contains("script-src 'self'"));
    }

    #[test]
    fn 基线策略的_connect_src_不放行_scheme_通配() {
        // 基线只留 'self'：后端主机是运行期才知道的，由动态改写补进去。
        assert_eq!(connect_src_sources(BASE_CSP), vec!["'self'"]);
        for wildcard in SCHEME_WILDCARDS {
            assert!(
                !BASE_CSP.contains(wildcard),
                "基线策略不该出现 scheme 通配 {wildcard}"
            );
        }
    }

    #[test]
    fn 后端基址换算成_connect_src_来源() {
        let sources = connect_sources(Some("http://10.0.0.5:8000"));
        assert_eq!(sources, vec!["http://10.0.0.5:*", "ws://10.0.0.5:*"]);

        let sources = connect_sources(Some("https://sandbox.example"));
        assert_eq!(sources, vec!["https://sandbox.example:*", "wss://sandbox.example:*"]);
    }

    #[test]
    fn ipv6_主机的方括号只带一层() {
        // url::Url::host_str() 已经带方括号：不能再包一层（`[[::1]]` 不合法）。
        let sources = connect_sources(Some("http://[::1]:8000"));
        assert_eq!(sources, vec!["http://[::1]:*", "ws://[::1]:*"]);
        assert!(!sources[0].contains("[["));
    }

    #[test]
    fn 没有后端基址时不补来源() {
        assert!(connect_sources(None).is_empty());
        assert!(connect_sources(Some("  ")).is_empty());
    }

    #[test]
    fn 解析不了或_scheme_不认识时不补来源() {
        assert!(connect_sources(Some("不是地址")).is_empty());
        assert!(connect_sources(Some("ftp://host")).is_empty());
    }

    #[test]
    fn 改写后_connect_src_多了后端主机() {
        let policy = apply_dynamic_csp(
            BASE_CSP,
            &connect_sources(Some("http://10.0.0.5:8000")),
        );
        assert!(policy.contains("connect-src 'self' http://10.0.0.5:* ws://10.0.0.5:*"));
        // 其余指令原样保留。
        assert!(policy.contains("script-src 'self'"));
        assert!(policy.contains("style-src 'self' 'unsafe-inline'"));
    }

    #[test]
    fn 改写后_connect_src_仍然没有_scheme_通配() {
        let policy = apply_dynamic_csp(BASE_CSP, &connect_sources(Some("http://10.0.0.5:8000")));
        let sources = connect_src_sources(&policy);
        for wildcard in SCHEME_WILDCARDS {
            assert!(
                !sources.iter().any(|source| source == wildcard),
                "改写后不该出现 scheme 通配 {wildcard}：{policy}"
            );
        }
        // 只多出当前后端主机的两条来源。
        assert_eq!(
            sources,
            vec!["'self'", "http://10.0.0.5:*", "ws://10.0.0.5:*"]
        );
    }

    #[test]
    fn 重复改写不重复加来源() {
        let sources = connect_sources(Some("http://10.0.0.5:8000"));
        let once = apply_dynamic_csp(BASE_CSP, &sources);
        let twice = apply_dynamic_csp(&once, &sources);
        assert_eq!(once, twice);
    }

    #[test]
    fn 策略里没有_connect_src_时补一条() {
        let policy = apply_dynamic_csp("default-src 'self'", &["http://h:*".to_string()]);
        assert!(policy.contains("connect-src 'self' http://h:*"));
    }

    #[test]
    fn 主文档的_csp_与期望基址不一致时需要重载() {
        // 刚起来：还不知道后端主机 → 一致（都不用放行）。
        assert!(csp_matches_backend(None, None));
        // 空串与 None 等价。
        assert!(csp_matches_backend(Some(""), None));
        // 前端送来了后端主机，但当前主文档还是旧策略 → 要重载。
        assert!(!csp_matches_backend(
            None,
            Some("http://10.0.0.5:8000")
        ));
        // 重载后一致 → 不用再重载。
        assert!(csp_matches_backend(
            Some("http://10.0.0.5:8000"),
            Some("http://10.0.0.5:8000")
        ));
        // 换了主机 → 又要重载。
        assert!(!csp_matches_backend(
            Some("http://10.0.0.5:8000"),
            Some("http://10.0.0.6:8000")
        ));
    }
}
