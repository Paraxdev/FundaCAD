//! A dropped in language file, checked line by line as FundaCAD 1's src/i18n/overrides.ts. Anyone can hand one to a
//! person, so markup, control characters and arguments the English line does not have are refused.

use std::collections::{BTreeSet, HashMap};

use serde_json::Value;

use super::format::{arg_names, parse, Node};
use super::languages::MAX_BYTES;

pub const MAX_LINE_CHARS: usize = 2000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkipReason {
    UnknownKey,
    NotText,
    TooLong,
    Markup,
    ControlCharacter,
    Empty,
    Syntax,
    BadArgument,
    /// A line that tells the person about their own file, which that file cannot rewrite.
    Locked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileError {
    TooLarge,
    NotJson { line: usize, column: usize },
    NotFlat,
    NotUtf8,
    NotRead,
}

#[derive(Clone, Debug, Default)]
pub struct Overrides {
    pub lines: HashMap<String, String>,
    pub skipped: Vec<(String, SkipReason)>,
    pub error: Option<FileError>,
}

fn locked(key: &str) -> bool {
    let Some(rest) = key.strip_prefix("prefs.language.") else { return false };
    matches!(
        rest,
        "system" | "systemYours" | "yours" | "machineYours" | "inUse" | "skipped" | "skip" | "more" | "remove" | "safeMode"
    ) || rest.strip_prefix("error.").is_some_and(|e| !e.is_empty())
}

/// `<[A-Za-z/!?]` or an entity such as `&amp;`, `&#38;` or `&#x26;`.
fn has_markup(s: &str) -> bool {
    let b = s.as_bytes();
    (0..b.len()).any(|i| match b[i] {
        b'<' => b.get(i + 1).is_some_and(|c| c.is_ascii_alphabetic() || matches!(c, b'/' | b'!' | b'?')),
        b'&' => entity_at(&b[i + 1..]),
        _ => false,
    })
}

fn entity_at(rest: &[u8]) -> bool {
    let (body, ok): (&[u8], fn(&u8) -> bool) = match rest {
        [b'#', b'x' | b'X', tail @ ..] => (tail, u8::is_ascii_hexdigit),
        [b'#', tail @ ..] => (tail, u8::is_ascii_digit),
        tail => (tail, u8::is_ascii_alphabetic),
    };
    let n = body.iter().take_while(|c| ok(c)).count();
    n > 0 && body.get(n) == Some(&b';')
}

/// A text part that something follows may not end in `<` or in an entity it has not closed, or a tag could be split
/// across parts.
fn open_end(s: &str) -> bool {
    let trimmed = s.trim_end_matches(|c: char| c.is_ascii_alphanumeric() || c == '#');
    s.ends_with('<') || trimmed.ends_with('&')
}

/// C0 and C1 controls, line and paragraph separators, a BOM or annotation inside text, tag characters, and the bidi
/// overrides and isolates. LRM, RLM, ZWJ and ZWNJ stay, RTL text needs them.
fn is_control(c: char) -> bool {
    matches!(c,
        '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}' | '\u{feff}' | '\u{fff9}'..='\u{fffb}' | '\u{e0000}'..='\u{e007f}')
}

fn blank(s: &str) -> bool {
    s.chars().all(|c| c.is_whitespace() || matches!(c, '\u{200b}'..='\u{200f}' | '\u{2060}'))
}

fn builds_markup(nodes: &[Node], followed: bool) -> bool {
    nodes.iter().enumerate().any(|(i, node)| {
        let next = followed || i + 1 < nodes.len();
        match node {
            Node::Text(v) => has_markup(v) || (next && open_end(v)),
            Node::Plural { options, .. } | Node::Select { options, .. } => {
                options.iter().any(|(_, o)| builds_markup(o, next))
            }
            _ => false,
        }
    })
}

fn names(nodes: &[Node]) -> BTreeSet<String> {
    let mut set = BTreeSet::new();
    arg_names(nodes, &mut set);
    set
}

pub fn check_line(value: &str, english: Option<&str>) -> Option<SkipReason> {
    if value.encode_utf16().count() > MAX_LINE_CHARS {
        return Some(SkipReason::TooLong);
    }
    if has_markup(value) {
        return Some(SkipReason::Markup);
    }
    if value.chars().any(is_control) {
        return Some(SkipReason::ControlCharacter);
    }
    if blank(value) {
        return Some(SkipReason::Empty);
    }
    let Ok(nodes) = parse(value) else { return Some(SkipReason::Syntax) };
    if builds_markup(&nodes, false) {
        return Some(SkipReason::Markup);
    }
    let english = english?;
    let Ok(base) = parse(english) else { return Some(SkipReason::Syntax) };
    let allowed = names(&base);
    names(&nodes).iter().any(|n| !allowed.contains(n)).then_some(SkipReason::BadArgument)
}

pub fn parse_overrides(text: &str, english: &HashMap<String, String>) -> Overrides {
    let mut out = Overrides::default();
    // Measured before the BOM goes, so the limit matches the bytes on disk.
    if text.len() as u64 > MAX_BYTES {
        out.error = Some(FileError::TooLarge);
        return out;
    }
    let body = text.strip_prefix('\u{feff}').unwrap_or(text);
    let data: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => {
            out.error = Some(FileError::NotJson { line: e.line(), column: e.column() });
            return out;
        }
    };
    let Value::Object(entries) = data else {
        out.error = Some(FileError::NotFlat);
        return out;
    };
    if entries.values().any(|v| v.is_object() || v.is_array()) {
        out.error = Some(FileError::NotFlat);
        return out;
    }
    for (key, value) in entries {
        let reason = match (english.get(&key), &value) {
            (None, _) => Some(SkipReason::UnknownKey),
            (Some(_), _) if locked(&key) => Some(SkipReason::Locked),
            (Some(_), v) if !v.is_string() => Some(SkipReason::NotText),
            (Some(base), Value::String(v)) => check_line(v, Some(base)),
            _ => Some(SkipReason::NotText),
        };
        match (reason, value) {
            (Some(r), _) => out.skipped.push((key, r)),
            (None, Value::String(v)) => {
                out.lines.insert(key, v);
            }
            (None, _) => {}
        }
    }
    out
}
