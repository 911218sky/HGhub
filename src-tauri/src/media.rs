//! Media layer: cover decrypt + HLS proxy.
//!
//! Covers are AES-128-CBC ciphertext; m3u8 segment/key URLs may be blocked by
//! WebView CORS, so image and video traffic use the local custom protocol
//! (`http://hg.localhost` on Windows/Android, `hg://localhost` elsewhere — see
//! [`LOCAL_ORIGIN`]). Frontend `src/api.ts` `LOCAL` must match or media fails.

use crate::net::fetch_bytes;
use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use once_cell::sync::Lazy;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::http::{Response, StatusCode};

/// Full origin for this platform's custom protocol.
///
/// Windows/Android: `http://<scheme>.localhost`; macOS/iOS/Linux: `<scheme>://localhost`.
/// Must stay in sync with frontend `LOCAL`.
#[cfg(any(target_os = "windows", target_os = "android"))]
pub const LOCAL_ORIGIN: &str = "http://hg.localhost";
#[cfg(not(any(target_os = "windows", target_os = "android")))]
pub const LOCAL_ORIGIN: &str = "hg://localhost";

const IMG_KEY: &[u8] = b"f5d965df75336270";
const IMG_IV: &[u8] = b"97b60394abc2fbe1";

static IMG_CACHE: Lazy<Mutex<HashMap<String, Arc<Vec<u8>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static PL_CACHE: Lazy<Mutex<HashMap<String, Arc<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static KEY_CACHE: Lazy<Mutex<HashMap<String, (String, Arc<Vec<u8>>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SEG_CACHE: Lazy<Mutex<HashMap<String, (String, Arc<Vec<u8>>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const IMG_CACHE_MAX: usize = 240;
const PL_CACHE_MAX: usize = 60;
const KEY_CACHE_MAX: usize = 120;
const SEG_CACHE_MAX: usize = 36;
const SEG_CACHE_MAX_BYTES: usize = 4 * 1024 * 1024;

fn cache_put<V: Clone>(map: &Mutex<HashMap<String, V>>, key: String, val: V, max: usize) {
    let mut m = map.lock().unwrap();
    if m.len() >= max {
        if let Some(k) = m.keys().next().cloned() {
            m.remove(&k);
        }
    }
    m.insert(key, val);
}

/* ───────────────────────── AES ───────────────────────── */

fn aes_cbc_decrypt(data: &[u8]) -> Option<Vec<u8>> {
    if data.is_empty() || data.len() % 16 != 0 {
        return None;
    }
    let cipher = Aes128::new_from_slice(IMG_KEY).ok()?;
    let mut prev = [0u8; 16];
    prev.copy_from_slice(IMG_IV);
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        let mut ct = [0u8; 16];
        ct.copy_from_slice(chunk);
        let mut block = ct;
        cipher.decrypt_block((&mut block).into());
        for i in 0..16 {
            out.push(block[i] ^ prev[i]);
        }
        prev = ct;
    }
    Some(out)
}

fn strip_padding(mut buf: Vec<u8>) -> Vec<u8> {
    let pad = *buf.last().unwrap_or(&0) as usize;
    if pad > 0 && pad <= 16 && buf.len() >= pad {
        if buf[buf.len() - pad..].iter().all(|b| *b as usize == pad) {
            buf.truncate(buf.len() - pad);
        }
    }
    buf
}

fn image_kind(buf: &[u8]) -> Option<&'static str> {
    if buf.len() < 12 {
        return None;
    }
    if buf[0] == 0xFF && buf[1] == 0xD8 {
        return Some("image/jpeg");
    }
    if buf.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some("image/png");
    }
    if buf.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if buf.starts_with(b"RIFF") && &buf[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// Load cover: cache hit or download + decrypt when needed.
pub async fn load_image(url: &str) -> Result<(String, Arc<Vec<u8>>), String> {
    if let Some(hit) = IMG_CACHE.lock().unwrap().get(url).cloned() {
        let kind = image_kind(&hit).unwrap_or("image/jpeg");
        return Ok((kind.to_string(), hit));
    }
    let (_, bytes) = fetch_bytes(url).await?;
    let plain = if image_kind(&bytes).is_some() {
        bytes
    } else {
        let dec = aes_cbc_decrypt(&bytes).ok_or_else(|| "Cover decrypt failed".to_string())?;
        strip_padding(dec)
    };
    let kind = image_kind(&plain).unwrap_or("image/jpeg").to_string();
    let arc = Arc::new(plain);
    cache_put(&IMG_CACHE, url.to_string(), arc.clone(), IMG_CACHE_MAX);
    Ok((kind, arc))
}

/* ───────────────────────── HLS ───────────────────────── */

fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

fn dec(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().to_string()
}

fn absolutize(base: &str, target: &str) -> String {
    if target.starts_with("http://") || target.starts_with("https://") {
        return target.to_string();
    }
    if let Ok(b) = url::Url::parse(base) {
        if let Ok(j) = b.join(target) {
            return j.to_string();
        }
    }
    target.to_string()
}

/// Quoted attribute values may contain commas — do not split on `,` blindly.
fn hls_attributes(line: &str) -> Option<(&str, Vec<&str>)> {
    let (tag, rest) = line.split_once(':')?;
    let mut attributes = Vec::new();
    let mut quoted = false;
    let mut start = 0;
    for (i, ch) in rest.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        }
        if ch == ',' && !quoted {
            attributes.push(&rest[start..i]);
            start = i + 1;
        }
    }
    attributes.push(&rest[start..]);
    Some((tag, attributes))
}

fn map_uri_attributes(line: &str, mut rewrite: impl FnMut(&str) -> String) -> String {
    let Some((tag, attributes)) = hls_attributes(line) else {
        return line.to_string();
    };
    let mapped: Vec<String> = attributes
        .into_iter()
        .map(|attribute| {
            if let Some((key, value)) = attribute.split_once('=') {
                if key.trim() == "URI" {
                    if let Some(uri) = value
                        .trim()
                        .strip_prefix('"')
                        .and_then(|v| v.strip_suffix('"'))
                    {
                        return format!("{key}=\"{}\"", rewrite(uri));
                    }
                }
            }
            attribute.to_string()
        })
        .collect();
    format!("{tag}:{}", mapped.join(","))
}

fn rewrite_uri_attr(line: &str, prefix: &str) -> String {
    map_uri_attributes(line, |uri| format!("{prefix}/seg?u={}", enc(uri)))
}

/// Fetch m3u8 and rewrite key / variant / segment URLs onto the local protocol.
pub async fn load_playlist(url: &str, prefix: &str) -> Result<Arc<String>, String> {
    let cache_key = format!("{prefix}|{url}");
    if let Some(hit) = PL_CACHE.lock().unwrap().get(&cache_key).cloned() {
        return Ok(hit);
    }
    if let Some(rel) = url.strip_prefix("offline:") {
        let (_ctype, bytes) = crate::download::read_local(rel)?;
        let text = std::str::from_utf8(&bytes).map_err(|_| "Playlist is not UTF-8 text")?;
        if !text.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
            return Err("Response is not an HLS playlist".into());
        }
        let dir = rel.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
        let arc = Arc::new(rewrite_offline_playlist(text, dir, prefix));
        cache_put(&PL_CACHE, cache_key, arc.clone(), PL_CACHE_MAX);
        return Ok(arc);
    }
    let (_, bytes) = fetch_bytes(url).await?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "Playlist is not UTF-8 text")?;
    if !text.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
        return Err("Response is not an HLS playlist".into());
    }
    let arc = Arc::new(rewrite_playlist(url, text, prefix));
    cache_put(&PL_CACHE, cache_key, arc.clone(), PL_CACHE_MAX);
    Ok(arc)
}

fn rewrite_offline_playlist(text: &str, dir: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(text.len() + 256);
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            out.push('\n');
            continue;
        }
        if line.starts_with('#') {
            if line.contains("URI=\"") {
                let mapped = map_uri_attributes(line, |uri| {
                    let rel = if uri.contains('/') {
                        uri.to_string()
                    } else {
                        format!("{dir}/{uri}")
                    };
                    format!("{prefix}/seg?u={}", enc(&format!("offline:{rel}")))
                });
                out.push_str(&mapped);
            } else {
                out.push_str(line);
            }
        } else {
            let rel = if line.contains('/') {
                line.to_string()
            } else {
                format!("{dir}/{line}")
            };
            out.push_str(&format!("{prefix}/seg?u={}", enc(&format!("offline:{rel}"))));
        }
        out.push('\n');
    }
    out
}

fn rewrite_playlist(url: &str, text: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(text.len() + 512);
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            out.push('\n');
            continue;
        }
        if line.starts_with('#') {
            // Drop content-steering (derivable URLs); keep DATERANGE timing/SCTE-35 metadata.
            if line.starts_with("#EXT-X-CONTENT-STEERING:") {
                continue;
            }
            if line.starts_with("#EXT-X-DATERANGE:") {
                if let Some((tag, attributes)) = hls_attributes(line) {
                    let safe: Vec<&str> = attributes
                        .into_iter()
                        .filter(|attribute| {
                            let key = attribute
                                .split('=')
                                .next()
                                .unwrap_or("")
                                .trim()
                                .to_ascii_uppercase();
                            !key.contains("URI") && key != "X-ASSET-LIST"
                        })
                        .collect();
                    out.push_str(&format!("{tag}:{}\n", safe.join(",")));
                }
                continue;
            }
            if line.contains("URI=\"") {
                // KEY/MAP/MEDIA/SESSION-KEY/PART/PRELOAD-HINT URIs must go through target checks.
                let absolute = absolutize_uri_in_attr(url, line);
                out.push_str(&rewrite_uri_attr(&absolute, prefix));
            } else {
                out.push_str(line);
            }
        } else {
            let absolute = absolutize(url, line);
            out.push_str(&format!("{prefix}/seg?u={}", enc(&absolute)));
        }
        out.push('\n');
    }

    out
}

fn absolutize_uri_in_attr(base: &str, line: &str) -> String {
    map_uri_attributes(line, |uri| absolutize(base, uri))
}

/// Load a segment or AES key (memory-cached to avoid seek thrashing).
pub async fn load_segment(url: &str) -> Result<(Option<String>, Arc<Vec<u8>>), String> {
    if let Some((ctype, hit)) = KEY_CACHE.lock().unwrap().get(url).cloned() {
        return Ok((Some(ctype), hit));
    }
    if let Some((ctype, hit)) = SEG_CACHE.lock().unwrap().get(url).cloned() {
        return Ok((Some(ctype), hit));
    }
    if let Some(rel) = url.strip_prefix("offline:") {
        let (ctype, raw) = crate::download::read_local(rel)?;
        let arc = Arc::new(raw);
        return Ok((Some(ctype), arc));
    }
    let (ctype, bytes) = fetch_bytes(url).await?;
    let mime = ctype.clone().unwrap_or_else(|| {
        let p = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
        if p.ends_with(".ts") {
            "video/mp2t".to_string()
        } else if p.ends_with(".m4s") || p.ends_with(".mp4") {
            "video/mp4".to_string()
        } else {
            "application/octet-stream".to_string()
        }
    });
    let len = bytes.len();
    let arc = Arc::new(bytes);
    if len <= 65536 {
        cache_put(&KEY_CACHE, url.to_string(), (mime.clone(), arc.clone()), KEY_CACHE_MAX);
    } else if len <= SEG_CACHE_MAX_BYTES {
        cache_put(&SEG_CACHE, url.to_string(), (mime.clone(), arc.clone()), SEG_CACHE_MAX);
    }
    Ok((Some(mime), arc))
}

/// Clear cover / playlist / segment memory caches.
pub fn clear_caches() {
    if let Ok(mut g) = IMG_CACHE.lock() { g.clear(); }
    if let Ok(mut g) = PL_CACHE.lock() { g.clear(); }
    if let Ok(mut g) = KEY_CACHE.lock() { g.clear(); }
    if let Ok(mut g) = SEG_CACHE.lock() { g.clear(); }
}

/* ───────────────────────── protocol responses ───────────────────────── */

fn respond(status: u16, ctype: &str, body: Vec<u8>, cache: &str) -> Response<Vec<u8>> {
    respond_range(status, ctype, body, cache, None)
}

fn respond_range(
    status: u16,
    ctype: &str,
    body: Vec<u8>,
    cache: &str,
    range: Option<&str>,
) -> Response<Vec<u8>> {
    let total = body.len();
    let (status, slice, content_range) = match range.and_then(parse_bytes_range) {
        Some((start, end_incl)) if start < total => {
            let end = end_incl.min(total.saturating_sub(1));
            if start > end {
                (
                    416,
                    Vec::new(),
                    Some(format!("bytes */{total}")),
                )
            } else {
                (
                    206,
                    body[start..=end].to_vec(),
                    Some(format!("bytes {start}-{end}/{total}")),
                )
            }
        }
        _ => (status, body, None),
    };
    let len = slice.len().to_string();
    let mut b = Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK))
        .header("Content-Type", ctype)
        .header("Content-Length", len)
        .header("Accept-Ranges", "bytes")
        .header("X-Content-Type-Options", "nosniff")
        .header(
            "Access-Control-Expose-Headers",
            "Content-Length, Content-Type, Accept-Ranges, Content-Range",
        )
        .header("Cache-Control", cache);
    if let Some(cr) = content_range {
        b = b.header("Content-Range", cr);
    }
    b.body(slice)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Parse `bytes=START-END` (single range). END may be omitted.
fn parse_bytes_range(header: &str) -> Option<(usize, usize)> {
    let s = header.trim();
    let rest = s.strip_prefix("bytes=")?;
    let (a, b) = rest.split_once('-')?;
    let start: usize = a.trim().parse().ok()?;
    let end = if b.trim().is_empty() {
        usize::MAX
    } else {
        b.trim().parse().ok()?
    };
    Some((start, end))
}

/// Nested playlists returned via /seg must keep being rewritten — never hand raw URLs to the player.
fn segment_response(
    target: &str,
    ctype: Option<&str>,
    bytes: Vec<u8>,
    origin: &str,
    range: Option<&str>,
) -> Response<Vec<u8>> {
    let playlist = ctype.is_some_and(|t| t.to_ascii_lowercase().contains("mpegurl"))
        || bytes.starts_with(b"#EXTM3U")
        || bytes.starts_with(b"\xef\xbb\xbf#EXTM3U");
    if playlist {
        // Offline playlists must keep local segment URIs mapped through offline:.
        let body = if let Some(rel) = target.strip_prefix("offline:") {
            match std::str::from_utf8(&bytes) {
                Ok(text) => {
                    let dir = rel.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
                    rewrite_offline_playlist(text, dir, origin).into_bytes()
                }
                Err(_) => {
                    return respond(
                        502,
                        "text/plain",
                        b"invalid playlist encoding".to_vec(),
                        "no-store",
                    );
                }
            }
        } else {
            match std::str::from_utf8(&bytes) {
                Ok(text) => rewrite_playlist(target, text, origin).into_bytes(),
                Err(_) => {
                    return respond(
                        502,
                        "text/plain",
                        b"invalid playlist encoding".to_vec(),
                        "no-store",
                    );
                }
            }
        };
        return respond(
            200,
            "application/vnd.apple.mpegurl",
            body,
            "public, max-age=3600",
        );
    }
    respond_range(
        200,
        ctype.unwrap_or("application/octet-stream"),
        bytes,
        "public, max-age=3600",
        range,
    )
}

/// Unified handler: `<LOCAL_ORIGIN>/img?u=` / `hls?u=` / `seg?u=`
///
/// `origin` is this platform's custom-protocol base ([`LOCAL_ORIGIN`]) used when
/// rewriting m3u8 segment/key URLs.
#[allow(dead_code)] // used by unit tests / callers that do not need Range
pub async fn handle(path: &str, query: &str, origin: &str) -> Response<Vec<u8>> {
    handle_with_range(path, query, origin, None).await
}

pub async fn handle_with_range(
    path: &str,
    query: &str,
    origin: &str,
    range: Option<&str>,
) -> Response<Vec<u8>> {
    let target = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("u="))
        .map(dec)
        .unwrap_or_default();

    if target.is_empty() {
        return respond(400, "text/plain", b"missing u".to_vec(), "no-store");
    }

    let started = std::time::Instant::now();
    let route = match path {
        "/img" => "image",
        "/hls" => "playlist",
        "/seg" => "segment_or_key",
        _ => "unknown",
    };
    crate::playback_log::record(
        "proxy.begin",
        serde_json::json!({"route": route, "resource": crate::playback_log::resource_id(&target)}),
    );
    let response = match path {
        "/img" => match load_image(&target).await {
            Ok((kind, bytes)) => {
                respond(200, &kind, bytes.as_ref().clone(), "public, max-age=86400")
            }
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        "/hls" => match load_playlist(&target, origin).await {
            Ok(text) => respond(
                200,
                "application/vnd.apple.mpegurl",
                text.as_bytes().to_vec(),
                "no-store",
            ),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        "/seg" => match load_segment(&target).await {
            Ok((ctype, bytes)) => segment_response(
                &target,
                ctype.as_deref(),
                bytes.as_ref().clone(),
                origin,
                range,
            ),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        _ => respond(404, "text/plain", b"not found".to_vec(), "no-store"),
    };
    crate::playback_log::record(
        "proxy.end",
        serde_json::json!({"route": route, "resource": crate::playback_log::resource_id(&target), "status": response.status().as_u16(), "bytes": response.body().len(), "elapsed_ms": started.elapsed().as_millis() as u64}),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dateranges_keep_timing_and_scte_metadata_but_drop_external_resources() {
        let line = "#EXTM3U\n#EXT-X-DATERANGE:ID=\"event\",START-DATE=\"2026-11-07T00:00:00Z\",DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\",X-ASSET-URI=\"https://evil.example/ad\",X-ASSET-LIST=\"https://evil.example/list.json\"\n";
        let out = rewrite_playlist("https://cdn.example/master.m3u8", line, LOCAL_ORIGIN);
        assert!(out.contains("DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\""));
        assert!(out.contains("START-DATE="));
        assert!(!out.contains("evil.example") && !out.contains("X-ASSET"));
    }

    #[test]
    fn every_uri_attribute_is_rewritten_without_splitting_quoted_commas() {
        let line = "#EXT-X-MEDIA:NAME=\"audio,main\",URI=\"first.m3u8\",URI=\"second.m3u8\"";
        let absolute = absolutize_uri_in_attr("https://cdn.example/master.m3u8", line);
        let rewritten = rewrite_uri_attr(&absolute, LOCAL_ORIGIN);
        assert_eq!(
            rewritten.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(),
            2
        );
        assert!(rewritten.contains("NAME=\"audio,main\""));
        assert!(!rewritten.contains("URI=\"https://"));
    }

    #[test]
    fn bytes_range_returns_partial_content() {
        let body = b"0123456789".to_vec();
        let resp = respond_range(200, "video/mp4", body, "no-store", Some("bytes=2-5"));
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(resp.body(), b"2345");
        assert_eq!(resp.headers()["Content-Range"], "bytes 2-5/10");
        assert_eq!(resp.headers()["Content-Length"], "4");
    }

    #[test]
    fn nested_playlists_and_alternate_uris_stay_behind_proxy() {
        let text = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio/list.m3u8\"\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"http://127.0.0.1/key\"\n#EXT-X-PART:DURATION=1,URI=\"part.ts\"\nvariant/list.m3u8\n";
        let response = segment_response(
            "https://cdn.example/master.m3u8",
            Some("application/octet-stream"),
            text.as_bytes().to_vec(),
            LOCAL_ORIGIN,
            None,
        );
        let body = std::str::from_utf8(response.body()).unwrap();
        assert_eq!(body.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(), 4);
        assert!(!body.contains("URI=\"http://127.0.0.1"));
        assert!(body.contains("https%3A%2F%2Fcdn%2Eexample%2Faudio%2Flist%2Em3u8"));
        assert_eq!(
            response.headers()["Content-Type"],
            "application/vnd.apple.mpegurl"
        );
        assert_eq!(response.headers()["X-Content-Type-Options"], "nosniff");
        assert!(!response
            .headers()
            .contains_key("Access-Control-Allow-Origin"));
        let optional = rewrite_playlist("https://cdn.example/list.m3u8",
            "#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI=\"https://other.example/list.json\"\n#EXT-X-DATERANGE:ID=\"ad\",X-ASSET-LIST=\"http://127.0.0.1/assets\"\nsegment.ts\n", LOCAL_ORIGIN);
        assert!(!optional.contains("CONTENT-STEERING") && !optional.contains("X-ASSET-LIST"));
        assert!(optional.contains("#EXT-X-DATERANGE:ID=\"ad\""));
        let bom = segment_response(
            "https://cdn.example/list.m3u8",
            None,
            b"\xef\xbb\xbf#EXTM3U\nsegment.ts\n".to_vec(),
            LOCAL_ORIGIN,
            None,
        );
        assert!(bom.body().starts_with(b"#EXTM3U\n"));
    }

    /// Live network test; depends on a live `/api/videos/117/play` URL.
    #[tokio::test]
    #[ignore = "network test: depends on live upstream play URL; run manually with --ignored"]
    async fn live_play_chain() {
        use crate::net::edge;
        let play = edge(
            &crate::net::base(),
            "GET",
            "/api/videos/117/play?ep=3&page_texts=0",
            None,
            None,
        )
        .await
        .expect("play api");
        let url = play["video_url"].as_str().expect("video_url").to_string();
        println!("play url: {}", &url[..url.len().min(90)]);
        let (_, bytes) = fetch_bytes(&url).await.expect("fetch playlist");
        let text = String::from_utf8_lossy(&bytes);
        println!(
            "raw playlist len={} head={}",
            text.len(),
            &text[..text.len().min(160)]
        );
        let q = format!("u={}", enc(&url));
        let resp = handle("/hls", &q, LOCAL_ORIGIN).await;
        let body = String::from_utf8_lossy(resp.body()).to_string();
        println!("proxied status={} len={}", resp.status(), body.len());
        assert!(body.contains("#EXTM3U"));
        let seg_line = body
            .lines()
            .find(|l| !l.starts_with('#') && l.contains("/seg?u="))
            .expect("seg line")
            .to_string();
        println!("seg line: {}", &seg_line[..seg_line.len().min(120)]);
        let seg_q = seg_line.split("?u=").nth(1).unwrap();
        let seg = handle("/seg", &format!("u={seg_q}"), LOCAL_ORIGIN).await;
        println!("segment status={} len={}", seg.status(), seg.body().len());
        assert_eq!(seg.status(), 200);
        assert!(seg.body().len() > 1000);
    }

    /// Offline: isomorphic playlist with signed segment + encrypted KEY + relative path.
    #[test]
    fn playlist_rewrite_works() {
        let base = "https://cdn.example/videos5/abc/abc.m3u8?auth_key=9999999999-0-0-deadbeef&v=3&via=hgdj";
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin?auth_key=9999999999-0-0-deadbeef\"\n#EXTINF:4,\nseg-1.ts?auth_key=9999999999-0-0-deadbeef\n";
        let body = rewrite_playlist(base, text, LOCAL_ORIGIN);

        assert!(body.contains("#EXTM3U"), "not a playlist: {body}");
        assert!(
            body.contains(&format!("{LOCAL_ORIGIN}/seg?u=")),
            "segments not rewritten: {body}"
        );
        // Segments must be absolutized to origin and keep signed query strings.
        assert!(
            body.contains("https%3A%2F%2Fcdn%2Eexample%2Fvideos5%2Fabc%2Fseg%2D1%2Ets%3Fauth%5Fkey%3D"),
            "segment not absolutized with query: {body}"
        );
        // KEY must also go through the local proxy or hls.js hits CORS on the origin.
        assert!(
            body.contains("URI=\"") && body.contains("%2Fkey%2Ebin%3Fauth%5Fkey%3D"),
            "key uri not rewritten: {body}"
        );
        assert!(!body.contains("URI=\"key.bin"), "key uri left relative");
    }

    /// Offline round-trip with built-in key/IV; live cover fetch stays `#[ignore]`.
    #[test]
    fn cover_decrypt_roundtrip() {
        use aes::cipher::BlockEncrypt;

        let plain = b"\xFF\xD8\xFF\xE0cover-payload-for-test".to_vec();
        let mut buf = plain.clone();
        let pad = 16 - plain.len() % 16;
        buf.extend(std::iter::repeat_n(pad as u8, pad));

        let cipher = Aes128::new_from_slice(IMG_KEY).expect("key");
        let mut prev = [0u8; 16];
        prev.copy_from_slice(IMG_IV);
        let mut encrypted = Vec::with_capacity(buf.len());
        for chunk in buf.chunks(16) {
            let mut block = [0u8; 16];
            block.copy_from_slice(chunk);
            for i in 0..16 {
                block[i] ^= prev[i];
            }
            let mut out_block = block;
            cipher.encrypt_block((&mut out_block).into());
            encrypted.extend_from_slice(&out_block);
            prev = out_block;
        }

        let decrypted = aes_cbc_decrypt(&encrypted).expect("decrypt");
        let stripped = strip_padding(decrypted);
        assert_eq!(stripped, plain);
        assert_eq!(image_kind(&stripped), Some("image/jpeg"));
    }

    /// Cover URLs are time-signed; pass a fresh one via env:
    /// `HGHUB_TEST_COVER_URL='https://…?auth_key=…' cargo test --lib -- --ignored`
    #[tokio::test]
    #[ignore = "network test: needs HGHUB_TEST_COVER_URL; run manually with --ignored"]
    async fn cover_decrypt_works() {
        let url = std::env::var("HGHUB_TEST_COVER_URL")
            .expect("Set HGHUB_TEST_COVER_URL to a currently valid cover URL");
        match load_image(&url).await {
            Ok((kind, bytes)) => {
                println!("kind={kind} len={}", bytes.len());
                assert!(kind.starts_with("image/"));
            }
            Err(e) => panic!("image failed: {e}"),
        }
    }
}
