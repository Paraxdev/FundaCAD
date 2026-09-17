//! Differential test of the viewport mesh against the Python sidecar's payload,
//! summarised by tests/mesh_oracle/gen.py on OCCT 7.9.3. The engine runs 7.8.1,
//! so triangle counts are compared loosely and the topology exactly.

use fundacad_geom::mesh;
use opencascade::mesh_access;
use serde_json::Value;
use std::path::PathBuf;

const FIXTURES: [&str; 9] = [
    "box",
    "box_minus_cylinder",
    "filleted_box",
    "sphere",
    "cone",
    "torus",
    "revolved",
    "thin_shell",
    "two_solids",
];

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/mesh_oracle")
}

fn stats(pos: &[f32], idx: &[u32]) -> (f64, f64) {
    let p = |i: u32| {
        let i = i as usize * 3;
        [pos[i] as f64, pos[i + 1] as f64, pos[i + 2] as f64]
    };
    let (mut vol, mut area) = (0.0, 0.0);
    for t in idx.chunks_exact(3) {
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let cr = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        area += (cr[0] * cr[0] + cr[1] * cr[1] + cr[2] * cr[2]).sqrt() / 2.0;
        let bc = [
            b[1] * c[2] - b[2] * c[1],
            b[2] * c[0] - b[0] * c[2],
            b[0] * c[1] - b[1] * c[0],
        ];
        vol += (a[0] * bc[0] + a[1] * bc[1] + a[2] * bc[2]) / 6.0;
    }
    (vol, area)
}

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap()
}

#[test]
fn viewport_mesh_matches_the_python_payload() {
    let mut failures = Vec::new();
    for name in FIXTURES {
        let text = std::fs::read_to_string(dir().join(format!("{name}.brep"))).unwrap();
        let want: Value = serde_json::from_str(
            &std::fs::read_to_string(dir().join(format!("{name}.json"))).unwrap(),
        )
        .unwrap();
        let shape = mesh_access::read_brep_str(&text).expect("fixture BREP reads");
        let got = mesh::body_payload(
            &shape,
            name,
            name,
            f(&want["requested"]),
            mesh::viewport_profile(1),
        );
        let mut fail = |what: String| failures.push(format!("{name}: {what}"));

        let keys: Vec<&str> = got.fields.keys().skip(3).map(String::as_str).collect();
        let want_keys: Vec<&str> = want["keys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap())
            .collect();
        if keys != want_keys {
            fail(format!("keys {keys:?} vs {want_keys:?}"));
        }
        let face_count = got.fields["faceCount"].as_u64().unwrap();
        if face_count != want["faceCount"].as_u64().unwrap() {
            fail(format!("faceCount {face_count} vs {}", want["faceCount"]));
        }
        let owners = got.fields["faceOwners"].as_array().unwrap().len() as u64;
        if owners != want["faces"].as_u64().unwrap() {
            fail(format!("faceOwners {owners} vs {}", want["faces"]));
        }
        if got.edges.len() as u64 != want["edgeCount"].as_u64().unwrap() {
            fail(format!(
                "edges {} vs {}",
                got.edges.len(),
                want["edgeCount"]
            ));
        }
        let smooth: Vec<u64> = got
            .edges
            .iter()
            .enumerate()
            .filter(|(_, e)| e.smooth)
            .map(|(i, _)| i as u64)
            .collect();
        let want_smooth: Vec<u64> = want["smooth"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect();
        if smooth != want_smooth {
            fail(format!("smooth {smooth:?} vs {want_smooth:?}"));
        }
        let edge_points: Vec<u64> = got.edges.iter().map(|e| e.points.len() as u64).collect();
        let want_points: Vec<u64> = want["edgePoints"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect();
        let points_off = edge_points
            .iter()
            .zip(&want_points)
            .filter(|(a, b)| a != b)
            .count();

        let (vol, area) = stats(&got.positions, &got.indices);
        let (wv, wa) = (f(&want["volume"]), f(&want["area"]));
        if ((vol - wv) / wv).abs() > 1e-3 {
            fail(format!("volume {vol} vs {wv}"));
        }
        if ((area - wa) / wa).abs() > 1e-3 {
            fail(format!("area {area} vs {wa}"));
        }
        let mut bbox_err: f64 = 0.0;
        for corner in ["min", "max"] {
            for k in 0..3 {
                let d = (f(&got.fields["bbox"][corner][k]) - f(&want["bbox"][corner][k])).abs();
                bbox_err = bbox_err.max(d);
            }
        }
        if bbox_err > 1e-6 {
            fail(format!("bbox off by {bbox_err}"));
        }

        let tris: Vec<u64> = want["trisPerFace"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect();
        let mut got_tris = vec![0u64; face_count as usize];
        for &fid in &got.face_ids {
            got_tris[fid as usize] += 1;
        }
        let mut worst_tris: f64 = 0.0;
        for (a, b) in got_tris.iter().zip(&tris) {
            let r = (*a as f64 - *b as f64).abs() / (*b as f64).max(1.0);
            worst_tris = worst_tris.max(r);
        }
        if worst_tris > 0.25 {
            fail(format!("triangles per face {got_tris:?} vs {tris:?}"));
        }

        let normals = got.normals.as_ref().expect("normals");
        let mut worst_deg: f64 = 0.0;
        let mut worst_dist: f64 = 0.0;
        for s in want["normalSamples"].as_array().unwrap() {
            let face = s["face"].as_u64().unwrap() as u32;
            let pt: Vec<f64> = s["point"].as_array().unwrap().iter().map(f).collect();
            let wn: Vec<f64> = s["normal"].as_array().unwrap().iter().map(f).collect();
            let mut best = (f64::INFINITY, 0usize);
            for (t, &fid) in got.indices.chunks_exact(3).zip(&got.face_ids) {
                if fid != face {
                    continue;
                }
                for &v in t {
                    let i = v as usize * 3;
                    let d = (0..3)
                        .map(|k| (got.positions[i + k] as f64 - pt[k]).powi(2))
                        .sum::<f64>()
                        .sqrt();
                    if d < best.0 {
                        best = (d, v as usize);
                    }
                }
            }
            let i = best.1 * 3;
            let gn: Vec<f64> = (0..3).map(|k| normals[i + k] as f64).collect();
            let cos = (gn[0] * wn[0] + gn[1] * wn[1] + gn[2] * wn[2]).clamp(-1.0, 1.0);
            let deg = cos.acos().to_degrees();
            worst_deg = worst_deg.max(deg);
            worst_dist = worst_dist.max(best.0);
        }
        if worst_deg > 1.0 {
            fail(format!(
                "normal off by {worst_deg} degrees (nearest vertex {worst_dist})"
            ));
        }
        let total: u64 = tris.iter().sum();
        eprintln!(
            "{name:20} faces {face_count:3} edges {:3} smooth {:3} tris {:6} vs {:6} (worst face {:5.1}%) \
             verts {:6} vs {:6} vol {:+.2e} area {:+.2e} bbox {:.1e} normal {:.3} deg @ {:.1e} edge pts differ {points_off}",
            got.edges.len(),
            smooth.len(),
            got.face_ids.len(),
            total,
            worst_tris * 100.0,
            got.positions.len() / 3,
            want["vertices"],
            (vol - wv) / wv,
            (area - wa) / wa,
            bbox_err,
            worst_deg,
            worst_dist,
        );
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
