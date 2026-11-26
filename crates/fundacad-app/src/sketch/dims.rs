//! The numbers a sketch shows and edits: entity dimensions (a rectangle's width and height, a circle's diameter) and
//! dimension constraints, each addressed by a path into the feature the inspector's number rows also use.

use fundacad_sketch::geom::rect_corners;
use fundacad_sketch::Entity;
use glam::DVec2;
use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq)]
pub struct Dim {
    /// `entities.<id>.width` or `constraints.<id>.value`, relative to the feature.
    pub key: String,
    pub label: String,
    pub value: f64,
    pub angle: bool,
    /// A parameter name the entity field holds, the engine resolves it.
    pub expr: Option<String>,
    /// The constraint's index, for conflict colours.
    pub constraint: Option<usize>,
    pub driven: bool,
    /// The measured span and where the label sits, in sketch mm.
    pub from: DVec2,
    pub to: DVec2,
    pub anchor: DVec2,
}

fn d2(x: f64, y: f64) -> DVec2 {
    DVec2::new(x, y)
}

/// "Line 2", counted by type in drawing order, as FundaCAD 1's entityLabeller names shapes.
pub fn shape_name(entities: &[Value], id: &str) -> String {
    let ty_of = |e: &Value| e.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
    let Some(me) = entities.iter().find(|e| e.get("id").and_then(Value::as_str) == Some(id)) else {
        return id.to_string();
    };
    let ty = ty_of(me);
    let n = entities.iter().take_while(|e| !std::ptr::eq(*e, me)).filter(|e| ty_of(e) == ty).count() + 1;
    let mut word = ty.clone();
    if let Some(f) = word.get_mut(0..1) {
        f.make_ascii_uppercase();
    }
    format!("{word} {n}")
}

/// The base of a rectangle edge id, `r1~0` is edge 0 of `r1`.
fn edge(id: &str) -> Option<(&str, usize)> {
    let (r, k) = id.split_once('~')?;
    Some((r, k.parse().ok()?))
}

fn span_of(solved: &[Entity], line: &str) -> Option<(DVec2, DVec2)> {
    if let Some((r, k)) = edge(line) {
        let Entity::Rectangle { x, y, width, height, angle, .. } = solved.iter().find(|e| e.id() == r)? else {
            return None;
        };
        let c = rect_corners(*x, *y, *width, *height, *angle);
        let (a, b) = (c[k % 4], c[(k + 1) % 4]);
        return Some((d2(a.x, a.y), d2(b.x, b.y)));
    }
    let (a, b) = solved.iter().find(|e| e.id() == line)?.as_line_seg()?;
    Some((d2(a.x, a.y), d2(b.x, b.y)))
}

fn beside(a: DVec2, b: DVec2, gap: f64) -> DVec2 {
    let d = (b - a).normalize_or_zero();
    (a + b) / 2.0 + DVec2::new(-d.y, d.x) * gap
}

fn line_name(entities: &[Value], line: &str) -> String {
    match edge(line) {
        Some((r, k)) => format!("{} side {}", shape_name(entities, r), k + 1),
        None => shape_name(entities, line),
    }
}

pub fn dims(entities: &[Value], constraints: &[Value], solved: &[Entity], gap: f64) -> Vec<Dim> {
    let mut out = Vec::new();
    let s = |c: &Value, k: &str| c.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let mut covered: Vec<String> = Vec::new();
    for (i, c) in constraints.iter().enumerate() {
        let (Some(id), Some(value)) = (c.get("id").and_then(Value::as_str), c.get("value").and_then(Value::as_f64))
        else {
            continue;
        };
        let driven = c.get("driven").and_then(Value::as_bool).unwrap_or(false);
        let ty = s(c, "type");
        let found = match ty.as_str() {
            "distance" => {
                let line = s(c, "line");
                if let Some((r, k)) = edge(&line) {
                    covered.push(format!("{r}.{}", if k % 2 == 0 { "width" } else { "height" }));
                }
                span_of(solved, &line).map(|(a, b)| (format!("Length of {}", line_name(entities, &line)), a, b, false))
            }
            "diameter" | "radius" => {
                let e = if ty == "diameter" { s(c, "circle") } else { s(c, "e") };
                covered.push(format!("{e}.diameter"));
                let word = if ty == "diameter" { "Diameter" } else { "Radius" };
                solved.iter().find(|x| x.id() == e).and_then(Entity::as_round).map(|(c, r)| {
                    (format!("{word} of {}", shape_name(entities, &e)), d2(c.x, c.y), d2(c.x + r, c.y), false)
                })
            }
            "angle" => {
                let (l1, l2) = (s(c, "l1"), s(c, "l2"));
                span_of(solved, &l1).zip(span_of(solved, &l2)).map(|((a, _), (b, _))| {
                    (format!("Angle of {} and {}", line_name(entities, &l1), line_name(entities, &l2)), a, b, true)
                })
            }
            _ => None,
        };
        if let Some((label, from, to, angle)) = found {
            let anchor = if angle { from + (to - from) * 0.3 } else { beside(from, to, gap) };
            let key = format!("constraints.{id}.value");
            out.push(Dim { key, label, value, angle, expr: None, constraint: Some(i), driven, from, to, anchor });
        }
    }
    for e in entities {
        let Some(id) = e.get("id").and_then(Value::as_str) else { continue };
        let Some(r) = solved.iter().find(|x| x.id() == id) else { continue };
        let mut push = |field: &str, label: String, value: f64, from: DVec2, to: DVec2| {
            if covered.iter().any(|c| c == &format!("{id}.{field}")) {
                return;
            }
            let expr = e.get(field).and_then(Value::as_str).map(str::to_string);
            let key = format!("entities.{id}.{field}");
            let anchor = beside(from, to, gap);
            out.push(Dim { key, label, value, angle: false, expr, constraint: None, driven: false, from, to, anchor });
        };
        match r {
            Entity::Rectangle { x, y, width, height, angle, .. } => {
                let c = rect_corners(*x, *y, *width, *height, *angle);
                let name = shape_name(entities, id);
                push("width", format!("Width of {name}"), *width, d2(c[1].x, c[1].y), d2(c[0].x, c[0].y));
                push("height", format!("Height of {name}"), *height, d2(c[1].x, c[1].y), d2(c[2].x, c[2].y));
            }
            Entity::Circle { x, y, radius, .. } => {
                let (a, b) = (d2(x - radius, *y), d2(x + radius, *y));
                push("diameter", format!("Diameter of {}", shape_name(entities, id)), radius * 2.0, a, b);
            }
            _ => {}
        }
    }
    out
}

/// The dimensions of a sketch feature as the document holds them, for the inspector's rows.
pub fn feature_dims(f: &Map<String, Value>) -> Vec<Dim> {
    let list = |k: &str| f.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    let (es, cs) = (list("entities"), list("constraints"));
    let solved = super::solve::resolve(&es, &Default::default());
    dims(&es, &cs, &solved, 0.0)
}

/// A circle's `diameter`, which FC1 shows and edits while the file keeps `radius`. None for a stored field.
pub fn virtual_field(f: &Map<String, Value>, key: &str) -> Option<Value> {
    let id = key.strip_prefix("entities.")?.strip_suffix(".diameter")?;
    let es = f.get("entities")?.as_array()?;
    let e = es.iter().find(|e| e.get("id").and_then(Value::as_str) == Some(id))?;
    Some(serde_json::json!(e.get("radius")?.as_f64()? * 2.0))
}

/// Folds a written `diameter` back into the circle's `radius`.
pub fn fold_diameters(entities: &mut [Value]) {
    for e in entities {
        if let Some(d) = e.as_object_mut().and_then(|o| o.remove("diameter")) {
            if let Some(d) = d.as_f64() {
                e["radius"] = serde_json::json!(d / 2.0);
            }
        }
    }
}
