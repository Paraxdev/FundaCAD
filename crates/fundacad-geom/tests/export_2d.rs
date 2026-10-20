//! 2D export of a sketch or a flat face as DXF and SVG, read back through the
//! DXF and SVG importers.

use std::f64::consts::PI;
use std::path::PathBuf;
use std::sync::OnceLock;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, Ctx, NoWatch};
use fundacad_geom::export::flat::{self, Seg};
use fundacad_geom::features::sketch::local_curves;
use fundacad_geom::import::{self, blobstore::BlobStore};
use fundacad_geom::kernel::{self, Frame};
use fundacad_protocol::JobResult;
use serde_json::{json, Map, Value};

fn dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let d = std::env::temp_dir().join(format!("fundacad-export-2d-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    })
}

fn source_entities() -> Value {
    json!([
        {"id": "r", "type": "rectangle", "width": 40, "height": 20, "x": 20, "y": 10},
        {"id": "c", "type": "circle", "x": 30, "y": 10, "radius": 4},
        {"id": "a", "type": "arc", "x1": 50, "y1": 30, "x2": 60, "y2": 30, "mx": 55, "my": 35},
        {"id": "l", "type": "line", "x1": 50, "y1": 0, "x2": 60, "y2": 10},
        {"id": "s", "type": "slot", "x1": 50, "y1": 20, "x2": 60, "y2": 20, "width": 6},
        {"id": "e", "type": "ellipse", "x": 85, "y": 10, "rx": 15, "ry": 5},
        {"id": "sp", "type": "spline", "points": [{"x": 0, "y": 30}, {"x": 10, "y": 40}, {"x": 20, "y": 32}, {"x": 30, "y": 45}, {"x": 40, "y": 35}]},
        {"id": "k", "type": "line", "x1": -50, "y1": -50, "x2": 150, "y2": 150, "construction": true}
    ])
}

fn doc_of(features: Value) -> (Value, CadDocument) {
    let doc = json!({"version": 6, "parameters": {}, "features": features});
    let typed: CadDocument = serde_json::from_value(doc.clone()).unwrap();
    (doc, typed)
}

fn export(doc: &Value, extra: Value, file: &str) -> PathBuf {
    let path = dir().join(file);
    let mut req: Map<String, Value> = extra.as_object().unwrap().clone();
    req.insert("document".into(), doc.clone());
    req.insert("path".into(), json!(path.to_string_lossy()));
    match fundacad_geom::export::export_result(&req, &NoWatch) {
        JobResult::Json(m) => assert!(m.get("error").is_none(), "{m:?}"),
        _ => panic!("export did not answer with JSON"),
    }
    path
}

fn import(path: &PathBuf, fmt: &str) -> Map<String, Value> {
    let store = BlobStore::open(dir().join("blobs")).unwrap();
    import::import_geometry(&path.to_string_lossy(), fmt, &store).unwrap()
}

fn xy() -> Frame {
    Frame { origin: [0.0; 3], x: [1.0, 0.0, 0.0], y: [0.0, 1.0, 0.0], z: [0.0, 0.0, 1.0] }
}

/// A sketch's curves as exact segments, the rest sampled 20 times finer than the export.
fn segs_of_sketch(entities: &Value, fill: Option<&Value>) -> Vec<Seg> {
    let mut sk = json!({"id": "s1", "type": "sketch", "plane": "XY", "entities": entities});
    if let Some(f) = fill {
        sk["fillRule"] = f.clone();
    }
    let (_, typed) = doc_of(json!([sk]));
    let Some(fundacad_core::schema::Feature::Sketch(f)) = typed.feature("s1") else { panic!() };
    let (curves, _) = local_curves(&Ctx::with_params(&typed), f).unwrap();
    let mut budget = 10_000_000;
    curves.iter().filter_map(|e| flat::segs_of_edge(e, &xy(), 0.0005, &mut budget).unwrap()).collect()
}

fn imported_segs(r: &Map<String, Value>) -> Vec<Seg> {
    r["sketches"].as_array().unwrap().iter().flat_map(|s| segs_of_sketch(&s["entities"], s.get("fillRule"))).collect()
}

fn samples(s: &Seg, n: usize) -> Vec<[f64; 2]> {
    match s {
        Seg::Line(a, b) => (0..=n).map(|i| {
            let t = i as f64 / n as f64;
            [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
        }).collect(),
        Seg::Arc { c, r, a0, sweep } => (0..=n).map(|i| {
            let a = a0 + sweep * i as f64 / n as f64;
            [c[0] + r * a.cos(), c[1] + r * a.sin()]
        }).collect(),
        Seg::Circle { c, r } => (0..=n).map(|i| {
            let a = 2.0 * PI * i as f64 / n as f64;
            [c[0] + r * a.cos(), c[1] + r * a.sin()]
        }).collect(),
        Seg::Poly(p) => {
            let total = p.windows(2).count().max(1);
            (0..=n).map(|i| {
                let u = i as f64 / n as f64 * total as f64;
                let k = (u.floor() as usize).min(total - 1);
                let t = u - k as f64;
                [p[k][0] + (p[k + 1][0] - p[k][0]) * t, p[k][1] + (p[k + 1][1] - p[k][1]) * t]
            }).collect()
        }
    }
}

fn dist_to(p: [f64; 2], chords: &[[[f64; 2]; 2]]) -> f64 {
    chords.iter().map(|[a, b]| {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
        (p[0] - a[0] - t * dx).hypot(p[1] - a[1] - t * dy)
    }).fold(f64::MAX, f64::min)
}

fn chords(segs: &[Seg]) -> Vec<[[f64; 2]; 2]> {
    segs.iter().flat_map(|s| {
        let n = match s { Seg::Poly(p) => p.len() - 1, Seg::Line(..) => 1, _ => 2000 };
        let pts = match s { Seg::Poly(p) => p.clone(), _ => samples(s, n) };
        pts.windows(2).map(|w| [w[0], w[1]]).collect::<Vec<_>>()
    }).collect()
}

fn lo(segs: &[Seg]) -> [f64; 2] {
    segs.iter().flat_map(|s| samples(s, 400)).fold([f64::MAX; 2], |b, p| [b[0].min(p[0]), b[1].min(p[1])])
}

fn hi(segs: &[Seg]) -> [f64; 2] {
    segs.iter().flat_map(|s| samples(s, 400)).fold([f64::MIN; 2], |b, p| [b[0].max(p[0]), b[1].max(p[1])])
}

fn shifted(segs: &[Seg], d: [f64; 2]) -> Vec<Seg> {
    segs.iter().map(|s| match s {
        Seg::Line(p, q) => Seg::Line([p[0] + d[0], p[1] + d[1]], [q[0] + d[0], q[1] + d[1]]),
        Seg::Arc { c, r, a0, sweep } => Seg::Arc { c: [c[0] + d[0], c[1] + d[1]], r: *r, a0: *a0, sweep: *sweep },
        Seg::Circle { c, r } => Seg::Circle { c: [c[0] + d[0], c[1] + d[1]], r: *r },
        Seg::Poly(p) => Seg::Poly(p.iter().map(|q| [q[0] + d[0], q[1] + d[1]]).collect()),
    }).collect()
}

/// The larger of the two one sided distances, on 200 samples per curve, after
/// moving `b` so the two drawings' lower left corners meet when `align`.
fn hausdorff(a: &[Seg], b: &[Seg], align: bool) -> f64 {
    let shift = if align {
        let (la, lb) = (lo(a), lo(b));
        [la[0] - lb[0], la[1] - lb[1]]
    } else {
        [0.0; 2]
    };
    let moved = shifted(b, shift);
    let one = |x: &[Seg], y: &[Seg]| {
        let ch = chords(y);
        x.iter().flat_map(|s| samples(s, 200)).map(|p| dist_to(p, &ch)).fold(0.0, f64::max)
    };
    one(a, &moved).max(one(&moved, a))
}

fn kinds(r: &Map<String, Value>, kind: &str) -> Vec<Value> {
    r["sketches"].as_array().unwrap().iter().flat_map(|s| s["entities"].as_array().unwrap().clone())
        .filter(|e| e["type"] == kind).collect()
}

fn notes(r: &Map<String, Value>) -> Vec<String> {
    r.get("notes").and_then(Value::as_array).map(|a| a.iter().map(|n| n.as_str().unwrap().to_owned()).collect()).unwrap_or_default()
}

fn f(e: &Value, k: &str) -> f64 {
    e[k].as_f64().unwrap()
}

fn sketch_doc() -> Value {
    doc_of(json!([{"id": "s1", "type": "sketch", "name": "Outline", "plane": "XY", "entities": source_entities()}])).0
}

#[test]
fn a_sketch_exports_to_dxf_and_imports_back_the_same() {
    let p = export(&sketch_doc(), json!({"format": "dxf", "sketch": "s1", "tolerance": 0.01}), "sketch.dxf");
    let r = import(&p, "dxf");
    assert!(!notes(&r).iter().any(|n| n.contains("names no unit")), "{:?}", notes(&r));
    let circles = kinds(&r, "circle");
    assert_eq!(circles.len(), 1);
    let c = &circles[0];
    assert!((f(c, "x") - 30.0).abs() < 1e-6 && (f(c, "y") - 10.0).abs() < 1e-6 && (f(c, "radius") - 4.0).abs() < 1e-6, "{c}");
    let arcs = kinds(&r, "arc");
    assert_eq!(arcs.len(), 3, "the arc and the slot's two ends: {arcs:?}");
    let has_arc = arcs.iter().any(|a| {
        let ends = [(f(a, "x1"), f(a, "y1")), (f(a, "x2"), f(a, "y2"))];
        ends.contains(&(50.0, 30.0)) || ends.iter().any(|e| (e.0 - 50.0).abs() < 1e-6 && (e.1 - 30.0).abs() < 1e-6)
            && (f(a, "my") - 35.0).abs() < 1e-6
    });
    assert!(has_arc, "{arcs:?}");
    let lines = kinds(&r, "line");
    for (x1, y1, x2, y2) in [(0.0, 0.0, 40.0, 0.0), (50.0, 0.0, 60.0, 10.0), (50.0, 23.0, 60.0, 23.0)] {
        let hit = lines.iter().any(|l| {
            let (a, b) = ((f(l, "x1"), f(l, "y1")), (f(l, "x2"), f(l, "y2")));
            let eq = |p: (f64, f64), q: (f64, f64)| (p.0 - q.0).abs() < 1e-6 && (p.1 - q.1).abs() < 1e-6;
            (eq(a, (x1, y1)) && eq(b, (x2, y2))) || (eq(b, (x1, y1)) && eq(a, (x2, y2)))
        });
        assert!(hit, "no line ({x1},{y1}) ({x2},{y2})");
    }
    assert!(!lines.iter().any(|l| f(l, "x1") <= -50.0 || f(l, "x2") <= -50.0), "the construction line is drawn");
    let d = hausdorff(&segs_of_sketch(&source_entities(), None), &imported_segs(&r), false);
    assert!(d <= 0.01, "the DXF is {d} mm off the sketch");
}

#[test]
fn a_sketch_exports_to_svg_and_imports_back_the_same() {
    let p = export(&sketch_doc(), json!({"format": "svg", "sketch": "Outline", "tolerance": 0.01}), "sketch.svg");
    let text = std::fs::read_to_string(&p).unwrap();
    let attr = |k: &str| {
        let i = text.find(&format!(" {k}=\"")).unwrap() + k.len() + 3;
        text[i..i + text[i..].find('"').unwrap()].to_owned()
    };
    let src = segs_of_sketch(&source_entities(), None);
    let (l, u) = (lo(&src), hi(&src));
    let (w, h) = (u[0] - l[0] + 1.0, u[1] - l[1] + 1.0);
    let width: f64 = attr("width").trim_end_matches("mm").parse().unwrap();
    let height: f64 = attr("height").trim_end_matches("mm").parse().unwrap();
    assert!((width - w).abs() < 1e-6, "width {width}, want {w}");
    assert!((height - h).abs() < 1e-3, "height {height}, want {h}");
    let vb: Vec<f64> = attr("viewBox").split(' ').map(|v| v.parse().unwrap()).collect();
    assert!((vb[2] - width).abs() < 1e-9 && (vb[3] - height).abs() < 1e-9, "{vb:?}");
    let r = import(&p, "svg");
    let d = hausdorff(&src, &imported_segs(&r), true);
    assert!(d <= 0.01, "the SVG is {d} mm off the sketch");
}

fn plate_doc() -> Value {
    doc_of(json!([
        {"id": "s1", "type": "sketch", "plane": "XY", "fillRule": "evenodd", "entities": [
            {"id": "r", "type": "rectangle", "width": 40, "height": 20, "x": 20, "y": 10},
            {"id": "c", "type": "circle", "x": 30, "y": 10, "radius": 4}]},
        {"id": "x1", "type": "extrude", "sketch": "s1", "distance": 5, "operation": "new"}
    ])).0
}

fn top() -> Value {
    json!({"kind": "face", "by": "normal", "dir": [0, 0, 1], "body": "body1"})
}

fn plane() -> Value {
    json!({"origin": [0, 0, 5], "normal": [0, 0, 1], "xdir": [1, 0, 0]})
}

/// The area the imported sketch fills, extruded 1 mm.
fn filled_area(r: &Map<String, Value>) -> f64 {
    let s = &r["sketches"][0];
    let mut sk = json!({"id": "f1", "type": "sketch", "plane": "XY", "entities": s["entities"]});
    if let Some(fr) = s.get("fillRule") {
        sk["fillRule"] = fr.clone();
    }
    let (doc, typed) = doc_of(json!([sk, {"id": "f2", "type": "extrude", "sketch": "f1", "distance": 1, "operation": "new"}]));
    let b = builder::rebuild(&typed, &doc, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    assert!(b.errors.is_empty(), "{:?}", b.errors);
    b.bodies.iter().map(|b| kernel::volume(&b.shape)).sum()
}

#[test]
fn a_planar_face_exports_with_its_holes() {
    let want = 800.0 - 16.0 * PI;
    let p = export(&plate_doc(), json!({"format": "dxf", "face": top(), "plane": plane()}), "face.dxf");
    let r = import(&p, "dxf");
    assert_eq!((kinds(&r, "line").len(), kinds(&r, "circle").len()), (4, 1), "{r:?}");
    let c = &kinds(&r, "circle")[0];
    assert!((f(c, "x") - 30.0).abs() < 1e-6 && (f(c, "y") - 10.0).abs() < 1e-6, "{c}");
    let a = filled_area(&r);
    assert!(a > 799.0, "a DXF import fills the outline, the hole is a second region: {a}");

    let p = export(&plate_doc(), json!({"format": "svg", "face": top(), "plane": plane(), "svg": {"fill": true}}), "face.svg");
    let text = std::fs::read_to_string(&p).unwrap();
    assert_eq!(text.matches("<path").count(), 1, "{text}");
    assert_eq!(text.matches('Z').count(), 2, "{text}");
    let r = import(&p, "svg");
    let a = filled_area(&r);
    assert!((a - want).abs() < 1e-6, "area {a}, want {want}");

    let src = segs_of_sketch(&plate_doc()["features"][0]["entities"], None);
    let p = export(&plate_doc(), json!({"format": "svg", "face": top()}), "face-own-frame.svg");
    let r = import(&p, "svg");
    let d = hausdorff(&src, &imported_segs(&r), true);
    assert!(d <= 1e-6, "the face in its own frame is {d} mm off");

    // Without a plane the face is drawn about its area centre.
    let centre = [(800.0 * 20.0 - 16.0 * PI * 30.0) / want, 10.0];
    let expect = shifted(&src, [-centre[0], -centre[1]]);
    let p = export(&plate_doc(), json!({"format": "dxf", "face": top()}), "face-own-frame.dxf");
    let d = hausdorff(&expect, &imported_segs(&import(&p, "dxf")), false);
    assert!(d <= 1e-6, "the face in its own frame is {d} mm off its area centre");
    let text = std::fs::read_to_string(dir().join("face-own-frame.svg")).unwrap();
    let i = text.find(" viewBox=\"").unwrap() + 10;
    let vb: Vec<f64> = text[i..i + text[i..].find('"').unwrap()].split(' ').map(|v| v.parse().unwrap()).collect();
    assert!((vb[0] - (-centre[0] - 0.5)).abs() < 1e-6, "viewBox {vb:?} starts off the area centre");
}

#[test]
fn a_sketch_only_document_exports() {
    for fmt in ["dxf", "svg"] {
        let p = export(&sketch_doc(), json!({"format": fmt, "sketch": "s1"}), &format!("only.{fmt}"));
        assert!(std::fs::metadata(&p).unwrap().len() > 100);
    }
}

fn refusal(doc: &Value, extra: Value) -> String {
    let mut req: Map<String, Value> = extra.as_object().unwrap().clone();
    req.insert("document".into(), doc.clone());
    req.insert("path".into(), json!(dir().join("refused.dxf").to_string_lossy()));
    match fundacad_geom::export::export_result(&req, &NoWatch) {
        JobResult::Json(m) => m.get("error").and_then(|e| e["message"].as_str()).unwrap_or("").to_owned(),
        _ => panic!(),
    }
}

#[test]
fn a_curved_face_is_refused() {
    let (doc, _) = doc_of(json!([{"id": "c", "type": "cylinder", "radius": 5, "height": 10}]));
    let side = json!({"kind": "face", "by": "nearest", "point": [5, 0, 0], "body": "body1"});
    let m = refusal(&doc, json!({"format": "dxf", "face": side}));
    assert!(m.contains("needs a flat face"), "{m}");
    let m = refusal(&doc, json!({"format": "svg"}));
    assert!(m.contains("pick a sketch or a flat face"), "{m}");
}

