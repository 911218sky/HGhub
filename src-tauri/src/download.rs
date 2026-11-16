//! Offline downloads: single episode or full series (HLS playlist + segments).
//! Uses the same legacy line play/detail endpoints as `api_play` / `api_video`.

use crate::api::Api;
use crate::net::{base, edge, fetch_bytes};
use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static ROOT: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));
static DEFAULT_ROOT: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));
static CONFIG_FILE: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));
static JOBS: Lazy<Mutex<HashMap<String, DownloadJob>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static QUEUE: Lazy<Mutex<VecDeque<QueuedTask>>> = Lazy::new(|| Mutex::new(VecDeque::new()));
static WORKER: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug)]
struct QueuedTask {
    key: String,
    origin: String,
    token: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DownloadJob {
    pub id: String,
    pub video_id: i64,
    pub series_id: String,
    pub slug: String,
    pub title: String,
    pub cover: String,
    pub ep: u32,
    pub total_eps: u32,
    pub mode: String, // "episode" | "series"
    pub status: String, // queued|running|done|error|cancelled
    pub progress: f64,
    pub message: String,
    pub playlist_path: String,
    /// Merged offline file (`video.mp4` or `video.ts`) when ready.
    #[serde(default)]
    pub video_path: String,
    #[serde(default)]
    pub file_size: u64,
    /// Episodes already on disk (series jobs); empty for single-episode jobs.
    #[serde(default)]
    pub ready_eps: Vec<u32>,
    pub updated_at: u64,
}

/// Bind default download root under app data; restore user-chosen folder if saved.
pub fn bind(app_data: &Path) {
    let default = app_data.join("downloads");
    let _ = std::fs::create_dir_all(&default);
    let cfg = app_data.join("download_dir.json");
    if let Ok(mut g) = DEFAULT_ROOT.lock() {
        *g = Some(default.clone());
    }
    if let Ok(mut g) = CONFIG_FILE.lock() {
        *g = Some(cfg.clone());
    }
    let chosen = load_saved_dir(&cfg).unwrap_or(default);
    let _ = std::fs::create_dir_all(&chosen);
    if let Ok(mut g) = ROOT.lock() {
        *g = Some(chosen);
    }
}

fn load_saved_dir(cfg: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(cfg).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let path = v.get("dir").and_then(|x| x.as_str())?;
    let p = PathBuf::from(path);
    if p.is_absolute() {
        Some(p)
    } else {
        None
    }
}

fn persist_dir(path: &Path) -> Result<(), String> {
    let cfg = CONFIG_FILE
        .lock()
        .map_err(|_| "download lock".to_string())?
        .clone()
        .ok_or_else(|| "Downloads not initialized".to_string())?;
    let text = serde_json::to_string_pretty(&json!({ "dir": path.to_string_lossy() }))
        .map_err(|e| e.to_string())?;
    std::fs::write(cfg, text).map_err(|e| e.to_string())
}

fn root() -> Result<PathBuf, String> {
    ROOT.lock()
        .map_err(|_| "download lock".to_string())?
        .clone()
        .ok_or_else(|| "Downloads not initialized".to_string())
}

pub fn current_dir() -> Result<String, String> {
    Ok(root()?.to_string_lossy().to_string())
}

pub fn set_dir(path: &str) -> Result<Value, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Folder path is empty".into());
    }
    let p = PathBuf::from(trimmed);
    if !p.is_absolute() {
        return Err("Please choose an absolute folder path".into());
    }
    std::fs::create_dir_all(&p).map_err(|e| format!("Cannot create folder: {e}"))?;
    // Reject if we cannot write a probe file.
    let probe = p.join(".hghub_write_test");
    std::fs::write(&probe, b"ok").map_err(|e| format!("Folder is not writable: {e}"))?;
    let _ = std::fs::remove_file(&probe);
    persist_dir(&p)?;
    if let Ok(mut g) = ROOT.lock() {
        *g = Some(p.clone());
    }
    Ok(json!({ "dir": p.to_string_lossy() }))
}

pub fn reset_dir() -> Result<Value, String> {
    let default = DEFAULT_ROOT
        .lock()
        .map_err(|_| "download lock".to_string())?
        .clone()
        .ok_or_else(|| "Downloads not initialized".to_string())?;
    let _ = std::fs::create_dir_all(&default);
    persist_dir(&default)?;
    if let Ok(mut g) = ROOT.lock() {
        *g = Some(default.clone());
    }
    Ok(json!({ "dir": default.to_string_lossy() }))
}

/// Native folder picker (desktop). Returns `null` when cancelled.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn pick_dir() -> Result<Value, String> {
    let current = root().ok();
    let picked = tokio::task::spawn_blocking(move || {
        let mut dlg = rfd::FileDialog::new().set_title("Choose download folder");
        if let Some(cur) = current.as_ref() {
            dlg = dlg.set_directory(cur);
        }
        dlg.pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    match picked {
        Some(path) => set_dir(&path.to_string_lossy()),
        None => Ok(Value::Null),
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub async fn pick_dir() -> Result<Value, String> {
    Err("Folder picker is not available on this platform".into())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn job_key(video_id: i64, ep: u32, mode: &str) -> String {
    if mode == "series" {
        format!("series:{video_id}")
    } else {
        format!("ep:{video_id}:{ep}")
    }
}

fn episode_dir(video_id: i64, ep: u32) -> Result<PathBuf, String> {
    Ok(root()?.join(format!("{video_id}")).join(format!("ep_{ep}")))
}

fn job_manifest_path(job: &DownloadJob) -> Result<PathBuf, String> {
    // Series jobs live at `<id>/job.json` so per-episode folders don't create stale duplicates.
    if job.mode == "series" {
        Ok(root()?.join(format!("{}", job.video_id)).join("job.json"))
    } else {
        Ok(episode_dir(job.video_id, job.ep)?.join("job.json"))
    }
}

fn save_manifest(job: &DownloadJob) -> Result<(), String> {
    let path = job_manifest_path(job)?;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let text = serde_json::to_string_pretty(job).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

fn bump_job(job_id: &str, mut edit: impl FnMut(&mut DownloadJob)) {
    if let Ok(mut jobs) = JOBS.lock() {
        if let Some(j) = jobs.get_mut(job_id) {
            edit(j);
            j.updated_at = now_secs();
            let _ = save_manifest(j);
        }
    }
}

fn read_job_file(path: &Path) -> Option<DownloadJob> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn list() -> Result<Value, String> {
    let base_dir = root()?;
    let mut by_id: HashMap<String, DownloadJob> = HashMap::new();
    if let Ok(series) = std::fs::read_dir(&base_dir) {
        for s in series.flatten() {
            let sp = s.path();
            if !sp.is_dir() {
                continue;
            }
            // Series-level manifest.
            if let Some(job) = read_job_file(&sp.join("job.json")) {
                by_id.insert(job.id.clone(), job);
            }
            if let Ok(eps) = std::fs::read_dir(&sp) {
                for e in eps.flatten() {
                    let jp = e.path().join("job.json");
                    if let Some(job) = read_job_file(&jp) {
                        // Keep newest by updated_at when duplicates exist from older builds.
                        match by_id.get(&job.id) {
                            Some(prev) if prev.updated_at >= job.updated_at => {}
                            _ => {
                                by_id.insert(job.id.clone(), job);
                            }
                        }
                    }
                }
            }
        }
    }
    // In-memory jobs always win (live progress).
    if let Ok(jobs) = JOBS.lock() {
        for job in jobs.values() {
            by_id.insert(job.id.clone(), job.clone());
        }
    }
    // Enrich jobs with on-disk video path / size / ready episode list.
    for job in by_id.values_mut() {
        if job.mode == "series" {
            let n = job.total_eps.max(1);
            let mut ready = Vec::new();
            let mut total_size = 0u64;
            for ep in 1..=n {
                if !episode_ready(job.video_id, ep) {
                    continue;
                }
                ready.push(ep);
                if let Ok((mp4, ts, pl)) = episode_media_files(job.video_id, ep) {
                    let path = if mp4.is_file() {
                        Some(mp4)
                    } else if ts.is_file() {
                        Some(ts)
                    } else if pl.is_file() {
                        Some(pl)
                    } else {
                        None
                    };
                    if let Some(path) = path {
                        total_size += std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    }
                }
            }
            job.ready_eps = ready;
            job.file_size = total_size;
            continue;
        }
        if let Ok((mp4, ts, pl)) = episode_media_files(job.video_id, job.ep) {
            let has_video = mp4.is_file() || ts.is_file();
            let path = if mp4.is_file() {
                Some(mp4)
            } else if ts.is_file() {
                Some(ts)
            } else if pl.is_file() {
                Some(pl)
            } else {
                None
            };
            if let Some(path) = path {
                if job.video_path.is_empty() {
                    job.video_path = path.to_string_lossy().to_string();
                }
                if job.file_size == 0 {
                    job.file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                }
                if job.status == "running" && has_video {
                    // Recover stale "running" manifests left by older builds.
                    job.status = "done".into();
                    job.progress = 1.0;
                    job.message = "Offline ready".into();
                }
                job.ready_eps = vec![job.ep];
            }
        }
    }
    let mut items: Vec<DownloadJob> = by_id.into_values().collect();
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(json!({
        "items": items,
        "dir": base_dir.to_string_lossy(),
    }))
}

fn episode_media_files(video_id: i64, ep: u32) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let dir = episode_dir(video_id, ep)?;
    Ok((dir.join("video.mp4"), dir.join("video.ts"), dir.join("index.m3u8")))
}

pub fn episode_ready(video_id: i64, ep: u32) -> bool {
    episode_media_files(video_id, ep)
        .map(|(mp4, ts, pl)| mp4.is_file() || ts.is_file() || pl.is_file())
        .unwrap_or(false)
}

/// Prefer offline play URL for the WebView player.
///
/// Order matters on mobile: raw MPEG-TS (`video.ts`) usually **cannot** play in
/// Android/iOS WebView `<video>`. Prefer MP4, then local HLS playlist (segments
/// + key already on disk), and only then TS as a last resort (desktop).
pub fn offline_playlist(video_id: i64, ep: u32) -> Result<Option<String>, String> {
    let (mp4, ts, pl) = episode_media_files(video_id, ep)?;
    if mp4.is_file() {
        return Ok(Some(format!("offline:{video_id}/ep_{ep}/video.mp4")));
    }
    if pl.is_file() {
        return Ok(Some(format!("offline:{video_id}/ep_{ep}/index.m3u8")));
    }
    if ts.is_file() {
        return Ok(Some(format!("offline:{video_id}/ep_{ep}/video.ts")));
    }
    Ok(None)
}

pub fn offline_file_path(video_id: i64, ep: u32) -> Result<Option<String>, String> {
    let (mp4, ts, pl) = episode_media_files(video_id, ep)?;
    if mp4.is_file() {
        return Ok(Some(mp4.to_string_lossy().to_string()));
    }
    if ts.is_file() {
        return Ok(Some(ts.to_string_lossy().to_string()));
    }
    if pl.is_file() {
        return Ok(Some(pl.to_string_lossy().to_string()));
    }
    Ok(None)
}

pub fn delete(video_id: i64, ep: Option<u32>) -> Result<Value, String> {
    let root = root()?;
    if let Some(ep) = ep {
        let dir = episode_dir(video_id, ep)?;
        let _ = std::fs::remove_dir_all(dir);
        if let Ok(mut jobs) = JOBS.lock() {
            jobs.retain(|_, j| !(j.video_id == video_id && j.ep == ep));
        }
    } else {
        let dir = root.join(format!("{video_id}"));
        let _ = std::fs::remove_dir_all(dir);
        if let Ok(mut jobs) = JOBS.lock() {
            jobs.retain(|_, j| j.video_id != video_id);
        }
    }
    Ok(json!({ "ok": true }))
}

/// Read a file under the downloads root (path traversal safe).
pub fn read_local(rel: &str) -> Result<(String, Vec<u8>), String> {
    let root = root()?;
    let path = root.join(rel);
    let canon = path.canonicalize().map_err(|e| e.to_string())?;
    let root_canon = root.canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(&root_canon) {
        return Err("Invalid offline path".into());
    }
    let bytes = std::fs::read(&canon).map_err(|e| e.to_string())?;
    let mime = if rel.ends_with(".m3u8") {
        "application/vnd.apple.mpegurl".into()
    } else if rel.ends_with(".mp4") {
        "video/mp4".into()
    } else if rel.ends_with(".ts") {
        "video/mp2t".into()
    } else if rel.ends_with(".key") {
        "application/octet-stream".into()
    } else {
        "application/octet-stream".into()
    };
    Ok((mime, bytes))
}

fn normalize_play_info(info: &mut Value) {
    fn non_empty(v: Option<&Value>) -> Option<String> {
        v.and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    }
    let main = non_empty(info.get("streams").and_then(|s| s.get("main")));
    let hevc = non_empty(info.get("streams").and_then(|s| s.get("hevc")));
    let Some(obj) = info.as_object_mut() else {
        return;
    };
    for (field, stream) in [("video_url", main), ("video_url_hevc", hevc)] {
        if let Some(url) = stream {
            if non_empty(obj.get(field)).is_none() {
                obj.insert(field.into(), json!(url));
            }
        }
    }
}

fn play_url_of(info: &Value) -> Option<String> {
    info.get("video_url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

async fn resolve_play_url(origin: &str, token: Option<&str>, id: i64, ep: u32) -> Result<String, String> {
    let primary = edge(
        origin,
        "POST",
        &format!("/api/videos/{id}/episodes/{ep}/playback"),
        Some(json!({})),
        token,
    )
    .await
    .map(|mut info| {
        normalize_play_info(&mut info);
        info
    });
    if let Ok(info) = &primary {
        if let Some(url) = play_url_of(info) {
            return Ok(url);
        }
    }
    match edge(
        origin,
        "GET",
        &format!("/api/videos/{id}/play?ep={ep}&page_texts=0"),
        None,
        token,
    )
    .await
    {
        Ok(mut legacy) => {
            normalize_play_info(&mut legacy);
            if let Some(url) = play_url_of(&legacy) {
                Ok(url)
            } else if let Ok(info) = primary {
                play_url_of(&info).ok_or_else(|| "Missing play URL".into())
            } else {
                Err("Missing play URL".into())
            }
        }
        Err(e) => {
            if let Ok(info) = primary {
                play_url_of(&info).ok_or_else(|| e)
            } else {
                Err(e)
            }
        }
    }
}

fn existing_done_job(video_id: i64, ep: u32, mode: &str, title: &str, cover: &str, total_eps: u32) -> Option<DownloadJob> {
    if mode == "episode" {
        if !episode_ready(video_id, ep) {
            return None;
        }
        let (mp4, ts, pl) = episode_media_files(video_id, ep).ok()?;
        let path = if mp4.is_file() {
            mp4
        } else if ts.is_file() {
            ts
        } else {
            pl
        };
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        return Some(DownloadJob {
            id: job_key(video_id, ep, "episode"),
            video_id,
            series_id: video_id.to_string(),
            slug: String::new(),
            title: title.to_string(),
            cover: cover.to_string(),
            ep,
            total_eps: total_eps.max(1),
            mode: "episode".into(),
            status: "done".into(),
            progress: 1.0,
            message: "Already downloaded".into(),
            playlist_path: path.to_string_lossy().to_string(),
            video_path: path.to_string_lossy().to_string(),
            file_size: size,
            ready_eps: vec![ep],
            updated_at: now_secs(),
        });
    }
    // Series: all episodes must already be present.
    let n = total_eps.max(1);
    if !(1..=n).all(|e| episode_ready(video_id, e)) {
        return None;
    }
    Some(DownloadJob {
        id: job_key(video_id, 0, "series"),
        video_id,
        series_id: video_id.to_string(),
        slug: String::new(),
        title: title.to_string(),
        cover: cover.to_string(),
        ep: n,
        total_eps: n,
        mode: "series".into(),
        status: "done".into(),
        progress: 1.0,
        message: "Already downloaded".into(),
        playlist_path: String::new(),
        video_path: String::new(),
        file_size: 0,
        ready_eps: (1..=n).collect(),
        updated_at: now_secs(),
    })
}

pub async fn start(api: &Api, video_id: i64, ep: u32, mode: &str) -> Result<Value, String> {
    let mode = if mode == "series" { "series" } else { "episode" };
    let key = job_key(video_id, if mode == "series" { 0 } else { ep }, mode);
    {
        let jobs = JOBS.lock().map_err(|_| "download lock".to_string())?;
        if jobs.get(&key).is_some_and(|j| j.status == "running" || j.status == "queued") {
            return Ok(json!(jobs.get(&key).cloned()));
        }
    }

    let origin = base();
    let token = api.session.token(&origin);
    let detail = edge(
        &origin,
        "GET",
        &format!("/api/videos/{video_id}"),
        None,
        token.as_deref(),
    )
    .await?;

    let title = detail
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("untitled")
        .to_string();
    let cover = detail
        .get("cover")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let total_eps = detail
        .get("total_episodes")
        .or_else(|| detail.get("episode_count"))
        .and_then(|v| v.as_u64())
        .unwrap_or(1) as u32;

    // Skip re-download when offline files already exist.
    if let Some(done) = existing_done_job(video_id, ep.max(1), mode, &title, &cover, total_eps) {
        JOBS.lock()
            .map_err(|_| "download lock".to_string())?
            .insert(done.id.clone(), done.clone());
        let _ = save_manifest(&done);
        return Ok(json!(done));
    }

    let job = DownloadJob {
        id: key.clone(),
        video_id,
        series_id: video_id.to_string(),
        slug: String::new(),
        title,
        cover,
        ep: if mode == "series" { 1 } else { ep.max(1) },
        total_eps: total_eps.max(1),
        mode: mode.to_string(),
        status: "queued".into(),
        progress: 0.0,
        message: "Queued".into(),
        playlist_path: String::new(),
        video_path: String::new(),
        file_size: 0,
        ready_eps: Vec::new(),
        updated_at: now_secs(),
    };
    JOBS.lock()
        .map_err(|_| "download lock".to_string())?
        .insert(key.clone(), job.clone());
    let _ = save_manifest(&job);

    QUEUE
        .lock()
        .map_err(|_| "download lock".to_string())?
        .push_back(QueuedTask {
            key: key.clone(),
            origin: origin.clone(),
            token: token.clone(),
        });
    kick_worker();

    Ok(json!(job))
}

fn kick_worker() {
    if WORKER
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            let next = {
                let mut q = match QUEUE.lock() {
                    Ok(g) => g,
                    Err(_) => break,
                };
                q.pop_front()
            };
            let Some(task) = next else { break };
            let _ = run_job(&task.key, &task.origin, task.token.as_deref()).await;
        }
        WORKER.store(false, Ordering::SeqCst);
        // Race: a push may land between empty-check and WORKER=false.
        let has_more = QUEUE.lock().map(|q| !q.is_empty()).unwrap_or(false);
        if has_more {
            kick_worker();
        }
    });
}

async fn run_job(key: &str, origin: &str, token: Option<&str>) -> Result<(), String> {
    bump_job(key, |job| {
        job.status = "running".into();
        job.message = "Downloading".into();
        job.progress = 0.0;
    });
    let job = {
        JOBS.lock()
            .map_err(|_| "download lock".to_string())?
            .get(key)
            .cloned()
            .ok_or_else(|| "job missing".to_string())?
    };
    log_download(&format!(
        "[download] start {} mode={} ep={} → {}",
        job.video_id, job.mode, job.ep, job.title
    ));

    let result = if job.mode == "series" {
        download_series(&job, origin, token).await
    } else {
        download_one(&job.id, job.video_id, job.ep, 0.0, 1.0, origin, token)
            .await
            .map(|_| ())
    };

    match &result {
        Ok(()) => {
            log_download(&format!("[download] done {}", job.video_id));
            bump_job(key, |job| {
                job.status = "done".into();
                job.progress = 1.0;
                job.message = "Done".into();
            });
        }
        Err(e) => {
            log_download(&format!("[download] error {} → {e}", job.video_id));
            bump_job(key, |job| {
                job.status = "error".into();
                job.message = e.clone();
            });
        }
    }
    Ok(())
}

fn log_download(msg: &str) {
    if let Ok(g) = CONFIG_FILE.lock() {
        if let Some(cfg) = g.as_ref() {
            if let Some(dir) = cfg.parent() {
                let _ = crate::logging::append_debug(dir, msg);
            }
        }
    }
}

async fn download_series(job: &DownloadJob, origin: &str, token: Option<&str>) -> Result<(), String> {
    let n = job.total_eps.max(1);
    for ep in 1..=n {
        let base_p = (ep - 1) as f64 / n as f64;
        let span = 1.0 / n as f64;
        if episode_ready(job.video_id, ep) {
            bump_job(&job.id, |j| {
                j.ep = ep;
                j.progress = ep as f64 / n as f64;
                j.message = format!("Skip existing {ep}/{n}");
            });
            continue;
        }
        bump_job(&job.id, |j| {
            j.ep = ep;
            j.message = format!("Downloading {ep}/{n}");
        });
        download_one(&job.id, job.video_id, ep, base_p, span, origin, token).await?;
        bump_job(&job.id, |j| {
            j.ep = ep;
            j.progress = ep as f64 / n as f64;
            j.message = format!("Downloaded {ep}/{n}");
        });
    }
    Ok(())
}

async fn download_one(
    job_id: &str,
    video_id: i64,
    ep: u32,
    progress_base: f64,
    progress_span: f64,
    origin: &str,
    token: Option<&str>,
) -> Result<PathBuf, String> {
    if episode_ready(video_id, ep) {
        let (mp4, ts, pl) = episode_media_files(video_id, ep)?;
        let path = if mp4.is_file() {
            mp4
        } else if ts.is_file() {
            ts
        } else {
            pl
        };
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        bump_job(job_id, |j| {
            j.ep = ep;
            j.video_path = path.to_string_lossy().to_string();
            j.playlist_path = path.to_string_lossy().to_string();
            j.file_size = size;
            j.message = format!("Ep {ep} already offline");
        });
        return Ok(path);
    }

    bump_job(job_id, |j| {
        j.message = format!("Fetching play URL · ep {ep}");
    });
    let url = resolve_play_url(origin, token, video_id, ep).await?;
    let dir = episode_dir(video_id, ep)?;
    let _ = std::fs::create_dir_all(&dir);

    bump_job(job_id, |j| {
        j.message = format!("Fetching playlist · ep {ep}");
    });
    let (ctype, playlist_bytes) = fetch_bytes(&url).await?;
    let _ = ctype;
    let playlist_text = String::from_utf8_lossy(&playlist_bytes).to_string();
    if !playlist_text.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
        return Err("Play URL did not return an HLS playlist".into());
    }
    let base_url = url::Url::parse(&url).map_err(|e| e.to_string())?;

    // Follow one level of master → media playlist when needed.
    let (playlist_text, base_url) =
        resolve_media_playlist(playlist_text, base_url, job_id, ep).await?;

    let mut out_lines = Vec::new();
    let mut segment_urls = Vec::new();
    for line in playlist_text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            if let Some(rewritten) = rewrite_attr_uris(line, &base_url, &mut segment_urls) {
                out_lines.push(rewritten);
            } else {
                out_lines.push(line.to_string());
            }
            continue;
        }
        let abs = base_url.join(trimmed).map_err(|e| e.to_string())?;
        let name = local_name(segment_urls.len(), abs.as_str());
        segment_urls.push((abs.to_string(), name.clone()));
        out_lines.push(name);
    }

    if segment_urls.is_empty() {
        return Err("Playlist has no media segments".into());
    }

    let fetch_span = progress_span * 0.85;
    let mux_span = progress_span * 0.15;
    let total = segment_urls.len() as f64;
    for (i, (seg_url, name)) in segment_urls.iter().enumerate() {
        let (_, bytes) = fetch_bytes(seg_url).await?;
        std::fs::write(dir.join(name), bytes).map_err(|e| e.to_string())?;
        let pct = (i + 1) as f64 / total;
        bump_job(job_id, |j| {
            j.ep = ep;
            j.progress = progress_base + fetch_span * pct;
            j.message = format!("Ep {ep} · {}/{}", i + 1, total as u32);
        });
    }

    let index_path = dir.join("index.m3u8");
    let local_playlist = out_lines.join("\n") + "\n";
    std::fs::write(&index_path, &local_playlist).map_err(|e| e.to_string())?;

    bump_job(job_id, |j| {
        j.ep = ep;
        j.message = format!("Decrypting & merging ep {ep}");
        j.progress = progress_base + fetch_span;
    });

    let video_path = finalize_episode(&dir, &local_playlist, job_id, progress_base + fetch_span, mux_span)?;
    let size = std::fs::metadata(&video_path).map(|m| m.len()).unwrap_or(0);

    bump_job(job_id, |j| {
        j.ep = ep;
        j.playlist_path = index_path.to_string_lossy().to_string();
        j.video_path = video_path.to_string_lossy().to_string();
        j.file_size = size;
        j.progress = progress_base + progress_span;
        j.message = format!("Ep {ep} ready for offline");
    });
    Ok(video_path)
}

async fn resolve_media_playlist(
    text: String,
    base: url::Url,
    job_id: &str,
    ep: u32,
) -> Result<(String, url::Url), String> {
    let has_segments = text.lines().any(|l| {
        let t = l.trim();
        !t.is_empty() && !t.starts_with('#') && !t.contains(".m3u8")
    });
    if has_segments {
        return Ok((text, base));
    }
    // Master playlist: pick the last variant (usually highest quality).
    let variant = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#') && l.contains(".m3u8"))
        .last()
        .ok_or_else(|| "Master playlist has no variants".to_string())?;
    let abs = base.join(variant).map_err(|e| e.to_string())?;
    bump_job(job_id, |j| {
        j.message = format!("Following media playlist · ep {ep}");
    });
    let (_, bytes) = fetch_bytes(abs.as_str()).await?;
    let media = String::from_utf8_lossy(&bytes).to_string();
    if !media.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
        return Err("Variant playlist is invalid".into());
    }
    Ok((media, abs))
}

fn local_name(idx: usize, url: &str) -> String {
    let path = url.split('?').next().unwrap_or(url);
    let ext = path
        .rsplit('.')
        .next()
        .filter(|e| e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("bin");
    format!("seg_{idx:04}.{ext}")
}

fn rewrite_attr_uris(
    line: &str,
    base: &url::Url,
    segment_urls: &mut Vec<(String, String)>,
) -> Option<String> {
    if !line.contains("URI=\"") {
        return None;
    }
    let mut out = String::new();
    let mut rest = line;
    while let Some(i) = rest.find("URI=\"") {
        out.push_str(&rest[..i + 5]);
        rest = &rest[i + 5..];
        let end = rest.find('"')?;
        let uri = &rest[..end];
        rest = &rest[end..];
        if let Ok(abs) = base.join(uri) {
            let name = local_name(segment_urls.len(), abs.as_str());
            segment_urls.push((abs.to_string(), name.clone()));
            out.push_str(&name);
        } else {
            out.push_str(uri);
        }
    }
    out.push_str(rest);
    Some(out)
}

/// Decrypt HLS segments (AES-128) and merge into `video.ts`, then try `ffmpeg` → `video.mp4`.
fn finalize_episode(
    dir: &Path,
    local_playlist: &str,
    job_id: &str,
    progress_base: f64,
    progress_span: f64,
) -> Result<PathBuf, String> {
    let key_info = parse_hls_key_in_dir(local_playlist, dir);
    let media_seq = parse_media_sequence(local_playlist);
    let segments: Vec<String> = local_playlist
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect();
    if segments.is_empty() {
        return Err("No segments to merge".into());
    }

    let ts_path = dir.join("video.ts");
    let mut out = std::fs::File::create(&ts_path).map_err(|e| e.to_string())?;
    use std::io::Write;
    let n = segments.len().max(1) as f64;
    for (i, name) in segments.iter().enumerate() {
        let raw = std::fs::read(dir.join(name)).map_err(|e| format!("read {name}: {e}"))?;
        let plain = if let Some((key, iv_opt)) = key_info.as_ref() {
            let mut iv = iv_opt.unwrap_or([0u8; 16]);
            if iv_opt.is_none() {
                iv = seq_iv(media_seq.wrapping_add(i as u64));
            }
            aes128_cbc_decrypt(&raw, key, &iv).ok_or_else(|| format!("decrypt failed for {name}"))?
        } else {
            raw
        };
        out.write_all(&plain).map_err(|e| e.to_string())?;
        bump_job(job_id, |j| {
            j.progress = progress_base + progress_span * ((i + 1) as f64 / n) * 0.7;
            j.message = format!("Merging {}/{}", i + 1, n as u32);
        });
    }
    drop(out);

    let mp4_path = dir.join("video.mp4");
    if crate::ffmpeg_tool::resolve_bin().is_some() {
        bump_job(job_id, |j| {
            j.progress = progress_base + progress_span * 0.75;
            j.message = "Remuxing to MP4".into();
        });
        if try_ffmpeg_remux(&ts_path, &mp4_path) {
            bump_job(job_id, |j| {
                j.progress = progress_base + progress_span;
                j.message = "MP4 ready".into();
            });
            return Ok(mp4_path);
        }
    }

    bump_job(job_id, |j| {
        j.progress = progress_base + progress_span;
        j.message = if crate::ffmpeg_tool::resolve_bin().is_none() {
            "TS ready — install FFmpeg for MP4".into()
        } else {
            "TS ready (offline)".into()
        };
    });
    Ok(ts_path)
}

fn parse_media_sequence(playlist: &str) -> u64 {
    for line in playlist.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            if let Ok(n) = rest.trim().parse::<u64>() {
                return n;
            }
        }
    }
    0
}

fn parse_hls_key_in_dir(playlist: &str, dir: &Path) -> Option<([u8; 16], Option<[u8; 16]>)> {
    for line in playlist.lines() {
        let t = line.trim();
        if !t.starts_with("#EXT-X-KEY:") {
            continue;
        }
        let attrs = &t["#EXT-X-KEY:".len()..];
        let method = attr_value(attrs, "METHOD").unwrap_or_default();
        if method.eq_ignore_ascii_case("NONE") || method.is_empty() {
            return None;
        }
        if !method.to_ascii_uppercase().contains("AES-128") {
            continue;
        }
        let uri = attr_value(attrs, "URI")?;
        let key_name = uri.trim_matches('"');
        let key_bytes = std::fs::read(dir.join(key_name)).ok()?;
        if key_bytes.len() < 16 {
            return None;
        }
        let mut key = [0u8; 16];
        key.copy_from_slice(&key_bytes[..16]);
        let iv = attr_value(attrs, "IV").and_then(|s| parse_iv(&s));
        return Some((key, iv));
    }
    None
}

fn attr_value(attrs: &str, key: &str) -> Option<String> {
    for part in attrs.split(',') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix(&format!("{key}=")) {
            return Some(rest.trim().trim_matches('"').to_string());
        }
    }
    None
}

fn parse_iv(raw: &str) -> Option<[u8; 16]> {
    let s = raw.trim().trim_start_matches("0x").trim_start_matches("0X");
    if s.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for i in 0..16 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn seq_iv(seq: u64) -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv[8..].copy_from_slice(&seq.to_be_bytes());
    iv
}

fn aes128_cbc_decrypt(data: &[u8], key: &[u8; 16], iv: &[u8; 16]) -> Option<Vec<u8>> {
    if data.is_empty() || data.len() % 16 != 0 {
        return None;
    }
    let cipher = Aes128::new_from_slice(key).ok()?;
    let mut prev = *iv;
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
    // PKCS7 unpad
    let pad = *out.last()? as usize;
    if pad > 0 && pad <= 16 && out.len() >= pad && out[out.len() - pad..].iter().all(|b| *b as usize == pad)
    {
        out.truncate(out.len() - pad);
    }
    Some(out)
}

fn try_ffmpeg_remux(ts: &Path, mp4: &Path) -> bool {
    let Some(bin) = crate::ffmpeg_tool::resolve_bin() else {
        return false;
    };
    let mut cmd = Command::new(&bin);
    cmd.args([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        &ts.to_string_lossy(),
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        &mp4.to_string_lossy(),
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    // Avoid a flashing console window on Windows when spawning ffmpeg.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    matches!(cmd.status(), Ok(st) if st.success()) && mp4.is_file()
}

