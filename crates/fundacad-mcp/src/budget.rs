//! Long replies on a token budget: rows that read the same once their ids are set aside fold into one, and a
//! long list shows one page of itself with the line that asks for the rest. Every row stays reachable.

use serde_json::{Map, Value};

/// A list longer than this folds its alike rows; a short one reads as it always did.
pub const FOLD_FROM: usize = 10;

/// The rows a list of bodies shows before it asks for `offset` or `limit`.
pub const ROWS: usize = 30;

/// The bodies `inspect` lists every face and edge of before it asks for the next page.
pub const DETAIL_BODIES: usize = 5;

/// Which rows of a long list a reply shows. `limit` 0 shows every row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Page {
    pub offset: usize,
    pub limit: usize,
}

impl Page {
    pub fn all() -> Page {
        Page { offset: 0, limit: 0 }
    }

    /// `limit` and `offset` from a tool's arguments, `default` rows when no limit is given.
    pub fn of(args: &Map<String, Value>, default: usize) -> Result<Page, String> {
        let count = |k: &str| -> Result<Option<usize>, String> {
            match args.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(v) => v
                    .as_f64()
                    .filter(|n| *n >= 0.0 && n.fract() == 0.0)
                    .map(|n| Some(n as usize))
                    .ok_or_else(|| format!("`{k}` is a whole number, 0 or more, got {v}")),
            }
        };
        Ok(Page { offset: count("offset")?.unwrap_or(0), limit: count("limit")?.unwrap_or(default) })
    }

    /// The rows this page shows, and the line saying what it left out and how to ask for it.
    pub fn cut<T>(&self, rows: Vec<T>, noun: &str) -> (Vec<T>, Option<String>) {
        self.cut_asking(rows, noun, "")
    }

    /// As `cut`, with `ask` put before the offset the more line asks for, as "full true and ".
    pub fn cut_asking<T>(&self, mut rows: Vec<T>, noun: &str, ask: &str) -> (Vec<T>, Option<String>) {
        let total = rows.len();
        if total == 0 {
            return (rows, None);
        }
        if self.offset >= total {
            return (Vec::new(), Some(format!("no {noun} from offset {}: there are {total}", self.offset)));
        }
        let end = if self.limit == 0 { total } else { total.min(self.offset + self.limit) };
        if self.offset == 0 && end == total {
            return (rows, None);
        }
        rows.truncate(end);
        let shown = rows.split_off(self.offset.min(rows.len()));
        let mut line = format!("showing {noun} {} to {end} of {total}", self.offset + 1);
        if end < total {
            line.push_str(&format!(": pass {ask}offset {end} for the next {}, or {ask}limit 0 for all", self.limit));
        }
        (shown, Some(line))
    }
}

/// One row of a list: `same` is what has to match for two rows to fold, the row less its id and name.
#[derive(Clone, Debug)]
pub struct Row {
    pub id: String,
    pub name: String,
    pub same: String,
    pub text: String,
}

impl Row {
    /// A row whose text starts with its id and quoted name, as `body4 "Pin 2": 2 x 2 x 2 mm`.
    pub fn of_line(id: String, name: String, text: String) -> Row {
        let head = format!("{id} \"{name}\"");
        let same = text.strip_prefix(&head).or_else(|| text.strip_prefix(&id)).unwrap_or(&text).to_string();
        Row { id, name, same, text }
    }
}

/// Ids in the order a person counts them: body2 before body10.
pub fn natural(a: &str, b: &str) -> std::cmp::Ordering {
    match (numbered(a), numbered(b)) {
        (Some((ha, na)), Some((hb, nb))) if ha == hb => na.cmp(&nb),
        _ => a.cmp(b),
    }
}

/// A name with its trailing copy number taken off: "Pin 12" and "Pin" are the same part.
pub fn stem(name: &str) -> &str {
    let trimmed = name.trim_end_matches(|c: char| c.is_ascii_digit());
    if trimmed.len() < name.len() && trimmed.ends_with(' ') {
        trimmed.trim_end()
    } else {
        name
    }
}

/// Rows alike in everything but their ids, and their names' copy numbers, become the first of them with
/// the others' ids appended. Order is kept, by each group's first row. Lists of FOLD_FROM rows or fewer
/// come back as they were.
pub fn fold(rows: Vec<Row>) -> Vec<String> {
    fold_capped(rows, usize::MAX, "")
}

/// As `fold`, each row's ids cut to `cap` characters, ending in " and K more, " then `more`.
pub fn fold_capped(rows: Vec<Row>, cap: usize, more: &str) -> Vec<String> {
    if rows.len() <= FOLD_FROM {
        return rows.into_iter().map(|r| r.text).collect();
    }
    let mut groups: Vec<(Row, Vec<Row>)> = Vec::new();
    let mut at: std::collections::HashMap<(String, String), usize> = std::collections::HashMap::new();
    for r in rows {
        let key = (r.same.clone(), stem(&r.name).to_string());
        match at.get(&key) {
            Some(&i) => groups[i].1.push(r),
            None => {
                at.insert(key, groups.len());
                groups.push((r, Vec::new()));
            }
        }
    }
    groups.into_iter().map(|(first, rest)| folded(first, &rest, cap, more)).collect()
}

fn folded(first: Row, rest: &[Row], cap: usize, more: &str) -> String {
    if rest.is_empty() {
        return first.text;
    }
    let ids: Vec<&str> = rest.iter().map(|r| r.id.as_str()).collect();
    let (said, left) = ranges_capped(&ids, false, cap);
    let mut tail = format!(" (and {} more alike: {said}", rest.len());
    if left > 0 {
        tail.push_str(&format!(" and {left} more, {more}"));
    }
    let names: Vec<&str> = rest.iter().map(|r| r.name.as_str()).filter(|n| !n.is_empty()).collect();
    if names.iter().any(|n| *n != first.name) {
        let said = ranges(&names, true);
        if said.len() <= 160 {
            tail.push_str(&format!(", named {said}"));
        }
    }
    tail.push(')');
    match first.text.split_once('\n') {
        Some((head, more)) => format!("{head}{tail}\n{more}"),
        None => format!("{}{tail}", first.text),
    }
}

/// The files a separate export wrote, as "  Pin_2.stl (684 bytes)" lines. With `fold` a list over FOLD_FROM
/// files puts the files of one name, less its copy number, extension and size on one line, ids capped.
pub fn files(written: &[(String, u64)], fold: bool) -> Vec<String> {
    let rows: Vec<Row> = written
        .iter()
        .map(|(name, size)| {
            let (stem, ext) = match name.rfind('.').filter(|&dot| dot > 0) {
                Some(dot) => name.split_at(dot),
                None => (name.as_str(), ""),
            };
            let bare = stem.trim_end_matches(|c: char| c.is_ascii_digit());
            let base = if bare.len() < stem.len() { bare.strip_suffix(['_', ' ']).unwrap_or(bare) } else { stem };
            Row {
                id: stem.to_string(),
                name: String::new(),
                same: format!("{base}\u{0}{ext}\u{0}{size}"),
                text: format!("  {name} ({size} bytes)"),
            }
        })
        .collect();
    if fold {
        fold_capped(rows, 240, "full true lists every file")
    } else {
        rows.into_iter().map(|r| r.text).collect()
    }
}

pub(crate) fn numbered(s: &str) -> Option<(&str, u64)> {
    let digits = s.len() - s.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 || digits > 18 {
        return None;
    }
    let (head, n) = s.split_at(s.len() - digits);
    Some((head, n.parse().ok()?))
}

/// "body4, body5, body6, body9" as "body4..body6, body9": runs of one prefix with consecutive numbers.
pub fn ranges(items: &[&str], quote: bool) -> String {
    let q = |s: &str| if quote { format!("\"{s}\"") } else { s.to_string() };
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < items.len() {
        let mut j = i;
        if let Some((head, n)) = numbered(items[i]) {
            while j + 1 < items.len() && numbered(items[j + 1]) == Some((head, n + (j + 1 - i) as u64)) {
                j += 1;
            }
        }
        while j == i && i + 1 < items.len() && items[i + 1] == items[i] {
            i += 1;
            j = i;
        }
        out.push(match j - i {
            0 => q(items[i]),
            1 => format!("{}, {}", q(items[i]), q(items[j])),
            _ => format!("{}..{}", q(items[i]), q(items[j])),
        });
        i = j + 1;
    }
    out.join(", ")
}

/// As `ranges`, cut to the most items whose ranges fit in `cap` characters, and how many were left out.
pub fn ranges_capped(items: &[&str], quote: bool, cap: usize) -> (String, usize) {
    let all = ranges(items, quote);
    if all.len() <= cap {
        return (all, 0);
    }
    let (mut lo, mut hi) = (1, items.len());
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if ranges(&items[..mid], quote).len() <= cap {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    (ranges(&items[..lo], quote), items.len() - lo)
}

/// Every float in a selector rounded to a millionth, far finer than any fingerprint the matcher compares, so
/// float noise such as 4.44e-16 or 2.9999999999999996 is no longer spelt out. A float stays a float: a client
/// comparing JSON values strictly still finds 1.0 where it found 1.0.
pub fn rounded(v: &Value) -> Value {
    match v {
        Value::Number(n) if !n.is_i64() && !n.is_u64() => {
            let r = (n.as_f64().unwrap_or(0.0) * 1e6).round() / 1e6;
            serde_json::Number::from_f64(if r == 0.0 { 0.0 } else { r }).map_or(Value::Null, Value::Number)
        }
        Value::Array(a) => Value::Array(a.iter().map(rounded).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), rounded(v))).collect()),
        other => other.clone(),
    }
}

/// `{body: {faces: {F0: selector}, edges: {E0: selector}}}` as JSON with one selector to a line, its numbers
/// rounded, where pretty printing put every number of a fingerprint on a line of its own.
pub fn selector_json(sel: &Map<String, Value>) -> String {
    let key = |k: &str| Value::String(k.to_string()).to_string();
    let block = |entries: Vec<String>, pad: &str| {
        if entries.is_empty() {
            "{}".to_string()
        } else {
            format!("{{\n{pad} {}\n{pad}}}", entries.join(&format!(",\n{pad} ")))
        }
    };
    let bodies = sel.iter().map(|(body, groups)| {
        let groups = groups.as_object().cloned().unwrap_or_default();
        let groups = groups.iter().map(|(group, items)| {
            let items = items.as_object().cloned().unwrap_or_default();
            let items = items.iter().map(|(name, item)| format!("{}: {}", key(name), rounded(item))).collect();
            format!("{}: {}", key(group), block(items, "  "))
        });
        format!("{}: {}", key(body), block(groups.collect(), " "))
    });
    block(bodies.collect(), "")
}
