//! The shipped languages and the person's own language files, `<config>/languages/<code>.json` or `<code>.json.txt` as
//! Notepad saves it, as FundaCAD 1's src/i18n/languages.ts and src-tauri/src/languages.rs. Each file is untrusted
//! text: the catalog checks every line, this side only guards the read.

use std::io::Read;
use std::path::Path;

pub const PSEUDO: &str = "pseudo";
pub const MAX_BYTES: u64 = 256 * 1024;
const MAX_FILES: usize = 100;

pub struct Language {
    pub code: &'static str,
    /// The name in that language, so a person who cannot read the current one still finds theirs.
    pub native: &'static str,
    /// "machine translated" in that language, None once a person has reviewed it.
    pub machine: Option<&'static str>,
    pub bcp47: &'static str,
    /// Whether System may pick it, set once the language covers the whole app.
    pub follows_system: bool,
}

pub const SHIPPED: &[Language] = &[
    Language { code: "en", native: "English", machine: None, bcp47: "en", follows_system: true },
    Language { code: "de", native: "Deutsch", machine: Some("maschinell übersetzt"), bcp47: "de", follows_system: false },
    Language {
        code: "fr",
        native: "Français",
        machine: Some("traduction automatique"),
        bcp47: "fr",
        follows_system: false,
    },
    Language {
        code: "es",
        native: "Español",
        machine: Some("traducción automática"),
        bcp47: "es",
        follows_system: false,
    },
    Language { code: "zh-CN", native: "简体中文", machine: Some("机器翻译"), bcp47: "zh-CN", follows_system: false },
    Language { code: "ja", native: "日本語", machine: Some("機械翻訳"), bcp47: "ja", follows_system: false },
];

/// en-XA is the reserved BCP 47 tag for pseudo locales.
pub const PSEUDO_LANGUAGE: Language =
    Language { code: PSEUDO, native: "Pseudo", machine: None, bcp47: "en-XA", follows_system: false };

pub fn shipped(code: &str) -> Option<&'static Language> {
    SHIPPED.iter().find(|l| l.code == code)
}

/// `^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$`: no separator or dot, so a code only ever names a file in
/// the folder. Windows opens a device for con, prn, aux and nul, so they are out.
pub fn is_language_code(code: &str) -> bool {
    if matches!(code, "con" | "prn" | "aux" | "nul") {
        return false;
    }
    let mut parts = code.split('-').map(str::as_bytes);
    let language = parts.next().is_some_and(|l| matches!(l.len(), 2 | 3) && l.iter().all(u8::is_ascii_lowercase));
    let script = |s: &[u8]| s.len() == 4 && s[0].is_ascii_uppercase() && s[1..].iter().all(u8::is_ascii_lowercase);
    let region = |r: &[u8]| match r.len() {
        2 => r.iter().all(u8::is_ascii_uppercase),
        3 => r.iter().all(u8::is_ascii_digit),
        _ => false,
    };
    let mut next = parts.next();
    if next.is_some_and(script) {
        next = parts.next();
    }
    if next.is_some_and(region) {
        next = parts.next();
    }
    language && next.is_none()
}

fn traditional(tag: &str) -> bool {
    tag.strip_prefix("zh-").is_some_and(|rest| {
        rest == "hant" || rest.starts_with("hant-") || matches!(rest, "tw" | "hk" | "mo")
    })
}

fn simplified(tag: &str) -> bool {
    tag == "zh"
        || tag.strip_prefix("zh-").is_some_and(|rest| {
            rest == "hans" || rest.starts_with("hans-") || matches!(rest, "cn" | "sg")
        })
}

/// The first OS language offered. A Traditional Chinese tag ends the search, so it never gets Simplified.
pub fn match_system_language(tags: &[String], offered: &[&str]) -> String {
    let lower: Vec<String> = offered.iter().map(|c| c.to_lowercase()).collect();
    let base_of = |c: &str| c.split('-').next().unwrap_or("").to_owned();
    for raw in tags {
        let tag = raw.to_lowercase();
        if let Some(i) = lower.iter().position(|c| *c == tag) {
            return offered[i].to_owned();
        }
        if traditional(&tag) {
            return lower.iter().position(|c| traditional(c)).map_or_else(|| "en".to_owned(), |i| offered[i].into());
        }
        if simplified(&tag) {
            if let Some(i) = lower.iter().position(|c| simplified(c)) {
                return offered[i].to_owned();
            }
            continue;
        }
        if tag.starts_with("zh-") {
            continue;
        }
        let base = base_of(&tag);
        if let Some(i) = lower.iter().position(|c| *c == base) {
            return offered[i].to_owned();
        }
        if let Some(i) = lower.iter().position(|c| base_of(c) == base) {
            return offered[i].to_owned();
        }
    }
    "en".to_owned()
}

/// `name` without one trailing `.txt` in any case, which Notepad adds on a plain save while Explorer hides it.
fn without_txt(name: &str) -> Option<&str> {
    let stem = name.len().checked_sub(4).filter(|&n| name.is_char_boundary(n))?;
    name[stem..].eq_ignore_ascii_case(".txt").then(|| &name[..stem])
}

/// The language a file in the folder is for: `pl` for `pl.json` and for `pl.json.txt`.
fn code_of(name: &str) -> Option<&str> {
    let code = without_txt(name).unwrap_or(name).strip_suffix(".json")?;
    is_language_code(code).then_some(code)
}

/// The codes of the language files in `dir`, sorted, at most 100. A `dir` that is a link reads as empty.
pub fn list(dir: &Path) -> Vec<String> {
    if !is_plain_dir(dir) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut codes: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|entry| code_of(entry.file_name().to_str()?).map(str::to_owned))
        .collect();
    codes.sort();
    codes.dedup();
    codes.truncate(MAX_FILES);
    codes
}

#[derive(Debug, PartialEq)]
pub enum ReadError {
    TooLarge,
    NotUtf8,
    Other(String),
}

/// The text of `<code>.json` in `dir`, else of `<code>.json.txt`, None when there is neither. The code is checked
/// before the disk is touched.
pub fn read(dir: &Path, code: &str) -> Result<Option<String>, ReadError> {
    if !is_language_code(code) {
        return Err(ReadError::Other(format!("not a language code: {code:?}")));
    }
    if !is_plain_dir(dir) {
        return Ok(None);
    }
    match read_file(dir, &format!("{code}.json"))? {
        Some(text) => Ok(Some(text)),
        None => saved_as_txt(dir, code).map_or(Ok(None), |name| read_file(dir, &name)),
    }
}

/// Found by listing, since a case sensitive disk may hold it as `.TXT`.
fn saved_as_txt(dir: &Path, code: &str) -> Option<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| without_txt(name).is_some() && code_of(name) == Some(code))
        .collect();
    names.sort();
    names.into_iter().next()
}

fn read_file(dir: &Path, name: &str) -> Result<Option<String>, ReadError> {
    let path = dir.join(name);
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if !meta.is_file() => return Err(ReadError::Other(format!("{name} is not a plain file"))),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(ReadError::Other(format!("{name}: {e}"))),
    }
    let file = open_no_link(&path).map_err(|e| ReadError::Other(format!("{name}: {e}")))?;
    let meta = file.metadata().map_err(|e| ReadError::Other(format!("{name}: {e}")))?;
    if !meta.is_file() {
        return Err(ReadError::Other(format!("{name} is not a plain file")));
    }
    if meta.len() > MAX_BYTES {
        return Err(ReadError::TooLarge);
    }
    let mut bytes = Vec::new();
    (&file).take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|e| ReadError::Other(format!("{name}: {e}")))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(ReadError::TooLarge);
    }
    String::from_utf8(bytes).map(Some).map_err(|_| ReadError::NotUtf8)
}

fn is_plain_dir(dir: &Path) -> bool {
    std::fs::symlink_metadata(dir).is_ok_and(|meta| meta.is_dir())
}

fn open_no_link(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    // FILE_FLAG_OPEN_REPARSE_POINT, so a link opens as itself and fails the plain file check.
    #[cfg(windows)]
    std::os::windows::fs::OpenOptionsExt::custom_flags(&mut options, 0x0020_0000);
    options.open(path)
}
