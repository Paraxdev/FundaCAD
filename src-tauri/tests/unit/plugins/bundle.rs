use std::io::Write;
use std::path::PathBuf;

use fundacad_lib::plugins::bundle::{
    allowed_bundle_url, extract_into, grants_match, is_official_url, now_secs, safe_entry, safe_id, sha256_hex,
    Consented,
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
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
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
