//! Compressed STEP and OCCT XBF, tests/fixtures written by tests/step/gen_compressed.py.

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::import::{self, blobstore::BlobStore};
use fundacad_geom::kernel::{self, Kind};
use serde_json::{json, Map, Value};

const BRACKET_VOLUME: f64 = 20.0 * 12.0 * 8.0;
const PLUG_VOLUME: f64 = std::f64::consts::PI * 16.0 * 6.0;
const RED: [f64; 3] = [0.8, 0.1, 0.1];
const BLUE: [f64; 3] = [0.1, 0.2, 0.9];

fn blob_dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("fundacad-import-compressed-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("FUNDACAD_BLOB_DIR", &dir);
        dir
    })
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/fixtures/{name}"))
}

fn try_import(path: &std::path::Path, fmt: &str) -> Result<Map<String, Value>, String> {
    let store = BlobStore::open(blob_dir()).unwrap();
    import::import_geometry(&path.to_string_lossy(), fmt, &store)
}

fn imported(name: &str, fmt: &str) -> Map<String, Value> {
    try_import(&fixture(name), fmt).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn build(reply: Map<String, Value>, fmt: &str) -> Rebuild {
    let mut f = reply;
    f.remove("faces");
    f.insert("id".into(), json!("f1"));
    f.insert("type".into(), json!("import"));
    f.insert("format".into(), json!(fmt));
    let doc = json!({"version": 1, "parameters": {}, "features": [f]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).unwrap();
    let r = builder::rebuild(&typed, &doc, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    r
}

fn counts(reply: &Map<String, Value>) -> (Value, usize, usize) {
    let len = |k: &str| reply.get(k).and_then(Value::as_array).map_or(0, Vec::len);
    (reply["faces"].clone(), len("parts"), len("nodes"))
}

/// The file holds linear RGB, a reply holds sRGB.
fn is_color(hex: Option<&str>, linear: [f64; 3]) -> bool {
    let Some(h) = hex else { return false };
    let v = i64::from_str_radix(h.trim_start_matches('#'), 16).unwrap();
    let got = [v >> 16 & 255, v >> 8 & 255, v & 255];
    got.iter().zip(linear).all(|(g, l)| {
        let s = if l <= 0.003_130_8 { 12.92 * l } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 };
        (*g as f64 - s * 255.0).abs() <= 1.5
    })
}

#[test]
fn a_gzip_stpz_reads_like_its_step() {
    let plain = counts(&imported("asm_colors.step", "step"));
    assert_eq!(plain.1, 4, "{plain:?}");
    for fmt in ["step", "stpz"] {
        assert_eq!(counts(&imported("asm_colors.stpz", fmt)), plain, "{fmt}");
    }
}

#[test]
fn a_zip_stpz_reads_like_its_step() {
    assert_eq!(counts(&imported("asm_colors_zip.stpz", "step")), counts(&imported("asm_colors.step", "step")));
}

#[test]
fn a_step_gz_body_is_named_without_step() {
    let reply = imported("asm_colors.step.gz", "step");
    assert_eq!(reply["name"], json!("asm_colors"));
    assert_eq!(reply["parts"].as_array().map(Vec::len), Some(4));
}

#[test]
fn a_gzip_that_unpacks_past_the_cap_is_refused() {
    let e = import::unpack_step(&fixture("asm_colors.stpz"), 1000).err().unwrap_or_default();
    assert!(e.contains("unpacks past"), "{e}");
    let e = import::unpack_step(&fixture("asm_colors_zip.stpz"), 1000).err().unwrap_or_default();
    assert!(e.contains("unpacks past"), "{e}");
}

#[test]
fn an_unpacked_step_is_removed_once_read() {
    let unpacked = import::unpack_step(&fixture("asm_colors.stpz"), u64::MAX).unwrap().unwrap();
    let path = unpacked.path().to_path_buf();
    let lf = |b: Vec<u8>| String::from_utf8(b).unwrap().replace("\r\n", "\n");
    assert_eq!(lf(std::fs::read(&path).unwrap()), lf(std::fs::read(fixture("asm_colors.step")).unwrap()));
    drop(unpacked);
    assert!(!path.exists());
    assert!(import::unpack_step(&fixture("asm_colors.step"), u64::MAX).unwrap().is_none());
}

#[test]
fn a_zip_without_a_step_file_says_so() {
    let path = blob_dir().join("notes.stpz");
    let mut z = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    for name in ["a.txt", "b.txt"] {
        z.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(b"hello").unwrap();
    }
    z.finish().unwrap();
    let e = try_import(&path, "step").unwrap_err();
    assert!(e.contains("no STEP file"), "{e}");
}

fn xbf_two_named_parts(name: &str) {
    let reply = imported(name, "xbf");
    assert_eq!(reply["solid"], json!(true));
    assert_eq!(reply["parts"].as_array().map(Vec::len), Some(2), "{reply:?}");
    let r = build(reply, "xbf");
    let names: Vec<&str> = r.bodies.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["Bracket", "Plug"]);
    for (body, (volume, want)) in r.bodies.iter().zip([(BRACKET_VOLUME, RED), (PLUG_VOLUME, BLUE)]) {
        assert_eq!(kernel::count(&body.shape, Kind::Solid), 1);
        let got = kernel::volume(&body.shape);
        assert!((got - volume).abs() < 0.05, "{}: volume {got}, want {volume}", body.name);
        let faces = kernel::count(&body.shape, Kind::Face);
        let face = fundacad_core::face_colors::decode_value(body.face_colors.as_ref(), faces);
        let painted = is_color(body.part_color.as_deref(), want)
            || (face.iter().all(|c| is_color(c.as_deref(), want)) && !face.is_empty());
        assert!(painted, "{}: {:?} {:?}", body.name, body.part_color, face);
    }
}

#[test]
fn xbf_parts_keep_their_names_and_colours() {
    xbf_two_named_parts("two_parts.xbf");
}

#[test]
fn an_xbf_in_metres_reads_in_millimetres() {
    xbf_two_named_parts("two_parts_m.xbf");
}

#[test]
fn a_step_file_is_not_read_as_xbf() {
    let e = try_import(&fixture("asm_flat.step"), "xbf").unwrap_err();
    assert!(e.contains("XBF"), "{e}");
}
