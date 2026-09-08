//! Everything about a plugin bundle that is arithmetic on bytes and text: what
//! an archive entry is allowed to be called, what a download URL is allowed to
//! be, what its digest is, and whether what arrived is what the person was
//! shown.
//!
//! Split from the commands next door so it can be compiled and run WITHOUT
//! linking Tauri. Every function in here is a refusal that has to work, and the
//! crate's own test binary cannot start on this machine (a webview DLL fault
//! that has nothing to do with these lines), so the guards would otherwise ship
//! having never once been executed. See scripts/check-plugin-guards.sh, which
//! builds this file on its own and runs the tests below against it.
//!
//! It knows NOTHING about what a permission means. The vocabulary lives in
//! src/plugins/manifest.ts, which is also what renders the screen the user
//! answers; all this side does is compare the grants shown against the grants
//! that arrived, as sets of opaque strings. Teaching both sides the meaning of
//! a grant would give them two chances to disagree about it.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

/// Where this project's own plugins are published.
///
/// This is a PROVENANCE claim and not a security boundary, and the difference
/// is worth being exact about because this constant used to be both. A bundle
/// from here was published by whoever can publish this repository's releases; a
/// bundle from anywhere else was not. That is all it says. What a plugin may
/// then do is decided by the grants it declared and the sandbox its kind runs
/// in, neither of which knows or cares where the bytes came from.
///
/// Keeping the two apart is what lets a third party publish a plugin at all,
/// which was the point: an origin allowlist that only ever admits us is not a
/// permission model, it is a distribution monopoly wearing one.
pub const BUNDLE_PREFIX: &str = "https://github.com/Paraxdev/fundacad/releases/download/";

/// Caps. A plugin is source, not a runtime: the interpreter it runs on is
/// already installed. Anything near these numbers is not a plugin.
pub const MAX_DOWNLOAD: usize = 32 * 1024 * 1024;
const MAX_UNPACKED: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 4000;

/// The manifest fields that make up the promise, as sets to be compared. Kept
/// deliberately dumb: strings in, strings out, no opinion about what any of
/// them mean.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Consented {
    pub kind: String,
    pub version: String,
    pub grants: Vec<String>,
    #[serde(default)]
    pub hosts: Vec<String>,
}

// ---------------------------------------------------------------------------

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

/// Whether a URL is one of this project's own release assets.
///
/// Used to LABEL a plugin, never to permit one. The prefix test works only
/// because the prefix ends at a path separator: `https://github.com/Paraxdev/`
/// as a prefix would also match `https://github.com/Paraxdev.evil.com/`.
pub fn is_official_url(url: &str) -> bool {
    if !url.starts_with(BUNDLE_PREFIX) {
        return false;
    }
    let tail = &url[BUNDLE_PREFIX.len()..];
    // `..` climbs back out of the prefix at fetch time, which would let an
    // "official" label be worn by an asset somewhere else on the host.
    !tail.is_empty() && !tail.contains("..") && !tail.contains('@') && !tail.contains("://")
}

/// Whether a URL may be fetched at all.
///
/// A bundle URL arrives from the webview, so it is not trusted to be a URL we
/// would have chosen. What is enforced here is the transport and the shape, not
/// the host: HTTPS, a host that is a host, and nothing in the authority that
/// makes the address mean something other than it reads.
///
/// HTTPS IS NOT NEGOTIABLE, and it is the one thing this function is really
/// for. Over plain HTTP the bytes are whatever the network decided they should
/// be, and every check downstream, the digest, the manifest comparison, the
/// extractor, would then be run faithfully against an attacker's archive. It
/// is also what makes the origin shown on the consent screen worth showing:
/// with TLS the host in the URL is the host that answered.
///
/// WHAT IS NOT CHECKED, deliberately: whether the host is one we like. Private
/// and loopback addresses are allowed, because a self-hosted plugin server on a
/// company network is a legitimate thing to install from and this is a desktop
/// app fetching on a person's own behalf, not a server following a link it was
/// handed.
pub fn allowed_bundle_url(url: &str) -> bool {
    const SCHEME: &str = "https://";
    if !url.starts_with(SCHEME) {
        return false;
    }
    // No spaces, no controls, anywhere. A URL containing either is one whose
    // reading depends on which parser you ask, and the parser that matters is
    // the one at the other end rather than this one.
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
    // Userinfo, refused early and by name. REDUNDANT TODAY: `@` is not in the
    // host character set below, so removing this line changes no answer, which
    // was checked rather than assumed. It stays because the charset is the sort
    // of thing that gets loosened one character at a time, for an underscore,
    // for an IDN, and this is the refusal that must not be loosened with it.
    if authority.contains('@') {
        return false;
    }

    // Strip a port and check what is left is a plausible host. This is the
    // check that actually stops `https://github.com@evil.example.com/x.zip`,
    // which reads as GitHub to a person and resolves somewhere else: the
    // consent screen shows this string, so a URL that reads as one host and
    // reaches another is the thing that must not get past.
    //
    // Bracketed IPv6 is not accepted: it is not needed to reach a plugin
    // server, and admitting a second address syntax here means a second one to
    // be wrong about.
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
    host.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// The path an archive entry may be written to, relative to the plugin
/// directory, or None if it may not be written at all.
///
/// Zip entry names are attacker-controlled text. An entry called
/// `../../../../sidecar-runtime/app/server.py` is a perfectly legal archive and
/// a complete compromise of the app, so this is the guard the whole extractor
/// stands on. Written by hand rather than leaning on the zip crate's
/// `enclosed_name()`, because it is the one function here whose failure is
/// silent and total, and because it can then be stricter than that helper: no
/// backslashes at all (a separator on Windows and an ordinary character
/// elsewhere, which is exactly the sort of difference that ships a hole to one
/// platform), and no name that is merely empty.
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

/// Whether what arrived is what was agreed to. Set equality, and the error says
/// which way it differs: a bundle asking for LESS than advertised is still a
/// refusal, because the screen the user answered was not a description of this
/// bundle, and a chain that tolerates one direction of drift is a chain that
/// has to be argued about every time it fires.
pub fn grants_match(expect: &Consented, found: &Consented) -> Result<(), String> {
    if expect.kind != found.kind {
        return Err(format!(
            "the bundle is a {} plugin, the one described was {}",
            found.kind, expect.kind
        ));
    }
    let mut a = expect.grants.clone();
    let mut b = found.grants.clone();
    a.sort();
    a.dedup();
    b.sort();
    b.dedup();
    if a != b {
        return Err(format!(
            "the bundle asks for different permissions than the ones shown: {}",
            b.join(", ")
        ));
    }
    let mut ha = expect.hosts.clone();
    let mut hb = found.hosts.clone();
    ha.sort();
    ha.dedup();
    hb.sort();
    hb.dedup();
    if ha != hb {
        return Err(format!(
            "the bundle names different hosts than the ones shown: {}",
            hb.join(", ")
        ));
    }
    Ok(())
}

/// Unpack a zip into `dest`, refusing anything that tries to leave it.
///
/// Takes bytes rather than a path so that the whole of the interesting
/// behaviour, every refusal included, can be driven from a test that builds its
/// archive in memory and never touches the network.
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
        // A symlink's "content" is its target, so an extractor that writes it as
        // a file is harmless but an extractor that recreates it is a second way
        // out of the directory. We do neither, and say so.
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
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("{raw}: {e}"))?;
        std::fs::write(&target, &buf).map_err(|e| format!("{}: {e}", target.display()))?;
    }
    Ok(())
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// An id from the webview names a directory, so it gets the same treatment as
/// an archive entry: a closed character set, not a sanitiser.
pub fn safe_id(id: &str) -> Result<&str, String> {
    // `Publisher.Name`, or a bare `Name`. Mirrors ID in src/plugins/manifest.ts.
    //
    // THE DOT IS WHY THIS IS WRITTEN OUT rather than left as one character
    // class. An id is joined onto the plugins root to make a directory, so it
    // is the only thing standing between a manifest and a path; allowing '.'
    // anywhere would allow `..`, and allowing a leading '.' would allow an id
    // to land on `.staging-x` or `.inspect-x`, which are real directories this
    // module creates and deletes. Requiring every segment to START WITH A
    // LETTER is what forbids all of those at once, and it is a rule about the
    // shape of a name rather than a list of strings to remember.
    fn segment(part: &str) -> bool {
        !part.is_empty()
            && part.len() <= 31
            && part.starts_with(|c: char| c.is_ascii_alphabetic())
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
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

    /// An id becomes a directory name, so this is a path guard wearing the word
    /// "id". Every refusal below is a path that would otherwise be joined onto
    /// the plugins root.
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
            "a.b.c",       // two dots is two chances to be a path
            "a..b",        // and this one is `..` in the middle
            "a.",
            ".a",
            "-leading",    // must start with a letter, not a dash
            "1st",         // nor a digit
            "with space",
            "with:colon",
            "with\u{0000}nul",
            "with\nnewline",
            "Uni\u{00e7}ode",
            "\u{0430}dmin",  // Cyrillic a: reads as ASCII, is not
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // 32 in one segment, cap is 31
            "Ok.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ] {
            assert!(
                safe_id(bad).is_err(),
                "should not be a usable plugin id: {bad:?}"
            );
        }

        // The controls. Without these the test passes just as well against a
        // safe_id that refuses everything, which would be a plugin system that
        // installs nothing.
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
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
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
            assert!(
                safe_entry(hostile).is_none(),
                "an escaping entry was allowed: {hostile:?}"
            );
        }
        // The control. If the guard refused everything it would pass the loop
        // above while making the feature impossible, and nothing else here
        // would notice.
        assert_eq!(safe_entry("manifest.json"), Some(PathBuf::from("manifest.json")));
        assert_eq!(
            safe_entry("pkg/sub/mod.py"),
            Some(PathBuf::from("pkg").join("sub").join("mod.py"))
        );
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

        // The control. Every refusal above is worth nothing unless ordinary
        // URLs, ours, someone else's, a self-hosted one on a port, go
        // through, which is the whole reason the host is no longer checked.
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
        assert!(is_official_url(
            "https://github.com/Paraxdev/fundacad/releases/download/beta/plugin-mcp.zip"
        ));
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
        let bytes = zip_of(&[
            ("manifest.json", b"{}" as &[u8]),
            ("server.py", b"print(1)"),
            ("pkg/mod.py", b"x = 2"),
        ]);
        extract_into(&bytes, &dir).expect("a plain bundle must unpack");
        assert_eq!(
            std::fs::read_to_string(dir.join("server.py")).unwrap(),
            "print(1)"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("pkg").join("mod.py")).unwrap(),
            "x = 2"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_zip_that_writes_outside_the_plugin_directory_is_refused() {
        let dir = tmpdir("slip");
        let outside = dir.join("outside.py");
        let bytes = zip_of(&[
            ("manifest.json", b"{}" as &[u8]),
            ("../outside.py", b"owned"),
        ]);
        let err = extract_into(&bytes, &dir.join("plug")).expect_err("zip slip must be refused");
        assert!(err.contains("unsafe path"), "refused for the wrong reason: {err}");
        assert!(
            !outside.exists(),
            "the escaping entry was written to {}",
            outside.display()
        );
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
        let reordered = Consented {
            grants: vec!["document.write".into(), "document.read".into()],
            ..shown.clone()
        };
        assert!(grants_match(&shown, &reordered).is_ok(), "order counted as a change");

        let greedier = Consented {
            grants: vec![
                "document.read".into(),
                "document.write".into(),
                "process.spawn".into(),
            ],
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
