//! The native half of the `network` grant: one HTTPS request to a host the plugin's manifest names. Public addresses
//! only, pinned to the checked ones, and redirects go back to the plugin to sign. Headers carry credentials, so nothing
//! here logs them.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::AppHandle;

use super::bundle::safe_id;
use super::data::{data_dir, safe_name};
use super::localnet::{is_local, target_of};

const MAX_TEXT: usize = 64 * 1024 * 1024;
const MAX_DOWNLOAD: u64 = 512 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 900_000;
const DOWNLOADS: &str = "downloads";
const STALE: Duration = Duration::from_secs(24 * 3600);

/// Shipped plugins holding `network`, for the dev build that runs them from source; an installed bundle is checked
/// against its consent record instead. A test keeps this list complete.
const SHIPPED: &[&str] = &[include_str!("../../../plugins/FundaCAD.Onshape/manifest.json")];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebRequest {
    #[serde(default)]
    pub method: Option<String>,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<WebBody>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// Stream the reply to `plugin-data/<id>/downloads/<name>` and answer
    /// with its path, so a large file never crosses IPC.
    #[serde(default)]
    pub save_as: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WebBody {
    Text {
        text: String,
        #[serde(default)]
        mime: Option<String>,
    },
    Json {
        value: serde_json::Value,
    },
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WebResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub location: Option<String>,
    pub retry_after: Option<String>,
    pub text: Option<String>,
    pub path: Option<String>,
    pub len: Option<u64>,
}

/// `host` is on `list`, where an entry with a leading dot stands for exactly
/// one level of subdomain, the rule manifest.ts states for the consent screen.
pub fn host_allowed(host: &str, list: &[String]) -> bool {
    let host = host.to_ascii_lowercase();
    list.iter().any(|entry| {
        let entry = entry.to_ascii_lowercase();
        if entry.starts_with('.') {
            host.strip_suffix(entry.as_str()).is_some_and(|label| !label.is_empty() && !label.contains('.'))
        } else {
            host == entry
        }
    })
}

fn is_public(ip: IpAddr) -> bool {
    let v4 = match ip {
        IpAddr::V4(v4) => Some(v4),
        IpAddr::V6(v6) => v6.to_ipv4_mapped(),
    };
    let special = match (ip, v4) {
        (_, Some(v4)) => {
            v4.is_loopback()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.octets()[0] == 0
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64)
        }
        (IpAddr::V6(v6), None) => v6.is_loopback() || v6.is_unspecified(),
        _ => false,
    };
    !special && !is_local(v4.map(IpAddr::V4).unwrap_or(ip))
}

/// The URL is https, names an allowed host, and the host is a name, not an address.
pub fn check_target(url: &reqwest::Url, hosts: &[String]) -> Result<(String, u16), String> {
    if url.scheme() != "https" {
        return Err(format!("{} is not an https address", url.scheme()));
    }
    let (host, port, literal) = target_of(url)?;
    if literal.is_some() {
        return Err(format!("{host} is an address, not a host name"));
    }
    if !host_allowed(&host, hosts) {
        return Err(format!("{host} is not one of the hosts this plugin may reach"));
    }
    Ok((host, port))
}

fn resolve_public(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let addrs: Vec<SocketAddr> =
        (host, port).to_socket_addrs().map_err(|e| format!("{host} could not be resolved: {e}"))?.collect();
    if addrs.is_empty() {
        return Err(format!("{host} resolved to no address"));
    }
    if let Some(bad) = addrs.iter().find(|a| !is_public(a.ip())) {
        return Err(format!("{host} is {}, which is not a public address", bad.ip()));
    }
    Ok(addrs)
}

fn hosts_in_manifest(text: &str, plugin: &str) -> Option<Vec<String>> {
    let m: serde_json::Value = serde_json::from_str(text).ok()?;
    if m.get("id")?.as_str()? != plugin {
        return None;
    }
    let grants = m.get("grants")?.as_array()?;
    if !grants.iter().any(|g| g.as_str() == Some("network")) {
        return Some(vec![]);
    }
    Some(m.get("hosts")?.as_array()?.iter().filter_map(|h| h.as_str().map(str::to_string)).collect())
}

fn allowed_hosts(app: &AppHandle, plugin: &str) -> Result<Vec<String>, String> {
    if let Some(c) = super::consented_of(app, plugin) {
        return Ok(if c.grants.iter().any(|g| g == "network") { c.hosts } else { vec![] });
    }
    Ok(SHIPPED.iter().find_map(|m| hosts_in_manifest(m, plugin)).unwrap_or_default())
}

fn downloads_dir(app: &AppHandle, plugin: &str) -> Result<PathBuf, String> {
    let dir = data_dir(app, plugin)?.join(DOWNLOADS);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

/// Downloads left behind by an import that never finished.
fn sweep_stale(dir: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > STALE);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

fn header_of(resp: &reqwest::Response, name: reqwest::header::HeaderName) -> Option<String> {
    resp.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string)
}

#[tauri::command]
pub async fn plugin_web_request(app: AppHandle, plugin: String, request: WebRequest) -> Result<WebResponse, String> {
    let plugin = safe_id(&plugin)?.to_string();
    let url = reqwest::Url::parse(&request.url).map_err(|e| format!("not an address: {e}"))?;
    let hosts = allowed_hosts(&app, &plugin)?;
    let (host, port) = check_target(&url, &hosts)?;
    let save = match &request.save_as {
        Some(name) => Some(downloads_dir(&app, &plugin)?.join(safe_name(name)?)),
        None => None,
    };

    let h = host.clone();
    let addrs =
        tauri::async_runtime::spawn_blocking(move || resolve_public(&h, port)).await.map_err(|e| e.to_string())??;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(&host, &addrs)
        .timeout(Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1, MAX_TIMEOUT_MS)))
        .build()
        .map_err(|e| e.to_string())?;

    let method = request.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(method, url);
    for (k, v) in &request.headers {
        req = req.header(k.as_str(), v.as_str());
    }
    req = match request.body {
        None => req,
        Some(WebBody::Text { text, mime }) => match mime {
            Some(m) => req.header(reqwest::header::CONTENT_TYPE, m).body(text),
            None => req.body(text),
        },
        // Serialised here rather than with .json() so a Content-Type the plugin
        // signed is the one sent.
        Some(WebBody::Json { value }) => req.body(serde_json::to_vec(&value).map_err(|e| e.to_string())?),
    };

    // reqwest's own error text can quote the URL but never the headers.
    let mut resp = req.send().await.map_err(|e| format!("{host}: {e}"))?;
    let status = resp.status().as_u16();
    let content_type = header_of(&resp, reqwest::header::CONTENT_TYPE);
    let location = header_of(&resp, reqwest::header::LOCATION);
    let retry_after = header_of(&resp, reqwest::header::RETRY_AFTER);
    let ok = resp.status().is_success();

    if let (Some(path), true) = (save, ok) {
        if resp.content_length().is_some_and(|n| n > MAX_DOWNLOAD) {
            return Err(format!("the file from {host} is larger than {MAX_DOWNLOAD} bytes"));
        }
        let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
        sweep_stale(&dir, SystemTime::now());
        let tmp = path.with_extension("part");
        let mut file = std::fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
        let mut len: u64 = 0;
        let result: Result<(), String> = async {
            while let Some(chunk) = resp.chunk().await.map_err(|e| format!("{host}: {e}"))? {
                len += chunk.len() as u64;
                if len > MAX_DOWNLOAD {
                    return Err(format!("the file from {host} is larger than {MAX_DOWNLOAD} bytes"));
                }
                file.write_all(&chunk).map_err(|e| format!("{}: {e}", tmp.display()))?;
            }
            file.flush().map_err(|e| format!("{}: {e}", tmp.display()))
        }
        .await;
        drop(file);
        if let Err(e) =
            result.and_then(|_| std::fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display())))
        {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
        return Ok(WebResponse {
            status,
            content_type,
            location,
            retry_after,
            text: None,
            path: Some(path.to_string_lossy().into_owned()),
            len: Some(len),
        });
    }

    if resp.content_length().is_some_and(|n| n as usize > MAX_TEXT) {
        return Err(format!("the reply from {host} is larger than {MAX_TEXT} bytes"));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("{host}: {e}"))?;
    if bytes.len() > MAX_TEXT {
        return Err(format!("the reply from {host} is larger than {MAX_TEXT} bytes"));
    }
    Ok(WebResponse {
        status,
        content_type,
        location,
        retry_after,
        text: Some(String::from_utf8_lossy(&bytes).into_owned()),
        path: None,
        len: None,
    })
}

/// Delete a file `plugin_web_request` saved, once the plugin is done with it.
#[tauri::command]
pub fn plugin_download_remove(app: AppHandle, plugin: String, name: String) -> Result<(), String> {
    let path = downloads_dir(&app, &plugin)?.join(safe_name(&name)?);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{name}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_leading_dot_is_one_level_of_subdomain() {
        let l = list(&[".onshape.com"]);
        assert!(host_allowed("cad.onshape.com", &l));
        assert!(host_allowed("ACME.onshape.com", &l));
        for bad in ["onshape.com", "evilonshape.com", "a.b.onshape.com", "onshape.com.evil.net", "cad.onshape.co"] {
            assert!(!host_allowed(bad, &l), "{bad}");
        }
        assert!(host_allowed("api.example.com", &list(&["api.example.com"])));
        assert!(!host_allowed("x.api.example.com", &list(&["api.example.com"])));
        assert!(!host_allowed("cad.onshape.com", &[]));
    }

    #[test]
    fn only_https_to_a_named_allowed_host() {
        let l = list(&[".onshape.com"]);
        let t = |s: &str| check_target(&reqwest::Url::parse(s).unwrap(), &l);
        assert_eq!(t("https://cad.onshape.com/api/x").unwrap(), ("cad.onshape.com".into(), 443));
        assert!(t("http://cad.onshape.com/api/x").is_err());
        assert!(t("https://evil.com/api/x").is_err());
        assert!(t("https://1.2.3.4/").is_err());
        assert!(t("https://[::1]/").is_err());
        assert!(t("https://user:pw@cad.onshape.com/").is_err());
    }

    #[test]
    fn private_and_loopback_addresses_are_not_public() {
        for bad in [
            "127.0.0.1",
            "10.0.0.1",
            "192.168.1.2",
            "169.254.1.1",
            "0.0.0.0",
            "100.64.0.1",
            "::1",
            "fe80::1",
            "fd00::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!is_public(bad.parse().unwrap()), "{bad}");
        }
        for ok in ["8.8.8.8", "52.1.2.3", "2606:4700::1111"] {
            assert!(is_public(ok.parse().unwrap()), "{ok}");
        }
    }

    #[test]
    fn a_name_that_resolves_to_this_machine_is_refused() {
        assert!(resolve_public("localhost", 443).is_err());
        assert!(resolve_public("127.0.0.1", 443).is_err());
    }

    #[test]
    fn every_shipped_plugin_with_network_is_embedded() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins");
        let mut want = vec![];
        for e in std::fs::read_dir(&root).unwrap().flatten() {
            let Ok(text) = std::fs::read_to_string(e.path().join("manifest.json")) else { continue };
            let id = e.file_name().to_string_lossy().into_owned();
            if hosts_in_manifest(&text, &id).is_some_and(|h| !h.is_empty()) {
                want.push(id);
            }
        }
        for id in &want {
            assert!(
                SHIPPED.iter().any(|m| hosts_in_manifest(m, id).is_some()),
                "{id} holds network but is not in SHIPPED"
            );
        }
        assert_eq!(
            SHIPPED.iter().find_map(|m| hosts_in_manifest(m, "FundaCAD.Onshape")),
            Some(list(&[".onshape.com"]))
        );
        assert_eq!(SHIPPED.iter().find_map(|m| hosts_in_manifest(m, "FundaCAD.Printing")), None);
    }

    #[test]
    fn stale_downloads_are_swept_and_fresh_ones_kept() {
        let dir = std::env::temp_dir().join(format!("fundacad-web-sweep-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.step");
        std::fs::write(&f, b"x").unwrap();
        sweep_stale(&dir, SystemTime::now());
        assert!(f.exists());
        sweep_stale(&dir, SystemTime::now() + STALE + Duration::from_secs(60));
        assert!(!f.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
