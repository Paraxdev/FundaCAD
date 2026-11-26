//! The problem report's text and its GitHub issue link, FundaCAD 1's src/ui/reportText.ts.

#[cfg(test)]
mod tests;

pub const REPO_URL: &str = "https://github.com/Paraxdev/fundacad";
/// GitHub refuses an issue body over 65,536 characters, and the body also holds the form's other boxes.
pub const REPORT_CAP: usize = 55_000;
/// Windows URL handlers have truncated near 2,048 characters.
pub const URL_CAP: usize = 2_000;
const TITLE_CHARS: usize = 70;
const URL_CUT_MARKER: &str = " \u{2026} (cut, the full text is in the pasted report)";
const LOG_HEADING: &str = "app log (the end, user names hidden):";
const LOG_CUT_HEADING: &str = "app log (the end, user names hidden, cut to fit):";
const REDACTED: &str = "[REDACTED]";

fn redact_after(text: &str, needle: &str, ends: impl Fn(char) -> bool) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while let Some(at) = lower[i..].find(needle) {
        let name = i + at + needle.len();
        out.push_str(&text[i..name]);
        let len = text[name..].find(&ends).unwrap_or(text.len() - name);
        if len > 0 {
            out.push_str(REDACTED);
        }
        i = name + len;
    }
    out.push_str(&text[i..]);
    out
}

/// The user name after `\Users\`, `/home/` and `/Users/`, as FundaCAD 1's redact_user_paths.
pub fn redact_user_paths(text: &str) -> String {
    let unix_end = |c: char| matches!(c, '/' | '\\' | '"' | '\'') || c.is_whitespace();
    let s = redact_after(text, r"\users\", |c| matches!(c, '/' | '\\' | '"' | '\'' | '\n' | '\r'));
    let s = redact_after(&s, "/home/", unix_end);
    redact_after(&s, "/users/", unix_end)
}

/// A home folder outside those, such as /root or D:\Profiles\name, shown as `~`.
pub fn redact_home(text: &str, home: &str) -> String {
    let home = home.trim_end_matches(['/', '\\']);
    if home.len() < 2 || home == "~" {
        return text.to_string();
    }
    let (lower, needle) = (text.to_ascii_lowercase(), home.to_ascii_lowercase());
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while let Some(at) = lower[i..].find(&needle) {
        let end = i + at + needle.len();
        let whole =
            text[end..].chars().next().is_none_or(|c| matches!(c, '/' | '\\' | '"' | '\'') || c.is_whitespace());
        out.push_str(&text[i..i + at]);
        out.push_str(if whole { "~" } else { &text[i + at..end] });
        i = end;
    }
    out.push_str(&text[i..]);
    out
}

/// Everything a report shows passes here: the user's home folder and any user name in a path.
pub fn redact(text: &str) -> String {
    let home = dirs::home_dir().map(|h| h.display().to_string()).unwrap_or_default();
    redact_user_paths(&redact_home(text, &home))
}

#[derive(Clone, Debug, Default)]
pub struct Input {
    pub version: String,
    pub system: String,
    pub description: String,
    pub document: Option<String>,
    pub crash: Option<String>,
    pub log: Option<String>,
}

#[derive(Debug, PartialEq)]
pub struct Report {
    pub text: String,
    pub log_cut: bool,
}

fn assemble(r: &Input, log: Option<(&str, &str)>) -> String {
    let mut lines = vec![
        "FundaCAD problem report (format 2)".to_string(),
        format!("version: {}", r.version),
        format!("system: {}", r.system),
    ];
    if let Some(doc) = &r.document {
        lines.push(format!("document: {doc}"));
    }
    lines.push(String::new());
    lines.push(r.description.trim_end().to_string());
    if let Some(crash) = &r.crash {
        lines.extend([String::new(), "crash on the last run:".into(), crash.trim_end().to_string()]);
    }
    if let Some((heading, text)) = log {
        lines.extend([String::new(), heading.to_string(), text.to_string()]);
    }
    lines.join("\n")
}

/// The end of `log` within `room` bytes, from a line start; None when not even its last line fits.
fn log_end(log: &str, room: usize) -> Option<&str> {
    if room >= log.len() {
        return Some(log);
    }
    let mut from = log.len() - room;
    while !log.is_char_boundary(from) {
        from += 1;
    }
    if log.as_bytes()[from - 1] == b'\n' {
        return Some(&log[from..]);
    }
    let nl = log[from..].find('\n')?;
    Some(&log[from + nl + 1..])
}

/// The log is cut from its start to fit the cap, since its end is what matters.
pub fn build(r: &Input, cap: usize) -> Report {
    let log = r.log.as_deref().map(str::trim_end).filter(|l| !l.is_empty());
    let whole = assemble(r, log.map(|l| (LOG_HEADING, l)));
    let Some(log) = log else { return Report { text: whole, log_cut: false } };
    if whole.len() <= cap {
        return Report { text: whole, log_cut: false };
    }
    let overhead = assemble(r, Some((LOG_CUT_HEADING, ""))).len();
    match log_end(log, cap.saturating_sub(overhead)) {
        Some(kept) => Report { text: assemble(r, Some((LOG_CUT_HEADING, kept))), log_cut: true },
        None => Report { text: assemble(r, None), log_cut: true },
    }
}

/// JavaScript's encodeURIComponent.
pub fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn cut_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

pub fn issue_title(description: &str) -> String {
    let first = description.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    format!("Problem: {}", cut_chars(first.trim(), TITLE_CHARS))
}

pub struct Fields<'a> {
    pub description: &'a str,
    pub version: &'a str,
    pub system: &'a str,
    pub report: &'a str,
}

#[derive(Debug, PartialEq)]
pub struct IssueLink {
    pub url: String,
    /// The report is in the link's Report box; false means it has to be pasted there.
    pub report_in: bool,
}

/// The bug.yml form with its boxes filled. The description is cut to fit the cap, the report goes in only whole.
pub fn issue_url(f: &Fields) -> IssueLink {
    let q = |name: &str, value: &str| format!("&{name}={}", encode(value));
    let head = format!("{REPO_URL}/issues/new?template=bug.yml")
        + &q("title", &issue_title(f.description))
        + &q("version", f.version)
        + &q("os", f.system);
    let what = q("what", f.description);
    let report = q("report", f.report);
    if head.len() + what.len() + report.len() <= URL_CAP {
        return IssueLink { url: head + &what + &report, report_in: true };
    }
    if head.len() + what.len() <= URL_CAP {
        return IssueLink { url: head + &what, report_in: false };
    }
    let room = URL_CAP - head.len() - "&what=".len();
    let chars: Vec<char> = f.description.chars().collect();
    let (mut lo, mut hi) = (0, chars.len());
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        let s: String = chars[..mid].iter().collect::<String>() + URL_CUT_MARKER;
        if encode(&s).len() <= room {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let cut: String = chars[..lo].iter().collect::<String>() + URL_CUT_MARKER;
    IssueLink { url: head + &q("what", &cut), report_in: false }
}

pub fn system_line() -> String {
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}
