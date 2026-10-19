//! Which denoiser cleans the native tracer's cap, and the optional one-time
//! download of Open Image Denoise into the app's data folder.

use fundacad_tracer::{denoise, oidn, Denoiser};
use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    active: Denoiser,
    version: &'static str,
    /// The download is offered on this platform.
    offered: bool,
    /// The CPU set it unpacks, in bytes.
    bytes: u64,
    /// Why Open Image Denoise is not the active one.
    note: Option<String>,
}

fn dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map(|d| oidn::dir_in(&d)).map_err(|e| e.to_string())
}

fn info(app: &tauri::AppHandle) -> Info {
    let rel = oidn::release();
    let note = match (oidn::api(), dir(app)) {
        (Some(_), _) => None,
        (None, Ok(d)) if !d.exists() => rel.as_ref().err().cloned().or_else(|| Some("not downloaded".into())),
        (None, Ok(d)) => oidn::load(&d).err(),
        (None, Err(e)) => Some(e),
    };
    Info {
        active: denoise::active(),
        version: oidn::VERSION,
        offered: rel.is_ok(),
        bytes: rel.map(|r| r.installed).unwrap_or(0),
        note,
    }
}

/// Loads an installed set at startup, off the main thread: checking the
/// digests reads about 52 MB.
pub fn load_installed(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(d) = dir(&app) {
            if d.exists() {
                let _ = oidn::load(&d);
            }
        }
    });
}

/// The active denoiser; tries the installed set again first, so a set that
/// appeared since needs no restart.
#[tauri::command]
pub async fn pt_denoiser(app: tauri::AppHandle) -> Info {
    tauri::async_runtime::spawn_blocking(move || info(&app)).await.unwrap_or_else(|e| Info {
        active: denoise::active(),
        version: oidn::VERSION,
        offered: false,
        bytes: 0,
        note: Some(e.to_string()),
    })
}

/// Fetches the pinned official release archive, unpacks only its CPU set
/// once the digests match, and loads it. Never runs anything it fetched.
#[tauri::command]
pub async fn pt_denoiser_download(app: tauri::AppHandle) -> Result<Info, String> {
    let rel = oidn::release()?;
    let dest = dir(&app)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let offline = |e: reqwest::Error| format!("the download failed, the edge aware filter stays ({e})");
    let resp = client.get(rel.url).send().await.map_err(offline)?.error_for_status().map_err(offline)?;
    let bytes = resp.bytes().await.map_err(offline)?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        oidn::install(&bytes, rel, &dest)?;
        oidn::load(&dest)?;
        Ok(info(&app2))
    })
    .await
    .map_err(|e| e.to_string())?
}
