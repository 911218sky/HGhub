mod api;
mod download;
mod ffmpeg_tool;
mod lines;
mod logging;
#[cfg(target_os = "macos")]
mod macos_titlebar;
mod media;
mod net;
mod network_policy;
mod playback_log;
mod session;

use api::Api;
use tauri::Manager;

fn allowed_dev_host(host: &str) -> bool {
    if matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]") {
        return true;
    }
    if let Some(configured) = option_env!("TAURI_DEV_HOST") {
        if host.eq_ignore_ascii_case(configured.trim()) {
            return true;
        }
    }
    std::env::var("TAURI_DEV_HOST")
        .ok()
        .is_some_and(|v| host.eq_ignore_ascii_case(v.trim()))
}

fn allowed_frontend_origin(origin: &str) -> bool {
    if matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost" | "null"
    ) {
        return true;
    }
    // Mobile/dev may set TAURI_DEV_HOST; in strict mode only localhost or that host is allowed.
    cfg!(debug_assertions)
        && url::Url::parse(origin).is_ok_and(|u| {
            u.scheme() == "http"
                && u.port() == Some(1420)
                && (!network_policy::strict_security()
                    || u.host_str().is_some_and(allowed_dev_host))
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(Api::new())
        .setup(|app| {
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                net::bind_base(&dir);
                playback_log::bind(&dir);
                download::bind(&dir);
                ffmpeg_tool::bind(&dir);
                let state: tauri::State<Api> = app.state();
                state.session.bind(dir);
            }
            #[cfg(target_os = "macos")]
            macos_titlebar::create_main_window(app)?;
            Ok(())
        })
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("navigation-guard")
                .on_navigation(|_webview, url| {
                    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || allowed_frontend_origin(&url.origin().ascii_serialization())
                        || (!network_policy::strict_security()
                            && matches!(url.scheme(), "http" | "https"))
                })
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("hg", |_app, request, responder| {
            let request_origin = request
                .headers()
                .get("Origin")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            if playback_log::enabled() {
                let resource = url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
                    .find(|(key, _)| key == "u")
                    .map(|(_, value)| playback_log::resource_id(&value));
                let route = match request.uri().path() { "/hls" => "playlist", "/seg" => "segment_or_key", "/img" => "image", _ => "unknown" };
                let range = request.headers().get("Range").and_then(|v| v.to_str().ok())
                    .filter(|v| v.len() <= 100 && v.bytes().all(|b| b.is_ascii_digit() || b"bytes=,- ".contains(&b)));
                let origin_kind = match request_origin.as_deref() { None => "missing", Some("null") => "null", Some(origin) if allowed_frontend_origin(origin) => "app", _ => "other" };
                playback_log::record("protocol.request", serde_json::json!({"resource": resource, "route": route, "method": request.method().as_str(), "range": range, "origin_kind": origin_kind}));
            }
            if network_policy::strict_security()
                && request_origin
                    .as_deref()
                    .is_some_and(|origin| !allowed_frontend_origin(origin))
            {
                playback_log::record("security.origin_denied", serde_json::json!({"origin_null": request_origin.as_deref() == Some("null")}));
                responder.respond(
                    tauri::http::Response::builder()
                        .status(403)
                        .body(b"origin denied".to_vec())
                        .unwrap(),
                );
                return;
            }
            let uri = request.uri().clone();
            let path = uri.path().to_string();
            let query = uri.query().unwrap_or("").to_string();
            let range = request
                .headers()
                .get("Range")
                .and_then(|v| v.to_str().ok())
                .filter(|v| {
                    v.len() <= 100
                        && v.bytes()
                            .all(|b| b.is_ascii_digit() || b"bytes=,- ".contains(&b))
                })
                .map(str::to_string);
            // LOCAL_ORIGIN is platform-specific and must match frontend src/api.ts `LOCAL`
            // (also the m3u8 segment/key rewrite prefix).
            tauri::async_runtime::spawn(async move {
                let mut resp = media::handle_with_range(
                    &path,
                    &query,
                    media::LOCAL_ORIGIN,
                    range.as_deref(),
                )
                .await;
                if let Some(origin) =
                    request_origin.and_then(|s| tauri::http::HeaderValue::from_str(&s).ok())
                {
                    resp.headers_mut()
                        .insert("Access-Control-Allow-Origin", origin);
                    resp.headers_mut()
                        .insert("Vary", tauri::http::HeaderValue::from_static("Origin"));
                } else {
                    resp.headers_mut().insert(
                        "Access-Control-Allow-Origin",
                        tauri::http::HeaderValue::from_static("*"),
                    );
                }
                responder.respond(resp);
            });
        })
        .invoke_handler(tauri::generate_handler![
            api::app_boot,
            playback_log::playback_log_status,
            playback_log::playback_log_set,
            playback_log::playback_log_write,
            playback_log::playback_log_read,
            api::security_set,
            api::debug_log,
            api::net_diag,
            api::line_state,
            api::line_set,
            api::line_mirrors,
            api::line_probe,
            api::check_update,
            api::open_url,
            api::set_orientation,
            api::set_immersive,
            api::api_login,
            api::api_register,
            api::api_logout,
            api::api_me,
            api::api_feed,
            api::api_category,
            api::api_rank,
            api::api_search,
            api::api_download_start,
            api::api_download_list,
            api::api_download_delete,
            api::api_download_dir,
            api::api_download_set_dir,
            api::api_download_pick_dir,
            api::api_download_reset_dir,
            api::api_download_open_dir,
            api::api_download_open_file,
            api::api_ffmpeg_status,
            api::api_ffmpeg_install,
            api::cache_clear,
            api::api_posts,
            api::api_post,
            api::api_post_like,
            api::api_post_collect,
            api::api_post_comments,
            api::api_video,
            api::api_play,
            api::api_comments,
            api::api_comment_send,
            api::api_like,
            api::api_collect,
            api::api_follow,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
