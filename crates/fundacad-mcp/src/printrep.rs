//! `printability` on a token budget. The engine writes a block per body; over FOLD_FROM blocks the reply
//! counts its findings first, folds bodies whose findings read the same but for ids and where they sit,
//! and shows one page of the blocks. A short report reads as the engine wrote it.

use std::collections::HashMap;

use serde_json::Value;

use crate::budget::{self, Page, Row};

/// The characters of ids a folded row lists before it says how many more it stands for.
const IDS: usize = 240;

const KINDS: [(&str, &str, &str); 8] = [
    ("overhang", "overhang", "overhangs"),
    ("bridge", "long bridge", "long bridges"),
    ("wall", "thin wall", "thin walls"),
    ("floor", "thin floor", "thin floors"),
    ("gap", "narrow gap", "narrow gaps"),
    ("meshHole", "mesh hole", "mesh holes"),
    ("flatTriangle", "flat triangle", "flat triangles"),
    ("fused", "fused pair", "fused pairs"),
];

const CLEAN: &str = ": nothing found";

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn list<'a>(r: &'a Value, k: &str) -> &'a [Value] {
    r.get(k).and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default()
}

fn counted(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn who(id: &str, name: &str) -> String {
    if name.is_empty() || name == id {
        id.to_string()
    } else {
        format!("{id} \"{name}\"")
    }
}

/// Every `focus {at: [x, y, z], size: S}` as `focus {size: S}`, so bodies alike but for where they sit match.
pub fn unplaced(text: &str) -> String {
    const AT: &str = "focus {at: [";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(AT) {
        let after = &rest[i + AT.len()..];
        let Some(j) = after.find("], ") else { break };
        out.push_str(&rest[..i + "focus {".len()]);
        rest = &after[j + 3..];
    }
    out.push_str(rest);
    out
}

/// The engine's report cut into the lines above the bodies, a row per body block, and the lines after.
fn blocks(report: &str, bodies: &[Value]) -> (Vec<String>, Vec<Row>, Vec<String>) {
    let names: HashMap<&str, &str> = bodies.iter().map(|b| (s(b, "id"), s(b, "name"))).collect();
    let body_head = |line: &str| -> Option<(String, String, usize)> {
        if line.starts_with(' ') {
            return None;
        }
        let id = line.split([' ', ':']).next()?;
        let name = names.get(id)?;
        let w = who(id, name);
        line.strip_prefix(&w).filter(|rest| rest.starts_with(": ")).map(|_| (id.to_string(), name.to_string(), w.len()))
    };
    let (mut head, mut rows, mut tail) = (Vec::new(), Vec::new(), Vec::new());
    let mut open: Option<(String, String, usize, Vec<&str>)> = None;
    let close = |open: &mut Option<(String, String, usize, Vec<&str>)>, rows: &mut Vec<Row>| {
        if let Some((id, name, at, lines)) = open.take() {
            let text = lines.join("\n");
            rows.push(Row { id, name, same: unplaced(&text[at..]), text });
        }
    };
    for line in report.lines() {
        if !tail.is_empty() {
            tail.push(line.to_string());
            continue;
        }
        if let Some(b) = open.as_mut().filter(|_| line.starts_with("  ")) {
            b.3.push(line);
            continue;
        }
        if let Some((id, name, at)) = body_head(line) {
            close(&mut open, &mut rows);
            open = Some((id, name, at, vec![line]));
        } else if rows.is_empty() && open.is_none() {
            head.push(line.to_string());
        } else {
            close(&mut open, &mut rows);
            tail.push(line.to_string());
        }
    }
    close(&mut open, &mut rows);
    (head, rows, tail)
}

/// "3001 of 3002 bodies have findings: 3001 overhangs, 2 open shells", from the findings the engine
/// returns beside its report, so it counts what the per body caps leave out.
fn summary(r: &Value, flagged: usize, topology: bool, full: bool) -> String {
    let findings = list(r, "findings");
    let bodies = list(r, "bodies");
    let mut counts: Vec<String> = KINDS
        .iter()
        .filter_map(|(kind, one, many)| {
            let n = findings.iter().filter(|f| s(f, "kind") == *kind).count();
            (n > 0).then(|| counted(n, one, many))
        })
        .collect();
    if topology {
        let num = |b: &Value, k: &str| b.get(k).and_then(Value::as_i64).unwrap_or(0);
        let open = bodies.iter().filter(|b| num(b, "openEdges") > 0).count();
        let unsound =
            bodies.iter().filter(|b| num(b, "openEdges") == 0 && b.get("fault").is_some_and(|f| !f.is_null())).count();
        let pieces = bodies.iter().filter(|b| num(b, "solids") > 1).count();
        let inside_out = bodies.iter().filter(|b| b.get("insideOut") == Some(&Value::Bool(true))).count();
        for (n, one, many) in [
            (open, "open shell", "open shells"),
            (unsound, "unsound solid", "unsound solids"),
            (pieces, "body in pieces", "bodies in pieces"),
            (inside_out, "body inside out", "bodies inside out"),
        ] {
            if n > 0 {
                counts.push(counted(n, one, many));
            }
        }
    }
    let alike =
        if full { "" } else { "; alike bodies in one row with the first one's focus, bodies [id] shows one alone" };
    format!("{flagged} of {} bodies have findings: {}{alike}", bodies.len(), counts.join(", "))
}

/// The reply for an engine `printability` result. `topology` is whether the open check ran, `full` lists
/// every body block on its own.
pub fn condensed(r: &Value, page: Page, full: bool, topology: bool) -> String {
    let report = s(r, "report");
    let (head, rows, tail) = blocks(report, list(r, "bodies"));
    if rows.is_empty() {
        return report.to_string();
    }
    let mut out = head;
    if rows.len() > budget::FOLD_FROM {
        let flagged = rows.iter().filter(|r| r.same != CLEAN).count();
        out.push(summary(r, flagged, topology, full));
    }
    let rows = if full {
        rows.into_iter().map(|r| r.text).collect()
    } else {
        budget::fold_capped(rows, IDS, "full true lists every body")
    };
    let (shown, more) = page.cut(rows, "body rows");
    out.extend(shown);
    out.extend(more);
    out.extend(tail);
    out.join("\n")
}
