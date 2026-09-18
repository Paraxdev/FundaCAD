//! File stems for a separate-bodies export, replaces `_safe_part_filename` of
//! the Python engine's `server.py`.

const MAX_NAME_BYTES: usize = 200;

fn reserved(stem: &str) -> bool {
    let s = stem.to_lowercase();
    matches!(s.as_str(), "con" | "prn" | "aux" | "nul")
        || ((s.starts_with("com") || s.starts_with("lpt"))
            && s.len() == 4
            && matches!(s.as_bytes()[3], b'1'..=b'9'))
}

fn word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

pub fn safe_part_filename(label: &str, fallback: &str) -> String {
    let mut name = String::new();
    let mut in_run = false;
    for c in label.chars() {
        if word(c) || c == '.' || c == '-' {
            name.push(c);
            in_run = false;
        } else if !in_run {
            name.push('_');
            in_run = true;
        }
    }
    let mut name = name.trim_matches('_').to_string();
    if name.is_empty() || name.chars().all(|c| c == '.') {
        name = fallback.to_string();
    }
    while name.len() > MAX_NAME_BYTES && name.chars().count() > 1 {
        name.pop();
    }
    let mut name = name.trim_end_matches(['_', '.']).to_string();
    if name.is_empty() {
        name = fallback.to_string();
    }
    if reserved(name.split('.').next().unwrap_or("")) {
        name.push('_');
    }
    name
}
