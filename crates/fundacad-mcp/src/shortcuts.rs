//! Sketch shortcuts an agent may write that the document never holds, and
//! the checks a sketch's entities get when they are sent.
//!
//! A `polyline` becomes `line` entities whose shared ends are written with
//! the very same values, which is how the app chains lines it draws one click
//! after another. A `rectangle` given by two corners becomes the centre form
//! the app stores. Both happen when the feature is added or its entities are
//! sent, so the app, the engine and a saved file only ever see entities they
//! already know.

use std::collections::BTreeSet;

use fundacad_core::schema::SketchEntity;
use serde_json::{json, Map, Value};

/// What a point's coordinate may be: a number or a parameter name.
fn coord(v: &Value) -> Option<Value> {
    match v {
        Value::Number(_) => Some(v.clone()),
        Value::String(s) if !s.trim().is_empty() => Some(v.clone()),
        _ => None,
    }
}

/// `[x, y]` or `{x, y}`.
fn point(v: &Value) -> Option<(Value, Value)> {
    match v {
        Value::Array(a) if a.len() == 2 => Some((coord(&a[0])?, coord(&a[1])?)),
        Value::Object(o) => Some((coord(o.get("x")?)?, coord(o.get("y")?)?)),
        _ => None,
    }
}

fn entity_ids(entities: &[Value]) -> BTreeSet<String> {
    entities.iter().filter_map(|e| e.get("id").and_then(Value::as_str).map(str::to_string)).collect()
}

/// A free id from `base`: `base_1`, `base_2`, ... skipping any taken.
fn fresh_id(base: &str, k: &mut usize, taken: &mut BTreeSet<String>) -> String {
    loop {
        *k += 1;
        let id = format!("{base}_{k}");
        if taken.insert(id.clone()) {
            return id;
        }
    }
}

/// Whether two point coordinates are the same: equal numbers, however
/// written, or the same parameter name.
fn same(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => x == y,
        _ => a == b,
    }
}

/// What a polyline became: its id and the lines it was written as.
struct Expanded {
    base: String,
    lines: Vec<String>,
}

fn polyline(
    sid: &str,
    e: &Map<String, Value>,
    taken: &mut BTreeSet<String>,
    out: &mut Vec<Value>,
) -> Result<(String, Expanded), String> {
    const KNOWN: [&str; 5] = ["type", "id", "points", "closed", "construction"];
    if let Some(k) = e.keys().find(|k| !KNOWN.contains(&k.as_str())) {
        return Err(format!("{sid}: a polyline has no field \"{k}\", it takes points, closed and construction"));
    }
    let closed = match e.get("closed") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(v) => return Err(format!("{sid}: a polyline's `closed` is true or false, not {v}")),
    };
    let Some(raw) = e.get("points").and_then(Value::as_array) else {
        return Err(format!("{sid}: a polyline needs `points`, a list of [x, y]"));
    };
    let mut pts = Vec::with_capacity(raw.len());
    for (i, p) in raw.iter().enumerate() {
        match point(p) {
            Some(xy) => pts.push(xy),
            None => {
                return Err(format!(
                    "{sid}: polyline point {i} is {p}, a point is [x, y] or {{x, y}}, each a number or a parameter name"
                ))
            }
        }
    }
    // A closed outline written back to its start: that last point is the first.
    if closed && pts.len() > 3 && pts.first().zip(pts.last()).is_some_and(|(a, b)| same(&a.0, &b.0) && same(&a.1, &b.1)) {
        pts.pop();
    }
    let need = if closed { 3 } else { 2 };
    if pts.len() < need {
        return Err(format!(
            "{sid}: a{} polyline needs at least {need} points, got {}",
            if closed { " closed" } else { "n open" },
            pts.len()
        ));
    }
    let n = pts.len();
    let segments = if closed { n } else { n - 1 };
    for s in 0..segments {
        let (a, b) = (&pts[s], &pts[(s + 1) % n]);
        if same(&a.0, &b.0) && same(&a.1, &b.1) {
            return Err(format!("{sid}: polyline points {s} and {} are the same point", (s + 1) % n));
        }
    }
    let base = match e.get("id") {
        Some(Value::String(id)) if !id.is_empty() => id.clone(),
        Some(v) if !v.is_null() && v != &json!("") => {
            return Err(format!("{sid}: a polyline's id is a string, not {v}"));
        }
        _ => {
            let mut n = 1;
            while taken.iter().any(|t| t == &format!("pl{n}") || t.starts_with(&format!("pl{n}_"))) {
                n += 1;
            }
            format!("pl{n}")
        }
    };
    taken.remove(&base);
    let construction = e.get("construction").cloned();
    let mut k = 0;
    let mut made = Vec::new();
    for s in 0..segments {
        // Each end written with the values of the point it is, so a line's
        // end and the next one's start are the same numbers, or the same
        // parameter, and join.
        let (a, b) = (&pts[s], &pts[(s + 1) % n]);
        let id = fresh_id(&base, &mut k, taken);
        let mut line = Map::new();
        line.insert("type".into(), json!("line"));
        line.insert("id".into(), json!(id));
        line.insert("x1".into(), a.0.clone());
        line.insert("y1".into(), a.1.clone());
        line.insert("x2".into(), b.0.clone());
        line.insert("y2".into(), b.1.clone());
        if let Some(c) = &construction {
            line.insert("construction".into(), c.clone());
        }
        out.push(Value::Object(line));
        made.push(id);
    }
    // A range only when it names every line in it: ids already taken are
    // stepped round, and "p_1..p_5" would then name one that is not a line.
    let run = made.len() > 2 && made.iter().enumerate().all(|(i, id)| *id == format!("{base}_{}", i + 1));
    let note = format!(
        "polyline {base} became lines {}",
        if run { format!("{}..{}", made[0], made[made.len() - 1]) } else { made.join(", ") }
    );
    Ok((note, Expanded { base, lines: made }))
}

/// Patterns that repeat a polyline now repeat its lines. A constraint or a
/// text path that names one is refused: a line of it is what it means, and
/// which line is not for this to guess.
fn follow(sid: &str, f: &mut Map<String, Value>, done: &[Expanded], entities: &[Value]) -> Result<(), String> {
    let named = |v: &Value| -> Option<&Expanded> {
        let s = v.as_str()?;
        done.iter().find(|d| s == d.base || s.strip_prefix(d.base.as_str()).is_some_and(|r| r.starts_with('~')))
    };
    if let Some(Value::Array(cs)) = f.get("constraints") {
        for (i, c) in cs.iter().enumerate() {
            let hit = c.as_object().and_then(|o| o.iter().filter(|(k, _)| *k != "type" && *k != "id").find_map(|(_, v)| named(v)));
            if let Some(d) = hit {
                let kind = c.get("type").and_then(Value::as_str).unwrap_or("constraint");
                return Err(format!(
                    "{sid}: constraint {i} ({kind}) names polyline {}, which is stored as the lines {}. Name the line it means",
                    d.base,
                    d.lines.join(", ")
                ));
            }
        }
    }
    for e in entities {
        if let Some(d) = e.get("pathRef").and_then(named) {
            return Err(format!(
                "{sid}: a text follows polyline {}, which is stored as the lines {}. A text follows one line, arc, circle or spline",
                d.base,
                d.lines.join(", ")
            ));
        }
    }
    if let Some(Value::Array(ps)) = f.get_mut("patterns") {
        for p in ps.iter_mut() {
            if let Some(Value::Array(src)) = p.get_mut("sources") {
                let mut next = Vec::with_capacity(src.len());
                for v in src.drain(..) {
                    match done.iter().find(|d| v.as_str() == Some(d.base.as_str())) {
                        Some(d) => next.extend(d.lines.iter().map(|l| json!(l))),
                        None => next.push(v),
                    }
                }
                *src = next;
            }
        }
    }
    Ok(())
}

fn corners(sid: &str, e: &mut Map<String, Value>) -> Result<Option<String>, String> {
    if !e.contains_key("from") && !e.contains_key("to") {
        return Ok(None);
    }
    for k in ["width", "height", "x", "y"] {
        if e.contains_key(k) {
            return Err(format!("{sid}: give a rectangle `from` and `to` corners, or width, height, x, y, not both"));
        }
    }
    if e.get("angle").is_some_and(|a| a.as_f64() != Some(0.0)) {
        return Err(format!(
            "{sid}: corners make a rectangle square to the sketch axes. For a turned one give width, height, \
             x, y (its centre) and angle"
        ));
    }
    let num = |k: &str| -> Result<(f64, f64), String> {
        let p = e.get(k).and_then(point).ok_or_else(|| format!("{sid}: a rectangle by corners needs `{k}`, [x, y]"))?;
        match (p.0.as_f64(), p.1.as_f64()) {
            (Some(x), Some(y)) => Ok((x, y)),
            _ => Err(format!(
                "{sid}: corners have to be numbers. To size a rectangle by parameters, write it as width, \
                 height and x, y (its centre)"
            )),
        }
    };
    let (a, b) = (num("from")?, num("to")?);
    let (w, h) = ((b.0 - a.0).abs(), (b.1 - a.1).abs());
    if w == 0.0 || h == 0.0 {
        return Err(format!("{sid}: the rectangle's corners are on one line, it has no area"));
    }
    let r = |v: f64| {
        let r = (v * 1e9).round() / 1e9;
        if r == 0.0 { 0.0 } else { r }
    };
    e.remove("from");
    e.remove("to");
    e.insert("width".into(), json!(r(w)));
    e.insert("height".into(), json!(r(h)));
    e.insert("x".into(), json!(r((a.0 + b.0) / 2.0)));
    e.insert("y".into(), json!(r((a.1 + b.1) / 2.0)));
    let id = e.get("id").and_then(Value::as_str).unwrap_or("rectangle");
    Ok(Some(format!(
        "{id} from corners became {} x {} centred at ({}, {})",
        crate::describe::g_format(r(w)),
        crate::describe::g_format(r(h)),
        crate::describe::g_format(r((a.0 + b.0) / 2.0)),
        crate::describe::g_format(r((a.1 + b.1) / 2.0))
    )))
}

/// `line` with each note after it as a sentence of its own.
pub fn noted(line: &str, notes: &[String]) -> String {
    let mut out = line.to_string();
    for n in notes {
        let mut c = n.chars();
        if let Some(first) = c.next() {
            out.push(' ');
            out.extend(first.to_uppercase());
            out.push_str(c.as_str());
            out.push('.');
        }
    }
    out
}

/// Expand the shortcuts in a sketch feature's entities and, when `check`
/// holds the entities the sketch already had, refuse any other the build
/// would not draw: an unknown type, a missing field, a field nothing reads.
/// Entities sent back as they were pass, so one the app keeps from a newer
/// build does not stop an edit. Two entities with one id are always refused.
/// Returns a note per shortcut expanded. Anything but a sketch passes
/// untouched.
pub fn expand(f: &mut Map<String, Value>, check: Option<&[Value]>) -> Result<Vec<String>, String> {
    if f.get("type").and_then(Value::as_str) != Some("sketch") {
        return Ok(Vec::new());
    }
    let sid = f.get("id").and_then(Value::as_str).unwrap_or("sketch").to_string();
    let Some(Value::Array(entities)) = f.get("entities") else {
        return Ok(Vec::new());
    };
    let mut taken = entity_ids(entities);
    let mut out = Vec::with_capacity(entities.len());
    let mut notes = Vec::new();
    let mut done = Vec::new();
    for e in entities {
        let Some(obj) = e.as_object() else {
            out.push(e.clone());
            continue;
        };
        match obj.get("type").and_then(Value::as_str) {
            Some("polyline") => {
                let (note, made) = polyline(&sid, obj, &mut taken, &mut out)?;
                notes.push(note);
                done.push(made);
            }
            Some("rectangle") => {
                let mut r = obj.clone();
                if let Some(note) = corners(&sid, &mut r)? {
                    notes.push(note);
                }
                out.push(Value::Object(r));
            }
            _ => out.push(e.clone()),
        }
    }
    if let Some(kept) = check {
        check_entities(&sid, &out, kept)?;
    }
    if !done.is_empty() {
        follow(&sid, f, &done, &out)?;
    }
    f.insert("entities".into(), Value::Array(out));
    Ok(notes)
}

fn check_entities(sid: &str, entities: &[Value], kept: &[Value]) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    for (i, e) in entities.iter().enumerate() {
        let kind = e.get("type").and_then(Value::as_str).unwrap_or_default();
        let name = e.get("id").and_then(Value::as_str).map_or_else(|| format!("entity {i}"), str::to_string);
        if let Some(id) = e.get("id").and_then(Value::as_str) {
            if !seen.insert(id.to_string()) {
                return Err(format!("{sid}: two entities have the id '{id}', each needs its own"));
            }
        }
        if kept.contains(e) {
            continue;
        }
        let parsed = match serde_json::from_value::<SketchEntity>(e.clone()) {
            Ok(p) => p,
            Err(err) => return Err(format!("{sid}: {name} ({kind}) is malformed: {err}")),
        };
        match &parsed {
            SketchEntity::Unknown(_) => {
                let mut kinds: Vec<&str> = SketchEntity::KNOWN.iter().copied().chain(["polyline"]).collect();
                kinds.sort_unstable();
                return Err(format!(
                    "{sid}: {name} has type '{kind}', which no build draws. Sketch entities are {}",
                    kinds.join(", ")
                ));
            }
            SketchEntity::Invalid(inv) => {
                let why = match crate::model::missing_field_of(&inv.error) {
                    Some(k) => format!("is missing the field \"{k}\""),
                    None => format!("is malformed: {}", inv.error),
                };
                return Err(format!("{sid}: {name} ({kind}) {why}. Call schema(\"sketch\") for each entity's fields"));
            }
            _ => {}
        }
        let unread: Vec<String> = parsed.extra().map(|x| x.keys().map(|k| format!("\"{k}\"")).collect()).unwrap_or_default();
        if !unread.is_empty() {
            let doc = crate::schema::sketch_entities().get(kind).map(|d| format!(" A {kind} is {d}.")).unwrap_or_default();
            return Err(format!(
                "{sid}: {name} ({kind}) has {} {}, which a build would ignore rather than use.{doc}",
                if unread.len() == 1 { "the field" } else { "the fields" },
                unread.join(", ")
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sketch(entities: Value) -> Map<String, Value> {
        json!({"id": "sk1", "type": "sketch", "plane": "XY", "entities": entities}).as_object().cloned().unwrap()
    }

    #[test]
    fn a_closed_polyline_is_lines_that_share_their_ends() {
        let mut f = sketch(json!([{"type": "polyline", "id": "p", "closed": true,
                                   "points": [[0, 0], ["w", 0], {"x": "w", "y": 10}]}]));
        let notes = expand(&mut f, Some(&[])).unwrap();
        assert_eq!(notes, vec!["polyline p became lines p_1..p_3"]);
        let lines = f["entities"].as_array().unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], json!({"type": "line", "id": "p_1", "x1": 0, "y1": 0, "x2": "w", "y2": 0}));
        assert_eq!(lines[1]["x1"], lines[0]["x2"]);
        assert_eq!(lines[2]["x2"], json!(0));
    }

    #[test]
    fn generated_ids_step_round_ones_in_use() {
        let mut f = sketch(json!([{"type": "circle", "id": "p_2", "radius": 1},
                                  {"type": "polyline", "id": "p", "points": [[0, 0], [1, 0], [1, 1]], "construction": true}]));
        expand(&mut f, Some(&[])).unwrap();
        let ids: Vec<&str> = f["entities"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["p_2", "p_1", "p_3"]);
        assert_eq!(f["entities"][1]["construction"], json!(true));
    }

    #[test]
    fn bad_polylines_and_entities_are_refused() {
        let refuse = |e: Value| expand(&mut sketch(e), Some(&[])).unwrap_err();
        assert!(refuse(json!([{"type": "polyline", "points": [[0, 0]]}])).contains("at least 2 points"));
        assert!(refuse(json!([{"type": "polyline", "closed": true, "points": [[0, 0], [1, 1]]}])).contains("at least 3"));
        assert!(refuse(json!([{"type": "polyline", "points": [[0, 0], [0, 0]]}])).contains("the same point"));
        assert!(refuse(json!([{"type": "polylin", "points": []}])).contains("no build draws"));
        assert!(refuse(json!([{"type": "rectangle", "w": 3, "height": 2}])).contains("missing the field \"width\""));
        assert!(refuse(json!([{"type": "circle", "radius": 2, "r": 3}])).contains("\"r\""));
        assert!(refuse(json!([{"type": "circle", "id": "a", "radius": 2}, {"type": "point", "id": "a", "x": 0, "y": 0}])).contains("two entities"));
    }

    #[test]
    fn ids_points_patterns_and_kept_entities() {
        // A range only when every id in it is one of the lines.
        let mut f = sketch(json!([{"type": "circle", "id": "p_2", "radius": 1},
                                  {"type": "polyline", "id": "p", "closed": true, "points": [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]}]));
        assert_eq!(expand(&mut f, Some(&[])).unwrap(), vec!["polyline p became lines p_1, p_3, p_4, p_5"]);
        assert_eq!(f["entities"].as_array().unwrap().len(), 5, "the repeated start is not a fifth line");
        // 1 and 1.0 are one point.
        let refuse = |e: Value| expand(&mut sketch(e), Some(&[])).unwrap_err();
        assert!(refuse(json!([{"type": "polyline", "points": [[1, 0], [1.0, 0], [2, 2]]}])).contains("the same point"));
        assert!(refuse(json!([{"type": "polyline", "closed": 1, "points": [[0, 0], [1, 0], [1, 1]]}])).contains("true or false"));
        assert!(refuse(json!([{"type": "polyline", "id": 7, "points": [[0, 0], [1, 0]]}])).contains("is a string"));
        let unknown = refuse(json!([{"type": "polylin", "points": []}]));
        assert!(unknown.contains("polyline") && unknown.contains("projected"), "{unknown}");
        // A pattern of a polyline repeats its lines; a constraint on it is refused.
        let mut f = sketch(json!([{"type": "polyline", "id": "q", "points": [[0, 0], [1, 0], [1, 1]]}]));
        f.insert("patterns".into(), json!([{"id": "pt", "type": "patternRect", "sources": ["q", "c"]}]));
        expand(&mut f, Some(&[])).unwrap();
        assert_eq!(f["patterns"][0]["sources"], json!(["q_1", "q_2", "c"]));
        let mut f = sketch(json!([{"type": "polyline", "id": "q", "points": [[0, 0], [1, 0], [1, 1]]}]));
        f.insert("constraints".into(), json!([{"type": "horizontal", "line": "q"}]));
        assert!(expand(&mut f, Some(&[])).unwrap_err().contains("constraint 0 (horizontal) names polyline q"));
        // What the sketch already held passes as it was; only the rest is checked.
        let kept = vec![json!({"type": "hyperbola", "a": 1}), json!({"type": "circle", "radius": 1, "futureFlag": 2.5})];
        let mut sent = kept.clone();
        sent.push(json!({"type": "circle", "radius": 2}));
        expand(&mut sketch(Value::Array(sent.clone())), Some(&kept)).unwrap();
        sent.push(json!({"type": "circle", "radius": 2, "r": 3}));
        assert!(expand(&mut sketch(Value::Array(sent)), Some(&kept)).unwrap_err().contains("\"r\""));
    }

    #[test]
    fn a_rectangle_by_corners_is_stored_by_its_centre() {
        let mut f = sketch(json!([{"type": "rectangle", "id": "r", "from": [10, 0], "to": [-10, 4]}]));
        let notes = expand(&mut f, Some(&[])).unwrap();
        assert_eq!(f["entities"][0], json!({"type": "rectangle", "id": "r", "width": 20.0, "height": 4.0, "x": 0.0, "y": 2.0}));
        assert_eq!(notes, vec!["r from corners became 20 x 4 centred at (0, 2)"]);
        assert!(expand(&mut sketch(json!([{"type": "rectangle", "from": ["a", 0], "to": [1, 1]}])), Some(&[])).is_err());
    }
}
