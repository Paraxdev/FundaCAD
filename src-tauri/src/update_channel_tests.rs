use super::*;
use semver::Version;
use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use tauri::test::MockRuntime;
use tauri_plugin_updater::Update;

const STABLE_URL: &str = "https://github.com/Paraxdev/fundacad/releases/latest/download/latest.json";
const BETA_URL: &str = "https://github.com/Paraxdev/fundacad/releases/download/beta/latest.json";
const DEV_URL: &str = "https://github.com/Paraxdev/fundacad/releases/download/development/latest.json";

fn v(s: &str) -> Version {
    Version::parse(s).unwrap()
}

#[test]
fn each_channel_has_the_endpoint_of_its_release_config() {
    assert_eq!(Channel::Stable.endpoint(), STABLE_URL);
    assert_eq!(Channel::Beta.endpoint(), BETA_URL);
    assert_eq!(Channel::Development.endpoint(), DEV_URL);
}

#[test]
fn channel_names_parse_and_round_trip() {
    for ch in [Channel::Stable, Channel::Beta, Channel::Development] {
        assert_eq!(Channel::parse(ch.as_str()), Some(ch));
    }
    assert_eq!(Channel::parse("beta"), Some(Channel::Beta));
    assert_eq!(Channel::parse("nightly"), None);
    assert_eq!(Channel::parse(""), None);
}

#[test]
fn the_build_channel_reads_back_from_its_configured_endpoint() {
    assert_eq!(Channel::from_endpoint(STABLE_URL), Some(Channel::Stable));
    assert_eq!(Channel::from_endpoint(BETA_URL), Some(Channel::Beta));
    assert_eq!(Channel::from_endpoint(DEV_URL), Some(Channel::Development));
    assert_eq!(Channel::from_endpoint("https://example.com/latest.json"), None);
}

#[test]
fn switching_beta_to_stable_and_back_changes_the_endpoint_the_next_check_uses() {
    assert_eq!(plan(Channel::Beta, Channel::Stable, false).unwrap().endpoint, STABLE_URL);
    assert_eq!(plan(Channel::Beta, Channel::Beta, false).unwrap().endpoint, BETA_URL);
    assert_eq!(plan(Channel::Stable, Channel::Beta, false).unwrap().endpoint, BETA_URL);
    assert_eq!(plan(Channel::Stable, Channel::Stable, false).unwrap().endpoint, STABLE_URL);
}

#[test]
fn a_downgrade_is_only_allowed_off_the_build_channel() {
    assert!(!plan(Channel::Beta, Channel::Beta, false).unwrap().allow_downgrade);
    assert!(!plan(Channel::Stable, Channel::Stable, false).unwrap().allow_downgrade);
    assert!(!plan(Channel::Development, Channel::Development, false).unwrap().allow_downgrade);
    assert!(plan(Channel::Beta, Channel::Stable, false).unwrap().allow_downgrade);
    assert!(plan(Channel::Stable, Channel::Beta, false).unwrap().allow_downgrade);
}

#[test]
fn the_stable_feed_is_probed_only_until_a_stable_release_was_seen() {
    let probes = [
        (Channel::Beta, Channel::Beta, false),
        (Channel::Beta, Channel::Beta, true),
        (Channel::Beta, Channel::Stable, false),
        (Channel::Stable, Channel::Beta, true),
        (Channel::Development, Channel::Development, false),
        (Channel::Development, Channel::Development, true),
    ]
    .map(|(build, picked, seen)| plan(build, picked, seen).unwrap().probe);
    assert_eq!(probes, [Some(STABLE_URL), None, None, None, Some(STABLE_URL), None]);
}

#[test]
fn development_is_another_product_and_never_replaces_fundacad() {
    assert_eq!(Channel::Stable.product(), Product::FundaCad);
    assert_eq!(Channel::Beta.product(), Product::FundaCad);
    assert_eq!(Channel::Development.product(), Product::FundaCadDev);
    assert!(plan(Channel::Beta, Channel::Development, false).is_err());
    assert!(plan(Channel::Stable, Channel::Development, false).is_err());
    assert!(plan(Channel::Development, Channel::Beta, false).is_err());
    assert!(plan(Channel::Development, Channel::Stable, false).is_err());
}

#[test]
fn a_newer_release_is_accepted_whether_or_not_a_downgrade_is_allowed() {
    assert!(accepts(&v("1.0.120"), &v("1.0.121"), false));
    assert!(accepts(&v("1.0.120"), &v("1.1.0"), true));
}

#[test]
fn an_older_release_is_accepted_only_when_a_downgrade_is_allowed() {
    assert!(!accepts(&v("1.0.121"), &v("1.0.120"), false));
    assert!(accepts(&v("1.0.121"), &v("1.0.120"), true));
}

#[test]
fn the_same_version_is_never_an_update() {
    assert!(!accepts(&v("1.0.120"), &v("1.0.120"), false));
    assert!(!accepts(&v("1.0.120"), &v("1.0.120"), true));
}

#[test]
fn only_a_lower_remote_version_counts_as_a_downgrade() {
    assert!(is_downgrade(&v("1.1.0"), &v("1.0.200")));
    assert!(!is_downgrade(&v("1.0.200"), &v("1.1.0")));
    assert!(!is_downgrade(&v("1.0.200"), &v("1.0.200")));
}

fn updater_section(conf: &str) -> serde_json::Value {
    let json: serde_json::Value = serde_json::from_str(conf).unwrap();
    json["plugins"]["updater"].clone()
}

#[test]
fn each_release_config_names_its_own_build_channel() {
    let beta = updater_section(include_str!("../tauri.conf.json"));
    let dev = updater_section(include_str!("../tauri.dev.conf.json"));
    let stable = updater_section(include_str!("../tauri.stable.conf.json"));
    assert_eq!(build_channel(Some(&beta)), Some(Channel::Beta));
    assert_eq!(build_channel(Some(&dev)), Some(Channel::Development));
    assert_eq!(build_channel(Some(&stable)), Some(Channel::Stable));
}

#[test]
fn a_missing_or_unknown_updater_endpoint_has_no_build_channel() {
    assert_eq!(build_channel(None), None);
    assert_eq!(build_channel(Some(&serde_json::json!({}))), None);
    assert_eq!(build_channel(Some(&serde_json::json!({ "endpoints": [] }))), None);
    assert_eq!(build_channel(Some(&serde_json::json!({ "endpoints": ["https://example.com/latest.json"] }))), None);
}

fn updater_keys(conf: &str) -> serde_json::Map<String, serde_json::Value> {
    updater_section(conf).as_object().cloned().unwrap_or_default()
}

#[test]
fn every_release_config_verifies_updates_with_the_one_pubkey_and_no_dangerous_option() {
    let base = updater_keys(include_str!("../tauri.conf.json"));
    let pubkey = base["pubkey"].as_str().unwrap();
    let configs = [
        base.clone(),
        updater_keys(include_str!("../tauri.beta.conf.json")),
        updater_keys(include_str!("../tauri.dev.conf.json")),
        updater_keys(include_str!("../tauri.dev-product.conf.json")),
        updater_keys(include_str!("../tauri.stable.conf.json")),
        updater_keys(include_str!("../tauri.macos-sign.conf.json")),
    ];
    let summary = configs.map(|keys| {
        let same_key = keys.get("pubkey").is_none_or(|k| k == pubkey);
        let dangerous = keys.keys().filter(|k| k.starts_with("dangerous")).count();
        (same_key, dangerous)
    });
    assert!(pubkey.len() > 100);
    assert_eq!(summary, [(true, 0); 6]);
}

// A minisign key made for these tests with `tauri signer generate`, and its signature of PAYLOAD.
const TEST_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDRDNzNENTgzQ0MzNkUyMEMKUldRTTRqYk1nOVZ6VEdscTZGd093N0cvSHZjT0hkNTVYMytjSjkzdWV1QzJXcjgxTm1TYjQ0NEkK";
const PAYLOAD: &[u8] = b"fundacad test payload";
const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRTTRqYk1nOVZ6VFBDY0dlaXFiak16eFlHZXg2WXg4dG9JYm5tb3l5QjVKL3NGaDhpRXl6cGxrb01sMXdaQmQwbFlGcVdUMTFYaEM4dVNaZXROMnIyR0xVSlAvczVCWWdNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzMzUwMTExCWZpbGU6cGF5bG9hZC5iaW4KL2RmbUJMT1dud0Qveis4bDk2eUhLaGlqMWxuZVYzWHVYTkd5dTV4VEFtajRxdFU5cjJ6d0NSTDhTS0JqOENWdXBmbkxyYW9QbWtualdMekZ2ZXNGRHc9PQo=";

struct Feed {
    base: String,
    hits: Arc<Mutex<Vec<String>>>,
}

impl Feed {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn hits(&self) -> Vec<String> {
        self.hits.lock().unwrap().clone()
    }
}

/// A plain HTTP server on localhost that answers each listed path and 404s the rest, one connection per request.
fn serve(routes: impl FnOnce(&str) -> Vec<(&'static str, Vec<u8>)>) -> Feed {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let routes = routes(&base);
    let hits = Arc::new(Mutex::new(Vec::new()));
    let log = hits.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            reader.read_line(&mut request).unwrap_or(0);
            let path = request.split_whitespace().nth(1).unwrap_or("").to_string();
            let mut header = String::new();
            while reader.read_line(&mut header).unwrap_or(0) > 2 {
                header.clear();
            }
            log.lock().unwrap().push(path.clone());
            let (status, body) = match routes.iter().find(|(p, _)| *p == path) {
                Some((_, body)) => ("200 OK", body.clone()),
                None => ("404 Not Found", Vec::new()),
            };
            let head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(&body));
        }
    });
    Feed { base, hits }
}

fn release(base: &str, version: &str, payload: &str) -> serde_json::Value {
    json!({
        "version": version,
        "notes": "Notes",
        "pub_date": "2026-10-29T12:00:00.000Z",
        "url": format!("{base}{payload}"),
        "signature": SIGNATURE,
    })
}

fn bytes(value: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&value).unwrap()
}

/// The app runs 0.1.0, the mock context's version, with the updater plugin set up from a config the way a release is,
/// apart from plain HTTP for the localhost feed.
fn app_with_updater() -> (tauri::App<MockRuntime>, tauri::WebviewWindow<MockRuntime>) {
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().plugins.0.insert(
        "updater".into(),
        json!({
            "pubkey": TEST_PUBKEY,
            "endpoints": ["https://example.invalid/latest.json"],
            "dangerousInsecureTransportProtocol": true,
        }),
    );
    let app = tauri::test::mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).build(context).unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    (app, window)
}

fn check(
    window: &tauri::WebviewWindow<MockRuntime>,
    endpoint: &str,
    allow_downgrade: bool,
    probe: Option<String>,
) -> ChannelCheck {
    tauri::async_runtime::block_on(check_feeds(window, endpoint, allow_downgrade, probe)).unwrap()
}

/// The check as the frontend receives it, with the resource id taken out.
fn as_sent(check: &ChannelCheck) -> serde_json::Value {
    let mut sent = serde_json::to_value(check).unwrap();
    if let Some(update) = sent["update"].as_object_mut() {
        assert!(update.remove("rid").unwrap().is_u64());
    }
    sent
}

#[test]
fn a_newer_release_comes_back_in_the_shape_the_frontend_update_takes() {
    let feed = serve(|base| vec![("/beta.json", bytes(release(base, "0.2.0", "/payload")))]);
    let (_app, window) = app_with_updater();
    let found = check(&window, &feed.url("/beta.json"), false, None);
    let expected = json!({
        "update": {
            "currentVersion": "0.1.0",
            "version": "0.2.0",
            "date": "2026-10-29T12:00:00Z",
            "body": "Notes",
            "rawJson": release(&feed.base, "0.2.0", "/payload"),
            "downgrade": false,
        },
        "stable": true,
    });
    assert_eq!((as_sent(&found), feed.hits()), (expected, vec!["/beta.json".to_string()]));
}

#[test]
fn an_older_release_comes_back_as_a_downgrade_only_when_one_is_allowed() {
    let feed = serve(|base| vec![("/stable.json", bytes(release(base, "0.0.9", "/payload")))]);
    let (_app, window) = app_with_updater();
    let refused = check(&window, &feed.url("/stable.json"), false, None);
    let allowed = check(&window, &feed.url("/stable.json"), true, None);
    let offered = as_sent(&allowed)["update"].clone();
    assert_eq!(
        (as_sent(&refused), offered["version"].clone(), offered["downgrade"].clone()),
        (json!({ "update": null, "stable": true }), json!("0.0.9"), json!(true)),
    );
}

#[test]
fn the_stable_probe_reports_a_stable_feed_without_offering_its_release() {
    let feed = serve(|base| {
        vec![
            ("/beta.json", bytes(release(base, "0.1.0", "/payload"))),
            ("/stable.json", bytes(release(base, "0.3.0", "/payload"))),
        ]
    });
    let (_app, window) = app_with_updater();
    let missing = check(&window, &feed.url("/beta.json"), false, Some(feed.url("/none.json")));
    let present = check(&window, &feed.url("/beta.json"), false, Some(feed.url("/stable.json")));
    let mut hits = feed.hits();
    hits.sort();
    assert_eq!(
        (as_sent(&missing), as_sent(&present), hits),
        (
            json!({ "update": null, "stable": false }),
            json!({ "update": null, "stable": true }),
            ["/beta.json", "/beta.json", "/none.json", "/stable.json"].map(String::from).to_vec(),
        ),
    );
}

#[test]
fn a_check_that_misses_its_feed_never_probes_stable() {
    let feed = serve(|base| {
        vec![
            ("/beta.json", bytes(release(base, "0.1.0", "/payload"))),
            ("/stable.json", bytes(release(base, "0.3.0", "/payload"))),
        ]
    });
    let (_app, window) = app_with_updater();
    let failed = tauri::async_runtime::block_on(check_feeds(
        &window,
        &feed.url("/none.json"),
        false,
        Some(feed.url("/stable.json")),
    ));
    let reached = check(&window, &feed.url("/beta.json"), false, Some(feed.url("/stable.json")));
    assert_eq!(
        (failed.is_err(), as_sent(&reached), feed.hits()),
        (
            true,
            json!({ "update": null, "stable": true }),
            ["/none.json", "/beta.json", "/stable.json"].map(String::from).to_vec(),
        ),
    );
}

#[test]
fn a_found_update_downloads_only_with_a_signature_from_the_config_pubkey() {
    let feed = serve(|base| {
        vec![
            ("/signed.json", bytes(release(base, "0.2.0", "/payload"))),
            ("/tampered.json", bytes(release(base, "0.2.0", "/tampered"))),
            ("/payload", PAYLOAD.to_vec()),
            ("/tampered", b"fundacad test payloaD".to_vec()),
        ]
    });
    let (_app, window) = app_with_updater();
    let download = |path: &str| {
        let rid = check(&window, &feed.url(path), false, None).update.unwrap().rid;
        let update = window.resources_table().get::<Update>(rid).unwrap();
        tauri::async_runtime::block_on(update.download(|_, _| {}, || {}))
    };
    let signed = download("/signed.json").unwrap();
    let tampered = download("/tampered.json");
    assert_eq!(signed, PAYLOAD);
    assert!(matches!(tampered, Err(tauri_plugin_updater::Error::Minisign(_))), "{tampered:?}");
}
