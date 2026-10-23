//! An `inspect` report as a summary an agent can afford, since the whole reply is a few hundred
//! kilobytes of exact numbers. Every line here is derived, the engine does the measuring.

use serde_json::Value;

/// Python's `f"{round(x, places):g}"`: the shorter of fixed and exponential, no trailing zeros.
pub fn fmt(x: Option<&Value>, places: i32) -> String {
    match x {
        None | Some(Value::Null) => "?".into(),
        Some(Value::Array(items)) => items.iter().map(|v| fmt(Some(v), places)).collect::<Vec<_>>().join(", "),
        Some(v) => match v.as_f64() {
            None => "?".into(),
            Some(f) => g_format(round_half_even(f, places)),
        },
    }
}

/// Python's `round()`: halves go to the even neighbour, so 2.5 is 2.
fn round_half_even(x: f64, places: i32) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let scale = 10f64.powi(places);
    let scaled = x * scale;
    let rounded = scaled.round();
    let out = if (scaled - scaled.trunc()).abs() == 0.5 && rounded % 2.0 != 0.0 {
        rounded - scaled.signum()
    } else {
        rounded
    };
    out / scale
}

pub use fundacad_protocol::pyjson::g_format;

fn s(v: &Value, key: &str) -> String {
    match v.get(key) {
        Some(Value::String(t)) => t.clone(),
        None | Some(Value::Null) => "None".into(),
        Some(other) => other.to_string(),
    }
}

fn list_of<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(Value::as_array).map_or(&[][..], Vec::as_slice)
}

fn index(v: &Value) -> i64 {
    v.get("i").and_then(Value::as_i64).unwrap_or(0)
}

/// {surface type: count}, biggest first: "6 plane" is a box, and a bspline means a loft or an import.
pub fn surface_census(body: &Value) -> Vec<(String, usize)> {
    if let Some(Value::Array(rows)) = body.get("surfaces") {
        return rows
            .iter()
            .filter_map(|r| Some((r.get(0)?.as_str()?.to_string(), r.get(1)?.as_u64()? as usize)))
            .collect();
    }
    let mut counts: Vec<(String, usize)> = Vec::new();
    for f in list_of(body, "faces") {
        let name = match f.get("surface") {
            Some(Value::String(t)) => t.clone(),
            _ => "?".into(),
        };
        match counts.iter_mut().find(|(k, _)| *k == name) {
            Some((_, n)) => *n += 1,
            None => counts.push((name, 1)),
        }
    }
    counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    counts
}

pub fn body_line(body: &Value) -> String {
    let id = s(body, "id");
    if body.get("empty").and_then(Value::as_bool).unwrap_or(false) {
        return format!("{id} ({}): did not build", s(body, "name"));
    }
    let mut bits = vec![format!("{id} \"{}\"", s(body, "name"))];
    let bbox = body.get("bbox").cloned().unwrap_or(Value::Null);
    if let Some(size) = bbox.get("size").and_then(Value::as_array) {
        bits.push(format!("{} x {} x {} mm", fmt(size.first(), 3), fmt(size.get(1), 3), fmt(size.get(2), 3)));
    }
    if body.get("volume").is_some_and(|v| !v.is_null()) {
        bits.push(format!("vol {} mm3", fmt(body.get("volume"), 1)));
    }
    bits.push(format!("{} faces, {} edges", s(body, "faceCount"), s(body, "edgeCount")));
    let solids = body.get("solidCount").and_then(Value::as_i64).unwrap_or(1);
    if solids > 1 {
        bits.push(format!("{solids} disjoint solids"));
    }
    let census = surface_census(body);
    if !census.is_empty() {
        bits.push(census.iter().map(|(k, n)| format!("{n} {k}")).collect::<Vec<_>>().join(", "));
    }
    bits.join(" | ")
}

fn few(items: &[i64], prefix: char) -> String {
    let shown: Vec<String> = items.iter().take(6).map(|i| format!("{prefix}{i}")).collect();
    format!("{}{}", shown.join(", "), if items.len() > 6 { "..." } else { "" })
}

/// What will bite a LATER feature: not errors, each is a valid solid and a refusal waiting to happen.
pub fn warnings_for(body: &Value) -> Vec<String> {
    let mut out = Vec::new();
    // A summary carries each flag as a list of indices, a detailed report
    // as a key on each face or edge.
    let flagged = |key: &str, list: &str, summary: &str| -> Vec<i64> {
        if let Some(Value::Array(ix)) = body.get(summary) {
            return ix.iter().filter_map(Value::as_i64).collect();
        }
        list_of(body, list).iter().filter(|e| e.get(key).and_then(Value::as_bool).unwrap_or(false)).map(index).collect()
    };
    let seams = flagged("seam", "edges", "seams");
    if !seams.is_empty() {
        out.push(format!(
            "{} seam edge(s) ({}), a fillet or chamfer on one of these will be refused: both \
             sides are the same face",
            seams.len(),
            few(&seams, 'E')
        ));
    }
    let wrapping = flagged("wraps", "faces", "wraps");
    if !wrapping.is_empty() {
        out.push(format!(
            "{} face(s) wrap all the way round ({}), press/pull thickens these along the \
             surface rather than pushing them in a direction",
            wrapping.len(),
            few(&wrapping, 'F')
        ));
    }
    let open = flagged("openBoundary", "edges", "openEdges");
    if !open.is_empty() {
        out.push(format!("{} edge(s) bound only ONE face, this body is a surface, not a closed solid", open.len()));
    }
    // An open body has its line above.
    if let Some(why) = body.get("fault").and_then(Value::as_str).filter(|_| open.is_empty()) {
        out.push(format!(
            "this body {why}: it has no volume to give, and a cut, a join, an interference or a stress check of it cannot be trusted"
        ));
    } else if body.get("insideOut").and_then(Value::as_bool).unwrap_or(false) {
        out.push(
            "this body is inside out, its faces point into the material: a cut or a join with it can come out wrong"
                .into(),
        );
    }
    let solids = body.get("solidCount").and_then(Value::as_i64).unwrap_or(1);
    if solids > 1 {
        out.push(format!("this body is {solids} solids that do not touch"));
    }
    if let Some(t) = body.get("truncated").filter(|t| !t.is_null()) {
        out.push(format!(
            "the report was truncated: {} more faces, {} more edges. Ask for one body at a time.",
            t.get("faces").and_then(Value::as_i64).unwrap_or(0),
            t.get("edges").and_then(Value::as_i64).unwrap_or(0)
        ));
    }
    out
}

pub fn face_line(f: &Value) -> String {
    let mut bits = vec![format!("F{} {}", index(f), s(f, "surface")), format!("area {}", fmt(f.get("area"), 2))];
    if f.get("radius").is_some_and(|v| !v.is_null()) {
        bits.push(format!("r {}", fmt(f.get("radius"), 3)));
    }
    if f.get("point").is_some_and(|v| !v.is_null()) {
        bits.push(format!("at ({})", fmt(f.get("point"), 3)));
    }
    bits.push(format!("normal ({})", fmt(f.get("normal"), 3)));
    if f.get("wraps").and_then(Value::as_bool).unwrap_or(false) {
        bits.push("WRAPS".into());
    }
    format!("  {}", bits.join(" | "))
}

pub fn edge_line(e: &Value) -> String {
    let mut bits = vec![format!("E{} {}", index(e), s(e, "curve")), format!("len {}", fmt(e.get("length"), 2))];
    if e.get("radius").is_some_and(|v| !v.is_null()) {
        bits.push(format!("r {}", fmt(e.get("radius"), 3)));
    }
    bits.push(format!("mid ({})", fmt(e.get("mid"), 3)));
    let faces = list_of(e, "faces");
    let mut between = format!("between F{}", faces.first().map_or("?".into(), |v| fmt(Some(v), 3)));
    if faces.len() > 1 {
        between.push_str(&format!(" and F{}", fmt(faces.get(1), 3)));
    }
    bits.push(between);
    if e.get("seam").and_then(Value::as_bool).unwrap_or(false) {
        bits.push("SEAM".into());
    }
    if e.get("openBoundary").and_then(Value::as_bool).unwrap_or(false) {
        bits.push("OPEN".into());
    }
    format!("  {}", bits.join(" | "))
}

/// `detail` adds the per-face and per-edge lines, for once a caller knows which body it cares about.
pub fn describe(report: &Value, detail: bool) -> String {
    let mut lines: Vec<String> = Vec::new();
    let bodies = list_of(report, "bodies");
    if bodies.is_empty() {
        lines.push("No bodies. The document built nothing.".into());
    }
    for b in bodies {
        lines.push(body_line(b));
        for w in warnings_for(b) {
            lines.push(format!("  ! {w}"));
        }
        if detail && !b.get("empty").and_then(Value::as_bool).unwrap_or(false) {
            lines.push("  faces:".into());
            lines.extend(list_of(b, "faces").iter().map(face_line));
            lines.push("  edges:".into());
            lines.extend(list_of(b, "edges").iter().map(edge_line));
        }
    }
    for e in list_of(report, "errors") {
        let where_ = match e.get("feature_id").and_then(Value::as_str) {
            Some(id) if !id.is_empty() => format!(" (feature {id})"),
            _ => String::new(),
        };
        lines.push(format!("ERROR{where_}: {}", s(e, "message")));
    }
    lines.join("\n")
}
