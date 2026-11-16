//! Network layer: talk to the upstream site via `POST /api/edge/request`.
//!
//! All client traffic goes through reqwest here (not WebView2), so browser proxy
//! and certificate stores are not shared. Requires the `system-proxy` feature for
//! Windows registry proxies; PAC is unsupported. Override with
//! `HGHUB_PROXY=http://127.0.0.1:7897`. `net_diag` dumps a DNS/HTTP/env snapshot.

use crate::network_policy;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// Default upstream (fixed line 1).
pub const DEFAULT_BASE: &str = "https://huangguoai.com";

/// Current upstream origin (no trailing slash). Switched at runtime via settings.
static BASE: Lazy<RwLock<String>> = Lazy::new(|| RwLock::new(DEFAULT_BASE.to_string()));
/// Persisted line path (`line.json` under app data); bound by [`bind_base`] at startup.
static BASE_FILE: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));

/// Current upstream origin.
pub fn base() -> String {
    BASE.read()
        .map(|b| b.clone())
        .unwrap_or_else(|_| DEFAULT_BASE.to_string())
}

/// Line must be a plain HTTPS origin — no path, auth, query, or fragment.
pub fn normalize_base(raw: &str) -> Option<String> {
    let parsed = network_policy::parse_target(raw.trim()).ok()?;
    if parsed.scheme() != "https"
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(parsed.origin().ascii_serialization())
}

/// Remote publish page only offers guest mirrors; do not expand auth trust to them.
pub fn trusted_auth_origin(origin: &str) -> bool {
    matches!(origin, "https://huangguoai.com" | "https://huangguoai.ai")
}

/// Restore the last chosen line at startup (keep default if missing/corrupt).
pub fn bind_base(dir: &std::path::Path) {
    network_policy::bind_security(dir);
    let path = dir.join("line.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(next) = v
                .get("base")
                .and_then(|x| x.as_str())
                .and_then(normalize_base)
            {
                if let Ok(mut cur) = BASE.write() {
                    *cur = next;
                }
            }
        }
    }
    if let Ok(mut f) = BASE_FILE.write() {
        *f = Some(path);
    }
}

/// Switch line and persist; returns the normalized origin.
pub fn set_base(url: &str) -> Result<String, String> {
    let next = normalize_base(url)
        .ok_or_else(|| "Invalid line URL (must be a plain HTTPS origin; private networks denied)".to_string())?;
    let previous = base();
    if let Ok(mut cur) = BASE.write() {
        *cur = next.clone();
    }
    if let Some(path) = BASE_FILE.read().ok().and_then(|p| p.clone()) {
        let _ = std::fs::write(path, json!({ "base": next }).to_string());
    }
    if previous != next {
        crate::playback_log::record(
            "line.changed",
            json!({
                "previous_host": url::Url::parse(&previous).ok().and_then(|u| u.host_str().map(str::to_owned)),
                "line_host": url::Url::parse(&next).ok().and_then(|u| u.host_str().map(str::to_owned)),
            }),
        );
    }
    Ok(next)
}

pub const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Manual proxy override: `HGHUB_PROXY=http://127.0.0.1:7897`.
/// When unset, reqwest `system-proxy` reads the registry / env.
fn proxy_override() -> Option<String> {
    std::env::var("HGHUB_PROXY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Build a client from the **current** system proxy settings.
///
/// reqwest `system-proxy` reads registry/env once at build time. After a proxy
/// app is quit, a stale client still tunnels to `127.0.0.1:7897` and fails with
/// tunnel errors while the browser (which re-reads) works — so rebuild is allowed.
fn build_client(host: &str, addrs: &[SocketAddr]) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .gzip(true)
        .brotli(true)
        .pool_idle_timeout(Duration::from_secs(60));
    if !addrs.is_empty() {
        builder = builder.resolve_to_addrs(host, addrs);
    }
    if let Some(p) = proxy_override() {
        // Never include the raw proxy URL in errors (may contain credentials).
        let proxy = reqwest::Proxy::all(&p).map_err(|_| "Invalid HGHUB_PROXY configuration (raw value hidden)")?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|_| "Failed to create HTTP client".to_string())
}

const CLIENT_TTL: Duration = Duration::from_secs(30);
type ClientCache = HashMap<String, (Instant, Arc<reqwest::Client>)>;
static CLIENTS: Lazy<Mutex<ClientCache>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn cached_client(cache: &ClientCache, key: &str, now: Instant) -> Option<Arc<reqwest::Client>> {
    cache
        .get(key)
        .filter(|(expires, _)| now < *expires)
        .map(|(_, http)| http.clone())
}

/// Cache is keyed by mode/host/port; only reuse clients with pinned checked addrs.
/// On expiry, re-resolve all DNS answers — do not reuse old pins past policy checks.
async fn client_for(raw: &str) -> Result<(url::Url, Arc<reqwest::Client>), String> {
    let strict = network_policy::strict_security();
    let target = network_policy::parse_target_with_mode(raw, strict)?;
    let host = target.host_str().ok_or("Target is missing a hostname")?;
    let port = target.port_or_known_default().ok_or("Invalid target port")?;
    let key = format!("{strict}:{host}:{port}");
    {
        let cache = CLIENTS.lock().map_err(|_| "HTTP client lock failed")?;
        if let Some(http) = cached_client(&cache, &key, Instant::now()) {
            return Ok((target, http));
        }
    }
    let addrs = if strict {
        network_policy::resolve_target(&target, strict).await?
    } else {
        Vec::new()
    };
    let http = Arc::new(build_client(host, &addrs)?);
    let now = Instant::now();
    let mut cache = CLIENTS.lock().map_err(|_| "HTTP client lock failed")?;
    // Concurrent callers may have finished resolve; do not extend an existing TTL.
    let http = cached_client(&cache, &key, now).unwrap_or(http);
    if !cache.get(&key).is_some_and(|(expires, _)| now < *expires) {
        cache.retain(|_, (expires, _)| now < *expires);
        if cache.len() >= 64 {
            cache.clear();
        }
        cache.insert(key, (now + CLIENT_TTL, http.clone()));
    }
    Ok((target, http))
}

pub fn refresh_client() {
    if let Ok(mut cache) = CLIENTS.lock() {
        cache.clear();
    }
}

/// Untrusted GET entry point; auto-redirect is off — each hop rechecks URL/DNS and pins.
pub async fn get(
    raw: &str,
    timeout: Duration,
    accept: Option<&str>,
    referer: Option<&str>,
) -> Result<reqwest::Response, String> {
    tokio::time::timeout(timeout, async {
        let policy_error = |phase: &str, error: String| {
            crate::playback_log::record("network.target_failed", json!({"resource": crate::playback_log::resource_id(raw), "phase": phase, "error_kind": crate::playback_log::error_kind(&error)}));
            error
        };
        let mut next = network_policy::parse_target(raw).map_err(|e| policy_error("parse", e))?;
        for hop in 0..=5 {
            let resolving = Instant::now();
            let (target, http) = client_for(next.as_str()).await.map_err(|e| policy_error("dns_or_client", e))?;
            crate::playback_log::record("network.target_ready", json!({"resource": crate::playback_log::resource_id(raw), "target_resource": crate::playback_log::resource_id(target.as_str()), "dns_or_client_ms": resolving.elapsed().as_millis() as u64, "hop": hop}));
            let mut request = http.get(target.clone()).timeout(timeout);
            if let Some(value) = accept {
                request = request.header("Accept", value);
            }
            if let Some(value) = referer {
                request = request.header("Referer", value);
            }
            let response = request.send().await.map_err(|e| err_text(&e))?;
            if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            if hop == 5 {
                return Err("Redirect limit exceeded".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or("Redirect is missing a valid Location")?;
            next = network_policy::redirect_target(&target, location).map_err(|e| policy_error("redirect", e))?;
            crate::playback_log::record("network.redirect", json!({"resource": crate::playback_log::resource_id(raw), "from": crate::playback_log::resource_id(target.as_str()), "to": crate::playback_log::resource_id(next.as_str()), "status": response.status().as_u16(), "hop": hop + 1}));
        }
        Err("Redirect limit exceeded".into())
    })
    .await
    .map_err(|_| "Request timed out".to_string())?
}

/// Return only proxy scheme/host/port; never echo credentials or query.
pub fn redact_proxy(raw: &str) -> String {
    let parsed = url::Url::parse(raw.trim())
        .ok()
        .filter(|u| u.host_str().is_some());
    match parsed {
        Some(url) => {
            let mut safe = format!("{}://{}", url.scheme(), url.host_str().unwrap());
            if let Some(port) = url.port() {
                safe.push_str(&format!(":{port}"));
            }
            safe
        }
        None => "[configured, raw value hidden]".into(),
    }
}

/// Looks like a proxy/tunnel problem rather than the target being unreachable.
pub fn is_proxy_error(e: &str) -> bool {
    let e = e.to_ascii_lowercase();
    e.contains("tunnel") || e.contains("proxy")
}

static LAST_HEAL: Lazy<std::sync::Mutex<Option<Instant>>> =
    Lazy::new(|| std::sync::Mutex::new(None));

/// Rebuild the client after failures that suggest the network environment changed.
/// At most once per 3 seconds so batch probes do not thrash.
pub fn heal_client(reason: &str) {
    let connectish = reason.contains("Connect")
        || reason.contains("timed out")
        || reason.contains("refused")
        || reason.contains("dns");
    if !is_proxy_error(reason) && !connectish {
        return;
    }
    let mut last = match LAST_HEAL.lock() {
        Ok(l) => l,
        Err(_) => return,
    };
    if let Some(t) = *last {
        if t.elapsed() < Duration::from_secs(3) {
            return;
        }
    }
    *last = Some(Instant::now());
    drop(last);
    refresh_client();
}

/// Expand reqwest's source chain into one line (Display alone is too shallow).
pub fn err_text(e: &reqwest::Error) -> String {
    let mut out = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        let t = s.to_string();
        if !t.is_empty() && !out.contains(&t) {
            out.push_str(" ← ");
            out.push_str(&t);
        }
        src = s.source();
    }
    out
}

fn dns_summary(addrs: impl IntoIterator<Item = SocketAddr>) -> Value {
    let mut ips: Vec<_> = addrs.into_iter().map(|addr| addr.ip()).collect();
    ips.sort_unstable();
    ips.dedup();
    let has_fake_ip = ips.iter().any(|ip| {
        let v4 = match ip {
            std::net::IpAddr::V4(v4) => Some(*v4),
            std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped(),
        };
        v4.is_some_and(|ip| {
            let [a, b, _, _] = ip.octets();
            a == 198 && (b == 18 || b == 19)
        })
    });
    json!({ "count": ips.len(), "has_fake_ip": has_fake_ip })
}

/// Network self-check: DNS / HTTP / proxy-related env, for remote "won't open" triage.
pub async fn diagnose() -> Value {
    let cur = base();
    let host = url::Url::parse(&cur)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default();

    // Fake-IP (198.18.0.0/15) means DNS is TUN-hijacked; those addrs are unroutable without TUN.
    let dns = {
        let host = host.clone();
        tokio::task::spawn_blocking(move || {
            use std::net::ToSocketAddrs;
            match (host.as_str(), 443u16).to_socket_addrs() {
                Ok(iter) => dns_summary(iter),
                Err(_) => json!({ "error": "DNS resolution failed" }),
            }
        })
        .await
        .unwrap_or(Value::Null)
    };

    let started = Instant::now();
    let http = match get(&format!("{cur}/"), Duration::from_secs(20), None, None).await {
        Ok(r) => json!({
            "status": r.status().as_u16(),
            "ms": started.elapsed().as_millis() as u64,
        }),
        Err(e) => json!({
            "error": e,
            "ms": started.elapsed().as_millis() as u64,
        }),
    };

    json!({
        "base": cur,
        "host": host,
        "dns": dns,
        "http": http,
        "env": {
            "HTTP_PROXY": std::env::var("HTTP_PROXY").ok().map(|p| redact_proxy(&p)),
            "HTTPS_PROXY": std::env::var("HTTPS_PROXY").ok().map(|p| redact_proxy(&p)),
            "ALL_PROXY": std::env::var("ALL_PROXY").ok().map(|p| redact_proxy(&p)),
            "NO_PROXY": std::env::var("NO_PROXY").ok().map(|_| "[configured, list hidden]"),
            "HGHUB_PROXY": proxy_override().map(|p| redact_proxy(&p)),
        },
    })
}

fn retryable_error(error: &str) -> bool {
    if error == "401" {
        return false;
    }
    if let Some(status) = error
        .strip_prefix("HTTP ")
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse::<u16>().ok())
    {
        return matches!(status, 408 | 425 | 429 | 500..=599);
    }
    !matches!(
        crate::playback_log::error_kind(error),
        "https_downgrade_denied"
            | "private_address_denied"
            | "target_policy_denied"
            | "redirect_error"
    )
}

/// Retry only recoverable errors; skip 404 / auth / security denials.
async fn with_retry<F, Fut, T>(retry: bool, mut f: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut last = String::from("network error");
    let attempts = if retry { 3 } else { 1 };
    for attempt in 0..attempts {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = e;
                if !retryable_error(&last) {
                    return Err(last);
                }
                heal_client(&last);
                if attempt + 1 < attempts {
                    tokio::time::sleep(Duration::from_millis(350 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(last)
}

// Only record fixed operation types — never search terms, accounts, content IDs, or query params.
fn edge_operation(path: &str) -> &'static str {
    let path = path.split('?').next().unwrap_or("");
    if path.starts_with("/api/videos/category/") {
        "category"
    } else if path.starts_with("/api/videos/") && (path.ends_with("/play") || path.ends_with("/playback")) {
        "play"
    } else if path == "/api/videos" {
        "feed"
    } else if path.starts_with("/api/videos/") {
        "video"
    } else if path == "/api/posts" {
        "posts"
    } else if path.starts_with("/api/posts/") {
        "post"
    } else if path.starts_with("/api/ranks/") {
        "rank"
    } else if path == "/api/search" {
        "search"
    } else if path.starts_with("/api/account/") {
        "account"
    } else {
        "other"
    }
}

/// Only credential-free logical GETs may follow gateway redirects; envelope stays POST.
fn edge_redirect_target(
    current: &url::Url,
    status: u16,
    location: &str,
    guest_get: bool,
) -> Result<url::Url, String> {
    if !guest_get || !matches!(status, 301 | 302 | 303) {
        return Err("API redirect rejected".into());
    }
    network_policy::redirect_target(current, location)
}

/// Business request via the edge envelope.
pub async fn edge(
    origin: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> Result<Value, String> {
    let cur = normalize_base(origin).ok_or("API requests require a secure HTTPS line")?;
    if network_policy::strict_security()
        && (token.is_some()
            || matches!(
                path,
                "/api/account/loginByPassword" | "/api/account/registerByPassword"
            ))
        && !trusted_auth_origin(&cur)
    {
        return Err("Mirror lines are guest-only; switch to a fixed line to sign in or register".into());
    }
    let (encoded, ctype) = match &body {
        Some(v) => (
            B64.encode(serde_json::to_vec(v).map_err(|e| e.to_string())?),
            "application/json",
        ),
        None => (String::new(), ""),
    };
    let envelope = json!({
        "method": method,
        "path": path,
        "body": encoded,
        "content_type": ctype,
    });

    let url = format!("{cur}/api/edge/request");
    let referer = format!("{cur}/");
    let token = token.map(|s| s.to_string());

    static NEXT_EDGE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let request = NEXT_EDGE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let line_host = url::Url::parse(&cur)
        .unwrap()
        .host_str()
        .unwrap()
        .to_string();
    let operation = edge_operation(path);
    let mut attempt = 0;
    let guest_get = method.eq_ignore_ascii_case("GET") && body.is_none() && token.is_none();
    // Play-address POSTs are side-effect free; allow retry like GET.
    let can_retry = (method.eq_ignore_ascii_case("GET") && body.is_none())
        || (method.eq_ignore_ascii_case("POST") && operation == "play");
    let value = with_retry(can_retry, || {
        attempt += 1;
        let attempt = attempt;
        let envelope = envelope.clone();
        let token = token.clone();
        let url = url.clone();
        let referer = referer.clone();
        let line_host = line_host.clone();
        async move {
            let started = Instant::now();
            crate::playback_log::record("api.begin", json!({"request": request, "attempt": attempt, "operation": operation, "method": method, "line_host": line_host}));
            let mut status_code = None;
            let mut headers_ms = None;
            let mut target_host = line_host.clone();
            let mut response_kind = "unknown";
            let mut gateway = "other";
            let result = async {
                let mut next = network_policy::parse_target(&url)?;
                for hop in 0..=5 {
                    let (target, client) = client_for(next.as_str()).await?;
                    target_host = target.host_str().unwrap_or("").to_string();
                    let mut req = client
                        .post(target.clone())
                        .header("Accept", "application/json")
                        .header("Referer", &referer)
                        .json(&envelope);
                    if let Some(t) = token.as_deref() {
                        if !t.is_empty() {
                            req = req.header("Authorization", format!("Bearer {t}"));
                        }
                    }
                    let resp = req.send().await.map_err(|e| err_text(&e))?;
                    let status = resp.status();
                    status_code = Some(status.as_u16());
                    headers_ms = Some(started.elapsed().as_millis() as u64);
                    let ctype = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
                    response_kind = if ctype.contains("json") { "json" } else if ctype.contains("html") { "html" } else { "other" };
                    gateway = if resp.headers().contains_key("x-amz-cf-id") { "cloudfront" } else if resp.headers().contains_key("cf-ray") { "cloudflare" } else { "other" };
                    // Rebuild/recheck client per hop; never rewrite envelope POST into bare GET.
                    if status.is_redirection() {
                        if hop == 5 {
                            return Err("Redirect limit exceeded".into());
                        }
                        let location = resp
                            .headers()
                            .get(reqwest::header::LOCATION)
                            .and_then(|h| h.to_str().ok())
                            .ok_or("Redirect is missing a valid Location")?;
                        next = edge_redirect_target(&target, status.as_u16(), location, guest_get)?;
                        continue;
                    }
                    let text = resp.text().await.map_err(|e| err_text(&e))?;
                    if status.as_u16() == 401 || status.as_u16() == 403 {
                        return Err("401".to_string());
                    }
                    if !status.is_success() {
                        return Err(format!(
                            "HTTP {status}: {}",
                            text.chars().take(160).collect::<String>()
                        ));
                    }
                    if text.trim().is_empty() {
                        return Ok(Value::Null);
                    }
                    return serde_json::from_str::<Value>(&text)
                        .map_err(|e| format!("{e}: {}", text.chars().take(160).collect::<String>()));
                }
                Err("Redirect limit exceeded".into())
            }.await;
            crate::playback_log::record("api.end", json!({
                "request": request, "attempt": attempt, "operation": operation, "method": method,
                "line_host": line_host, "target_host": target_host, "status": status_code,
                "headers_ms": headers_ms, "elapsed_ms": started.elapsed().as_millis() as u64,
                "response_kind": response_kind, "gateway": gateway,
                "business_status": result.as_ref().ok().and_then(|v: &Value| v.get("status")).and_then(Value::as_i64),
                "error_kind": result.as_ref().err().map(|e: &String| crate::playback_log::error_kind(e)),
                "retryable": can_retry && result.as_ref().err().is_some_and(|e| retryable_error(e)),
            }));
            result
        }
    })
    .await?;

    if value.is_null() {
        return Ok(Value::Null);
    }

    if value.get("status").and_then(|v| v.as_i64()) == Some(1) {
        Ok(value.get("data").cloned().unwrap_or(Value::Null))
    } else {
        Err(value
            .get("msg")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("API request failed")
            .to_string())
    }
}

/// Fetch raw bytes (images / m3u8 / segments).
pub async fn fetch_bytes(url: &str) -> Result<(Option<String>, Vec<u8>), String> {
    static NEXT_REQUEST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let request = NEXT_REQUEST.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let resource = crate::playback_log::resource_id(url);
    let mut attempt = 0;
    let url = url.to_string();
    let referer = format!("{}/", base());
    with_retry(true, || {
        attempt += 1;
        let attempt = attempt;
        let resource = resource.clone();
        let url = url.clone();
        let referer = referer.clone();
        async move {
            let started = Instant::now();
            crate::playback_log::record("network.begin", json!({"request": request, "resource": resource, "attempt": attempt}));
            let mut status = None;
            let mut headers_ms = None;
            let result = async {
                let resp = get(&url, Duration::from_secs(20), None, Some(&referer)).await?;
                status = Some(resp.status().as_u16());
                headers_ms = Some(started.elapsed().as_millis() as u64);
                if !resp.status().is_success() {
                    return Err(format!("HTTP {}", resp.status()));
                }
                let ctype = resp
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                let bytes = resp.bytes().await.map_err(|e| err_text(&e))?.to_vec();
                Ok((ctype, bytes))
            }.await;
            crate::playback_log::record("network.end", json!({"request": request, "resource": resource, "attempt": attempt, "status": status, "headers_ms": headers_ms, "elapsed_ms": started.elapsed().as_millis() as u64, "bytes": result.as_ref().ok().map(|(_, bytes)| bytes.len()), "error_kind": result.as_ref().err().map(|e: &String| crate::playback_log::error_kind(e))}));
            result
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn terminal_errors_do_not_retry_but_transient_failures_can_recover() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for error in [
            "HTTP 404 Not Found: <html>nginx</html>",
            "HTTP 403 Forbidden",
            "401",
            "Access to private networks is denied",
            "Redirect limit exceeded",
        ] {
            let calls = AtomicUsize::new(0);
            assert!(with_retry(true, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err::<(), _>(error.to_string())
            })
            .await
            .is_err());
            assert_eq!(calls.load(Ordering::SeqCst), 1, "{error}");
        }
        for error in ["HTTP 503 Service Unavailable", "Request timed out"] {
            let calls = AtomicUsize::new(0);
            let value = with_retry(true, || {
                let attempt = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt == 0 {
                        Err(error.to_string())
                    } else {
                        Ok(42)
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(value, 42);
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        }
    }

    #[test]
    fn api_operation_labels_exclude_user_input() {
        for (path, expected) in [
            ("/api/videos?page=1&size=10", "feed"),
            ("/api/videos/category/private?x=secret", "category"),
            ("/api/videos/42/play?ep=1", "play"),
            ("/api/videos/42/episodes/1/playback", "play"),
            ("/api/search?q=private-search", "search"),
            ("/api/account/loginByPassword", "account"),
            ("/unknown/private", "other"),
        ] {
            assert_eq!(edge_operation(path), expected);
        }
    }

    #[tokio::test]
    async fn non_idempotent_operations_are_attempted_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for (retry, expected) in [(false, 1), (true, 3)] {
            let calls = AtomicUsize::new(0);
            let result = with_retry(retry, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err::<(), _>("rejected".to_string())
            })
            .await;
            assert!(result.is_err());
            assert_eq!(calls.load(Ordering::SeqCst), expected);
        }
    }

    #[test]
    fn dns_diagnostics_only_expose_counts_and_fake_ip_presence() {
        let addrs: Vec<SocketAddr> = ["10.0.0.1:443", "198.18.0.2:443", "[::ffff:198.18.0.3]:443"]
            .into_iter()
            .map(|raw| raw.parse().unwrap())
            .collect();
        let summary = dns_summary(addrs);
        assert_eq!(summary, json!({"count": 3, "has_fake_ip": true}));
        assert!(!summary.to_string().contains("10.0.0.1"));
        assert!(!summary.to_string().contains("198.18"));
        assert_eq!(
            dns_summary(Vec::<SocketAddr>::new()),
            json!({"count":0,"has_fake_ip":false})
        );
    }

    #[test]
    fn pinned_clients_expire_without_extending_the_dns_ttl() {
        let now = Instant::now();
        let client = Arc::new(reqwest::Client::new());
        let mut cache = ClientCache::new();
        cache.insert(
            "true:example.com:443".into(),
            (now + CLIENT_TTL, client.clone()),
        );
        assert!(Arc::ptr_eq(
            &cached_client(
                &cache,
                "true:example.com:443",
                now + Duration::from_secs(29)
            )
            .unwrap(),
            &client
        ));
        assert!(cached_client(&cache, "true:example.com:443", now + CLIENT_TTL).is_none());
        assert!(cached_client(&cache, "false:example.com:443", now).is_none());
        assert!(cached_client(&cache, "true:example.com:8443", now).is_none());
    }

    #[test]
    fn edge_redirects_only_replay_anonymous_reads() {
        let current = url::Url::parse("https://huangguoai.ai/api/edge/request").unwrap();
        assert_eq!(
            edge_redirect_target(
                &current,
                301,
                "https://huangguoai.com/api/edge/request",
                true
            )
            .unwrap()
            .host_str(),
            Some("huangguoai.com")
        );
        assert!(edge_redirect_target(&current, 302, "/next", true).is_ok());
        for status in [301, 302, 303, 307, 308] {
            assert!(edge_redirect_target(&current, status, "/next", false).is_err());
        }
        for status in [307, 308] {
            assert!(edge_redirect_target(&current, status, "/next", true).is_err());
        }
        assert!(edge_redirect_target(&current, 301, "http://example.com/", true).is_err());
        assert!(edge_redirect_target(&current, 301, "https://127.0.0.1/", true).is_err());
    }

    #[test]
    fn proxy_credentials_and_query_are_redacted() {
        assert_eq!(
            redact_proxy("http://alice:p%40ss@127.0.0.1:7897/path?token=secret#hidden"),
            "http://127.0.0.1:7897"
        );
        assert_eq!(
            redact_proxy("socks5://alice:secret@[::1]:1080"),
            "socks5://[::1]:1080"
        );
        for raw in ["alice:secret@127.0.0.1:7897", "not a url secret", ""] {
            assert_eq!(redact_proxy(raw), "[configured, raw value hidden]");
        }
    }

    #[test]
    fn base_requires_https_origin_and_auth_trust_is_static() {
        assert_eq!(
            normalize_base("https://HUANGGUOAI.COM:443/"),
            Some(DEFAULT_BASE.into())
        );
        for raw in [
            "http://huangguoai.com",
            "https://user:pass@huangguoai.com",
            "https://huangguoai.com/path",
            "https://huangguoai.com/?secret=1",
            "https://huangguoai.com/#fragment",
            "https://192.168.1.1",
        ] {
            assert_eq!(normalize_base(raw), None, "{raw}");
        }
        assert!(trusted_auth_origin(DEFAULT_BASE));
        assert!(trusted_auth_origin("https://huangguoai.ai"));
        assert!(!trusted_auth_origin("https://mirror.example"));
        assert!(!trusted_auth_origin("https://huangguoai.com.evil.example"));
    }

    #[tokio::test]
    async fn untrusted_origins_reject_credentials_before_network() {
        for (path, body, token) in [
            (
                "/api/account/loginByPassword",
                Some(json!({"password":"secret"})),
                None,
            ),
            (
                "/api/account/registerByPassword",
                Some(json!({"password":"secret"})),
                None,
            ),
            ("/api/videos", None, Some("secret-token")),
        ] {
            let err = edge("https://mirror.invalid", "POST", path, body, token)
                .await
                .unwrap_err();
            assert!(err.contains("Mirror lines are guest-only"));
        }
    }

    #[tokio::test]
    async fn private_get_is_rejected_before_network() {
        let err = get(
            "http://127.0.0.1:1/private",
            Duration::from_secs(1),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.contains("denied"));
    }

    /// Manual: `cargo test --lib -- --ignored net::tests::diag -- --nocapture`
    #[tokio::test]
    #[ignore = "network test: hits upstream for net_diag; run manually with --ignored"]
    async fn diag() {
        println!(
            "{}",
            serde_json::to_string_pretty(&diagnose().await).expect("json")
        );
    }
}
