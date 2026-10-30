use std::io::Write;
use std::path::PathBuf;

use fundacad_lib::plugins::bundle::{
    allowed_bundle_url, bundle_target, component_path, extract_into, grants_match, is_official_url, now_secs,
    official_label, official_url, read_capped, safe_entry, safe_id, sha256_hex, swap_into_place, CappedBody,
    ChunkSource, Consented, BUNDLE_PREFIX,
};

/// An id becomes a directory under the plugins root, so every refusal below is a path guard.
#[test]
fn an_id_from_the_webview_cannot_name_a_directory_of_its_choosing() {
    for bad in [
        "",
        ".",
        "..",
        "../etc",
        "..\\windows",
        ".hidden",
        ".staging-x",
        ".inspect-x",
        "a/b",
        "a\\b",
        "a.b.c", // two dots is two chances to be a path
        "a..b",  // and this one is `..` in the middle
        "a.",
        ".a",
        "-leading", // must start with a letter, not a dash
        "1st",      // nor a digit
        "with space",
        "with:colon",
        "with\u{0000}nul",
        "with\nnewline",
        "Uni\u{00e7}ode",
        "\u{0430}dmin",                     // Cyrillic a: reads as ASCII, is not
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // 32 in one segment, cap is 31
        "Ok.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ] {
        assert!(safe_id(bad).is_err(), "should not be a usable plugin id: {bad:?}");
    }

    // The controls: a safe_id that refused everything would pass the loop above too.
    for good in [
        "FundaCAD.MCP",
        "FundaCAD.MultiColor",
        "someone.their-tool",
        "bare",
        "a",
        "A1.b2",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // 31 + 31
    ] {
        assert_eq!(safe_id(good), Ok(good), "should be a usable plugin id");
    }
}

/// Build a zip in memory from (name, contents) pairs, so an archive with a
/// hostile entry name can be written on purpose.
fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut w = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default();
        for (name, body) in entries {
            w.start_file(*name, opts).unwrap();
            w.write_all(body).unwrap();
        }
        w.finish().unwrap();
    }
    buf.into_inner()
}

fn tmpdir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-plugins-{tag}-{}", now_secs()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_digest_is_the_one_sha256sum_would_print() {
    // Not a self-consistency check: the release job computes this with
    // `sha256sum`, and a digest only we can reproduce is worth nothing.
    assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
}

#[test]
fn an_entry_that_climbs_out_of_the_plugin_directory_is_refused() {
    for hostile in [
        "../server.py",
        "a/../../b.py",
        "/etc/passwd",
        "C:/windows/system32/x.dll",
        "C:x.dll",
        "..",
        "sub\\evil.py",
        "",
    ] {
        assert!(safe_entry(hostile).is_none(), "an escaping entry was allowed: {hostile:?}");
    }
    // The control: a guard that refused everything would pass the loop above.
    assert_eq!(safe_entry("manifest.json"), Some(PathBuf::from("manifest.json")));
    assert_eq!(safe_entry("pkg/sub/mod.py"), Some(PathBuf::from("pkg").join("sub").join("mod.py")));
    assert_eq!(safe_entry("./a.py"), Some(PathBuf::from("a.py")));
}

#[test]
fn a_bundle_url_must_be_https_and_name_a_host() {
    for bad in [
        // The transport. Everything downstream would run faithfully against
        // whatever the network substituted.
        "http://example.com/x.zip",
        "ftp://example.com/x.zip",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "https:/example.com/x.zip",
        // No host at all.
        "https://",
        "https:///x.zip",
        // Userinfo: reads as github.com, resolves to evil.example.com, and
        // the consent screen would have shown the first one.
        "https://github.com@evil.example.com/x.zip",
        "https://user:pass@evil.example.com/x.zip",
        // A host that is not a host.
        "https://exa mple.com/x.zip",
        "https://ex\u{7f}ample.com/x.zip",
        "https://.example.com/x.zip",
        "https://example..com/x.zip",
        "https://example.com./x.zip",
        "https://example.com:notaport/x.zip",
        "https://example.com:/x.zip",
        "https://exa_mple.com/x.zip",
        "https://example.com\\evil.com/x.zip",
    ] {
        assert!(!allowed_bundle_url(bad), "a bad URL was allowed: {bad}");
    }

    // The control: ordinary URLs, ours, someone else's, a self hosted one on a port, must go through.
    for good in [
        "https://github.com/Paraxdev/fundacad/releases/download/beta/plugin-mcp.zip",
        "https://github.com/someone/else/releases/download/v1/plugin-x.zip",
        "https://plugins.example.com/a/b/c.zip",
        "https://plugins.example.com:8443/c.zip",
        "https://127.0.0.1:8443/c.zip",
        "https://example.com/x.zip?token=abc",
    ] {
        assert!(allowed_bundle_url(good), "a fine URL was refused: {good}");
    }
}

#[test]
fn official_is_a_label_and_not_a_permission() {
    assert!(is_official_url("https://github.com/Paraxdev/fundacad/releases/download/beta/plugin-mcp.zip"));
    for not_ours in [
        "https://github.com/someone/else/releases/download/beta/x.zip",
        "https://plugins.example.com/x.zip",
        "http://github.com/Paraxdev/fundacad/releases/download/beta/x.zip",
        "https://github.com/Paraxdev/fundacad/releases/download/",
        "https://github.com/Paraxdev/fundacad/releases/download/../../../x.zip",
        "https://github.com/Paraxdev/fundacad/releases/download/beta@evil.com/x.zip",
    ] {
        assert!(!is_official_url(not_ours), "wrongly ours: {not_ours}");
    }

    // The two answer different questions, and this is the case that shows
    // it: a perfectly installable bundle that is not ours.
    let third_party = "https://plugins.example.com/x.zip";
    assert!(allowed_bundle_url(third_party));
    assert!(!is_official_url(third_party));
}

#[test]
fn official_holds_only_for_a_tag_and_asset_the_parser_leaves_as_written() {
    for ours in [
        "https://github.com/Paraxdev/fundacad/releases/download/beta/plugin-mcp.zip",
        "https://github.com/Paraxdev/fundacad/releases/download/v1.0.493/plugin-FundaCAD.Screws.zip",
    ] {
        assert!(is_official_url(ours), "ours but refused: {ours}");
        assert_eq!(official_url(ours).map(|u| u.as_str().to_string()).as_deref(), Some(ours));
    }
    assert!(is_official_url(&format!("{BUNDLE_PREFIX}beta/x.zip")));

    let base = "https://github.com/Paraxdev/fundacad/releases/download/";
    let tails = [
        "%2e%2e/%2e%2e/%2e%2e/someone/else/releases/download/beta/x.zip",
        "%2E%2E/%2E%2E/%2E%2E/someone/else/releases/download/beta/x.zip",
        "%2e%2E/%2E%2e/%2e%2E/someone/else/releases/download/beta/x.zip",
        ".%2e/.%2E/.%2e/someone/else/releases/download/beta/x.zip",
        "%2e./%2E./%2e./someone/else/releases/download/beta/x.zip",
        "%2e/beta/x.zip",
        "%2E/beta/x.zip",
        "./beta/x.zip",
        "beta/./x.zip",
        "beta/%2e",
        "beta/x%2ezip",
        "beta/x.zip?x",
        "beta/x.zip?",
        "beta/x.zip#x",
        "beta/x.zip#",
        "beta/x.zip/",
        "beta/sub/x.zip",
        "beta",
        "beta/",
        "/x.zip",
        "beta//x.zip",
        "beta/x\t.zip",
    ];
    for tail in tails {
        let url = format!("{base}{tail}");
        assert!(!is_official_url(&url), "wrongly ours: {url}");
        assert!(official_url(&url).is_none(), "parsed as ours: {url}");
    }

    let tail = "beta/x.zip";
    for prefix in [
        "https://github.com:443/Paraxdev/fundacad/releases/download/",
        "https://github.com:8443/Paraxdev/fundacad/releases/download/",
        "https://GitHub.com/Paraxdev/fundacad/releases/download/",
        "https://GITHUB.COM/Paraxdev/fundacad/releases/download/",
        "https://github.com./Paraxdev/fundacad/releases/download/",
        "https://user@github.com/Paraxdev/fundacad/releases/download/",
        "https://user:pw@github.com/Paraxdev/fundacad/releases/download/",
        "https://:pw@github.com/Paraxdev/fundacad/releases/download/",
        "HTTPS://github.com/Paraxdev/fundacad/releases/download/",
        "https:github.com/Paraxdev/fundacad/releases/download/",
        "https://github.com\\Paraxdev/fundacad/releases/download/",
        "https://github.com/paraxdev/fundacad/releases/download/",
        "https://github.com/Paraxdev/fundacad/releases/download/../download/",
        " https://github.com/Paraxdev/fundacad/releases/download/",
    ] {
        let url = format!("{prefix}{tail}");
        assert!(!is_official_url(&url), "wrongly ours: {url}");
    }
}

/// What is fetched is what gets stored as the source and labelled, even where the parser rewrites the text it was given.
#[test]
fn the_url_fetched_is_the_one_stored_and_labelled() {
    let ours = format!("{BUNDLE_PREFIX}beta/plugin-mcp.zip");
    let target = bundle_target(&ours).expect("ours is fetchable");
    assert_eq!(target.url.as_str(), ours);
    assert!(target.official);

    let fetched = "https://github.com/Paraxdev/fundacad/releases/download/beta/x.zip";
    let elsewhere = "https://github.com/someone/else/releases/download/beta/x.zip";
    let base = "https://github.com/Paraxdev/fundacad/releases/download/";
    for (raw, want) in [
        ("https://GitHub.com/Paraxdev/fundacad/releases/download/beta/x.zip".to_string(), fetched),
        ("https://GITHUB.COM/Paraxdev/fundacad/releases/download/beta/x.zip".to_string(), fetched),
        ("https://github.com:443/Paraxdev/fundacad/releases/download/beta/x.zip".to_string(), fetched),
        (format!("{base}%2e%2e/%2e%2e/%2e%2e/%2e%2e/someone/else/releases/download/beta/x.zip"), elsewhere),
        (format!("{base}%2E%2E/%2E%2E/%2E%2E/%2E%2E/someone/else/releases/download/beta/x.zip"), elsewhere),
        (format!("{base}.%2e/%2e./.%2E/%2E./someone/else/releases/download/beta/x.zip"), elsewhere),
    ] {
        let target = bundle_target(&raw).unwrap_or_else(|e| panic!("{raw}: {e}"));
        assert_eq!(target.url.as_str(), want, "fetched from {raw}");
        assert_eq!(target.official, want == fetched, "labelled from {raw}");
        // The window installs with the source inspect handed back, so both screens must agree on the label.
        let installed = bundle_target(target.url.as_str()).unwrap();
        assert_eq!((installed.url, installed.official), (target.url, target.official), "relabelled: {raw}");
    }

    let third_party = "https://plugins.example.com:8443/a/b.zip?token=abc";
    let target = bundle_target(third_party).expect("a self hosted URL is fetchable");
    assert_eq!(target.url.as_str(), third_party);
    assert!(!target.official);

    for bad in [
        "http://github.com/Paraxdev/fundacad/releases/download/beta/x.zip",
        "https://github.com@evil.example.com/x.zip",
    ] {
        assert!(bundle_target(bad).is_err(), "fetchable: {bad}");
    }
}

#[test]
fn app_side_code_from_a_release_is_official_only_for_a_shipped_id() {
    for kind in ["builtin", "process"] {
        assert!(official_label(true, kind, "FundaCAD.Printing"), "{kind}");
        assert!(!official_label(true, kind, "FundaCAD.Unknown"), "{kind}");
        assert!(!official_label(true, kind, "fundacad.printing"), "{kind}");
        assert!(!official_label(true, kind, ""), "{kind}");
        assert!(!official_label(false, kind, "FundaCAD.Printing"), "{kind}");
    }
    for kind in ["compute", "panel"] {
        assert!(official_label(true, kind, "FundaCAD.Unknown"), "{kind}");
        assert!(!official_label(false, kind, "FundaCAD.Printing"), "{kind}");
    }
}

#[test]
fn a_zip_unpacks_into_the_plugin_directory() {
    let dir = tmpdir("extract");
    let bytes = zip_of(&[("manifest.json", b"{}" as &[u8]), ("server.py", b"print(1)"), ("pkg/mod.py", b"x = 2")]);
    extract_into(&bytes, &dir).expect("a plain bundle must unpack");
    assert_eq!(std::fs::read_to_string(dir.join("server.py")).unwrap(), "print(1)");
    assert_eq!(std::fs::read_to_string(dir.join("pkg").join("mod.py")).unwrap(), "x = 2");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_zip_that_writes_outside_the_plugin_directory_is_refused() {
    let dir = tmpdir("slip");
    let outside = dir.join("outside.py");
    let bytes = zip_of(&[("manifest.json", b"{}" as &[u8]), ("../outside.py", b"owned")]);
    let err = extract_into(&bytes, &dir.join("plug")).expect_err("zip slip must be refused");
    assert!(err.contains("unsafe path"), "refused for the wrong reason: {err}");
    assert!(!outside.exists(), "the escaping entry was written to {}", outside.display());
    let _ = std::fs::remove_dir_all(&dir);
}

const LOCAL: &[u8; 4] = b"PK\x03\x04";
const LOCAL_NAME_AT: usize = 30;
const CENTRAL: &[u8; 4] = b"PK\x01\x02";
const CENTRAL_NAME_AT: usize = 46;

fn rename(bytes: &mut [u8], signature: &[u8; 4], name_at: usize, from: &str, to: &str) {
    assert_eq!(from.len(), to.len(), "a rename in place keeps every offset");
    let at = (0..bytes.len() - name_at - from.len())
        .find(|&p| &bytes[p..p + 4] == signature && &bytes[p + name_at..p + name_at + from.len()] == from.as_bytes())
        .unwrap_or_else(|| panic!("no record names {from}"));
    bytes[at + name_at..at + name_at + to.len()].copy_from_slice(to.as_bytes());
}

fn is_empty(dir: &std::path::Path) -> bool {
    std::fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(true)
}

/// A streaming unzip walks the local headers and we walk the central directory, so a bundle where the two disagree
/// would unpack one set of files for us and another for anyone checking it with a different tool.
#[test]
fn a_bundle_whose_local_header_names_another_file_is_refused() {
    let dir = tmpdir("local-header");
    let mut bytes = zip_of(&[("manifest.json", b"{}" as &[u8]), ("server.py", b"print(1)")]);
    rename(&mut bytes, LOCAL, LOCAL_NAME_AT, "server.py", "loader.py");
    let err = extract_into(&bytes, &dir).expect_err("a bundle with a renamed local header must be refused");
    assert!(err.contains("damaged"), "refused for the wrong reason: {err}");
    assert!(is_empty(&dir), "a refused bundle left files behind");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Two entries named manifest.json: one tool shows the first one's permissions, another installs the second's.
#[test]
fn a_bundle_with_two_manifests_is_refused() {
    let dir = tmpdir("two-manifests");
    let mut bytes = zip_of(&[
        ("manifest.json", br#"{"permissions":["document.read"]}"# as &[u8]),
        ("manifesx.json", br#"{"permissions":["process.spawn"]}"#),
    ]);
    rename(&mut bytes, LOCAL, LOCAL_NAME_AT, "manifesx.json", "manifest.json");
    rename(&mut bytes, CENTRAL, CENTRAL_NAME_AT, "manifesx.json", "manifest.json");
    let err = extract_into(&bytes, &dir).expect_err("a bundle with two manifests must be refused");
    assert!(err.contains("damaged"), "refused for the wrong reason: {err}");
    assert!(is_empty(&dir), "a refused bundle left files behind");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn what_arrived_must_be_what_was_shown() {
    let shown = Consented {
        kind: "process".into(),
        version: "1".into(),
        grants: vec!["document.read".into(), "document.write".into()],
        hosts: vec![],
    };
    // Order is not a difference.
    let reordered = Consented { grants: vec!["document.write".into(), "document.read".into()], ..shown.clone() };
    assert!(grants_match(&shown, &reordered).is_ok(), "order counted as a change");

    let greedier = Consented {
        grants: vec!["document.read".into(), "document.write".into(), "process.spawn".into()],
        ..shown.clone()
    };
    let err = grants_match(&shown, &greedier).expect_err("a greedier bundle must be refused");
    assert!(err.contains("process.spawn"), "the refusal did not say what: {err}");

    let other_kind = Consented { kind: "panel".into(), ..shown.clone() };
    assert!(grants_match(&shown, &other_kind).is_err(), "the kind was not checked");

    let extra_host = Consented {
        grants: vec!["document.read".into(), "document.write".into(), "network".into()],
        hosts: vec!["evil.example.com".into()],
        ..shown.clone()
    };
    assert!(grants_match(&shown, &extra_host).is_err(), "an added host slipped through");
}

fn entries(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> =
        std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

#[test]
fn a_swap_that_cannot_place_the_new_install_keeps_the_old_one() {
    let root = tmpdir("swap-fail");
    let dest = root.join("Acme.Tool");
    std::fs::create_dir_all(&dest).unwrap();
    std::fs::write(dest.join("main.js"), b"old").unwrap();
    let missing = root.join(".staging-Acme.Tool");

    assert!(swap_into_place(&missing, &dest).is_err(), "a missing staging dir was put in place");
    assert_eq!(std::fs::read(dest.join("main.js")).unwrap(), b"old", "the old install was lost");
    assert_eq!(entries(&root), vec!["Acme.Tool".to_string()], "the swap left something beside the install");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_finished_swap_replaces_the_whole_old_install_and_leaves_nothing_beside_it() {
    let root = tmpdir("swap-ok");
    let dest = root.join("Acme.Tool");
    std::fs::create_dir_all(&dest).unwrap();
    std::fs::write(dest.join("main.js"), b"old").unwrap();
    std::fs::write(dest.join("stale.js"), b"old").unwrap();
    let staging = root.join(".staging-Acme.Tool");
    std::fs::create_dir_all(&staging).unwrap();
    std::fs::write(staging.join("main.js"), b"new").unwrap();

    swap_into_place(&staging, &dest).unwrap();
    assert_eq!(std::fs::read(dest.join("main.js")).unwrap(), b"new");
    assert!(!dest.join("stale.js").exists(), "a file of the old install survived the update");
    assert_eq!(entries(&root), vec!["Acme.Tool".to_string()]);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_first_install_needs_no_old_one_to_set_aside() {
    let root = tmpdir("swap-first");
    let dest = root.join("Acme.Tool");
    let staging = root.join(".staging-Acme.Tool");
    std::fs::create_dir_all(&staging).unwrap();
    std::fs::write(staging.join("main.js"), b"new").unwrap();

    swap_into_place(&staging, &dest).unwrap();
    assert_eq!(std::fs::read(dest.join("main.js")).unwrap(), b"new");
    assert_eq!(entries(&root), vec!["Acme.Tool".to_string()]);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_body_is_refused_as_soon_as_its_running_total_passes_the_cap() {
    let mut body = CappedBody::new(10);
    assert!(body.push(b"12345"));
    assert!(body.push(b"67890"));
    assert!(!body.push(b"x"));
    assert!(!body.push(b""), "once over, it stays over");

    let mut big = CappedBody::new(4);
    assert!(!big.push(b"12345"), "one chunk larger than the cap is refused on its own");
}

#[test]
fn a_body_within_the_cap_comes_back_whole_and_in_order() {
    let mut body = CappedBody::new(10);
    for chunk in [&b"ab"[..], b"", b"cde", b"fghij"] {
        assert!(body.push(chunk));
    }
    assert_eq!(body.into_bytes(), b"abcdefghij");
}

#[test]
fn a_refused_body_does_not_keep_growing() {
    let mut body = CappedBody::new(3);
    assert!(!body.push(&[0u8; 1024]));
    assert!(!body.push(&[0u8; 1024]));
    assert!(body.into_bytes().len() <= 3);
}

struct Reply {
    declared: Option<u64>,
    chunks: std::collections::VecDeque<Result<Vec<u8>, String>>,
    pulled: usize,
}

impl ChunkSource for Reply {
    type Error = String;
    fn declared_len(&self) -> Option<u64> {
        self.declared
    }
    fn next_chunk(&mut self) -> impl std::future::Future<Output = Result<Option<Vec<u8>>, String>> + Send {
        self.pulled += 1;
        std::future::ready(self.chunks.pop_front().transpose())
    }
}

fn reply(declared: Option<u64>, chunks: &[&[u8]]) -> Reply {
    Reply { declared, chunks: chunks.iter().map(|c| Ok(c.to_vec())).collect(), pulled: 0 }
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    loop {
        if let std::task::Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return v;
        }
    }
}

#[test]
fn a_reply_declaring_more_than_the_cap_is_refused_before_any_read() {
    let mut r = reply(Some(11), &[b"12345"]);
    assert_eq!(block_on(read_capped(&mut r, 10)), Ok(None));
    assert_eq!(r.pulled, 0);
}

#[test]
fn a_reply_stops_being_read_at_the_chunk_that_passes_the_cap() {
    let mut r = reply(None, &[b"12345", b"67890", b"x", b"never read"]);
    assert_eq!(block_on(read_capped(&mut r, 10)), Ok(None));
    assert_eq!(r.pulled, 3);

    let mut lying = reply(Some(4), &[b"1234", b"5"]);
    assert_eq!(block_on(read_capped(&mut lying, 4)), Ok(None), "a short declared length is not trusted");
}

#[test]
fn a_reply_within_the_cap_comes_back_whole_and_a_read_error_comes_back_as_is() {
    let mut r = reply(Some(10), &[b"abcde", b"", b"fghij"]);
    assert_eq!(block_on(read_capped(&mut r, 10)), Ok(Some(b"abcdefghij".to_vec())));

    let mut broken = reply(None, &[b"ab"]);
    broken.chunks.push_back(Err("reset".into()));
    assert_eq!(block_on(read_capped(&mut broken, 10)), Err("reset".to_string()));
}

/// The three plugin request paths read their bodies only through read_capped.
#[test]
fn no_plugin_request_reads_a_whole_body_unchecked() {
    let sources = [
        ("mod.rs", include_str!("../../../src/plugins/mod.rs")),
        ("web.rs", include_str!("../../../src/plugins/web.rs")),
        ("localnet.rs", include_str!("../../../src/plugins/localnet.rs")),
    ];
    let unchecked: Vec<String> = sources
        .iter()
        .flat_map(|(name, text)| {
            [".bytes().await", ".text().await", ".json().await", ".json::<", "bytes_stream("]
                .into_iter()
                .filter(|call| text.contains(*call))
                .map(move |call| format!("{name} {call}"))
        })
        .collect();
    assert_eq!(unchecked, Vec::<String>::new());
}

/// The unpack budget sums declared sizes, which holds only while no entry can inflate past the size its headers give.
#[test]
fn an_entry_that_inflates_past_its_declared_size_is_refused_and_not_written() {
    let body = vec![0u8; 2 * 1024 * 1024];
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut w = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        w.start_file("big.bin", opts).unwrap();
        w.write_all(&body).unwrap();
        w.finish().unwrap();
    }
    let mut bytes = buf.into_inner();
    assert!(bytes.len() < body.len() / 100, "the entry must be stored compressed");
    let declared = 1000u32.to_le_bytes();
    for (signature, name_at, size_at) in [(LOCAL, LOCAL_NAME_AT, 22), (CENTRAL, CENTRAL_NAME_AT, 24)] {
        let at = (0..bytes.len() - name_at - 7)
            .find(|&p| &bytes[p..p + 4] == signature && &bytes[p + name_at..p + name_at + 7] == b"big.bin")
            .expect("record for big.bin");
        assert_eq!(bytes[at + size_at..at + size_at + 4], (body.len() as u32).to_le_bytes());
        bytes[at + size_at..at + size_at + 4].copy_from_slice(&declared);
    }
    let dir = tmpdir("inflate");
    assert!(extract_into(&bytes, &dir).is_err(), "an entry larger than declared must be refused");
    assert!(!dir.join("big.bin").exists(), "nothing of the oversized entry may be written");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_component_path_stays_inside_the_plugin_directory() {
    let root = tmpdir("component-path");
    let dir = root.join("P");
    std::fs::create_dir_all(dir.join("geometry")).unwrap();
    std::fs::write(root.join("outside.wasm"), b"x").unwrap();
    std::fs::write(dir.join("p.wasm"), b"x").unwrap();
    std::fs::write(dir.join("geometry").join("g.wasm"), b"x").unwrap();
    let abs = root.join("outside.wasm").to_string_lossy().replace('\\', "/");
    for rel in ["../outside.wasm", "geometry/../../outside.wasm", abs.as_str(), "", "/p.wasm"] {
        assert_eq!(component_path(&dir, rel), None, "{rel:?}");
    }
    assert_eq!(component_path(&dir, "p.wasm"), Some(dir.join("p.wasm")));
    assert_eq!(component_path(&dir, "geometry/g.wasm"), Some(dir.join("geometry").join("g.wasm")));
    assert_eq!(component_path(&dir, "missing.wasm"), None);
    let _ = std::fs::remove_dir_all(&root);
}
