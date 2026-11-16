//! Locate or install a portable FFmpeg binary for remuxing offline downloads to MP4.

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

static TOOLS_DIR: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

pub fn bind(app_data: &Path) {
    let dir = app_data.join("tools").join("ffmpeg");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut g) = TOOLS_DIR.lock() {
        *g = Some(dir);
    }
}

fn tools_dir() -> Option<PathBuf> {
    TOOLS_DIR.lock().ok().and_then(|g| g.clone())
}

fn bundled_bin() -> Option<PathBuf> {
    let dir = tools_dir()?;
    #[cfg(windows)]
    let name = "ffmpeg.exe";
    #[cfg(not(windows))]
    let name = "ffmpeg";
    let p = dir.join(name);
    if p.is_file() { Some(p) } else { None }
}

fn path_bin() -> Option<PathBuf> {
    #[cfg(windows)]
    let names = ["ffmpeg.exe", "ffmpeg"];
    #[cfg(not(windows))]
    let names = ["ffmpeg"];
    for name in names {
        let mut cmd = Command::new(name);
        cmd.arg("-version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        if cmd.status().map(|s| s.success()).unwrap_or(false) {
            return Some(PathBuf::from(name));
        }
    }
    None
}

/// Preferred FFmpeg executable: app-bundled first, then PATH.
pub fn resolve_bin() -> Option<PathBuf> {
    bundled_bin().or_else(path_bin)
}

pub fn status() -> Value {
    if let Some(p) = bundled_bin() {
        return json!({
            "available": true,
            "source": "bundled",
            "path": p.to_string_lossy(),
            "can_install": false,
        });
    }
    if let Some(p) = path_bin() {
        return json!({
            "available": true,
            "source": "path",
            "path": p.to_string_lossy(),
            "can_install": false,
        });
    }
    json!({
        "available": false,
        "source": "missing",
        "path": Value::Null,
        "can_install": cfg!(not(any(target_os = "android", target_os = "ios"))),
    })
}

fn download_url() -> Result<&'static str, String> {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Ok("https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffmpeg-6.1-win-64.zip")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Ok("https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffmpeg-6.1-linux-64.zip")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Ok("https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffmpeg-6.1-macos-64.zip")
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Ok("https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffmpeg-6.1-macos-arm64.zip")
    } else {
        Err("Automatic FFmpeg install is not available on this platform".into())
    }
}

fn host_allowed(host: &str) -> bool {
    matches!(
        host,
        "github.com" | "objects.githubusercontent.com" | "release-assets.githubusercontent.com"
    )
}

async fn fetch_bytes_allowed(url: &str) -> Result<Vec<u8>, String> {
    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https" {
        return Err("FFmpeg download must use HTTPS".into());
    }
    let host = parsed.host_str().unwrap_or("");
    if !host_allowed(host) {
        return Err(format!("Host not allowed for FFmpeg download: {host}"));
    }
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .redirect(reqwest::redirect::Policy::limited(8))
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(url)
        .header(
            "User-Agent",
            format!("HGhub/{} (ffmpeg-tool)", env!("CARGO_PKG_VERSION")),
        )
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(h) = res.url().host_str() {
        if !host_allowed(h) {
            return Err(format!("Redirect host not allowed: {h}"));
        }
    }
    if !res.status().is_success() {
        return Err(format!("FFmpeg download HTTP {}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() < 64_000 {
        return Err("FFmpeg download looks too small".into());
    }
    Ok(bytes.to_vec())
}

fn extract_ffmpeg_from_zip(zip_bytes: &[u8], dest_dir: &Path) -> Result<PathBuf, String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(zip_bytes)).map_err(|e| format!("zip open: {e}"))?;
    #[cfg(windows)]
    let want = "ffmpeg.exe";
    #[cfg(not(windows))]
    let want = "ffmpeg";

    let mut found_index = None;
    for i in 0..archive.len() {
        let name = archive
            .by_index(i)
            .map_err(|e| e.to_string())?
            .name()
            .replace('\\', "/");
        let file_name = name.rsplit('/').next().unwrap_or(&name);
        if file_name.eq_ignore_ascii_case(want) {
            found_index = Some(i);
            break;
        }
    }
    let idx = found_index.ok_or_else(|| format!("{want} not found in archive"))?;
    let mut file = archive.by_index(idx).map_err(|e| e.to_string())?;
    let out = dest_dir.join(want);
    let tmp = dest_dir.join(format!("{want}.tmp"));
    {
        let mut w = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        w.write_all(&buf).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&out).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&out, perms).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

fn smoke_ok(bin: &Path) -> bool {
    let mut cmd = Command::new(bin);
    cmd.arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

/// Download a portable FFmpeg into the app tools directory. Call only after UI consent.
pub async fn install() -> Result<Value, String> {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        return Err("FFmpeg install is not supported on mobile".into());
    }
    if let Some(p) = resolve_bin() {
        return Ok(json!({
            "ok": true,
            "already": true,
            "path": p.to_string_lossy(),
            "source": if bundled_bin().is_some() { "bundled" } else { "path" },
        }));
    }
    let url = download_url()?;
    let dest = tools_dir().ok_or_else(|| "Tools directory not initialized".to_string())?;
    let _ = std::fs::create_dir_all(&dest);
    let bytes = fetch_bytes_allowed(url).await?;
    let dest2 = dest.clone();
    let bin = tokio::task::spawn_blocking(move || extract_ffmpeg_from_zip(&bytes, &dest2))
        .await
        .map_err(|e| e.to_string())??;
    if !smoke_ok(&bin) {
        let _ = std::fs::remove_file(&bin);
        return Err("Downloaded FFmpeg failed to run".into());
    }
    Ok(json!({
        "ok": true,
        "already": false,
        "path": bin.to_string_lossy(),
        "source": "bundled",
    }))
}
