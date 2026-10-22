//! Loose ends of a sketch, the rules of src/sketch/looseEnds.ts: an open end meets no curve, an untied one
//! meets one only by position. `tie` also moves the end onto what it touches, since the engine never solves.
//! Unlike the sketcher, spline, slot and polygon bodies count here only through their ends.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

use crate::model::{self, Doc};

type P = (f64, f64);

#[derive(Debug, Clone)]
struct End {
    entity: String,
    p: i64,
    at: P,
    /// a line, arc or free form end with plain numbers, the only kind a tie moves
    movable: bool,
    /// its coordinates name a parameter, a tie would break the binding
    bound: bool,
}

#[derive(Debug, Clone)]
enum Body {
    Segs(Vec<P>),
    Circle(P, f64),
    Arc { c: P, r: f64, a0: f64, sweep: f64 },
}

struct Ent {
    id: String,
    ends: Vec<End>,
    body: Option<Body>,
    tieable: bool,
    self_closable: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Touch {
    End(String, i64),
    Curve(String),
}

#[derive(Debug, Clone)]
pub struct Untied {
    pub entity: String,
    pub p: i64,
    pub at: P,
    pub touches: Touch,
    pub gap: f64,
    pub tieable: bool,
}

#[derive(Debug, Clone, Default)]
pub struct LooseEnds {
    pub open: Vec<(String, i64, P)>,
    pub untied: Vec<Untied>,
    pub tolerance: f64,
}

fn num(params: Option<&Map<String, Value>>, v: &Value, default: Option<f64>) -> Option<(f64, bool)> {
    match v {
        Value::Number(n) => n.as_f64().map(|x| (x, false)),
        Value::String(s) => params.and_then(|p| p.get(s)).and_then(Value::as_f64).map(|x| (x, true)),
        Value::Null => default.map(|d| (d, false)),
        _ => None,
    }
}

fn pt(params: Option<&Map<String, Value>>, o: &Value, kx: &str, ky: &str) -> Option<(P, bool)> {
    let (x, bx) = num(params, &o[kx], None)?;
    let (y, by) = num(params, &o[ky], None)?;
    Some(((x, y), bx || by))
}

fn circumcenter(a: P, b: P, c: P) -> Option<(P, f64)> {
    let d = 2.0 * (a.0 * (b.1 - c.1) + b.0 * (c.1 - a.1) + c.0 * (a.1 - b.1));
    if d.abs() < 1e-12 {
        return None;
    }
    let (a2, b2, c2) = (a.0 * a.0 + a.1 * a.1, b.0 * b.0 + b.1 * b.1, c.0 * c.0 + c.1 * c.1);
    let ux = (a2 * (b.1 - c.1) + b2 * (c.1 - a.1) + c2 * (a.1 - b.1)) / d;
    let uy = (a2 * (c.0 - b.0) + b2 * (a.0 - c.0) + c2 * (b.0 - a.0)) / d;
    Some(((ux, uy), ((a.0 - ux).powi(2) + (a.1 - uy).powi(2)).sqrt()))
}

/// The arc from `s` through `m` to `e` as a start angle and a signed sweep.
fn arc_body(s: P, e: P, m: P) -> Option<Body> {
    let (c, r) = circumcenter(s, m, e)?;
    let ang = |q: P| (q.1 - c.1).atan2(q.0 - c.0);
    let tau = std::f64::consts::TAU;
    let a0 = ang(s);
    let ccw = |q: P| (ang(q) - a0).rem_euclid(tau);
    let (dm, de) = (ccw(m), ccw(e));
    let sweep = if dm <= de { de } else { de - tau };
    Some(Body::Arc { c, r, a0, sweep })
}

fn seg_dist(q: P, a: P, b: P) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((q.0 - a.0) * dx + (q.1 - a.1) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    (q.0 - (a.0 + t * dx)).hypot(q.1 - (a.1 + t * dy))
}

fn body_dist(b: &Body, q: P) -> f64 {
    match b {
        Body::Segs(pts) => pts.windows(2).map(|w| seg_dist(q, w[0], w[1])).fold(f64::INFINITY, f64::min),
        Body::Circle(c, r) => ((q.0 - c.0).hypot(q.1 - c.1) - r).abs(),
        Body::Arc { c, r, a0, sweep } => {
            let tau = std::f64::consts::TAU;
            let a = (q.1 - c.1).atan2(q.0 - c.0);
            let rel = if *sweep >= 0.0 { (a - a0).rem_euclid(tau) } else { (a0 - a).rem_euclid(tau) };
            if rel <= sweep.abs() {
                ((q.0 - c.0).hypot(q.1 - c.1) - r).abs()
            } else {
                let at = |t: f64| (c.0 + r * t.cos(), c.1 + r * t.sin());
                let (s, e) = (at(*a0), at(a0 + sweep));
                (q.0 - s.0).hypot(q.1 - s.1).min((q.0 - e.0).hypot(q.1 - e.1))
            }
        }
    }
}

fn rect_corners(c: P, w: f64, h: f64, deg: f64) -> [P; 4] {
    let (hw, hh) = (w / 2.0, h / 2.0);
    let local = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)];
    if deg == 0.0 {
        return local.map(|(x, y)| (c.0 + x, c.1 + y));
    }
    let (s, k) = deg.to_radians().sin_cos();
    local.map(|(x, y)| (c.0 + x * k - y * s, c.1 + x * s + y * k))
}

fn read(params: Option<&Map<String, Value>>, e: &Value) -> Option<Ent> {
    let id = e.get("id").and_then(Value::as_str)?.to_string();
    let kind = e.get("type").and_then(Value::as_str)?;
    if e.get("construction").and_then(Value::as_bool) == Some(true) || matches!(kind, "text" | "point") {
        return None;
    }
    let end = |p: i64, (at, bound): (P, bool), movable: bool| End { entity: id.clone(), p, at, movable, bound };
    let mut ent = Ent { id: id.clone(), ends: vec![], body: None, tieable: false, self_closable: false };
    match kind {
        "line" => {
            let (a, b) = (pt(params, e, "x1", "y1")?, pt(params, e, "x2", "y2")?);
            ent.body = Some(Body::Segs(vec![a.0, b.0]));
            ent.ends = vec![end(0, a, true), end(1, b, true)];
            ent.tieable = true;
        }
        "arc" => {
            let (a, b, m) = (pt(params, e, "x1", "y1")?, pt(params, e, "x2", "y2")?, pt(params, e, "mx", "my")?);
            ent.body = arc_body(a.0, b.0, m.0);
            ent.ends = vec![end(0, a, true), end(1, b, true)];
            ent.tieable = true;
        }
        "circle" => {
            let c = ((num(params, &e["x"], Some(0.0))?.0, num(params, &e["y"], Some(0.0))?.0), false);
            ent.body = Some(Body::Circle(c.0, num(params, &e["radius"], None)?.0));
            ent.tieable = true;
        }
        "rectangle" => {
            let c = (num(params, &e["x"], Some(0.0))?.0, num(params, &e["y"], Some(0.0))?.0);
            let (w, h) = (num(params, &e["width"], None)?.0, num(params, &e["height"], None)?.0);
            let k = rect_corners(c, w, h, num(params, &e["angle"], Some(0.0))?.0);
            ent.body = Some(Body::Segs(vec![k[0], k[1], k[2], k[3], k[0]]));
            ent.ends = (0..4).map(|i| end(i as i64, (k[i], false), false)).collect();
        }
        "spline" | "bspline" => {
            let key = if kind == "spline" { "points" } else { "poles" };
            let pts = e.get(key).and_then(Value::as_array)?;
            if pts.len() > 1 && !(kind == "bspline" && e.get("closed").and_then(Value::as_bool) == Some(true)) {
                let (a, b) = (pt(params, &pts[0], "x", "y")?, pt(params, &pts[pts.len() - 1], "x", "y")?);
                ent.ends = vec![end(0, a, true), end(1, b, true)];
                ent.self_closable = true;
            }
        }
        "projected" => {
            let cv = &e["curve"];
            match cv.get("kind").and_then(Value::as_str)? {
                "line" => {
                    let (a, b) = (pt(params, cv, "x1", "y1")?, pt(params, cv, "x2", "y2")?);
                    ent.body = Some(Body::Segs(vec![a.0, b.0]));
                    ent.ends = vec![end(0, a, false), end(1, b, false)];
                    ent.tieable = true;
                }
                "arc" => {
                    let (a, b, m) =
                        (pt(params, cv, "x1", "y1")?, pt(params, cv, "x2", "y2")?, pt(params, cv, "mx", "my")?);
                    ent.body = arc_body(a.0, b.0, m.0);
                    ent.ends = vec![end(0, a, false), end(1, b, false)];
                    ent.tieable = true;
                }
                "circle" => {
                    let c = pt(params, cv, "x", "y")?.0;
                    ent.body = Some(Body::Circle(c, num(params, &cv["r"], None)?.0));
                    ent.tieable = true;
                }
                "poly" => {
                    let pts: Vec<P> = cv
                        .get("pts")
                        .and_then(Value::as_array)?
                        .iter()
                        .filter_map(|q| Some((q.get(0)?.as_f64()?, q.get(1)?.as_f64()?)))
                        .collect();
                    if let (Some(&a), Some(&b)) = (pts.first(), pts.last()) {
                        if a != b {
                            ent.ends = vec![end(0, (a, false), false), end(1, (b, false), false)];
                        }
                    }
                    ent.body = Some(Body::Segs(pts));
                }
                _ => {}
            }
        }
        _ => {}
    }
    for x in &mut ent.ends {
        x.movable = x.movable && !x.bound;
    }
    Some(ent)
}

fn sketch_of<'a>(doc: &'a Doc, sketch: &str) -> Result<&'a Value, String> {
    let Some((_, f)) = model::find_feature(doc, sketch) else {
        return Err(format!("no feature '{sketch}'"));
    };
    if f.get("type").and_then(Value::as_str) != Some("sketch") {
        return Err(format!("{sketch} is not a sketch"));
    }
    Ok(f)
}

fn constraints(f: &Value) -> &[Value] {
    f.get("constraints").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn ref_key(e: &Value, p: &Value) -> Option<(String, i64)> {
    Some((e.as_str()?.to_string(), p.as_i64()?))
}

/// Coincidents join into classes, so a chain through a construction end still ties the curve ends on it.
/// Construction geometry, points and arc centres alone hold nothing the profile can close through.
fn tied_ends(f: &Value, ents: &[Ent]) -> BTreeSet<(String, i64)> {
    let mut parent: BTreeMap<(String, i64), (String, i64)> = BTreeMap::new();
    for c in constraints(f) {
        if c["type"].as_str() != Some("coincident") {
            continue;
        }
        let (Some(a), Some(b)) = (ref_key(&c["e1"], &c["p1"]), ref_key(&c["e2"], &c["p2"])) else { continue };
        let (ra, rb) = (root(&mut parent, &a), root(&mut parent, &b));
        if ra != rb {
            parent.insert(ra, rb);
        }
    }
    let by_id: BTreeMap<&str, &Ent> = ents.iter().map(|e| (e.id.as_str(), e)).collect();
    let mut members: BTreeMap<(String, i64), Vec<(String, i64)>> = BTreeMap::new();
    for x in ents.iter().flat_map(|e| e.ends.iter()) {
        let k = (x.entity.clone(), x.p);
        members.entry(root(&mut parent, &k)).or_default().push(k);
    }
    let mut on_curve: BTreeMap<(String, i64), BTreeSet<String>> = BTreeMap::new();
    for c in constraints(f) {
        let curve = match c["type"].as_str() {
            Some("pointOnCurve") => &c["curve"],
            Some("midpoint") => &c["line"],
            _ => continue,
        };
        let (Some(k), Some(curve)) = (ref_key(&c["e"], &c["p"]), curve.as_str()) else { continue };
        if by_id.contains_key(curve) {
            on_curve.entry(root(&mut parent, &k)).or_default().insert(curve.to_string());
        }
    }
    let mut tied = BTreeSet::new();
    for e in ents {
        for x in &e.ends {
            let k = (x.entity.clone(), x.p);
            let r = root(&mut parent, &k);
            let mate = members
                .get(&r)
                .is_some_and(|m| m.iter().any(|o| if o.0 == e.id { o.1 != x.p && e.self_closable } else { true }));
            let on = on_curve.get(&r).is_some_and(|cs| cs.iter().any(|c| *c != e.id));
            if mate || on {
                tied.insert(k);
            }
        }
    }
    tied
}

fn read_all(doc: &Doc, f: &Value) -> Vec<Ent> {
    let params = doc.get("parameters").and_then(Value::as_object);
    f.get("entities")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|e| read(params, e))
        .collect()
}

/// 1% of the profile's size, about the sketcher's 10 px snap reach when the
/// sketch fills the view, never under a micron.
fn default_reach(ents: &[Ent]) -> f64 {
    let (mut lo, mut hi) = ((f64::INFINITY, f64::INFINITY), (f64::NEG_INFINITY, f64::NEG_INFINITY));
    let mut grow = |q: P| {
        lo = (lo.0.min(q.0), lo.1.min(q.1));
        hi = (hi.0.max(q.0), hi.1.max(q.1));
    };
    for e in ents {
        e.ends.iter().for_each(|x| grow(x.at));
        match &e.body {
            Some(Body::Segs(pts)) => pts.iter().for_each(|&q| grow(q)),
            Some(Body::Circle(c, r)) | Some(Body::Arc { c, r, .. }) => {
                grow((c.0 - r, c.1 - r));
                grow((c.0 + r, c.1 + r));
            }
            None => {}
        }
    }
    let diag = if lo.0.is_finite() { (hi.0 - lo.0).hypot(hi.1 - lo.1) } else { 0.0 };
    (0.01 * diag).max(1e-3)
}

pub fn find(doc: &Doc, sketch: &str, tolerance: Option<f64>) -> Result<LooseEnds, String> {
    let f = sketch_of(doc, sketch)?;
    let ents = read_all(doc, f);
    let tol = tolerance.unwrap_or_else(|| default_reach(&ents));
    let tied = tied_ends(f, &ents);
    let by_id: BTreeMap<&str, &Ent> = ents.iter().map(|e| (e.id.as_str(), e)).collect();
    let targets: Vec<&End> = ents.iter().flat_map(|e| e.ends.iter()).collect();
    let mut out = LooseEnds { tolerance: tol, ..Default::default() };
    for e in &ents {
        for end in e.ends.iter().filter(|x| x.movable || x.bound) {
            let own = by_id[end.entity.as_str()];
            if tied.contains(&(end.entity.clone(), end.p)) {
                continue;
            }
            let mut best: Option<(&End, f64)> = None;
            for t in &targets {
                if t.entity == end.entity && (t.p == end.p || !own.self_closable) {
                    continue;
                }
                let d = (t.at.0 - end.at.0).hypot(t.at.1 - end.at.1);
                if d <= tol && best.is_none_or(|(_, b)| d < b) {
                    best = Some((t, d));
                }
            }
            if let Some((t, d)) = best {
                out.untied.push(Untied {
                    entity: end.entity.clone(),
                    p: end.p,
                    at: end.at,
                    touches: Touch::End(t.entity.clone(), t.p),
                    gap: d,
                    tieable: !end.bound || t.movable,
                });
                continue;
            }
            let mut near: Option<(&Ent, f64)> = None;
            for c in &ents {
                let Some(b) = c.body.as_ref().filter(|_| c.id != end.entity) else { continue };
                let d = body_dist(b, end.at);
                if d <= tol && near.is_none_or(|(_, n)| d < n) {
                    near = Some((c, d));
                }
            }
            match near {
                Some((c, d)) => out.untied.push(Untied {
                    entity: end.entity.clone(),
                    p: end.p,
                    at: end.at,
                    touches: Touch::Curve(c.id.clone()),
                    gap: d,
                    tieable: c.tieable && !end.bound,
                }),
                None => out.open.push((end.entity.clone(), end.p, end.at)),
            }
        }
    }
    Ok(out)
}

pub fn to_json(le: &LooseEnds) -> Value {
    let at = |q: P| json!([q.0, q.1]);
    json!({
        "tolerance": le.tolerance,
        "open": le.open.iter().map(|(e, p, q)| json!({"entity": e, "p": p, "at": at(*q)})).collect::<Vec<_>>(),
        "untied": le.untied.iter().map(|u| json!({
            "entity": u.entity, "p": u.p, "at": at(u.at),
            "touches": match &u.touches {
                Touch::End(e, p) => json!({"entity": e, "p": p}),
                Touch::Curve(c) => json!({"curve": c}),
            },
            "gap": u.gap, "tieable": u.tieable,
        })).collect::<Vec<_>>(),
    })
}

fn root(parent: &mut BTreeMap<(String, i64), (String, i64)>, k: &(String, i64)) -> (String, i64) {
    let mut r = k.clone();
    while let Some(n) = parent.get(&r).filter(|n| **n != r) {
        r = n.clone();
    }
    r
}

/// Where end `p` of entity `e` sits in the document now, and a writer for it.
fn end_slot<'a>(e: &'a mut Value, p: i64) -> Option<(&'a mut Value, &'static str, &'static str)> {
    match e["type"].as_str()? {
        "line" | "arc" => Some((e, if p == 0 { "x1" } else { "x2" }, if p == 0 { "y1" } else { "y2" })),
        "spline" | "bspline" => {
            let key = if e["type"] == json!("spline") { "points" } else { "poles" };
            let a = e.get_mut(key)?.as_array_mut()?;
            let i = if p == 0 { 0 } else { a.len().checked_sub(1)? };
            Some((a.get_mut(i)?, "x", "y"))
        }
        _ => None,
    }
}

fn move_end(f: &mut Value, entity: &str, p: i64, to: P) -> bool {
    let Some(e) = f["entities"].as_array_mut().and_then(|a| a.iter_mut().find(|e| e["id"] == json!(entity))) else {
        return false;
    };
    if e["type"] == json!("arc") {
        let other = if p == 0 { ("x2", "y2") } else { ("x1", "y1") };
        let (Some(ox), Some(oy), Some(mx), Some(my)) =
            (e[other.0].as_f64(), e[other.1].as_f64(), e["mx"].as_f64(), e["my"].as_f64())
        else {
            return false;
        };
        if circumcenter(to, (mx, my), (ox, oy)).is_none() {
            return false;
        }
    }
    let Some((slot, kx, ky)) = end_slot(e, p) else { return false };
    slot[kx] = json!(to.0);
    slot[ky] = json!(to.1);
    true
}

fn foot(b: &Body, q: P) -> Option<P> {
    match b {
        Body::Segs(pts) if pts.len() == 2 => {
            let (a, c) = (pts[0], pts[1]);
            let (dx, dy) = (c.0 - a.0, c.1 - a.1);
            let l2 = dx * dx + dy * dy;
            if l2 == 0.0 {
                return None;
            }
            let t = ((q.0 - a.0) * dx + (q.1 - a.1) * dy) / l2;
            Some((a.0 + t * dx, a.1 + t * dy))
        }
        Body::Circle(c, r) | Body::Arc { c, r, .. } => {
            let d = (q.0 - c.0).hypot(q.1 - c.1);
            (d > 0.0).then(|| (c.0 + (q.0 - c.0) * r / d, c.1 + (q.1 - c.1) * r / d))
        }
        _ => None,
    }
}

#[derive(Debug, Default)]
pub struct Tied {
    pub added: Vec<Value>,
    pub skipped: Vec<String>,
    pub left: LooseEnds,
}

/// Copies a coincident end onto its partner bit for bit, projects a pointOnCurve end onto the curve.
/// A pair seen from both ends, or a ring at one corner, is tied once.
pub fn tie(doc: &mut Doc, sketch: &str, tolerance: Option<f64>) -> Result<Tied, String> {
    let le = find(doc, sketch, tolerance)?;
    let tol = le.tolerance;
    let mut parent: BTreeMap<(String, i64), (String, i64)> = BTreeMap::new();
    for c in constraints(sketch_of(doc, sketch)?) {
        if c["type"] == json!("coincident") {
            if let (Some(a), Some(b)) = (ref_key(&c["e1"], &c["p1"]), ref_key(&c["e2"], &c["p2"])) {
                let (ra, rb) = (root(&mut parent, &a), root(&mut parent, &b));
                parent.insert(ra, rb);
            }
        }
    }
    let bodies: BTreeMap<String, Body> = {
        let f = sketch_of(doc, sketch)?;
        read_all(doc, f).into_iter().filter_map(|e| Some((e.id, e.body?))).collect()
    };
    let movable: BTreeSet<(String, i64)> = {
        let f = sketch_of(doc, sketch)?;
        read_all(doc, f)
            .iter()
            .flat_map(|e| e.ends.iter())
            .filter(|x| x.movable)
            .map(|x| (x.entity.clone(), x.p))
            .collect()
    };
    let at_now = |doc: &Doc, k: &(String, i64)| -> Option<P> {
        let f = sketch_of(doc, sketch).ok()?;
        read_all(doc, f).into_iter().find(|e| e.id == k.0)?.ends.into_iter().find(|x| x.p == k.1).map(|x| x.at)
    };
    let mut out = Tied::default();
    let Some(idx) = model::find_feature(doc, sketch).map(|(i, _)| i) else {
        return Err(format!("no feature '{sketch}'"));
    };
    for u in le.untied.iter().filter(|u| u.tieable) {
        let me = (u.entity.clone(), u.p);
        let (constraint, mover, to) = match &u.touches {
            Touch::End(e, p) => {
                let other = (e.clone(), *p);
                let (ra, rb) = (root(&mut parent, &me), root(&mut parent, &other));
                if ra == rb {
                    continue;
                }
                parent.insert(ra, rb);
                let (mover, target) =
                    if movable.contains(&me) { (me.clone(), other.clone()) } else { (other.clone(), me.clone()) };
                let Some(to) = at_now(doc, &target) else { continue };
                (json!({"type": "coincident", "e1": u.entity, "p1": u.p, "e2": e, "p2": p}), mover, to)
            }
            Touch::Curve(c) => {
                let Some(to) = bodies.get(c).and_then(|b| foot(b, u.at)) else { continue };
                (json!({"type": "pointOnCurve", "e": u.entity, "p": u.p, "curve": c}), me.clone(), to)
            }
        };
        let Some(f) = doc.get_mut("features").and_then(Value::as_array_mut).and_then(|a| a.get_mut(idx)) else { break };
        if !move_end(f, &mover.0, mover.1, to) {
            out.skipped.push(format!("{}:{}", u.entity, u.p));
            continue;
        }
        let cs = f.as_object_mut().expect("a feature is an object").entry("constraints").or_insert_with(|| json!([]));
        if let Some(a) = cs.as_array_mut() {
            a.push(constraint.clone());
        }
        out.added.push(constraint);
    }
    out.left = find(doc, sketch, Some(tol))?;
    Ok(out)
}

pub fn summary(sketch: &str, le: &LooseEnds) -> String {
    let tieable = le.untied.iter().filter(|u| u.tieable).count();
    format!(
        "{sketch}: {} open end{}, {} untied end{} ({} tieable), reach {:.4} mm\nlooseEnds: {}",
        le.open.len(),
        if le.open.len() == 1 { "" } else { "s" },
        le.untied.len(),
        if le.untied.len() == 1 { "" } else { "s" },
        tieable,
        le.tolerance,
        to_json(le)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(entities: Value, constraints: Value) -> Doc {
        let mut d = model::new_document();
        d.insert(
            "features".into(),
            json!([{"id": "s1", "type": "sketch", "plane": "XY", "entities": entities, "constraints": constraints}]),
        );
        d
    }

    fn line(id: &str, x1: f64, y1: f64, x2: f64, y2: f64) -> Value {
        json!({"type": "line", "id": id, "x1": x1, "y1": y1, "x2": x2, "y2": y2})
    }

    fn square(g: f64) -> Value {
        json!([
            line("a", 0.0, 0.0, 10.0, 0.0),
            line("b", 10.0, 0.0, 10.0, 8.0),
            line("c", 10.0, 8.0, 0.0, 8.0),
            line("d", 0.0, 8.0, 0.0, g)
        ])
    }

    #[test]
    fn a_square_drawn_without_snaps_is_all_untied_and_one_tie_closes_it() {
        let mut d = doc(square(4e-5), json!([]));
        let le = find(&d, "s1", Some(0.1)).unwrap();
        assert!(le.open.is_empty());
        assert_eq!(le.untied.len(), 8);
        let t = tie(&mut d, "s1", Some(0.1)).unwrap();
        assert_eq!(t.added.len(), 4);
        assert!(t.left.open.is_empty() && t.left.untied.is_empty(), "{:?}", t.left);
        let f = model::find_feature(&d, "s1").unwrap().1;
        let ents = f["entities"].as_array().unwrap();
        let (a, dd) = (&ents[0], &ents[3]);
        assert_eq!((a["x1"].as_f64(), a["y1"].as_f64()), (dd["x2"].as_f64(), dd["y2"].as_f64()));
    }

    #[test]
    fn a_lone_line_is_two_open_ends_and_a_t_near_miss_ties_onto_the_line() {
        let d = doc(json!([line("a", 0.0, 0.0, 10.0, 0.0), line("m", 5.0, 0.03, 5.0, 6.0)]), json!([]));
        let le = find(&d, "s1", Some(0.1)).unwrap();
        assert_eq!(le.open.len(), 3);
        assert_eq!(le.untied.len(), 1);
        assert_eq!(le.untied[0].touches, Touch::Curve("a".into()));
        let mut d = d;
        let t = tie(&mut d, "s1", Some(0.1)).unwrap();
        assert_eq!(t.added, vec![json!({"type": "pointOnCurve", "e": "m", "p": 0, "curve": "a"})]);
        let m = &model::find_feature(&d, "s1").unwrap().1["entities"][1];
        assert_eq!((m["x1"].as_f64(), m["y1"].as_f64()), (Some(5.0), Some(0.0)));
    }

    #[test]
    fn constraints_tie_ends_and_parameter_bound_ends_are_reported_but_not_moved() {
        let tied = doc(
            square(0.0),
            json!([
                {"type": "coincident", "e1": "a", "p1": 1, "e2": "b", "p2": 0},
                {"type": "coincident", "e1": "b", "p1": 1, "e2": "c", "p2": 0},
                {"type": "coincident", "e1": "c", "p1": 1, "e2": "d", "p2": 0},
                {"type": "coincident", "e1": "d", "p1": 1, "e2": "a", "p2": 0}
            ]),
        );
        let le = find(&tied, "s1", Some(0.1)).unwrap();
        assert!(le.open.is_empty() && le.untied.is_empty());
        let mut d = doc(
            json!([line("a", 0.0, 0.0, 10.0, 0.0), {"type": "line", "id": "b", "x1": "w", "y1": 0.05, "x2": 10.0, "y2": 8.0}]),
            json!([]),
        );
        d.insert("parameters".into(), json!({"w": 10.0}));
        let le = find(&d, "s1", Some(0.1)).unwrap();
        let b0 = le.untied.iter().find(|u| u.entity == "b").unwrap();
        assert!(b0.tieable, "a bound end ties by moving the free end it touches");
        let t = tie(&mut d, "s1", Some(0.1)).unwrap();
        assert_eq!(t.added.len(), 1);
        let ents = &model::find_feature(&d, "s1").unwrap().1["entities"];
        assert_eq!(ents[1]["x1"], json!("w"));
        assert_eq!((ents[0]["x2"].as_f64(), ents[0]["y2"].as_f64()), (Some(10.0), Some(0.05)));
    }

    #[test]
    fn a_tie_onto_construction_geometry_or_an_arc_centre_leaves_the_end_open() {
        let mut k = line("k", 5.0, 0.0, 5.0, 5.0);
        k["construction"] = json!(true);
        let arc =
            json!({"type": "arc", "id": "r", "x1": 25.0, "y1": 0.0, "x2": 15.0, "y2": 0.0, "mx": 20.0, "my": 5.0});
        let d = doc(
            json!([line("a", 0.0, 0.0, 5.0, 0.0), k, line("b", 30.0, 9.0, 20.0, 0.0), arc]),
            json!([
                {"type": "coincident", "e1": "a", "p1": 1, "e2": "k", "p2": 0},
                {"type": "coincident", "e1": "b", "p1": 1, "e2": "r", "p2": 2}
            ]),
        );
        let le = find(&d, "s1", Some(0.1)).unwrap();
        let open: BTreeSet<(String, i64)> = le.open.iter().map(|(e, p, _)| (e.clone(), *p)).collect();
        assert!(open.contains(&("a".into(), 1)), "{le:?}");
        assert!(open.contains(&("b".into(), 1)), "{le:?}");
    }

    #[test]
    fn two_ends_held_at_one_construction_end_are_tied_to_each_other() {
        let mut k = line("k", 5.0, 0.0, 9.0, 9.0);
        k["construction"] = json!(true);
        let d = doc(
            json!([line("a", 0.0, 0.0, 5.0, 0.0), line("b", 5.0, 0.0, 5.0, 5.0), k]),
            json!([
                {"type": "coincident", "e1": "a", "p1": 1, "e2": "k", "p2": 0},
                {"type": "coincident", "e1": "k", "p1": 0, "e2": "b", "p2": 0}
            ]),
        );
        let le = find(&d, "s1", Some(0.1)).unwrap();
        assert!(le.untied.is_empty(), "{le:?}");
        assert_eq!(le.open.len(), 2);
    }
}
