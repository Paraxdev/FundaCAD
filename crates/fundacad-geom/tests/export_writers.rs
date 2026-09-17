//! The mesh export writers against the Python sidecar's, byte for byte on the
//! same arrays (tests/export/gen.py), and the export grade mesh against
//! Python's by volume and area, since the kernels differ in version.

use blake2::digest::{Update, VariableOutput};
use blake2::Blake2bVar;
use fundacad_geom::export::{self, glb, names, refine, stl, threemf};
use opencascade::mesh_access;
use serde_json::Value;
use std::io::Read;
use std::path::PathBuf;

const FIXTURES: [&str; 4] = ["box", "box_minus_cylinder", "sphere", "two_solids"];

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests")
}

fn oracle() -> Value {
    serde_json::from_str(&std::fs::read_to_string(dir().join("export/oracle.json")).unwrap()).unwrap()
}

fn digest(data: &[u8]) -> String {
    let mut h = Blake2bVar::new(16).unwrap();
    h.update(data);
    let mut out = [0u8; 16];
    h.finalize_variable(&mut out).unwrap();
    out.iter().map(|b| format!("{b:02x}")).collect()
}

fn arrays(name: &str) -> (Vec<f64>, Vec<u32>) {
    let raw = std::fs::read(dir().join(format!("export/{name}.mesh"))).unwrap();
    let nv = u32::from_le_bytes(raw[0..4].try_into().unwrap()) as usize;
    let nt = u32::from_le_bytes(raw[4..8].try_into().unwrap()) as usize;
    let pos = raw[8..8 + nv * 24]
        .chunks_exact(8)
        .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
        .collect();
    let idx = raw[8 + nv * 24..8 + nv * 24 + nt * 12]
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .collect();
    (pos, idx)
}

fn model_digests(bytes: Vec<u8>) -> Value {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut m = serde_json::Map::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let mut data = Vec::new();
        f.read_to_end(&mut data).unwrap();
        m.insert(f.name().to_string(), Value::String(digest(&data)));
    }
    Value::Object(m)
}

fn capped(pos: &[f64], idx: &[u32], edge: f64, budget: usize) -> Value {
    let (p, i) = refine::cap_edge_length(pos, idx, edge, budget);
    serde_json::json!({
        "vertices": p.len() / 3,
        "triangles": i.len() / 3,
        "positions": digest(&p.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()),
        "indices": digest(&i.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()),
    })
}

#[test]
fn writers_match_python_byte_for_byte() {
    let want = oracle();
    let mut failures = Vec::new();
    for name in FIXTURES {
        let rec = &want["fixtures"][name];
        let (pos, idx) = arrays(name);
        let mut check = |what: &str, got: Value| {
            if got != rec[what] {
                failures.push(format!("{name} {what}: got {got}, want {}", rec[what]));
            }
        };
        let mut buf = Vec::new();
        stl::write_binary(&pos, &idx, &mut buf).unwrap();
        check("stl", Value::String(digest(&buf)));
        let mut buf = Vec::new();
        stl::write_ascii(&pos, &idx, "FundaCAD", &mut buf).unwrap();
        check("stlAscii", Value::String(digest(&buf)));
        let mut buf = std::io::Cursor::new(Vec::new());
        threemf::write(&pos, &idx, "millimeter", &mut buf).unwrap();
        check("3mf", model_digests(buf.into_inner()));
        let inch: Vec<f64> = pos.iter().map(|v| v / 25.4).collect();
        let mut buf = std::io::Cursor::new(Vec::new());
        threemf::write(&inch, &idx, "inch", &mut buf).unwrap();
        check("3mfInch", model_digests(buf.into_inner()));
        let mut buf = Vec::new();
        stl::write_ascii(&inch, &idx, "FundaCAD", &mut buf).unwrap();
        check("stlAsciiInch", Value::String(digest(&buf)));
        check("capped3", capped(&pos, &idx, 3.0, export::EXPORT_TRIANGLE_HARD_CAP));
        check("cappedBudget", capped(&pos, &idx, 0.5, 5000));
    }

    let (bp, bi) = arrays("box");
    let (sp, si) = arrays("sphere");
    let (cp, ci) = arrays("box_minus_cylinder");
    let meshes = [
        glb::GlbMesh { name: Some("Box".into()), positions: &bp, indices: &bi, color: Some("#ff8800".into()) },
        glb::GlbMesh { name: Some("Kugel \u{e9}t\u{e9} \"q\"".into()), positions: &sp, indices: &si, color: None },
        glb::GlbMesh { name: Some(String::new()), positions: &[], indices: &[], color: Some("#00ff00".into()) },
        glb::GlbMesh { name: None, positions: &cp, indices: &ci, color: Some("#123456".into()) },
    ];
    let mut buf = Vec::new();
    glb::write(&meshes, &mut buf).unwrap();
    if Value::String(digest(&buf)) != want["glb"] {
        failures.push(format!("glb differs, {} bytes", buf.len()));
    }
    let mut buf = Vec::new();
    glb::write(&[], &mut buf).unwrap();
    if Value::String(digest(&buf)) != want["glbEmpty"] {
        failures.push(format!("empty glb differs: {}", String::from_utf8_lossy(&buf)));
    }

    for (input, out) in want["normColor"].as_object().unwrap() {
        let input = if input == "None" { "" } else { input.as_str() };
        let got = glb::norm_color(input);
        if got != out.as_str().unwrap() {
            failures.push(format!("norm_color({input:?}) = {got}, want {out}"));
        }
    }
    for (label, out) in want["safeNames"].as_object().unwrap() {
        let got = names::safe_part_filename(label, "body7");
        if got != out.as_str().unwrap() {
            failures.push(format!("safe name {label:?} = {got:?}, want {out}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn export_grade_mesh_matches_python_by_measure() {
    let want = oracle();
    for name in FIXTURES {
        let text = std::fs::read_to_string(dir().join(format!("mesh_oracle/{name}.brep"))).unwrap();
        let shape = mesh_access::read_brep_str(&text).unwrap();
        let (pos, idx) = export::export_mesh(&shape, &export::mesh_options(None));
        let rec = &want["fixtures"][name]["exportGrade"];
        let (mut vol, mut area) = (0.0, 0.0);
        let p = |i: u32| [pos[i as usize * 3], pos[i as usize * 3 + 1], pos[i as usize * 3 + 2]];
        for t in idx.chunks_exact(3) {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            area += (cr[0] * cr[0] + cr[1] * cr[1] + cr[2] * cr[2]).sqrt() / 2.0;
            let bc = [b[1] * c[2] - b[2] * c[1], b[2] * c[0] - b[0] * c[2], b[0] * c[1] - b[1] * c[0]];
            vol += (a[0] * bc[0] + a[1] * bc[1] + a[2] * bc[2]) / 6.0;
        }
        let (wv, wa, wt) = (
            rec["volume"].as_f64().unwrap(),
            rec["area"].as_f64().unwrap(),
            rec["triangles"].as_f64().unwrap(),
        );
        let tris = (idx.len() / 3) as f64;
        assert!((vol - wv).abs() <= 1e-3 * wv.abs(), "{name} volume {vol} vs {wv}");
        assert!((area - wa).abs() <= 1e-3 * wa, "{name} area {area} vs {wa}");
        assert!((tris - wt).abs() <= 0.25 * wt, "{name} triangles {tris} vs {wt}");
    }
}
