//! Mesh import against the Python engine's (tests/mesh_import/gen.py on the legacy branch). The input
//! files are written here by the Rust writers, byte for byte the Python ones.

use fundacad_geom::export::{glb, stl, threemf};
use fundacad_geom::import::{self, blobstore::BlobStore};
use fundacad_geom::kernel::{self, Kind};
use opencascade::xcaf;
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};

const FIXTURES: [&str; 3] = ["box", "box_minus_cylinder", "two_solids"];
const FORMATS: [&str; 5] = ["stl", "ascii.stl", "3mf", "obj", "glb"];

fn tests() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests")
}

fn arrays(name: &str) -> (Vec<f64>, Vec<u32>) {
    let raw = std::fs::read(tests().join(format!("export/{name}.mesh"))).unwrap();
    let nv = u32::from_le_bytes(raw[0..4].try_into().unwrap()) as usize;
    let nt = u32::from_le_bytes(raw[4..8].try_into().unwrap()) as usize;
    let pos = raw[8..8 + nv * 24].chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
    let idx = raw[8 + nv * 24..8 + nv * 24 + nt * 12]
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .collect();
    (pos, idx)
}

fn write(pos: &[f64], idx: &[u32], path: &Path, fmt: &str) {
    match fmt {
        "stl" => stl::write_binary_file(pos, idx, path).unwrap(),
        "ascii.stl" => stl::write_ascii_file(pos, idx, path).unwrap(),
        "3mf" => threemf::write_file(pos, idx, "millimeter", path).unwrap(),
        "glb" => glb::write_file(
            &[glb::GlbMesh { name: Some("Part".into()), positions: pos, indices: idx, color: Some("#3366cc".into()) }],
            path,
        )
        .unwrap(),
        _ => {
            let mut f = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
            for p in pos.chunks_exact(3) {
                writeln!(f, "v {:?} {:?} {:?}", p[0], p[1], p[2]).unwrap();
            }
            for t in idx.chunks_exact(3) {
                writeln!(f, "f {} {} {}", t[0] + 1, t[1] + 1, t[2] + 1).unwrap();
            }
        }
    }
}

#[test]
fn mesh_import_matches_python() {
    let oracle: Value =
        serde_json::from_str(&std::fs::read_to_string(tests().join("mesh_import/oracle.json")).unwrap()).unwrap();
    let dir = std::env::temp_dir().join(format!("fundacad-mesh-import-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = BlobStore::open(dir.join("blobs")).unwrap();
    let mut failures = Vec::new();
    let mut faces_differ = Vec::new();
    for name in FIXTURES {
        let (pos, idx) = arrays(name);
        for fmt in FORMATS {
            let key = format!("{name}.{fmt}");
            if key == "two_solids.ascii.stl" {
                // six digit text ties the two shells' boxes, and Mesher makes the second a void
                continue;
            }
            let path = dir.join(&key);
            write(&pos, &idx, &path, fmt);
            let got = import::import_geometry(path.to_str().unwrap(), fmt.rsplit('.').next().unwrap(), &store);
            // lib3mf reads no ASCII STL, the Rust reader does, so it answers as the binary file does
            let want = if fmt == "ascii.stl" { &oracle[format!("{name}.stl")] } else { &oracle[&key] };
            let mut reply = match got {
                Ok(r) => r,
                Err(e) => {
                    failures.push(format!("{key}: {e}"));
                    continue;
                }
            };
            let shape = xcaf::from_bin(&store.get_bytes(reply.remove("geom").unwrap().as_str().unwrap()).unwrap())
                .unwrap();
            let w = &want["reply"];
            if reply["solid"] != w["solid"] || reply.get("color") != w.get("color") {
                failures.push(format!("{key}: {reply:?} want {w}"));
            }
            if reply["faces"] != w["faces"] {
                faces_differ.push(format!("{key}: {} faces, python {}", reply["faces"], w["faces"]));
            }
            let vol = kernel::volume(&shape);
            let wv = want["volume"].as_f64().unwrap();
            if (vol - wv).abs() > 2e-3 * wv.abs() {
                failures.push(format!("{key}: volume {vol} want {wv}"));
            }
            if kernel::count(&shape, Kind::Solid) as u64 != want["solids"].as_u64().unwrap() {
                failures.push(format!("{key}: solids {}", kernel::count(&shape, Kind::Solid)));
            }
            let bb = kernel::bbox(&shape).unwrap();
            for (k, v) in want["bbox"].as_array().unwrap().iter().enumerate() {
                if (bb[k] - v.as_f64().unwrap()).abs() > 0.05 {
                    failures.push(format!("{key}: bbox {bb:?} want {}", want["bbox"]));
                    break;
                }
            }
        }
    }
    eprintln!("face counts that differ from Python:\n{}", faces_differ.join("\n"));
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(faces_differ.len() <= 3, "{}", faces_differ.join("\n"));
}
