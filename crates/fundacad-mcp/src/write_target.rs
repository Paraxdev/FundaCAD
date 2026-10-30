//! What a tool that writes a file is allowed to write over.

use std::io::Read;
use std::path::Path;

const SNIFF: u64 = 4096;

fn fits(path: &Path, exts: &[&str]) -> bool {
    path.extension().is_some_and(|e| exts.contains(&e.to_string_lossy().to_ascii_lowercase().as_str()))
}

/// None when `path`, and the file it leads to, both end in one of `exts` (any case), else the refusal.
pub fn extension_refusal(path: &Path, exts: &[&str], what: &str) -> Option<String> {
    let listed = exts.iter().map(|e| format!(".{e}")).collect::<Vec<_>>().join(" or ");
    if !fits(path, exts) {
        let ending = exts.first().map_or(String::new(), |e| format!(" Give a path ending in .{e}."));
        return Some(format!("{} is refused: {what} writes only {listed} files.{ending}", path.display()));
    }
    let target = crate::scope::canonical(path)?;
    if !fits(&target, exts) {
        return Some(format!(
            "{} is refused: it leads to {}, and {what} writes only {listed} files.",
            path.display(),
            target.display()
        ));
    }
    None
}

/// The app offers every .funda in its recovery folder back at launch, so only the app writes there.
pub fn recovery_refusal(path: &Path) -> Option<String> {
    let recovery = crate::scope::canonical(&crate::app_session::app_data_dir().join("recovery"))?;
    let target = crate::scope::canonical(path)?;
    crate::scope::within(&target, &recovery).then(|| {
        format!(
            "{} is refused: the app's recovery folder holds the snapshots FundaCAD writes itself. Save to a \
             folder of your own, such as one under Documents.",
            path.display()
        )
    })
}

/// The doc_save rules for a tool that writes a file of the kind `exts` names: not into the recovery folder,
/// only those extensions, into a folder that exists, and over another kind of file only with `overwrite`.
pub fn save_refusal(path: &Path, exts: &[&str], what: &str, overwrite: bool) -> Option<String> {
    if let Some(why) = recovery_refusal(path).or_else(|| extension_refusal(path, exts, what)) {
        return Some(why);
    }
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty() && !p.is_dir()) {
        return Some(format!("No such directory: {}", parent.display()));
    }
    if overwrite {
        return None;
    }
    overwrite_refusal(path, exts, what)
}

fn after_blanks(head: &[u8]) -> &[u8] {
    let head = head.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(head);
    let start = head.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(head.len());
    &head[start..]
}

fn first_line(text: &[u8]) -> &[u8] {
    let end = text.iter().position(|&b| b == b'\n').unwrap_or(text.len());
    text[..end].trim_ascii()
}

fn holds(head: &[u8], word: &[u8]) -> bool {
    head.windows(word.len()).any(|w| w.eq_ignore_ascii_case(word))
}

/// Whether a file of `len` bytes that starts with `head` already is the kind `exts` names, by its first extension.
pub fn looks_like(exts: &[&str], head: &[u8], len: u64) -> bool {
    let text = after_blanks(head);
    let zip = head.starts_with(b"PK\x03\x04");
    match exts.first().copied() {
        Some("funda") => {
            head.starts_with(b"FUNDACAD") || head.starts_with(b"FNDATAIL") || zip || text.starts_with(b"{")
        }
        Some("step") => text.starts_with(b"ISO-10303-21"),
        Some("stl") => {
            let count = head.get(80..84).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]));
            text.starts_with(b"solid") || count.is_some_and(|n| len == 84 + 50 * u64::from(n))
        }
        Some("3mf") => zip,
        Some("dxf") => head.starts_with(b"AutoCAD Binary DXF") || matches!(first_line(text), b"0" | b"999"),
        Some("svg") => holds(head, b"<svg"),
        _ => false,
    }
}

/// None when nothing but a folder or an empty file is at `path`, or a file that already is of the kind `exts`
/// names, else the refusal. A file that cannot be read is refused, since what it holds is unknown.
pub fn overwrite_refusal(path: &Path, exts: &[&str], what: &str) -> Option<String> {
    let meta = std::fs::metadata(path).ok().filter(|m| m.is_file() && m.len() > 0)?;
    let mut head = Vec::new();
    let read = std::fs::File::open(path).and_then(|f| f.take(SNIFF).read_to_end(&mut head));
    if read.is_ok() && looks_like(exts, &head, meta.len()) {
        return None;
    }
    let listed = exts.iter().map(|e| format!(".{e}")).collect::<Vec<_>>().join(" or ");
    Some(format!(
        "{} already holds a file that does not read as a {listed} file, so {what} leaves it alone. Pass \
         overwrite: true to replace it, or give another path.",
        path.display()
    ))
}
