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

/// A bundle URL arrives from the webview, so it is not trusted to be a URL we
/// would have chosen. Everything must sit under the releases host for this
/// repository: without this, "install this plugin" is a request to download and
/// unpack an arbitrary URL, which is a considerably more interesting feature
/// than the one being built.
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

pub fn allowed_bundle_url(url: &str) -> bool {
    // A prefix test only works because the prefix ends at a path separator and
    // the rest is checked for traversal below. `https://github.com/Paraxdev/`
    // as a prefix would also match `https://github.com/Paraxdev.evil.com/`.
    if !url.starts_with(BUNDLE_PREFIX) {
        return false;
    }
    let tail = &url[BUNDLE_PREFIX.len()..];
    // `..` climbs back out of the prefix at fetch time; `@` reaches a different
    // host through userinfo; a second scheme is a redirect written by hand.
    !tail.is_empty()
        && !tail.contains("..")
        && !tail.contains('@')
        && !tail.contains("://")
        && !tail.contains('\\')
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
    let ok = !id.is_empty()
        && id.len() <= 32
        && id.starts_with(|c: char| c.is_ascii_lowercase())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
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
        assert_eq!(safe_entry("plugin.json"), Some(PathBuf::from("plugin.json")));
        assert_eq!(
            safe_entry("pkg/sub/mod.py"),
            Some(PathBuf::from("pkg").join("sub").join("mod.py"))
        );
        assert_eq!(safe_entry("./a.py"), Some(PathBuf::from("a.py")));
    }

    #[test]
    fn a_bundle_url_must_be_this_repositorys_releases_over_https() {
        for bad in [
            "http://github.com/Paraxdev/fundacad/releases/download/beta/x.zip",
            "https://github.com/someone/else/releases/download/beta/x.zip",
            "https://evil.example.com/x.zip",
            "https://github.com/Paraxdev/fundacad/releases/download/../../../x.zip",
            "https://github.com/Paraxdev/fundacad/releases/download/beta@evil.com/x.zip",
            "https://github.com/Paraxdev/fundacad/releases/download/",
        ] {
            assert!(!allowed_bundle_url(bad), "an outside URL was allowed: {bad}");
        }
        assert!(allowed_bundle_url(
            "https://github.com/Paraxdev/fundacad/releases/download/beta/plugin-mcp.zip"
        ));
    }

    #[test]
    fn a_zip_unpacks_into_the_plugin_directory() {
        let dir = tmpdir("extract");
        let bytes = zip_of(&[
            ("plugin.json", b"{}" as &[u8]),
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
            ("plugin.json", b"{}" as &[u8]),
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

    #[test]
    fn an_id_from_the_webview_cannot_name_a_directory_of_its_choosing() {
        for bad in ["..", "../other", "a/b", "", "Mcp", "-mcp", "a".repeat(33).as_str()] {
            assert!(safe_id(bad).is_err(), "a bad id was accepted: {bad:?}");
        }
        assert!(safe_id("mcp").is_ok());
        assert!(safe_id("print-farm2").is_ok());
    }
}
