//! Volume, area, bounding box and the `measure` op, exact from BRepGProp, BRepBndLib and
//! BRepExtrema rather than a mesh, since `inspect` reports them and the tests assert on them.

use fundacad_engine::error_result;
use fundacad_protocol::JobResult;
use glam::{dvec3, DVec3};
use opencascade::extrema::ShapeDistance;
use opencascade::primitives::{Shape, ShapeType, Vertex};
use opencascade::select_access::{self as sa, ItemKind};
use opencascade_sys::face_query as fq;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::builder::{BuiltBody, FeatureError, Watch};
use crate::select::Resolver;

/// Axis-aligned bounding box in model units, `min`/`max` corners.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bbox {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

/// Volume of a closed shape; zero for open shells, faces and wires.
pub fn volume(shape: &Shape) -> f64 {
    shape.volume()
}

pub fn surface_area(shape: &Shape) -> f64 {
    shape.surface_area()
}

pub fn bbox(shape: &Shape) -> Option<Bbox> {
    let bb = opencascade::bounding_box::aabb(shape);
    if bb.is_void() {
        return None;
    }
    let (min, max) = (bb.min(), bb.max());
    Some(Bbox { min: [min.x, min.y, min.z], max: [max.x, max.y, max.z] })
}

/// One entity's size, radius and axis, or two entities' distance with both closest points, centre
/// or axis distance and angle. Raw values, the MCP side rounds them for the text.
pub fn measure_result(req: &Map<String, Value>, watch: &dyn Watch) -> JobResult {
    let _beat = crate::heartbeat::install(watch.heartbeat());
    let _cancel = crate::cancel::install(watch.cancel_token());
    let (_, r) = match crate::inspect::rebuild_request(req, watch) {
        Ok(x) => x,
        Err(e) => return e,
    };
    let errors = &r.errors;
    if r.bodies.is_empty() {
        if let Some(e) = errors.first() {
            let mut m = Map::new();
            m.insert("error".into(), e.wire());
            return JobResult::Json(m);
        }
        return error_result("the document has no bodies to measure");
    }
    let want = match req.get("want").filter(|v| !v.is_null()) {
        None => None,
        Some(v) => match v.as_str() {
            Some(w @ ("distance" | "angle" | "centres")) => Some(w),
            _ => return error_result(&format!("want is one of distance, angle or centres, got {v}")),
        },
    };
    let Some(a) = req.get("a").filter(|v| !v.is_null()) else {
        return error_result("give a, the thing to measure, and b to measure between two");
    };
    let a = match resolve("a", a, &r.bodies) {
        Ok(x) => x,
        Err(e) => return crate::stress::refuse(&e, errors),
    };
    let b = match req.get("b").filter(|v| !v.is_null()).map(|v| resolve("b", v, &r.bodies)) {
        None => None,
        Some(Ok(x)) => Some(x),
        Some(Err(e)) => return crate::stress::refuse(&e, errors),
    };
    let mut m = Map::new();
    let fa = a.describe();
    m.insert("a".into(), Value::Object(fa.json.clone()));
    match &b {
        None => {
            if let Some(w) = want {
                return error_result(&format!("{w} is measured between two things, give b too"));
            }
        }
        Some(b) => {
            let fb = b.describe();
            m.insert("b".into(), Value::Object(fb.json.clone()));
            match between(&a, &fa, b, &fb, want) {
                Ok(x) => {
                    m.insert("between".into(), Value::Object(x));
                }
                Err(e) => return error_result(&e),
            }
        }
    }
    if !errors.is_empty() {
        m.insert("errors".into(), Value::Array(errors.iter().map(FeatureError::wire).collect()));
    }
    JobResult::Json(m)
}

enum Geo {
    Face(Shape),
    Edge(Shape),
    Body,
    Point(DVec3),
}

struct Item<'a> {
    geo: Geo,
    body: Option<&'a BuiltBody>,
    index: Option<usize>,
}

fn dv(v: [f64; 3]) -> DVec3 {
    dvec3(v[0], v[1], v[2])
}

fn arr(v: DVec3) -> Value {
    json!([v.x, v.y, v.z])
}

fn find_body<'a>(at: &str, wanted: &str, bodies: &'a [BuiltBody]) -> Result<&'a BuiltBody, String> {
    bodies.iter().find(|b| b.id == wanted).or_else(|| bodies.iter().find(|b| b.name == wanted)).ok_or_else(|| {
        let have: Vec<String> = bodies.iter().map(|b| format!("{} ({})", b.id, b.name)).collect();
        format!("{at}: there is no body '{wanted}', the bodies are {}", have.join(", "))
    })
}

fn not_a_selector(at: &str) -> String {
    format!(
        "{at} is not a selector. Give a face or edge selector from inspect (detail:true, \
         selectors:true), {{body, face: n}}, {{body, edge: n}}, a body id, or {{point: [x, y, z]}}"
    )
}

/// `{body, face: 3}` or `{body, face: "F3"}`, the numbering inspect prints.
fn by_index<'a>(at: &str, o: &Map<String, Value>, body: &'a BuiltBody, face: bool) -> Option<Result<Item<'a>, String>> {
    let (key, label, kind) = if face { ("face", 'F', ItemKind::Face) } else { ("edge", 'E', ItemKind::Edge) };
    let raw = o.get(key)?;
    let n = raw.as_u64().map(|n| n as usize).or_else(|| {
        raw.as_str()
            .and_then(|s| s.strip_prefix(label).or_else(|| s.strip_prefix(label.to_ascii_lowercase())))
            .and_then(|s| s.parse().ok())
    });
    let all = sa::items(&body.shape, kind);
    Some(match n {
        Some(n) if n < all.len() => {
            let s = all[n].clone();
            Ok(Item { geo: if face { Geo::Face(s) } else { Geo::Edge(s) }, body: Some(body), index: Some(n) })
        }
        _ if all.is_empty() => Err(format!("{at}: {} has no {key}s", body.id)),
        _ => {
            Err(format!("{at}: {} has {} {key}s, {label}0 to {label}{}, got {raw}", body.id, all.len(), all.len() - 1))
        }
    })
}

fn resolve<'a>(at: &str, v: &Value, bodies: &'a [BuiltBody]) -> Result<Item<'a>, String> {
    if let Some(id) = v.as_str() {
        return Ok(Item { geo: Geo::Body, body: Some(find_body(at, id, bodies)?), index: None });
    }
    let Some(o) = v.as_object() else {
        return Err(not_a_selector(at));
    };
    if let Some(p) = o.get("point") {
        let xs: Vec<f64> = p.as_array().into_iter().flatten().filter_map(Value::as_f64).collect();
        let [x, y, z] = xs[..] else {
            return Err(format!("{at}: a point is [x, y, z] in mm, got {p}"));
        };
        return Ok(Item { geo: Geo::Point(dvec3(x, y, z)), body: None, index: None });
    }
    let kind = o.get("kind").map(|k| k.as_str());
    if matches!(kind, Some(k) if !matches!(k, Some("face" | "edge"))) {
        return Err(not_a_selector(at));
    }
    let body = match o.get("body") {
        Some(Value::String(id)) => find_body(at, id, bodies)?,
        Some(_) => return Err(format!("{at}: body is a body id such as body1")),
        None if bodies.len() == 1 => &bodies[0],
        None => return Err(format!("{at} names no body and there are {}, set its body", bodies.len())),
    };
    let Some(Some(kind)) = kind else {
        if let Some(x) = by_index(at, o, body, true).or_else(|| by_index(at, o, body, false)) {
            return x;
        }
        if o.len() == 1 && o.contains_key("body") {
            return Ok(Item { geo: Geo::Body, body: Some(body), index: None });
        }
        return Err(not_a_selector(at));
    };
    let face = kind == "face";
    let mut resolver = Resolver::new(None, None);
    let found = if face { resolver.faces(&body.shape, v) } else { resolver.edges(&body.shape, v) }
        .map_err(|e| format!("{at} could not be resolved, {}", crate::inspect::fail_text(&e)))?;
    match found.len() {
        0 => Err(format!(
            "{at} matches no {kind} of {}, it may have changed since inspect, take a fresh selector",
            body.id
        )),
        1 => {
            let one = found.into_iter().next().unwrap_or_else(Shape::empty);
            let list = sa::items(&body.shape, if face { ItemKind::Face } else { ItemKind::Edge });
            let index = list.iter().position(|s| s.is_same(&one));
            let geo = if face { Geo::Face(one) } else { Geo::Edge(one) };
            Ok(Item { geo, body: Some(body), index })
        }
        n => Err(format!("{at} picks {n} {kind}s of {}, measure takes one", body.id)),
    }
}

#[derive(Clone, Copy)]
enum Dir {
    Plane(DVec3),
    Line(DVec3),
}

/// One item as JSON, and what the pair measures need from it.
struct Facts {
    json: Map<String, Value>,
    what: String,
    centre: Option<DVec3>,
    axis: Option<(DVec3, DVec3)>,
    dir: Option<Dir>,
    plane: Option<(DVec3, DVec3)>,
}

fn project(p: DVec3, origin: DVec3, dir: DVec3) -> DVec3 {
    origin + dir * (p - origin).dot(dir)
}

impl Item<'_> {
    /// A body by its solids: BRepExtrema only sees a point inside a solid,
    /// not inside the compound that holds it.
    fn shapes(&self) -> Vec<Shape> {
        match &self.geo {
            Geo::Face(s) | Geo::Edge(s) => vec![s.clone()],
            Geo::Body => self.body.map_or(Vec::new(), |b| {
                let solids = b.shape.subshapes(ShapeType::Solid);
                if solids.is_empty() {
                    vec![b.shape.clone()]
                } else {
                    solids
                }
            }),
            Geo::Point(p) => vec![Shape::from(Vertex::new(*p))],
        }
    }

    fn describe(&self) -> Facts {
        let mut j = Map::new();
        let mut f = Facts { json: Map::new(), what: String::new(), centre: None, axis: None, dir: None, plane: None };
        let of_body = self.body.map_or(String::new(), |b| format!(" of {}", b.id));
        if let Some(b) = self.body {
            j.insert("body".into(), json!(b.id));
            j.insert("name".into(), json!(b.name));
        }
        if let Some(i) = self.index {
            j.insert("index".into(), json!(i));
        }
        match &self.geo {
            Geo::Point(p) => {
                j.insert("kind".into(), json!("point"));
                j.insert("at".into(), arr(*p));
                f.centre = Some(*p);
                f.what = "point".into();
            }
            Geo::Body => {
                j.insert("kind".into(), json!("body"));
                if let Some(b) = self.body {
                    let shape = &b.shape;
                    if let Some((v, c)) = crate::inspect::volume(shape) {
                        j.insert("volume".into(), json!(v));
                        j.insert("centreOfMass".into(), json!(c));
                    }
                    j.insert("area".into(), json!(surface_area(shape)));
                    let bb = crate::inspect::bbox(shape);
                    j.insert("bbox".into(), json!({"min": [bb[0], bb[1], bb[2]], "max": [bb[3], bb[4], bb[5]]}));
                    j.insert("size".into(), json!([bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]]));
                    f.what = format!("body, {}", b.id);
                }
            }
            Geo::Face(face) => self.face_facts(face, &of_body, &mut j, &mut f),
            Geo::Edge(edge) => self.edge_facts(edge, &of_body, &mut j, &mut f),
        }
        f.json = j;
        f
    }

    fn face_facts(&self, face: &Shape, of_body: &str, j: &mut Map<String, Value>, f: &mut Facts) {
        j.insert("kind".into(), json!("face"));
        let probe = sa::face_probe(face);
        let centroid = probe.and_then(|p| p.centre).map(dv);
        if let Some(a) = probe.and_then(|p| p.area) {
            j.insert("area".into(), json!(a));
        }
        if let Some(c) = centroid {
            j.insert("centroid".into(), arr(c));
        }
        let mut o = [0.0; 13];
        let kind = fq::FQ_surface(face.raw(), &mut o).unwrap_or(-1);
        let dir = dvec3(o[1], o[2], o[3]).normalize_or_zero();
        let loc = dvec3(o[4], o[5], o[6]);
        let surface = match kind {
            0 => "plane",
            1 => "cylinder",
            2 => "cone",
            3 => "sphere",
            4 => "torus",
            5 => "revolution",
            _ => probe.map_or("other", |p| p.surface.name()),
        };
        j.insert("surface".into(), json!(surface));
        match kind {
            0 => {
                // FQ_surface's plane axis ignores the face orientation, the probe's normal does not.
                if let Some(n) = probe.and_then(|p| p.normal).map(dv) {
                    j.insert("normal".into(), arr(n));
                    f.dir = Some(Dir::Plane(n));
                    f.plane = centroid.map(|c| (c, n));
                }
            }
            1 | 3 => {
                j.insert("radius".into(), json!(o[7]));
                j.insert("diameter".into(), json!(2.0 * o[7]));
            }
            2 => {
                j.insert("semiAngle".into(), json!(o[7].to_degrees()));
                j.insert("apex".into(), json!([o[9], o[10], o[11]]));
            }
            4 => {
                j.insert("majorRadius".into(), json!(o[7]));
                j.insert("minorRadius".into(), json!(o[8]));
            }
            _ => {}
        }
        if kind == 3 {
            j.insert("centre".into(), arr(loc));
            f.centre = Some(loc);
        }
        if matches!(kind, 1 | 2 | 4 | 5) && dir != DVec3::ZERO {
            // A cylinder's location is the base of its axis, the middle of the face reads better.
            let origin = match (kind, centroid) {
                (4, _) | (_, None) => loc,
                (_, Some(c)) => project(c, loc, dir),
            };
            j.insert("axis".into(), json!({"origin": arr(origin), "dir": arr(dir)}));
            f.axis = Some((origin, dir));
            f.dir = Some(Dir::Line(dir));
        }
        f.what = format!("{surface} face{of_body}");
    }

    fn edge_facts(&self, edge: &Shape, of_body: &str, j: &mut Map<String, Value>, f: &mut Facts) {
        j.insert("kind".into(), json!("edge"));
        let probe = sa::edge_probe(edge);
        let curve = probe.map_or("other", |p| p.curve.name());
        j.insert("curve".into(), json!(curve));
        let length = probe.and_then(|p| p.length);
        if let Some(l) = length {
            j.insert("length".into(), json!(l));
        }
        if let Some((s, e)) = probe.and_then(|p| p.ends) {
            j.insert("start".into(), json!(s));
            j.insert("end".into(), json!(e));
            let d = (dv(e) - dv(s)).normalize_or_zero();
            if curve == "line" && d != DVec3::ZERO {
                j.insert("dir".into(), arr(d));
                f.dir = Some(Dir::Line(d));
            }
        }
        let mut c = [0.0; 7];
        if matches!(fq::FQ_edge_circle(edge.raw(), &mut c), Ok(true)) {
            let dir = dvec3(c[0], c[1], c[2]).normalize_or_zero();
            let (centre, r) = (dvec3(c[3], c[4], c[5]), c[6]);
            j.insert("radius".into(), json!(r));
            j.insert("diameter".into(), json!(2.0 * r));
            j.insert("centre".into(), arr(centre));
            j.insert("axis".into(), json!({"origin": arr(centre), "dir": arr(dir)}));
            let closed = fq::FQ_edge_closed(edge.raw()).unwrap_or(false);
            let arc = if closed { 360.0 } else { length.map_or(0.0, |l| (l / r).to_degrees()) };
            j.insert("arc".into(), json!(arc));
            f.centre = Some(centre);
            f.axis = Some((centre, dir));
            f.dir = Some(Dir::Line(dir));
        }
        f.what = format!("{curve} edge{of_body}");
    }
}

fn degrees(cos: f64) -> f64 {
    cos.clamp(-1.0, 1.0).acos().to_degrees()
}

fn angle(fa: &Facts, fb: &Facts) -> Option<Map<String, Value>> {
    let mut m = Map::new();
    match (fa.dir?, fb.dir?) {
        (Dir::Plane(na), Dir::Plane(nb)) => {
            m.insert("value".into(), json!(degrees(na.dot(nb).abs())));
            m.insert("normals".into(), json!(degrees(na.dot(nb))));
            m.insert("how".into(), json!("between the planes"));
        }
        (Dir::Plane(n), Dir::Line(d)) | (Dir::Line(d), Dir::Plane(n)) => {
            m.insert("value".into(), json!(90.0 - degrees(n.dot(d).abs())));
            m.insert("how".into(), json!("between the line and the plane"));
        }
        (Dir::Line(da), Dir::Line(db)) => {
            m.insert("value".into(), json!(degrees(da.dot(db).abs())));
            m.insert("how".into(), json!("between the lines"));
        }
    }
    Some(m)
}

fn segment(m: &mut Map<String, Value>, from: DVec3, to: DVec3) {
    m.insert("value".into(), json!(from.distance(to)));
    m.insert("from".into(), arr(from));
    m.insert("to".into(), arr(to));
    m.insert("delta".into(), arr(to - from));
}

/// The closest points of two lines, each a point and a unit direction.
fn line_to_line(oa: DVec3, da: DVec3, ob: DVec3, db: DVec3) -> (DVec3, DVec3) {
    let w = oa - ob;
    let b = da.dot(db);
    let (d, e) = (da.dot(w), db.dot(w));
    let denom = 1.0 - b * b;
    if denom < 1e-12 {
        return (project(ob, oa, da), ob);
    }
    let s = (b * e - d) / denom;
    let t = (e - b * d) / denom;
    (oa + da * s, ob + db * t)
}

fn centres(fa: &Facts, fb: &Facts) -> Option<Map<String, Value>> {
    let mut m = Map::new();
    let how = match (fa.centre, fb.centre, fa.axis, fb.axis) {
        (Some(a), Some(b), _, _) => {
            segment(&mut m, a, b);
            "centre to centre"
        }
        (_, _, Some((oa, da)), Some((ob, db))) => {
            let (from, to) = line_to_line(oa, da, ob, db);
            segment(&mut m, from, to);
            m.insert("parallel".into(), json!(da.cross(db).length() < 1e-9));
            "axis to axis"
        }
        (Some(c), _, _, Some((o, d))) => {
            segment(&mut m, c, project(c, o, d));
            "centre to axis"
        }
        (_, Some(c), Some((o, d)), _) => {
            segment(&mut m, project(c, o, d), c);
            "axis to centre"
        }
        _ => return None,
    };
    m.insert("how".into(), json!(how));
    Some(m)
}

fn distance(a: &Item, b: &Item) -> Result<Map<String, Value>, String> {
    let mut m = Map::new();
    if let (Geo::Point(p), Geo::Point(q)) = (&a.geo, &b.geo) {
        segment(&mut m, *p, *q);
        m.insert("ties".into(), json!(1));
        m.insert("inside".into(), json!(false));
        return Ok(m);
    }
    let mut best: Option<ShapeDistance> = None;
    let mut inside = false;
    for first in a.shapes() {
        for second in b.shapes() {
            let d = first.distance(&second, 0.0).map_err(|e| format!("the distance could not be computed, {e:?}"))?;
            inside |= d.inner_solution;
            if best.as_ref().map_or(true, |b| d.value < b.value) {
                best = Some(d);
            }
        }
    }
    let d = best.ok_or("there is nothing to measure between")?;
    let pair = d.solutions.first().ok_or("the distance found no closest points")?;
    segment(&mut m, dv(pair.on_first.point.to_array()), dv(pair.on_second.point.to_array()));
    m.insert("value".into(), json!(if inside { 0.0 } else { d.value }));
    m.insert("ties".into(), json!(d.solutions.len()));
    m.insert("inside".into(), json!(inside));
    Ok(m)
}

fn lacks(at: &str, facts: &Facts, takes: &str) -> String {
    format!("{at} is a {}, {takes}", facts.what)
}

fn between(a: &Item, fa: &Facts, b: &Item, fb: &Facts, want: Option<&str>) -> Result<Map<String, Value>, String> {
    let mut m = Map::new();
    let all = want.is_none();
    if all || want == Some("distance") {
        m.insert("distance".into(), Value::Object(distance(a, b)?));
        if let (Some((ca, na)), Some((cb, nb))) = (fa.plane, fb.plane) {
            if na.cross(nb).length() < 1e-9 {
                m.insert("planeGap".into(), json!({"value": (cb - ca).dot(na).abs()}));
            }
        }
    }
    if all || want == Some("centres") {
        match centres(fa, fb) {
            Some(c) => {
                m.insert("centres".into(), Value::Object(c));
            }
            None if !all => {
                let (at, facts) = if fa.centre.is_none() && fa.axis.is_none() { ("a", fa) } else { ("b", fb) };
                return Err(lacks(at, facts, "centres takes a sphere, a circle, a point or the axis of a round face"));
            }
            None => {}
        }
    }
    if all || want == Some("angle") {
        match angle(fa, fb) {
            Some(x) => {
                m.insert("angle".into(), Value::Object(x));
            }
            None if !all => {
                let (at, facts) = if fa.dir.is_none() { ("a", fa) } else { ("b", fb) };
                return Err(lacks(
                    at,
                    facts,
                    "an angle takes a planar face, a straight edge or the axis of a round face (cylinder, cone, circle)",
                ));
            }
            None => {}
        }
    }
    Ok(m)
}
