//! One HTTP request to a device on the local network, for a plugin that talks
//! to one. The native half of the `network.local` grant.
//!
//! Rust rather than fetch() because the window's `connect-src` names the
//! loopback engine and nothing else, and widening it would open the network to
//! every script in the window.
//!
//! What this can reach is narrower than "the network" on purpose. The host is
//! resolved here, every address it resolves to must be private or link-local,
//! and the request is pinned to those addresses, so a name that resolves to a
//! public address, or re-resolves to one between the check and the connect,
//! cannot turn this into a general web client. Redirects are not followed for
//! the same reason. Loopback is refused, which keeps the geometry engine and
//! every other service on this machine out of reach.
//!
//! What the bytes mean is the plugin's business. Nothing here knows a protocol.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::Duration;
use tauri::State;

use super::bundle::safe_id;
use super::files::Handles;

const MAX_RESPONSE: usize = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const MAX_TIMEOUT_MS: u64 = 600_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRequest {
    #[serde(default)]
    pub method: Option<String>,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<RequestBody>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// Answer with base64 instead of text, for images and other binary replies.
    #[serde(default)]
    pub binary: bool,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RequestBody {
    Text {
        text: String,
        #[serde(default)]
        mime: Option<String>,
    },
    Json {
        value: serde_json::Value,
    },
    /// multipart/form-data. A file part names a handle from `plugin_file_pick`,
    /// never a path, so what can be sent is what the person chose.
    Form { parts: Vec<FormPart> },
}

#[derive(Deserialize)]
pub struct FormPart {
    pub name: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub mime: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub text: Option<String>,
    pub base64: Option<String>,
}

/// Private, unique-local or link-local. Not loopback, not anything routable.
pub fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_local(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

/// The host and port of an http(s) URL, and the IP when the host is a literal.
pub fn target_of(url: &reqwest::Url) -> Result<(String, u16, Option<IpAddr>), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("{} is not an http or https address", url.scheme()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials in the address are not accepted, send a header".into());
    }
    let host = url.host_str().ok_or("the address has no host")?.to_string();
    let port = url.port_or_known_default().ok_or("the address has no port")?;
    let literal = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .ok();
    Ok((host, port, literal))
}

/// Every address `host` resolves to, refused unless all of them are local.
fn resolve_local(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("{host} could not be resolved: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("{host} resolved to no address"));
    }
    if let Some(bad) = addrs.iter().find(|a| !is_local(a.ip())) {
        return Err(format!("{host} is {}, which is not on the local network", bad.ip()));
    }
    Ok(addrs)
}

#[tauri::command]
pub async fn plugin_local_request(
    handles: State<'_, Handles>,
    plugin: String,
    request: LocalRequest,
) -> Result<LocalResponse, String> {
    let plugin = safe_id(&plugin)?.to_string();
    let url = reqwest::Url::parse(&request.url).map_err(|e| format!("not an address: {e}"))?;
    let (host, port, literal) = target_of(&url)?;

    // Handles become paths before the first await, so no lock is held across one.
    let mut files = Vec::new();
    if let Some(RequestBody::Form { parts }) = &request.body {
        for part in parts {
            if let Some(handle) = &part.file {
                files.push(handles.path_for(&plugin, handle)?);
            }
        }
    }

    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(
            request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1, MAX_TIMEOUT_MS),
        ));
    match literal {
        Some(ip) if !is_local(ip) => {
            return Err(format!("{ip} is not on the local network"));
        }
        Some(_) => {}
        None => {
            let h = host.clone();
            let addrs = tauri::async_runtime::spawn_blocking(move || resolve_local(&h, port))
                .await
                .map_err(|e| e.to_string())??;
            builder = builder.resolve_to_addrs(&host, &addrs);
        }
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let method = request.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(method, url);
    for (k, v) in &request.headers {
        req = req.header(k.as_str(), v.as_str());
    }
    req = match request.body {
        None => req,
        Some(RequestBody::Text { text, mime }) => {
            let req = match mime {
                Some(m) => req.header(reqwest::header::CONTENT_TYPE, m),
                None => req,
            };
            req.body(text)
        }
        Some(RequestBody::Json { value }) => req.json(&value),
        Some(RequestBody::Form { parts }) => {
            let mut form = reqwest::multipart::Form::new();
            let mut files = files.into_iter();
            for part in parts {
                if part.file.is_some() {
                    let path = files.next().ok_or("a file part lost its handle")?;
                    let read_path = path.clone();
                    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(read_path))
                        .await
                        .map_err(|e| e.to_string())?
                        .map_err(|e| format!("{}: {e}", path.display()))?;
                    let name = part.filename.clone().unwrap_or_else(|| {
                        path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
                    });
                    let file = reqwest::multipart::Part::bytes(bytes)
                        .file_name(name)
                        .mime_str(part.mime.as_deref().unwrap_or("application/octet-stream"))
                        .map_err(|e| e.to_string())?;
                    form = form.part(part.name, file);
                } else {
                    form = form.text(part.name, part.text.unwrap_or_default());
                }
            }
            req.multipart(form)
        }
    };

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if resp.content_length().is_some_and(|n| n as usize > MAX_RESPONSE) {
        return Err(format!("the reply is larger than {MAX_RESPONSE} bytes"));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_RESPONSE {
        return Err(format!("the reply is larger than {MAX_RESPONSE} bytes"));
    }
    Ok(if request.binary {
        LocalResponse {
            status,
            content_type,
            text: None,
            base64: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
        }
    } else {
        LocalResponse {
            status,
            content_type,
            text: Some(String::from_utf8_lossy(&bytes).into_owned()),
            base64: None,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn only_local_addresses_are_local() {
        for ok in ["192.168.0.46", "10.1.2.3", "172.16.0.1", "169.254.10.10", "fd00::1", "fe80::1", "::ffff:192.168.1.2"] {
            assert!(is_local(ip(ok)), "{ok}");
        }
        for bad in ["127.0.0.1", "8.8.8.8", "172.32.0.1", "::1", "2001:db8::1", "0.0.0.0", "::ffff:8.8.8.8"] {
            assert!(!is_local(ip(bad)), "{bad}");
        }
    }

    #[test]
    fn targets_are_http_with_a_host_and_port() {
        let t = |s: &str| target_of(&reqwest::Url::parse(s).unwrap());
        assert_eq!(t("http://192.168.0.46:7125/x").unwrap(), ("192.168.0.46".into(), 7125, Some(ip("192.168.0.46"))));
        assert_eq!(t("http://device.local/").unwrap().1, 80);
        assert_eq!(t("http://[fe80::1]:8080/").unwrap().2, Some(ip("fe80::1")));
        assert!(t("file:///etc/passwd").is_err());
        assert!(t("http://user:pw@192.168.0.2/").is_err());
    }

    #[test]
    fn a_public_name_is_refused_after_resolving() {
        assert!(resolve_local("127.0.0.1", 80).is_err());
        assert!(resolve_local("192.168.1.20", 80).is_ok());
    }
}
