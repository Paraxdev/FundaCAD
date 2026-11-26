//! The sketch editor's model, free of GPUI: the open sketch, the drawing tools, snapping, the solve and what each
//! click writes, in FundaCAD 1's .funda sketch format. The viewport draws it and feeds it the cursor
//! (viewport/sketching.rs).

pub mod dims;
pub mod plane;
pub mod regions;
pub mod snap;
pub mod solve;

use std::collections::HashMap;

use fundacad_sketch::Entity;
use glam::DVec2;
use serde_json::{json, Map, Value};

pub use plane::Plane;
use snap::{point_relation, Snap};
use solve::{How, Solved};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Select,
    Line,
    Rectangle,
    Circle,
    Arc,
    Polygon,
    Dimension,
}

impl Tool {
    pub fn label(self) -> &'static str {
        match self {
            Tool::Select => "Select",
            Tool::Line => "Line",
            Tool::Rectangle => "Rectangle",
            Tool::Circle => "Circle",
            Tool::Arc => "Arc",
            Tool::Polygon => "Polygon",
            Tool::Dimension => "Dimension",
        }
    }
}

/// A point being dragged: the sketch as it was and the point grabbed.
#[derive(Clone, Debug)]
pub struct Drag {
    pub entities: Vec<Value>,
    pub from: DVec2,
    pub moved: bool,
}

pub struct Editor {
    pub feature: String,
    pub name: String,
    pub plane: Plane,
    pub entities: Vec<Value>,
    pub constraints: Vec<Value>,
    pub params: HashMap<String, f64>,
    pub tool: Tool,
    /// The next shape is drawn as construction.
    pub construction: bool,
    pub clicks: Vec<Snap>,
    pub cursor: Option<Snap>,
    pub solved: Solved,
    pub selected: Option<String>,
    pub drag: Option<Drag>,
    pub polygon_sides: u32,
}

pub type Feature = Map<String, Value>;

pub fn feature<'a>(doc: &'a Map<String, Value>, id: &str) -> Option<&'a Feature> {
    doc.get("features")?.as_array()?.iter().filter_map(Value::as_object).find(|f| f.get("id").and_then(Value::as_str) == Some(id))
}

pub fn feature_mut<'a>(doc: &'a mut Map<String, Value>, id: &str) -> Option<&'a mut Feature> {
    doc.get_mut("features")?
        .as_array_mut()?
        .iter_mut()
        .filter_map(Value::as_object_mut)
        .find(|f| f.get("id").and_then(Value::as_str) == Some(id))
}

fn list(f: &Feature, k: &str) -> Vec<Value> {
    f.get(k).and_then(Value::as_array).cloned().unwrap_or_default()
}

/// An id not yet in `taken`, `<prefix><n>`.
pub fn fresh_id(prefix: &str, taken: &[&str]) -> String {
    (1..).map(|n| format!("{prefix}{n}")).find(|id| !taken.contains(&id.as_str())).expect("an unused id")
}

fn ids(vals: &[Value]) -> Vec<&str> {
    vals.iter().filter_map(|v| v.get("id").and_then(Value::as_str)).collect()
}

/// A new sketch feature on `plane` (a named plane or a plane def), appended to the document. Its id.
pub fn add_sketch(doc: &mut Map<String, Value>, plane: Value) -> Result<String, String> {
    let fs = doc.entry("features").or_insert_with(|| json!([])).as_array_mut().ok_or("features is not a list")?;
    let taken: Vec<&str> = ids(fs);
    let id = fresh_id("sketch", &taken);
    let n = fs.iter().filter(|f| f.get("type").and_then(Value::as_str) == Some("sketch")).count() + 1;
    fs.push(json!({"id": id, "type": "sketch", "name": format!("Sketch {n}"), "plane": plane, "entities": []}));
    Ok(id)
}

fn polygon_points(e: &Value, params: &HashMap<String, f64>) -> Option<Vec<DVec2>> {
    let n = |k: &str| match e.get(k)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => params.get(s).copied(),
        _ => None,
    };
    let (x, y, r, sides, angle) = (n("x")?, n("y")?, n("radius")?, n("sides")?, n("angle").unwrap_or(0.0));
    let k = (sides.round() as usize).max(3);
    Some(
        (0..k)
            .map(|i| DVec2::new(x, y) + DVec2::from_angle(angle.to_radians() + i as f64 / k as f64 * std::f64::consts::TAU) * r)
            .collect(),
    )
}

fn r3(v: f64) -> f64 {
    (v * 1e3).round() / 1e3
}

impl Editor {
    pub fn open(doc: &Map<String, Value>, id: &str) -> Option<Self> {
        let f = feature(doc, id)?;
        if f.get("type").and_then(Value::as_str) != Some("sketch") {
            return None;
        }
        let plane = Plane::from_spec(f.get("plane")?)?;
        let constraints = with_ids(list(f, "constraints"));
        let mut e = Self {
            feature: id.to_string(),
            name: f.get("name").and_then(Value::as_str).unwrap_or(id).to_string(),
            plane,
            entities: list(f, "entities"),
            constraints,
            params: solve::params(doc),
            tool: Tool::Select,
            construction: false,
            clicks: Vec::new(),
            cursor: None,
            solved: Solved::default(),
            selected: None,
            drag: None,
            polygon_sides: 6,
        };
        e.resolve(false);
        Some(e)
    }

    /// Reads the document again after an undo or a panel edit, unless a drag is in flight.
    pub fn reload(&mut self, doc: &Map<String, Value>) -> bool {
        if self.drag.is_some() {
            return true;
        }
        let Some(f) = feature(doc, &self.feature) else { return false };
        let (es, cs) = (list(f, "entities"), with_ids(list(f, "constraints")));
        let params = solve::params(doc);
        if es != self.entities || cs != self.constraints || params != self.params {
            (self.entities, self.constraints, self.params) = (es, cs, params);
            self.resolve(false);
        }
        true
    }

    /// Solves the sketch, keeping the solved positions when `keep`.
    pub fn resolve(&mut self, keep: bool) {
        let (out, solved) = solve::solve(&self.entities, &self.constraints, &self.params, How::Plain, true);
        if keep && solved.ok {
            self.entities = out;
        }
        self.solved = solved;
    }

    /// The sketch's entities and constraints written into its feature.
    pub fn write(&self, doc: &mut Map<String, Value>) -> Result<(), String> {
        let f = feature_mut(doc, &self.feature).ok_or("the sketch is gone")?;
        f.insert("entities".into(), Value::Array(self.entities.clone()));
        if self.constraints.is_empty() {
            f.remove("constraints");
        } else {
            f.insert("constraints".into(), Value::Array(self.constraints.clone()));
        }
        Ok(())
    }

    pub fn is_construction(&self, id: &str) -> bool {
        self.entities
            .iter()
            .any(|e| e.get("id").and_then(Value::as_str) == Some(id) && e.get("construction").and_then(Value::as_bool) == Some(true))
    }

    pub fn construction_ids(&self) -> Vec<String> {
        self.entities
            .iter()
            .filter(|e| e.get("construction").and_then(Value::as_bool) == Some(true))
            .filter_map(|e| e.get("id").and_then(Value::as_str).map(String::from))
            .collect()
    }

    pub fn polygons(&self) -> Vec<(String, Vec<DVec2>)> {
        self.entities
            .iter()
            .filter(|e| e.get("type").and_then(Value::as_str) == Some("polygon"))
            .filter_map(|e| Some((e.get("id")?.as_str()?.to_string(), polygon_points(e, &self.params)?)))
            .collect()
    }

    /// The closed areas, polygons included.
    pub fn regions(&self) -> Vec<Vec<DVec2>> {
        let cons = self.construction_ids();
        let mut out = regions::regions(&self.solved.entities, &cons);
        out.extend(self.polygons().into_iter().filter(|(id, _)| !cons.contains(id)).map(|(_, p)| p));
        out
    }

    pub fn set_tool(&mut self, tool: Tool) {
        self.tool = tool;
        self.clicks.clear();
        self.selected = None;
    }

    /// Esc: drops the shape being drawn, else the tool, else nothing (false, the caller finishes the sketch).
    pub fn escape(&mut self) -> bool {
        if !self.clicks.is_empty() {
            self.clicks.clear();
            return true;
        }
        if self.tool != Tool::Select || self.selected.is_some() {
            self.set_tool(Tool::Select);
            return true;
        }
        false
    }

    pub fn hover(&mut self, raw: DVec2, px_per_mm: f64) {
        self.cursor = Some(if self.tool == Tool::Select || self.tool == Tool::Dimension {
            Snap::free(raw)
        } else {
            snap::snap(raw, &snap::candidates(&self.solved.entities), px_per_mm, true)
        });
    }

    fn taken(&self) -> Vec<&str> {
        ids(&self.entities).into_iter().chain(ids(&self.constraints)).collect()
    }

    fn add_entity(&mut self, prefix: &str, mut e: Value) -> String {
        let id = fresh_id(prefix, &self.taken());
        e["id"] = json!(id);
        if self.construction {
            e["construction"] = json!(true);
        }
        self.entities.push(e);
        id
    }

    fn relate(&mut self, id: &str, p: i64, at: &Snap) {
        if let Some(c) = point_relation(id, p, &at.r) {
            self.constraints.push(c);
        }
    }

    /// The shape the clicks so far and the cursor make, as document JSON without an id.
    pub fn preview(&self) -> Option<Value> {
        let end = self.cursor.as_ref()?.p;
        let a = self.clicks.first()?.p;
        Some(match (self.tool, self.clicks.len()) {
            (Tool::Line, _) => {
                let b = snap::axis_of(a, end).map_or(end, |(_, b)| b);
                json!({"type": "line", "x1": a.x, "y1": a.y, "x2": b.x, "y2": b.y})
            }
            (Tool::Rectangle, _) => {
                let (c, s) = ((a + end) / 2.0, (end - a).abs());
                json!({"type": "rectangle", "x": c.x, "y": c.y, "width": s.x, "height": s.y})
            }
            (Tool::Circle, _) => json!({"type": "circle", "x": a.x, "y": a.y, "radius": a.distance(end)}),
            (Tool::Polygon, _) => {
                let d = end - a;
                json!({"type": "polygon", "x": a.x, "y": a.y, "radius": d.length(), "sides": self.polygon_sides, "angle": d.y.atan2(d.x).to_degrees()})
            }
            (Tool::Arc, 1) => json!({"type": "line", "x1": a.x, "y1": a.y, "x2": end.x, "y2": end.y}),
            (Tool::Arc, _) => {
                let b = self.clicks[1].p;
                json!({"type": "arc", "x1": a.x, "y1": a.y, "x2": b.x, "y2": b.y, "mx": end.x, "my": end.y})
            }
            _ => return None,
        })
    }

    /// A click with the current tool. What the click added, as an undo label, None while the shape is unfinished.
    pub fn click(&mut self, raw: DVec2, px_per_mm: f64) -> Option<String> {
        self.hover(raw, px_per_mm);
        let at = self.cursor.clone()?;
        match self.tool {
            Tool::Select => {
                self.selected = self.nearest(raw, snap::PIXEL_TOL / px_per_mm);
                None
            }
            Tool::Dimension => {
                let id = self.nearest(raw, snap::PIXEL_TOL / px_per_mm)?;
                self.dimension(&id)
            }
            _ if self.clicks.is_empty() => {
                self.clicks.push(at);
                None
            }
            Tool::Line => {
                let a = self.clicks[0].clone();
                let (axis, b) = snap::axis_of(a.p, at.p).map_or((None, at.p), |(k, b)| (Some(k), b));
                if a.p.distance(b) < 1e-6 {
                    return None;
                }
                let r = |v: f64| r3(v);
                let id = self.add_entity("line", json!({"type": "line", "x1": r(a.p.x), "y1": r(a.p.y), "x2": r(b.x), "y2": r(b.y)}));
                self.relate(&id, 0, &a);
                if at.r.is_some() && axis.is_none_or(|_| at.p == b) {
                    self.relate(&id, 1, &at);
                }
                if let Some(k) = axis {
                    self.constraints.push(json!({"type": k, "line": id}));
                }
                let closes = at.r.is_some();
                self.clicks = if closes { Vec::new() } else { vec![Snap { p: b, kind: snap::Kind::Endpoint, r: Some(snap::Ref::Point { entity: id.clone(), at: 1 }), guides: Vec::new() }] };
                self.finish(&id)
            }
            Tool::Rectangle => {
                let a = self.clicks.remove(0);
                let (c, s) = ((a.p + at.p) / 2.0, (at.p - a.p).abs());
                if s.x < 1e-6 || s.y < 1e-6 {
                    return None;
                }
                let id = self.add_entity("rect", json!({"type": "rectangle", "x": r3(c.x), "y": r3(c.y), "width": r3(s.x), "height": r3(s.y)}));
                let corner = |p: DVec2| -> i64 {
                    match (p.x > c.x, p.y > c.y) {
                        (false, false) => 0,
                        (true, false) => 1,
                        (true, true) => 2,
                        (false, true) => 3,
                    }
                };
                self.relate(&id, corner(a.p), &a);
                self.relate(&id, corner(at.p), &at);
                self.finish(&id)
            }
            Tool::Circle | Tool::Polygon => {
                let a = self.clicks.remove(0);
                let rad = a.p.distance(at.p);
                if rad < 1e-6 {
                    return None;
                }
                let id = if self.tool == Tool::Circle {
                    let id = self.add_entity("circle", json!({"type": "circle", "x": r3(a.p.x), "y": r3(a.p.y), "radius": r3(rad)}));
                    self.relate(&id, 0, &a);
                    id
                } else {
                    let d = at.p - a.p;
                    let e = json!({"type": "polygon", "x": r3(a.p.x), "y": r3(a.p.y), "radius": r3(rad), "sides": self.polygon_sides, "angle": r3(d.y.atan2(d.x).to_degrees())});
                    self.add_entity("polygon", e)
                };
                self.finish(&id)
            }
            Tool::Arc if self.clicks.len() == 1 => {
                (self.clicks[0].p.distance(at.p) > 1e-6).then(|| self.clicks.push(at));
                None
            }
            Tool::Arc => {
                let (a, b) = (self.clicks[0].clone(), self.clicks[1].clone());
                self.clicks.clear();
                let r = r3;
                let e = json!({"type": "arc", "x1": r(a.p.x), "y1": r(a.p.y), "x2": r(b.p.x), "y2": r(b.p.y), "mx": r(at.p.x), "my": r(at.p.y)});
                let id = self.add_entity("arc", e);
                self.relate(&id, 0, &a);
                self.relate(&id, 1, &b);
                self.finish(&id)
            }
        }
    }

    fn finish(&mut self, id: &str) -> Option<String> {
        self.resolve(true);
        Some(format!("Add {}", dims::shape_name(&self.entities, id)))
    }

    /// The shape under `p` within `tol` mm, a rectangle side named `<rect>~<k>`.
    pub fn nearest(&self, p: DVec2, tol: f64) -> Option<String> {
        let seg = |a: DVec2, b: DVec2| {
            let d = b - a;
            let t = ((p - a).dot(d) / d.length_squared().max(1e-12)).clamp(0.0, 1.0);
            (a + d * t).distance(p)
        };
        let poly = |pts: &[DVec2], closed: bool| {
            let n = pts.len();
            (0..n - usize::from(!closed)).map(|i| seg(pts[i], pts[(i + 1) % n])).fold(f64::INFINITY, f64::min)
        };
        let mut best: Option<(String, f64)> = None;
        for e in &self.solved.entities {
            let (id, d) = match e {
                Entity::Rectangle { id, .. } => {
                    let pts = regions::outline(e).unwrap_or_default();
                    let (k, d) = (0..4).map(|k| (k, seg(pts[k], pts[(k + 1) % 4]))).min_by(|a, b| a.1.total_cmp(&b.1)).unwrap_or((0, f64::INFINITY));
                    (format!("{id}~{k}"), d)
                }
                Entity::Circle { id, x, y, radius } => (id.clone(), (DVec2::new(*x, *y).distance(p) - radius).abs()),
                _ => match regions::path(e) {
                    Some(pts) => (e.id().to_string(), poly(&pts, false)),
                    None => continue,
                },
            };
            if d <= tol && best.as_ref().is_none_or(|(_, b)| d < *b) {
                best = Some((id, d));
            }
        }
        for (id, pts) in self.polygons() {
            let d = poly(&pts, true);
            if d <= tol && best.as_ref().is_none_or(|(_, b)| d < *b) {
                best = Some((id, d));
            }
        }
        best.map(|(id, _)| id)
    }

    /// Adds the dimension the Dimension tool puts on a shape: a length, a diameter or an arc radius.
    pub fn dimension(&mut self, id: &str) -> Option<String> {
        let base = id.split('~').next().unwrap_or(id);
        let e = self.solved.entities.iter().find(|e| e.id() == base)?.clone();
        let dim_id = fresh_id("d", &self.taken());
        let c = match &e {
            Entity::Circle { radius, .. } => json!({"type": "diameter", "id": dim_id, "circle": id, "value": r3(radius * 2.0)}),
            Entity::Arc { .. } => json!({"type": "radius", "id": dim_id, "e": id, "value": r3(e.as_round()?.1)}),
            Entity::Rectangle { width, height, .. } => {
                let k: usize = id.split('~').nth(1)?.parse().ok()?;
                json!({"type": "distance", "id": dim_id, "line": id, "value": r3(if k % 2 == 0 { *width } else { *height })})
            }
            Entity::Line { x1, y1, x2, y2, .. } => {
                json!({"type": "distance", "id": dim_id, "line": id, "value": r3((x2 - x1).hypot(y2 - y1))})
            }
            _ => return None,
        };
        let key = c.get("line").or(c.get("circle")).or(c.get("e")).cloned();
        let ty = c["type"].clone();
        if self.constraints.iter().any(|o| o["type"] == ty && (o.get("line").or(o.get("circle")).or(o.get("e")).cloned() == key)) {
            return None;
        }
        self.constraints.push(c);
        self.resolve(true);
        Some(format!("Dimension {}", dims::shape_name(&self.entities, base)))
    }

    pub fn dims(&self, gap: f64) -> Vec<dims::Dim> {
        dims::dims(&self.entities, &self.constraints, &self.solved.entities, gap)
    }

    /// Sets the number at `key` (a `Dim::key`) and solves with drawn axes held. Refused when the sketch cannot take it.
    pub fn set_dim(&mut self, key: &str, value: f64) -> Result<String, String> {
        if !value.is_finite() || value <= 0.0 {
            return Err(format!("{value} is not a size"));
        }
        let mut parts = key.splitn(3, '.');
        let (Some(list), Some(id), Some(field)) = (parts.next(), parts.next(), parts.next()) else {
            return Err(format!("no dimension {key}"));
        };
        let (mut es, mut cs) = (self.entities.clone(), self.constraints.clone());
        let target = if list == "entities" { &mut es } else { &mut cs };
        let item = target.iter_mut().find(|e| e.get("id").and_then(Value::as_str) == Some(id)).ok_or_else(|| format!("no {id}"))?;
        item[field] = json!(value);
        let anchor = self.dims(0.0).into_iter().find(|d| d.key == key).map(|d| d.from);
        let (out, solved) = solve::solve(&es, &cs, &self.params, How::Typed(anchor), true);
        if !solved.ok || !solved.conflicts.is_empty() {
            return Err("the sketch cannot take that number, it conflicts with another constraint".into());
        }
        self.entities = out;
        self.constraints = cs;
        self.solved = solved;
        Ok(format!("Set {}", self.dims(0.0).iter().find(|d| d.key == key).map_or(key.to_string(), |d| d.label.to_lowercase())))
    }

    /// Construction on the selected shape, else for the next shapes drawn.
    pub fn toggle_construction(&mut self) -> Option<String> {
        let Some(sel) = self.selected.clone() else {
            self.construction = !self.construction;
            return None;
        };
        let base = sel.split('~').next().unwrap_or(&sel).to_string();
        let e = self.entities.iter_mut().find(|e| e.get("id").and_then(Value::as_str) == Some(base.as_str()))?;
        let on = e.get("construction").and_then(Value::as_bool) != Some(true);
        if on {
            e["construction"] = json!(true);
        } else if let Some(o) = e.as_object_mut() {
            o.remove("construction");
        }
        Some(format!("{} {}", if on { "Construction" } else { "Normal" }, dims::shape_name(&self.entities, &base)))
    }

    /// Horizontal or vertical on the selected line.
    pub fn constrain(&mut self, kind: &str) -> Option<String> {
        let line = self.selected.clone()?;
        if !matches!(self.solved.entities.iter().find(|e| e.id() == line), Some(Entity::Line { .. })) {
            return None;
        }
        self.constraints.push(json!({"type": kind, "line": line}));
        self.resolve(true);
        Some(format!("{} {}", if kind == "horizontal" { "Horizontal" } else { "Vertical" }, dims::shape_name(&self.entities, &line)))
    }

    /// Deletes the selected shape and every constraint naming it.
    pub fn delete_selected(&mut self) -> Option<String> {
        let sel = self.selected.take()?;
        let base = sel.split('~').next().unwrap_or(&sel).to_string();
        let name = dims::shape_name(&self.entities, &base);
        self.entities.retain(|e| e.get("id").and_then(Value::as_str) != Some(base.as_str()));
        let names = |c: &Value| {
            c.as_object().is_some_and(|o| {
                o.iter().filter(|(k, _)| *k != "id" && *k != "type").any(|(_, v)| v.as_str().is_some_and(|s| s.split('~').next() == Some(base.as_str())))
            })
        };
        self.constraints.retain(|c| !names(c));
        self.resolve(false);
        Some(format!("Delete {name}"))
    }

    /// Grabs the point nearest `p` within `tol` mm for a drag.
    pub fn drag_start(&mut self, p: DVec2, tol: f64) -> bool {
        let best = self
            .solved
            .entities
            .iter()
            .flat_map(|e| e.dim_ref_points())
            .map(|(_, q)| DVec2::new(q.x, q.y))
            .min_by(|a, b| a.distance(p).total_cmp(&b.distance(p)));
        let Some(from) = best.filter(|q| q.distance(p) <= tol) else { return false };
        self.drag = Some(Drag { entities: self.entities.clone(), from, moved: false });
        true
    }

    /// Solves the sketch with the grabbed point at `p`, live.
    pub fn drag_to(&mut self, p: DVec2) {
        let Some(d) = &mut self.drag else { return };
        d.moved = true;
        let (out, solved) = solve::solve(&d.entities, &self.constraints, &self.params, How::Drag(d.from, p), false);
        if solved.ok {
            self.entities = out;
            let freedom = self.solved.freedom.take();
            self.solved = Solved { freedom, ..solved };
        }
    }

    /// Ends a drag, the undo label when it moved anything.
    pub fn drag_end(&mut self) -> Option<String> {
        let d = self.drag.take()?;
        self.resolve(false);
        (d.moved && d.entities != self.entities).then(|| "Drag sketch point".to_string())
    }
}

/// Dimensions without an id get one, so the inspector and the labels can name them.
fn with_ids(mut cs: Vec<Value>) -> Vec<Value> {
    let mut taken: Vec<String> = cs.iter().filter_map(|c| c.get("id").and_then(Value::as_str).map(String::from)).collect();
    for c in cs.iter_mut().filter(|c| c.get("value").is_some() && c.get("id").is_none()) {
        let refs: Vec<&str> = taken.iter().map(String::as_str).collect();
        let id = fresh_id("d", &refs);
        c["id"] = json!(id);
        taken.push(id);
    }
    cs
}

/// A new extrude of the sketch, every closed area, `distance` mm. Its id.
pub fn add_extrude(doc: &mut Map<String, Value>, sketch: &str, distance: f64) -> Result<String, String> {
    add_feature(doc, "extrude", json!({"type": "extrude", "sketch": sketch, "distance": distance, "operation": "new"}))
}

/// A new full revolve of the sketch about `axis` (an `{origin, dir}` line in world mm). Its id.
pub fn add_revolve(doc: &mut Map<String, Value>, sketch: &str, axis: Value) -> Result<String, String> {
    add_feature(doc, "revolve", json!({"type": "revolve", "sketch": sketch, "axis": axis, "angle": 360, "operation": "new"}))
}

fn add_feature(doc: &mut Map<String, Value>, ty: &str, mut f: Value) -> Result<String, String> {
    let fs = doc.entry("features").or_insert_with(|| json!([])).as_array_mut().ok_or("features is not a list")?;
    let id = fresh_id(ty, &ids(fs));
    let n = fs.iter().filter(|f| f.get("type").and_then(Value::as_str) == Some(ty)).count() + 1;
    let mut word = ty.to_string();
    word[..1].make_ascii_uppercase();
    f["id"] = json!(id);
    f["name"] = json!(format!("{word} {n}"));
    fs.push(f);
    Ok(id)
}

#[cfg(test)]
mod tests;
