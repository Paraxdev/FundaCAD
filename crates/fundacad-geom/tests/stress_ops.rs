//! The `stress` op on documents: a cantilever against beam theory, a pressure load, the
//! refusals, the warnings, then over the protocol. Meshes stay coarse (2.5 to 3 mm) so the
//! debug build is quick.

use base64::Engine;
use fundacad_geom::builder::NoWatch;
use fundacad_geom::jobs::GeomJobs;
use fundacad_geom::kernel;
use fundacad_geom::stress::stress_result;
use fundacad_protocol::JobResult;
use serde_json::{json, Value};

fn json_of(r: JobResult) -> Value {
    match r {
        JobResult::Json(m) => Value::Object(m),
        _ => panic!("expected a JSON result"),
    }
}

/// A 100 x 10 x 10 bar along x from x = 0 to 100 (the box is centred, so it is moved).
fn bar() -> Value {
    json!({"features": [
        {"id": "b", "type": "box", "length": 100, "width": 10, "height": 10},
        {"id": "m", "type": "move", "dx": 50, "bodies": ["body1"]},
    ]})
}

fn face(dir: [f64; 3]) -> Value {
    json!({"kind": "face", "by": "normal", "dir": dir})
}

fn run(req: Value) -> Value {
    let Value::Object(m) = req else {
        panic!("a request is an object")
    };
    json_of(stress_result(&m, &NoWatch))
}

fn cantilever(material: Value, size: f64) -> Value {
    json!({
        "document": bar(), "body": "body1",
        "fixed": [face([-1.0, 0.0, 0.0])],
        "loads": [{"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, -100]}],
        "material": material, "size": size,
    })
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
}

fn vec3(v: &Value) -> [f64; 3] {
    std::array::from_fn(|k| num(&v[k]))
}

fn error_of(v: &Value) -> String {
    v["error"]["message"]
        .as_str()
        .unwrap_or_else(|| panic!("expected an error: {v}"))
        .to_string()
}

#[test]
fn a_cantilever_matches_timoshenko_and_balances() {
    let r = run(cantilever(json!("aluminium"), 2.5));
    assert!(r.get("error").is_none(), "{r}");
    assert_eq!(r["body"], "body1");
    assert_eq!(
        r["material"],
        json!({"name": "aluminium 6061-T6", "E": 69000.0, "nu": 0.33, "yield": 275.0, "density": 2.7})
    );

    // Tip deflection with shear: P L^3 / 3 E I + P L / k G A, k = 5/6 for a rectangle.
    let (p, l, e, nu): (f64, f64, f64, f64) = (100.0, 100.0, 69000.0, 0.33);
    let (i, a) = (10.0 * 10.0f64.powi(3) / 12.0, 100.0);
    let g = e / (2.0 * (1.0 + nu));
    let want = p * l.powi(3) / (3.0 * e * i) + p * l / (5.0 / 6.0 * g * a);
    let got = num(&r["maxDisplacement"]["value"]);
    assert!(
        (got - want).abs() < 0.05 * want,
        "tip deflection {got} mm vs {want} mm"
    );
    let tip = vec3(&r["maxDisplacement"]["vector"]);
    assert!(tip[2] < 0.0 && tip[2].abs() > 0.99 * got, "{tip:?}");
    assert!(num(&r["maxDisplacement"]["at"][0]) > 99.0, "{r}");

    let applied = vec3(&r["applied"]);
    let reaction = vec3(&r["reaction"]);
    assert_eq!(applied, [0.0, 0.0, -100.0]);
    assert_eq!(r["weight"], Value::Null);
    assert_eq!(r["reactions"].as_array().map(Vec::len), Some(1), "{r}");
    assert_eq!(vec3(&r["reactions"][0]), reaction);
    for k in 0..3 {
        assert!(
            (applied[k] + reaction[k]).abs() < 1e-6 * 100.0,
            "{applied:?} vs {reaction:?}"
        );
    }

    let peak = num(&r["maxVonMises"]["value"]);
    // M c / I at the root is 60 MPa; the corner where the fixture ends reads higher.
    assert!(peak > 50.0 && peak < 200.0, "{peak}");
    let sf = num(&r["safetyFactor"]);
    assert!(
        (sf - 275.0 / peak).abs() < 1e-5 * sf,
        "{sf} vs {}",
        275.0 / peak
    );
    assert!(r["maxVonMises"]["face"].is_u64(), "{r}");
    let warnings: Vec<&str> = r["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("is where a fixed face ends")),
        "{warnings:?}"
    );
    assert!(
        !warnings.iter().any(|w| w.contains("deflection")),
        "{warnings:?}"
    );
    assert!(
        !warnings.iter().any(|w| w.contains("printed")),
        "{warnings:?}"
    );

    let mesh = &r["mesh"];
    assert_eq!(num(&mesh["size"]), 2.5);
    assert!(
        num(&mesh["elements"]) > 1000.0 && num(&mesh["nodes"]) > num(&mesh["elements"]),
        "{mesh}"
    );
    assert!(num(&mesh["minDihedral"]) > 9.0, "{mesh}");

    // One value per surface vertex, one face id per triangle, the six faces of the bar.
    let s = &r["surface"];
    let n = s["positions"].as_array().unwrap().len();
    assert_eq!(n % 3, 0);
    assert_eq!(s["vonMises"].as_array().unwrap().len(), n / 3);
    assert_eq!(s["displacement"].as_array().unwrap().len(), n);
    let tris = s["indices"].as_array().unwrap().len();
    assert_eq!(tris % 3, 0);
    assert_eq!(s["faceIds"].as_array().unwrap().len(), tris / 3);
    assert!(s["indices"]
        .as_array()
        .unwrap()
        .iter()
        .all(|i| (num(i) as usize) < n / 3));
    let mut ids: Vec<u64> = s["faceIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap())
        .collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids, vec![0, 1, 2, 3, 4, 5]);
    assert!(r.get("errors").is_none(), "{r}");

    // The same request gives the same bits.
    assert_eq!(run(cantilever(json!("aluminium"), 2.5)), r);
}

#[test]
fn a_pressure_on_the_top_pushes_down_and_balances() {
    let r = run(json!({
        "document": bar(), "body": "Box",
        "fixed": face([-1.0, 0.0, 0.0]),
        "loads": [{"faces": face([0.0, 0.0, 1.0]), "pressure": 0.1}],
        "material": "PLA", "size": 3,
    }));
    assert!(r.get("error").is_none(), "{r}");
    // 0.1 MPa on 100 x 10 mm is 100 N, pushing into the top face.
    let applied = vec3(&r["applied"]);
    let reaction = vec3(&r["reaction"]);
    assert!(
        applied[0].abs() < 1e-9 && applied[1].abs() < 1e-9,
        "{applied:?}"
    );
    assert!((applied[2] + 100.0).abs() < 1e-6 * 100.0, "{applied:?}");
    for k in 0..3 {
        assert!(
            (applied[k] + reaction[k]).abs() < 1e-6 * 100.0,
            "{applied:?} vs {reaction:?}"
        );
    }
    // A uniform load q on a cantilever bends its tip q L^4 / 8 E I.
    let want = 1.0 * 100.0f64.powi(4) / (8.0 * 3500.0 * (10.0 * 1000.0 / 12.0));
    let got = num(&r["maxDisplacement"]["value"]);
    assert!((got - want).abs() < 0.1 * want, "{got} vs {want}");
    assert!(num(&r["maxDisplacement"]["vector"][2]) < 0.0);
    let warnings = r["warnings"].to_string();
    assert!(
        warnings.contains("not trustworthy") && warnings.contains("printed parts"),
        "{warnings}"
    );
    assert_eq!(r["material"]["name"], "PLA");
}

#[test]
fn the_refusals_say_why() {
    let base = || cantilever(json!("PETG"), 3.0);
    let with = |key: &str, v: Value| {
        let mut req = base();
        req[key] = v;
        error_of(&run(req))
    };

    let unknown = with("body", json!("Spring"));
    assert!(
        unknown.contains("there is no body 'Spring'") && unknown.contains("body1 (Box)"),
        "{unknown}"
    );
    let none = with("fixed", json!([]));
    assert!(none.contains("no face is fixed"), "{none}");
    let nothing = with("fixed", json!([face([0.0, 0.6, 0.8])]));
    assert!(
        nothing.contains("fixed[0] matches no face of body1"),
        "{nothing}"
    );
    let other = with(
        "fixed",
        json!({"kind": "face", "by": "normal", "dir": [-1, 0, 0], "body": "body7"}),
    );
    assert!(other.contains("picks a face of body7"), "{other}");
    let no_load = with("loads", json!([]));
    assert!(no_load.contains("there is no load"), "{no_load}");
    let both = with(
        "loads",
        json!([{"faces": face([1.0, 0.0, 0.0]), "force": [0, 0, 1], "pressure": 1}]),
    );
    assert!(both.contains("load 1 (loads[0]) has both"), "{both}");
    let wood = with("material", json!("oak"));
    assert!(
        wood.contains("no material called 'oak'") && wood.contains("PLA"),
        "{wood}"
    );
    let size = with("size", json!(-1));
    assert!(size.contains("size must be a number above 0"), "{size}");
    let few = with("maxElements", json!(20));
    assert!(
        few.contains("could not be meshed") && few.contains("allow more elements"),
        "{few}"
    );

    let mut req = base();
    req.as_object_mut().unwrap().remove("body");
    assert!(error_of(&run(req)).contains("name the body"));
}

#[test]
fn a_body_of_two_solids_is_refused() {
    let doc = json!({"features": [
        {"id": "a", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "b", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "m", "type": "move", "dx": 30, "bodies": ["body2"]},
        {"id": "u", "type": "boolean", "operation": "union", "target": "body1", "tools": ["body2"]},
    ]});
    let r = run(json!({
        "document": doc, "body": "body1",
        "fixed": face([-1.0, 0.0, 0.0]),
        "loads": [{"faces": face([1.0, 0.0, 0.0]), "force": [0, 0, -1]}],
        "size": 3,
    }));
    let msg = error_of(&r);
    assert!(msg.contains("body1 is 2 separate solids"), "{r}");
}

#[test]
fn a_feature_that_failed_is_reported_with_the_answer() {
    let mut doc = bar();
    doc["features"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "bad", "type": "box", "length": -1, "width": 1, "height": 1}));
    let mut req = cantilever(json!("ABS"), 3.0);
    req["document"] = doc;
    let r = run(req.clone());
    assert!(r.get("error").is_none(), "{r}");
    assert_eq!(r["errors"][0]["feature_id"], "bad", "{r}");
    // A refusal names the failure in its message and carries its feature id.
    req["body"] = json!("Bracket");
    let r = run(req);
    let msg = error_of(&r);
    assert!(
        msg.contains("there is no body 'Bracket'")
            && msg.contains("a feature failed, the first (bad): "),
        "{msg}"
    );
    assert_eq!(r["error"]["feature_id"], "bad", "{r}");
}

#[test]
fn the_op_answers_over_the_protocol() {
    use fundacad_engine::{Engine, Outbox};
    use fundacad_protocol::Message;
    use std::sync::{mpsc, Arc, Mutex};

    struct Chan(Mutex<mpsc::Sender<String>>);
    impl Outbox for Chan {
        fn send(&self, msgs: &mut dyn Iterator<Item = Message>) -> std::io::Result<()> {
            for m in msgs {
                if let Message::Text(t) = m {
                    let _ = self.0.lock().unwrap().send(t);
                }
            }
            Ok(())
        }
    }
    let (tx, rx) = mpsc::channel();
    let engine = Engine::start(GeomJobs, Arc::new(Chan(Mutex::new(tx))));
    let reply = |id: i64| -> Value {
        loop {
            let v: Value = serde_json::from_str(&rx.recv().unwrap()).unwrap();
            if v["id"] == id && v.get("ok").is_some() {
                return v;
            }
        }
    };
    let mut req = cantilever(
        json!({"E": 2000, "nu": 0.3, "yield": 30, "name": "my PETG"}),
        3.0,
    );
    req["id"] = json!(1);
    req["op"] = json!("stress");
    engine.handle(Message::Text(req.to_string()));
    let r = reply(1)["result"].clone();
    assert_eq!(
        r["material"],
        json!({"name": "my PETG", "E": 2000.0, "nu": 0.3, "yield": 30.0, "density": null}),
        "{r}"
    );
    assert!(num(&r["maxVonMises"]["value"]) > 0.0);
    assert!(num(&r["safetyFactor"]) > 0.0);
    let keys: Vec<&str> = r.as_object().unwrap().keys().map(String::as_str).collect();
    for k in [
        "body",
        "name",
        "material",
        "mesh",
        "maxVonMises",
        "maxDisplacement",
        "safetyFactor",
        "applied",
        "weight",
        "reaction",
        "reactions",
        "warnings",
        "surface",
    ] {
        assert!(keys.contains(&k), "{k} missing from {keys:?}");
    }

    engine.handle(Message::Text(
        json!({"id": 2, "op": "stress", "document": bar(), "body": "body9"}).to_string(),
    ));
    // An error reply: {id, ok: false, error: {message}}, with no feature id as none failed.
    let r = reply(2);
    assert_eq!(r["ok"], false, "{r}");
    assert!(
        r["error"]["message"]
            .as_str()
            .unwrap()
            .contains("there is no body 'body9'"),
        "{r}"
    );
    assert!(r["error"].get("feature_id").is_none(), "{r}");
}

fn warnings_of(r: &Value) -> String {
    assert!(r.get("error").is_none(), "{r}");
    r["warnings"].to_string()
}

#[test]
fn the_peak_face_is_the_one_it_lies_on() {
    // The peak sits at the root, inside one face of the bar, where the surface triangles
    // touching it are mostly that face's and one or two of the face beside it.
    let r = run(cantilever(json!("steel"), 3.0));
    assert!(r.get("error").is_none(), "{r}");
    let at = vec3(&r["maxVonMises"]["at"]);
    assert!(at[0] < 3.0, "{at:?}");
    // The plane of the bar's sides it lies in, and not on an edge where two meet.
    let planes = [
        (0, 0.0),
        (0, 100.0),
        (1, -5.0),
        (1, 5.0),
        (2, -5.0),
        (2, 5.0),
    ];
    let on: Vec<(usize, f64)> = planes
        .into_iter()
        .filter(|&(a, c)| (at[a] - c).abs() < 1e-6)
        .collect();
    let [(axis, c)] = on[..] else {
        panic!("the peak at {at:?} is not inside one face");
    };
    // That face's id: the face of the surface triangles lying in that plane.
    let s = &r["surface"];
    let p: Vec<f64> = s["positions"].as_array().unwrap().iter().map(num).collect();
    let idx: Vec<usize> = s["indices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| num(i) as usize)
        .collect();
    let face = idx
        .chunks_exact(3)
        .position(|t| t.iter().all(|&v| (p[3 * v + axis] - c).abs() < 1e-6))
        .map(|t| s["faceIds"][t].clone())
        .expect("a triangle in that plane");
    assert_eq!(r["maxVonMises"]["face"], face, "{r}");
}

#[test]
fn a_load_only_on_fixed_faces_is_refused() {
    let mut req = cantilever(json!("steel"), 3.0);
    req["loads"] = json!([{"faces": face([-1.0, 0.0, 0.0]), "force": [0, 0, -100]}]);
    let msg = error_of(&run(req.clone()));
    assert!(msg.contains("the load is only on fixed faces"), "{msg}");
    // Beside a load that bends the bar it is only a warning.
    req["loads"] = json!([
        {"faces": face([-1.0, 0.0, 0.0]), "force": [0, 0, -100]},
        {"faces": face([1.0, 0.0, 0.0]), "force": [0, 0, -100]},
    ]);
    let w = warnings_of(&run(req));
    assert!(
        w.contains("load 1 (loads[0]) is only on fixed faces"),
        "{w}"
    );
}

/// A solid whose shell lost a face, as an inline BREP import brings it in (tangent_union.rs).
fn open_box_brep() -> String {
    let dir = std::env::temp_dir().join(format!("fundacad-stress-open-box-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let path = dir.join("box.brep");
    kernel::make_box(10.0, 10.0, 10.0)
        .expect("box")
        .write_brep_text(&path)
        .expect("written");
    let text = std::fs::read_to_string(&path).expect("read");
    let _ = std::fs::remove_dir_all(&dir);
    // The shell's line lists its six faces, "-26 0 +16 0 ... *": drop the first.
    // The writer heads the file with a DBRep line the importer does not take.
    let lines: Vec<&str> = text
        .lines()
        .skip_while(|l| !l.starts_with("CASCADE"))
        .collect();
    let sh = lines.iter().position(|l| *l == "Sh").expect("a shell");
    let faces = sh
        + lines[sh + 1..]
            .iter()
            .position(|l| l.ends_with('*'))
            .expect("its faces")
        + 1;
    let mut out: Vec<String> = lines.iter().map(|l| (*l).to_owned()).collect();
    let tokens: Vec<&str> = lines[faces].split(' ').collect();
    out[faces] = tokens[2..].join(" ");
    base64::engine::general_purpose::STANDARD.encode(out.join("\n") + "\n")
}

#[test]
fn an_open_body_is_refused() {
    let doc = json!({"features": [
        {"id": "imp", "type": "import", "name": "open box", "format": "step", "brep": open_box_brep()},
    ]});
    let r = run(json!({
        "document": doc, "body": "body1",
        "fixed": face([-1.0, 0.0, 0.0]),
        "loads": [{"faces": face([1.0, 0.0, 0.0]), "force": [0, 0, -1]}],
        "size": 3,
    }));
    let msg = error_of(&r);
    assert!(msg.contains("body1 is not closed"), "{msg}");
}

#[test]
fn an_inside_corner_is_told_apart_from_a_convex_part() {
    // An L bracket: a 60 x 20 x 5 base and a 5 x 20 x 40 upright at its x = -30 end, pushed
    // sideways at the top, so the peak is in the inside corner at x = -25, z = 2.5.
    let bracket = json!({"features": [
        {"id": "base", "type": "box", "length": 60, "width": 20, "height": 5},
        {"id": "up", "type": "box", "length": 5, "width": 20, "height": 40},
        {"id": "m", "type": "move", "dx": -27.5, "dz": 22.5, "bodies": ["body2"]},
        {"id": "u", "type": "boolean", "operation": "union", "target": "body1", "tools": ["body2"]},
    ]});
    let r = run(json!({
        "document": bracket, "body": "body1",
        "fixed": face([0.0, 0.0, -1.0]),
        "loads": [{"faces": {"kind": "face", "by": "nearest", "point": [-27.5, 0, 42.5]}, "force": [10, 0, 0]}],
        "material": "PETG", "size": 2.5,
    }));
    let w = warnings_of(&r);
    let at = vec3(&r["maxVonMises"]["at"]);
    assert!(
        (at[0] + 25.0).abs() < 2.5 && (at[2] - 2.5).abs() < 2.5,
        "{at:?}"
    );
    assert!(w.contains("is at a sharp inside corner"), "{w}");

    // Half a cylinder is convex everywhere, whatever the volume mesh does to its edges.
    let half = json!({"features": [
        {"id": "c", "type": "cylinder", "radius": 10, "height": 50},
        {"id": "b", "type": "box", "length": 20, "width": 30, "height": 60},
        {"id": "m", "type": "move", "dx": -10, "bodies": ["body2"]},
        {"id": "s", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2"]},
    ]});
    let r = run(json!({
        "document": half, "body": "body1",
        "fixed": face([0.0, 0.0, -1.0]),
        "loads": [{"faces": {"kind": "face", "by": "nearest", "point": [10, 0, 0]}, "pressure": 1}],
        "material": "PETG", "size": 2.5,
    }));
    let w = warnings_of(&r);
    assert!(!w.contains("is at a sharp inside corner"), "{w}");
}

#[test]
fn a_tiny_size_on_a_curved_part_meshes_for_the_size_it_can_have() {
    // The surface is triangulated for the element size the limit allows, not for 0.001 mm,
    // so this stays as quick as any coarse mesh.
    let doc = json!({"features": [{"id": "c", "type": "cylinder", "radius": 10, "height": 20}]});
    let t = std::time::Instant::now();
    let r = run(json!({
        "document": doc, "body": "body1",
        "fixed": face([0.0, 0.0, -1.0]),
        "loads": [{"faces": face([0.0, 0.0, 1.0]), "force": [5, 0, 0]}],
        "material": "PLA", "size": 0.001, "maxElements": 2000,
    }));
    let w = warnings_of(&r);
    assert!(w.contains("the element size grew from 0.001 mm"), "{w}");
    assert!(num(&r["mesh"]["elements"]) <= 2000.0, "{}", r["mesh"]);
    assert!(t.elapsed().as_secs() < 60, "{:?}", t.elapsed());
}

fn nearest(p: [f64; 3]) -> Value {
    json!({"kind": "face", "by": "nearest", "point": p})
}

fn balanced(r: &Value) {
    assert!(r.get("error").is_none(), "{r}");
    let applied = vec3(&r["applied"]);
    let reaction = vec3(&r["reaction"]);
    let size = applied.iter().map(|v| v * v).sum::<f64>().sqrt();
    for k in 0..3 {
        assert!(
            (applied[k] + reaction[k]).abs() < 1e-6 * size,
            "{applied:?} vs {reaction:?}"
        );
    }
    // One reaction per support, summing to the whole, within the reply's six places.
    let parts: Vec<[f64; 3]> = r["reactions"]
        .as_array()
        .unwrap()
        .iter()
        .map(vec3)
        .collect();
    for k in 0..3 {
        let sum: f64 = parts.iter().map(|p| p[k]).sum();
        assert!(
            (sum - reaction[k]).abs() < 1e-5 + 1e-9 * size,
            "{parts:?} vs {reaction:?}"
        );
    }
}

#[test]
fn a_cantilever_on_a_wall_and_a_floor_balances() {
    // Glued to a wall at x = 0 and resting on a frictionless floor under it, pushed down and
    // along at the far end.
    let floor = json!({"type": "slider", "faces": face([0.0, 0.0, -1.0])});
    let req = json!({
        "document": bar(), "body": "body1",
        "fixed": [face([-1.0, 0.0, 0.0])],
        "supports": [floor],
        "loads": [{"faces": [face([1.0, 0.0, 0.0])], "force": [10, 5, -100]}],
        "material": "PETG", "size": 3,
    });
    let r = run(req.clone());
    balanced(&r);
    let reactions = r["reactions"].as_array().unwrap();
    assert_eq!(reactions.len(), 2, "{r}");
    // The floor only pushes up, and takes most of the 100 N down.
    let floor = vec3(&reactions[1]);
    assert!(floor[0].abs() < 1e-4 && floor[1].abs() < 1e-4, "{floor:?}");
    assert!(floor[2] > 50.0, "{floor:?}");
    // The tip slides along the floor and does not sink into it.
    let tip = vec3(&r["maxDisplacement"]["vector"]);
    assert!(
        tip[2].abs() < 0.2 * tip[0].abs().max(tip[1].abs()),
        "{tip:?}"
    );

    // `fixed` is a fixed support listed first: the same faces as a support with no type
    // give the same answer.
    let mut same = req.clone();
    same.as_object_mut().unwrap().remove("fixed");
    same["supports"] = json!([{"faces": [face([-1.0, 0.0, 0.0])]}, req["supports"][0]]);
    assert_eq!(run(same), r);
}

#[test]
fn a_plate_on_sliders_alone_is_free_to_slide() {
    let plate = json!({"features": [
        {"id": "p", "type": "box", "length": 40, "width": 40, "height": 4},
    ]});
    let r = run(json!({
        "document": plate, "body": "body1",
        "supports": [{"type": "slider", "faces": face([0.0, 0.0, -1.0])}],
        "loads": [{"faces": face([0.0, 0.0, 1.0]), "pressure": 0.01}],
        "size": 3,
    }));
    let msg = error_of(&r);
    assert!(
        msg.contains("the body can still slide along X, add a support that holds it that way"),
        "{msg}"
    );
}

/// A ring of radius 20 round a hole of radius 5 along Z, with an arm out to x = 55.
fn lever() -> Value {
    json!({"features": [
        {"id": "ring", "type": "cylinder", "radius": 20, "height": 5},
        {"id": "hole", "type": "cylinder", "radius": 5, "height": 10},
        {"id": "cut", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2"]},
        {"id": "arm", "type": "box", "length": 40, "width": 10, "height": 5},
        {"id": "m", "type": "move", "dx": 35, "bodies": ["body3"]},
        {"id": "join", "type": "boolean", "operation": "union", "target": "body1", "tools": ["body3"]},
    ]})
}

#[test]
fn a_lever_on_one_pin_turns_and_a_stop_holds_it() {
    let pin = json!({"type": "pinned", "faces": nearest([5.0, 0.0, 0.0])});
    let req = |supports: Value| {
        json!({
            "document": lever(), "body": "body1",
            "supports": supports,
            "loads": [
                {"faces": nearest([55.0, 0.0, 0.0]), "force": [0, 20, 0]},
                {"faces": nearest([-20.0, 0.0, 0.0]), "force": [-20, 0, 0]},
            ],
            "material": "PLA", "size": 2.5,
        })
    };
    let msg = error_of(&run(req(json!([pin]))));
    assert!(
        msg.contains(
            "the body can still turn about the pin's axis through (0, 0, 0), add another support"
        ),
        "{msg}"
    );
    // A stop against the arm's side keeps it from turning.
    let stop = json!({"type": "slider", "faces": nearest([35.0, 5.0, 0.0])});
    let r = run(req(json!([pin, stop])));
    balanced(&r);
    let parts: Vec<[f64; 3]> = r["reactions"]
        .as_array()
        .unwrap()
        .iter()
        .map(vec3)
        .collect();
    assert_eq!(parts.len(), 2);
    // The stop only pushes across the arm, so the pull on the ring goes to the pin.
    assert!(
        parts[1][0].abs() < 1e-3 && parts[1][2].abs() < 1e-3,
        "{parts:?}"
    );
    assert!(parts[1][1] < -10.0, "{parts:?}");
    assert!((parts[0][0] - 20.0).abs() < 1e-3, "{parts:?}");

    // A pin needs a round face.
    let flat = json!({"type": "pinned", "faces": face([0.0, 0.0, 1.0])});
    let msg = error_of(&run(req(json!([flat, stop]))));
    // Named as the panel names it, then as the request does, and the face by what it is.
    assert!(
        msg.contains(
            "support 1 (supports[0]) is pinned, which needs cylindrical faces (a hole or a pin), but "
        ) && msg.contains(" is flat, pick the round face of the hole or the pin"),
        "{msg}"
    );
    let msg = error_of(&run(req(
        json!([{"type": "glued", "faces": face([0.0, 0.0, 1.0])}]),
    )));
    assert!(
        msg.contains(
            "support 1 (supports[0]) has type 'glued', a support is fixed, pinned or slider"
        ),
        "{msg}"
    );
    let mut none = req(json!([]));
    none.as_object_mut().unwrap().remove("supports");
    assert!(error_of(&run(none)).contains("no face is fixed"));
}

#[test]
fn gravity_weighs_the_body_and_bends_it() {
    let req = json!({
        "document": bar(), "body": "body1",
        "fixed": [face([-1.0, 0.0, 0.0])],
        "gravity": true,
        "material": "PLA", "size": 3,
    });
    let r = run(req.clone());
    balanced(&r);
    assert_eq!(r["material"]["density"], json!(1.24));
    // rho g V: 1.24 g/cm3 is 1.24e-9 t/mm3, 9.81 m/s2 is 9810 mm/s2, over 10000 cubic mm.
    let want = 1.24e-9 * 9810.0 * 10_000.0;
    let weight = vec3(&r["weight"]);
    assert!(weight[0] == 0.0 && weight[1] == 0.0, "{weight:?}");
    // The mesh rounds the bar's edges over, and the weight is still the real bar's.
    assert!(
        (weight[2] + want).abs() < 1e-4 * want,
        "{weight:?} vs {want}"
    );
    assert_eq!(vec3(&r["applied"]), weight);
    // The weight is a uniform load q = rho g A, bending the tip q L^4 / 8 E I.
    let q = want / 100.0;
    let tip_want = q * 100.0f64.powi(4) / (8.0 * 3500.0 * (10.0 * 1000.0 / 12.0));
    let tip = num(&r["maxDisplacement"]["value"]);
    assert!(
        (tip - tip_want).abs() < 0.1 * tip_want,
        "{tip} vs {tip_want}"
    );
    assert!(num(&r["maxDisplacement"]["vector"][2]) < 0.0);

    // Gravity as a vector, along +X here, and beside a load.
    let mut along = req.clone();
    along["gravity"] = json!([9.81, 0, 0]);
    along["loads"] = json!([{"faces": face([1.0, 0.0, 0.0]), "force": [0, 0, -1]}]);
    let r = run(along);
    balanced(&r);
    let w = vec3(&r["weight"]);
    assert!((w[0] - want).abs() < 1e-4 * want && w[2] == 0.0, "{w:?}");
    let applied = vec3(&r["applied"]);
    assert!(
        (applied[2] + 1.0).abs() < 1e-6 && (applied[0] - w[0]).abs() < 1e-6,
        "{applied:?}"
    );

    // A material of your own needs a density for gravity.
    let mut custom = req.clone();
    custom["material"] = json!({"E": 2000, "nu": 0.3});
    let msg = error_of(&run(custom.clone()));
    assert!(
        msg.contains("gravity needs the material's density in g/cm3"),
        "{msg}"
    );
    custom["material"]["density"] = json!(-1);
    let msg = error_of(&run(custom.clone()));
    assert!(msg.contains("density must be a number above 0"), "{msg}");
    custom["material"]["density"] = json!(1.24);
    custom["material"]["E"] = json!(3500);
    custom["material"]["nu"] = json!(0.36);
    let r = run(custom);
    balanced(&r);
    assert!((num(&r["weight"][2]) + want).abs() < 1e-4 * want);

    let mut bad = req.clone();
    bad["gravity"] = json!("down");
    assert!(error_of(&run(bad)).contains("gravity must be true, false or [gx, gy, gz]"));

    // A vector of no length is no gravity, so with no load there is nothing to analyse.
    let mut none = req;
    none["gravity"] = json!([0, 0, 0]);
    let msg = error_of(&run(none.clone()));
    assert!(msg.contains("there is no load"), "{msg}");
    none["loads"] = json!([{"faces": face([1.0, 0.0, 0.0]), "force": [0, 0, -1]}]);
    let r = run(none);
    balanced(&r);
    assert_eq!(r["weight"], Value::Null);
}

/// A shaft of radius 10 along Z, from z = -20 to 20.
fn shaft() -> Value {
    json!({"features": [{"id": "c", "type": "cylinder", "radius": 10, "height": 40}]})
}

#[test]
fn a_slider_on_a_round_face_leaves_its_slide_and_turn_free() {
    // A frictionless hole holds the lever only towards its axis: it can still slide along
    // the axis, and once a floor stops that, turn about it.
    let req = |supports: Value| {
        json!({
            "document": lever(), "body": "body1",
            "supports": supports,
            "loads": [{"faces": nearest([55.0, 0.0, 0.0]), "force": [0, 10, 0]}],
            "material": "steel", "size": 2.5,
        })
    };
    let hole = json!({"type": "slider", "faces": nearest([5.0, 0.0, 0.0])});
    let msg = error_of(&run(req(json!([hole]))));
    assert!(msg.contains("the body can still slide along Z"), "{msg}");
    let floor = json!({"type": "slider", "faces": face([0.0, 0.0, -1.0])});
    let msg = error_of(&run(req(json!([hole, floor]))));
    assert!(
        msg.contains("the body can still turn about the hole's axis through (0, 0, ")
            && msg.contains("add another support"),
        "{msg}"
    );

    // A shaft on a slider round its side slides along it under an axial load.
    let side = json!({"type": "slider", "faces": nearest([10.0, 0.0, 0.0])});
    let on_shaft = |fixed: Value, force: Value| {
        json!({
            "document": shaft(), "body": "body1",
            "fixed": fixed, "supports": [side],
            "loads": [{"faces": face([0.0, 0.0, 1.0]), "force": force}],
            "material": "steel", "size": 3,
        })
    };
    let msg = error_of(&run(on_shaft(json!([]), json!([0, 0, -100]))));
    assert!(msg.contains("the body can still slide along Z"), "{msg}");
    // With its end fixed it is held, and the round face, which has no friction, takes none
    // of the axial load.
    let r = run(on_shaft(
        json!([face([0.0, 0.0, -1.0])]),
        json!([30, 0, -100]),
    ));
    balanced(&r);
    let round = vec3(&r["reactions"][1]);
    assert!(round[2].abs() < 1e-6 * 100.0, "{round:?}");
    assert!(round[0].abs() > 1.0, "{round:?}");
    assert!((num(&r["reactions"][0][2]) - 100.0).abs() < 1e-4, "{r}");

    // A ball on a slider all over can still turn every way about its centre.
    let ball = json!({"features": [{"id": "s", "type": "sphere", "radius": 10}]});
    let msg = error_of(&run(json!({
        "document": ball, "body": "body1",
        "supports": [{"type": "slider", "faces": nearest([10.0, 0.0, 0.0])}],
        "loads": [{"faces": nearest([10.0, 0.0, 0.0]), "force": [0, 5, 0]}],
        "material": "steel", "size": 3,
    })));
    assert!(
        msg.contains(
            "the body can still turn about the centre of its ball-shaped slider face at (0, 0, 0)"
        ),
        "{msg}"
    );
}

/// The default element size on the cantilever, timed. Run with
/// `cargo test --release -p fundacad-geom --test stress_ops -- --ignored --nocapture`.
#[test]
#[ignore]
fn time_the_default_cantilever() {
    let mut req = cantilever(json!("PLA"), 1.0);
    req.as_object_mut().unwrap().remove("size");
    let Value::Object(m) = req else {
        unreachable!()
    };
    let t = std::time::Instant::now();
    let r = json_of(stress_result(&m, &NoWatch));
    let secs = t.elapsed().as_secs_f64();
    println!(
        "default cantilever: {secs:.2} s, mesh {}, peak {} MPa, tip {} mm, warnings {}",
        r["mesh"], r["maxVonMises"]["value"], r["maxDisplacement"]["value"], r["warnings"]
    );
    assert!(r.get("error").is_none(), "{r}");
}

#[test]
fn a_peak_where_a_slider_face_ends_is_warned_about() {
    // The lever pushed sideways at its tip against a stop along the arm's side: the peak is
    // at the tip's corner, where the stop's face ends, and draws the same caution as the
    // edge of a fixed face.
    let r = run(json!({
        "document": lever(), "body": "body1",
        "supports": [
            {"type": "pinned", "faces": nearest([5.0, 0.0, 0.0])},
            {"type": "slider", "faces": nearest([35.0, 5.0, 0.0])},
        ],
        "loads": [{"faces": nearest([55.0, 0.0, 0.0]), "force": [0, 20, 0]}],
        "material": "PLA", "size": 2.5,
    }));
    let w = warnings_of(&r);
    assert!(num(&r["maxVonMises"]["at"][0]) > 50.0, "{r}");
    assert!(
        w.contains("the peak stress is where a slider face ends, stress at a sharp inside corner or where a support ends grows as the mesh is refined"),
        "{w}"
    );
}
