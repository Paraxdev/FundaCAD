//! Plugin bundle checks that are arithmetic on bytes and text: entry names, download URLs, digests and grants. Tauri
//! free so scripts/check-plugin-guards.sh can run these tests on their own. Grants are opaque strings here, their
//! meaning lives in src/plugins/manifest.ts.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

/// A provenance label only, never a permission: what a plugin may do comes from its declared grants and its sandbox,
/// which is what lets third parties publish plugins.
pub const BUNDLE_PREFIX: &str = "https://github.com/Paraxdev/fundacad/releases/download/";

/// Caps. A plugin is source, not a runtime: the interpreter it runs on is
/// already installed. Anything near these numbers is not a plugin.
pub const MAX_DOWNLOAD: usize = 32 * 1024 * 1024;
const MAX_UNPACKED: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 4000;

/// The manifest fields that make up the promise, compared as plain string sets.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Consented {
    pub kind: String,
    pub version: String,
    pub grants: Vec<String>,
    #[serde(default)]
    pub hosts: Vec<String>,
}

fn hex_of(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex_of(&h.finalize())
}

/// Labels a plugin, never permits one. The prefix test works only because the prefix ends at a path separator, without
/// it `https://github.com/Paraxdev` would also match `https://github.com/Paraxdev.evil.com/`.
pub fn is_official_url(url: &str) -> bool {
    if !url.starts_with(BUNDLE_PREFIX) {
        return false;
    }
    let tail = &url[BUNDLE_PREFIX.len()..];
    // `..` climbs back out of the prefix at fetch time, which would let an
    // "official" label be worn by an asset somewhere else on the host.
    !tail.is_empty() && !tail.contains("..") && !tail.contains('@') && !tail.contains("://")
}

/// HTTPS, a real host and nothing in the authority that changes its meaning. HTTPS is the point: without it every later
/// check runs against whatever the network sent. Private and loopback hosts are allowed on purpose (self hosted
/// servers).
pub fn allowed_bundle_url(url: &str) -> bool {
    const SCHEME: &str = "https://";
    if !url.starts_with(SCHEME) {
        return false;
    }
    // No spaces or controls: how such a URL reads depends on which parser you ask.
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    if url.contains('\\') {
        return false;
    }

    let rest = &url[SCHEME.len()..];
    let authority = match rest.find(['/', '?', '#']) {
        Some(i) => &rest[..i],
        None => rest,
    };
    if authority.is_empty() {
        return false;
    }
    // Userinfo, refused by name. Redundant while `@` is outside the host charset below, kept for when that charset gets
    // loosened.
    if authority.contains('@') {
        return false;
    }

    // This stops `https://github.com@evil.example.com/x.zip`, which the consent screen would show as GitHub. Bracketed
    // IPv6 is refused: no plugin server needs it, and a second address syntax is a second one to get wrong.
    let host = match authority.rsplit_once(':') {
        Some((h, port)) => {
            if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
                return false;
            }
            h
        }
        None => authority,
    };
    if host.is_empty() || host.starts_with('.') || host.ends_with('.') || host.contains("..") {
        return false;
    }
    host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// Where an archive entry may be written, relative to the plugin dir. Entry names are attacker text, so this is
/// stricter than zip's `enclosed_name()`: no empty name, no backslash at all, a separator only on Windows, where it
/// would ship a hole to one platform.
pub fn safe_entry(name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.len() > 512 {
        return None;
    }
    if name.contains('\\') || name.contains('\0') {
        return None;
    }
    if name.starts_with('/') {
        return None;
    }
    // A drive-relative or drive-absolute Windows path: `C:foo`, `C:/foo`.
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        return None;
    }
    let mut out = PathBuf::new();
    for part in name.split('/') {
        if part.is_empty() || part == "." {
            // A trailing slash is how a directory entry is spelled, and an
            // interior `//` is noise; neither is an escape.
            continue;
        }
        if part == ".." {
            return None;
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Set equality of what arrived and what was agreed to. Asking for less is still a refusal, since the screen the user
/// answered did not describe this bundle.
pub fn grants_match(expect: &Consented, found: &Consented) -> Result<(), String> {
    if expect.kind != found.kind {
        return Err(format!("the bundle is a {} plugin, the one described was {}", found.kind, expect.kind));
    }
    let mut a = expect.grants.clone();
    let mut b = found.grants.clone();
    a.sort();
    a.dedup();
    b.sort();
    b.dedup();
    if a != b {
        return Err(format!("the bundle asks for different permissions than the ones shown: {}", b.join(", ")));
    }
    let mut ha = expect.hosts.clone();
    let mut hb = found.hosts.clone();
    ha.sort();
    ha.dedup();
    hb.sort();
    hb.dedup();
    if ha != hb {
        return Err(format!("the bundle names different hosts than the ones shown: {}", hb.join(", ")));
    }
    Ok(())
}

/// Takes bytes rather than a path so every refusal can be tested with an in memory archive.
pub fn extract_into(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let reader = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| format!("not a zip: {e}"))?;
    if zip.len() > MAX_ENTRIES {
        return Err(format!("bundle holds {} files", zip.len()));
    }
    let mut written: u64 = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("unreadable entry: {e}"))?;
        let raw = entry.name().to_string();
        // Recreating a symlink would be a second way out of the directory, so symlinks are refused by name.
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(format!("bundle holds a symbolic link: {raw}"));
            }
        }
        let Some(rel) = safe_entry(&raw) else {
            return Err(format!("bundle holds an unsafe path: {raw}"));
        };
        let target = dest.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| format!("{}: {e}", target.display()))?;
            continue;
        }
        written = written.saturating_add(entry.size());
        if written > MAX_UNPACKED {
            return Err("bundle unpacks to more than the limit".into());
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut buf).map_err(|e| format!("{raw}: {e}"))?;
        std::fs::write(&target, &buf).map_err(|e| format!("{}: {e}", target.display()))?;
    }
    Ok(())
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// An id from the webview names a directory, so it gets the same treatment as
/// an archive entry: a closed character set, not a sanitiser.
pub fn safe_id(id: &str) -> Result<&str, String> {
    // `Publisher.Name` or `Name`, mirroring ID in src/plugins/manifest.ts. Every segment must start with a letter,
    // which forbids `..` and the dot directories this module creates, like `.staging-x`.
    fn segment(part: &str) -> bool {
        !part.is_empty()
            && part.len() <= 31
            && part.starts_with(|c: char| c.is_ascii_alphabetic())
            && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    }

    let mut parts = id.split('.');
    let ok = match (parts.next(), parts.next(), parts.next()) {
        (Some(a), None, _) => segment(a),
        (Some(a), Some(b), None) => segment(a) && segment(b),
        _ => false,
    };
    if ok {
        Ok(id)
    } else {
        Err(format!("not a plugin id: {id}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

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
}
