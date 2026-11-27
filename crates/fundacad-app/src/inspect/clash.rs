//! Interference, FundaCAD 1's InterferencePanel and interferenceRows.ts: the `interference` reply as rows, a clash
//! per overlapping pair, a close pair per clearance, and the bodies that could not be checked.

use serde_json::{Map, Value};

use super::spell;
use crate::i18n::{t, tr};

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq)]
pub struct Clash {
    pub a: String,
    pub b: String,
    /// "Box and Lid".
    pub pair: String,
    /// "12.5 mm³ overlap" or "0.15 mm apart".
    pub detail: String,
    pub close: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Report {
    pub rows: Vec<Clash>,
    /// "Name: why".
    pub unchecked: Vec<String>,
    pub note: Option<String>,
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn row(v: &Value, detail: String, close: bool) -> Clash {
    let name = |n: &str, id: &str| if s(v, n).is_empty() { s(v, id).to_string() } else { s(v, n).to_string() };
    Clash {
        a: s(v, "a").into(),
        b: s(v, "b").into(),
        pair: tr!("interference.pair", a = name("aName", "a"), b = name("bName", "b")),
        detail,
        close,
    }
}

pub fn read(reply: &Map<String, Value>) -> Report {
    let list = |k: &str| reply.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    let num = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let mut rows: Vec<Clash> =
        list("pairs").iter().map(|p| row(p, tr!("interference.overlap", volume = format!("{} mm³", spell(num(p, "volume")))), false)).collect();
    rows.extend(list("clearances").iter().map(|p| row(p, tr!("interference.apart", distance = format!("{} mm", spell(num(p, "distance")))), true)));
    let unchecked = list("unchecked")
        .iter()
        .map(|u| {
            let name = if s(u, "name").is_empty() { s(u, "id") } else { s(u, "name") };
            format!("{name}: {}", s(u, "reason"))
        })
        .collect();
    let note = reply.get("message").and_then(Value::as_str).map(str::to_string);
    Report { rows, unchecked, note }
}

/// The line under the title: "No clashes", or the counts.
pub fn summary(r: &Report) -> String {
    let clashes = r.rows.iter().filter(|c| !c.close).count();
    let close = r.rows.len() - clashes;
    let mut parts = vec![tr!("inspect.clash.count", n = clashes)];
    if close > 0 {
        parts.push(tr!("inspect.clash.close", n = close));
    }
    if !r.unchecked.is_empty() {
        parts.push(tr!("inspect.clash.unchecked", n = r.unchecked.len()));
    }
    parts.join(", ")
}

/// The lines under the rows: in clearance mode with no close pair, how close was looked for, then the hint.
pub fn footer(r: &Report, gap: Option<f64>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(g) = gap.filter(|_| !r.rows.iter().any(|c| c.close)) {
        out.push(tr!("interference.noneCloser", amount = crate::inspect::spell(g)));
    }
    out.push(t(if r.rows.is_empty() { "interference.hintClose" } else { "inspect.clash.hintRows" }));
    out
}
