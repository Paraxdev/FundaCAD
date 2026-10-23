//! `doc_import` against a stub engine, so the fields the app's import writes and the refusals around them,
//! a failed read included, are under test. Inline `content` becomes a temporary file: it must hold what was
//! sent, be safely named, and be gone afterwards whether the read worked or not.

mod common;

use std::io::Write;
use std::path::Path;
use std::time::Duration;

use base64::Engine as _;
use common::{is_error, part_reply, text_of, FakeEngine};
use fundacad_mcp::server::FundaCad;
use fundacad_mcp::upload;
use serde_json::{json, Map, Value};

/// Small enough to read in a failure message, and a real (if trivial) ASCII STL.
const STL: &[u8] = b"solid s\nfacet normal 0 0 1\nendfacet\nendsolid s\n";

/// The inline caps are the process's, so the two tests that move them would otherwise refuse
/// a file under a neighbour's ceiling.
fn serial() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn server_with(reply: Value) -> (FundaCad, FakeEngine) {
    let engine = FakeEngine::always(reply);
    (FundaCad::with_link(engine.link()), engine)
}

fn args(pairs: Value) -> Map<String, Value> {
    pairs.as_object().cloned().unwrap_or_default()
}

async fn run(srv: &FundaCad, a: Value) -> rmcp::model::CallToolResult {
    srv.t_doc_import(args(a)).await.expect("a tool never errors out")
}

fn a_file(suffix: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "fundacad-import-fixture-{}{suffix}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos())
    ));
    std::fs::write(&path, b"").expect("a temp file");
    path
}

async fn features(srv: &FundaCad) -> Vec<Value> {
    srv.document().await.get("features").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn upload_id(out: &rmcp::model::CallToolResult) -> String {
    let said = text_of(out);
    let at = said.find("upload=\"").unwrap_or_else(|| panic!("{said}"));
    let rest = &said[at + 8..];
    rest[..rest.find('"').expect("a closing quote")].to_string()
}

#[test]
fn the_extension_decides_the_format() {
    let _serial = serial();
    for (ext, want) in [
        (".stl", "stl"),
        (".3MF", "3mf"),
        (".obj", "obj"),
        (".brep", "brep"),
        (".glb", "glb"),
        (".step", "step"),
        (".stp", "step"),
        (".igs", "iges"),
        (".IGES", "iges"),
        (".FCStd", "fcstd"),
        (".ply", "ply"),
        (".OFF", "off"),
        (".amf", "amf"),
        (".gltf", "gltf"),
        (".wrl", "vrml"),
        (".x3d", "x3d"),
        (".xbf", "xbf"),
        (".3dm", "3dm"),
        (".ifc", "ifc"),
        (".dxf", "dxf"),
        (".FBX", "fbx"),
        (".3DS", "3ds"),
        (".DXF", "dxf"),
        (".svg", "svg"),
        (".stpz", "step"),
    ] {
        assert_eq!(upload::import_format(&format!("part{ext}")), want, "{ext}");
    }
}

#[test]
fn an_unknown_extension_is_read_as_step() {
    let _serial = serial();
    // Mirrors extToImportFormat: STEP is spelled many ways, so the commonest import must not need an argument.
    assert_eq!(upload::import_format("part.xyz"), "step");
    assert_eq!(upload::import_format("part"), "step");
}

#[test]
fn an_ordinary_name_is_left_exactly_as_it_is() {
    let _serial = serial();
    // The control for the sanitiser: it must not rewrite the ordinary case.
    assert_eq!(upload::safe_filename("Bracket_v2-final.step", "step"), "Bracket_v2-final.step");
    assert_eq!(upload::safe_filename("", "stl"), "imported.stl");
    assert_eq!(upload::safe_filename("..", "step"), "imported.step");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_format_told_in_any_spelling_reaches_the_engine_by_its_own_name() {
    let _serial = serial();
    for (told, want) in [("STP", "step"), ("Stp", "step"), ("STEP", "step"), ("IGS", "iges"), ("STL", "stl")] {
        let (srv, engine) = server_with(part_reply());
        let path = a_file(".dat");
        let out = run(&srv, json!({"path": path.to_string_lossy(), "format": told})).await;
        let _ = std::fs::remove_file(&path);
        assert!(!is_error(&out), "{told}: {}", text_of(&out));
        assert_eq!(engine.calls()[0].payload["format"], json!(want), "{told}");

        let (srv, engine) = server_with(part_reply());
        let out = run(&srv, json!({"content": b64(STL), "name": "PART.STP", "format": told})).await;
        assert!(!is_error(&out), "{told}: {}", text_of(&out));
        assert_eq!(engine.calls()[0].payload["format"], json!(want), "{told} inline");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn it_reads_the_file_and_puts_a_body_in_the_timeline() {
    let _serial = serial();
    let (srv, engine) = server_with(part_reply());
    let path = a_file(".step");
    let out = run(&srv, json!({"path": path.to_string_lossy()})).await;
    let _ = std::fs::remove_file(&path);
    assert!(!is_error(&out), "{}", text_of(&out));

    let call = &engine.calls()[0];
    assert_eq!(call.op, "import");
    assert_eq!(call.payload["format"], json!("step"));
    assert_eq!(call.payload["path"], json!(path.to_string_lossy()));

    let f = features(&srv).await[0].clone();
    // Exactly the fields the app's import writes. `geom` is the one that
    // matters: without it the feature is a body with no geometry.
    assert_eq!(f["type"], json!("import"));
    assert_eq!(f["geom"], json!("abc123"));
    assert_eq!(f["solid"], json!(true));
    assert_eq!(f["format"], json!("step"));
    assert_eq!(f["name"], json!("bracket"));
    assert_eq!(f["source"], json!(path.to_string_lossy()));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_plain_part_carries_no_colour_and_no_tree() {
    let _serial = serial();
    // `color`, `nodes` and `parts` are SPREAD by the app's import, not defaulted: absent differs from null downstream.
    let (srv, _engine) = server_with(part_reply());
    let path = a_file(".step");
    run(&srv, json!({"path": path.to_string_lossy()})).await;
    let _ = std::fs::remove_file(&path);
    let f = features(&srv).await[0].clone();
    for key in ["color", "nodes", "parts"] {
        assert!(f.get(key).is_none(), "{key}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_unit_goes_to_the_engine_and_is_kept_on_the_feature() {
    let _serial = serial();
    let (srv, engine) = server_with(json!({"ok": true, "result": {
        "geom": "abc123", "solid": true, "faces": 6, "name": "cube", "unit": "inch"}}));
    let path = a_file(".glb");
    run(&srv, json!({"path": path.to_string_lossy(), "unit": "inch"})).await;
    let _ = std::fs::remove_file(&path);
    assert_eq!(engine.calls()[0].payload["unit"], json!("inch"));
    assert_eq!(features(&srv).await[0]["unit"], json!("inch"));

    let (srv, engine) = server_with(part_reply());
    let path = a_file(".glb");
    run(&srv, json!({"path": path.to_string_lossy()})).await;
    let _ = std::fs::remove_file(&path);
    assert!(engine.calls()[0].payload.get("unit").is_none());
    assert!(features(&srv).await[0].get("unit").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_assembly_keeps_its_tree_and_a_glb_its_colour() {
    let _serial = serial();
    // `color` and `parts` as the real engine sends them (a hex string, `{node, faces}` per part),
    // since `feature_add` checks a feature against the schema it builds with.
    let (srv, _engine) = server_with(json!({"ok": true, "result": {
        "geom": "def456", "solid": true, "faces": 40, "name": "asm",
        "color": "#336699", "nodes": [{"name": "Plate"}],
        "parts": [{"node": 0, "faces": 20}, {"node": 1, "faces": 20}]}}));
    let path = a_file(".glb");
    let out = run(&srv, json!({"path": path.to_string_lossy()})).await;
    let _ = std::fs::remove_file(&path);
    let f = features(&srv).await[0].clone();
    assert_eq!(f["color"], json!("#336699"));
    assert_eq!(f["nodes"], json!([{"name": "Plate"}]));
    assert_eq!(f["parts"], json!([{"node": 0, "faces": 20}, {"node": 1, "faces": 20}]));
    assert!(text_of(&out).contains("2 parts"), "{}", text_of(&out));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_file_is_refused_without_asking_the_engine() {
    let _serial = serial();
    // A read that cannot happen must not cost a round trip, and must not look
    // like the engine's fault.
    let (srv, engine) = server_with(part_reply());
    let missing = std::env::temp_dir().join("no-such-part.step");
    let out = run(&srv, json!({"path": missing.to_string_lossy()})).await;
    assert!(is_error(&out));
    assert!(text_of(&out).contains("No such file"));
    assert!(engine.calls().is_empty(), "{:?}", engine.ops());
    assert!(features(&srv).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_format_the_engine_cannot_read_is_refused_by_name() {
    let _serial = serial();
    let (srv, engine) = server_with(part_reply());
    let path = a_file(".step");
    let out = run(&srv, json!({"path": path.to_string_lossy(), "format": "dwg"})).await;
    let _ = std::fs::remove_file(&path);
    assert!(is_error(&out));
    assert!(text_of(&out).contains("dwg") && text_of(&out).contains("step"));
    assert!(engine.calls().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_engines_refusal_is_passed_through_whole() {
    let _serial = serial();
    // Its reasons are actionable (too large, too many triangles, unreadable), so they pass through unsummarised.
    let why = "file is 512 MiB, too large to import (limit 400 MiB).";
    let (srv, _engine) = server_with(json!({"ok": false, "error": {"message": why}}));
    let path = a_file(".step");
    let out = run(&srv, json!({"path": path.to_string_lossy()})).await;
    let _ = std::fs::remove_file(&path);
    assert!(is_error(&out));
    assert!(text_of(&out).contains(why));
    assert!(features(&srv).await.is_empty(), "kept a feature for a read that failed");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_that_returns_no_geometry_is_a_failure() {
    let _serial = serial();
    // ok, but nothing to reference. A feature built from this would name an
    // empty hash and fail at build time instead of here.
    let (srv, _engine) = server_with(json!({"ok": true, "result": {"name": "empty", "solid": false}}));
    let path = a_file(".step");
    let out = run(&srv, json!({"path": path.to_string_lossy()})).await;
    let _ = std::fs::remove_file(&path);
    assert!(is_error(&out));
    assert!(features(&srv).await.is_empty());
}

fn line(id: &str) -> Value {
    json!({"id": id, "type": "line", "x1": 0, "y1": 0, "x2": 10, "y2": 0})
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dxf_adds_one_sketch_per_layer_and_no_body() {
    let _serial = serial();
    let (srv, engine) = server_with(json!({"ok": true, "result": {"name": "plate", "unit": "mm",
        "notes": ["skipped what is not geometry: 1 TEXT"],
        "sketches": [{"name": "Plate", "entities": [line("e1"), line("e2")]}, {"name": "Cam", "entities": [line("e1")]}]}}));
    let path = a_file(".dxf");
    let out = run(&srv, json!({"path": path.to_string_lossy()})).await;
    let _ = std::fs::remove_file(&path);
    assert!(!is_error(&out), "{}", text_of(&out));
    assert_eq!(engine.calls()[0].payload["format"], json!("dxf"));
    let fs = features(&srv).await;
    let kinds: Vec<(&str, &str, &str)> = fs
        .iter()
        .map(|f| (f["type"].as_str().unwrap(), f["plane"].as_str().unwrap(), f["name"].as_str().unwrap()))
        .collect();
    assert_eq!(kinds, [("sketch", "XY", "Plate"), ("sketch", "XY", "Cam")]);
    assert_eq!(fs[0]["entities"].as_array().unwrap().len(), 2);
    let said = text_of(&out);
    assert!(said.contains("2 sketches") && said.contains("'Plate', 2 entities") && said.contains("1 TEXT"), "{said}");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_svg_sketch_keeps_its_fill_rule_so_an_extrude_leaves_the_holes() {
    let _serial = serial();
    let (srv, engine) = server_with(json!({"ok": true, "result": {"name": "logo", "unit": "mm",
        "sketches": [{"name": "logo", "fillRule": "evenodd", "entities": [line("e1")]}]}}));
    let path = a_file(".svg");
    let out = run(&srv, json!({"path": path.to_string_lossy()})).await;
    let _ = std::fs::remove_file(&path);
    assert!(!is_error(&out), "{}", text_of(&out));
    assert_eq!(engine.calls()[0].payload["format"], json!("svg"));
    let fs = features(&srv).await;
    assert_eq!(fs.len(), 1);
    assert_eq!(fs[0]["fillRule"], json!("evenodd"));
    let said = text_of(&out);
    assert!(said.contains("holes stay open"), "{said}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dxf_with_3d_faces_adds_its_body_after_the_sketches() {
    let _serial = serial();
    let (srv, _engine) =
        server_with(json!({"ok": true, "result": {"name": "mix", "geom": "h1", "solid": true, "faces": 6,
        "sketches": [{"name": "Outline", "entities": [line("e1")]}]}}));
    let path = a_file(".dxf");
    let out = run(&srv, json!({"path": path.to_string_lossy()})).await;
    let _ = std::fs::remove_file(&path);
    assert!(!is_error(&out), "{}", text_of(&out));
    let fs = features(&srv).await;
    let kinds: Vec<&str> = fs.iter().map(|f| f["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["sketch", "import"]);
    assert_eq!(fs[1]["format"], json!("dxf"));
    assert_eq!(fs[1]["geom"], json!("h1"));
}

#[tokio::test(flavor = "multi_thread")]
async fn content_reaches_the_engine_as_a_file_holding_those_bytes() {
    let _serial = serial();
    let (srv, engine) = server_with(part_reply());
    let out = run(&srv, json!({"content": b64(STL), "name": "part.stl"})).await;
    assert!(!is_error(&out), "{}", text_of(&out));
    let call = &engine.calls()[0];
    assert_eq!(call.payload["format"], json!("stl"));
    assert_eq!(call.saw.as_deref(), Some(STL));
    let path = call.payload["path"].as_str().unwrap_or_default().to_string();
    assert_eq!(
        Path::new(&path).file_name().map(|f| f.to_string_lossy().into_owned()),
        Some("part.stl".into()),
        "{path}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_temporary_file_does_not_outlive_the_read() {
    let _serial = serial();
    // The document keeps `geom`, a hash into the blob store, so the bytes are durable; a copy left behind
    // would keep every file an agent ever sent in the temp directory.
    let (srv, engine) = server_with(part_reply());
    run(&srv, json!({"content": b64(STL), "name": "part.stl"})).await;
    let path = engine.calls()[0].payload["path"].as_str().unwrap_or_default().to_string();
    assert!(!Path::new(&path).exists(), "{path}");
    assert!(!Path::new(&path).parent().expect("a spool directory").exists(), "left the directory behind");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_temporary_file_goes_when_the_read_fails_too() {
    let _serial = serial();
    // The control for the case above, and the one worth writing down: clean-up
    // on the happy path is easy to get right by accident.
    let (srv, engine) = server_with(json!({"ok": false, "error": {"message": "unreadable"}}));
    let out = run(&srv, json!({"content": b64(STL), "name": "part.stl"})).await;
    assert!(is_error(&out));
    let path = engine.calls()[0].payload["path"].as_str().unwrap_or_default().to_string();
    assert!(!Path::new(&path).exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_document_records_the_file_name_and_not_the_temporary_path() {
    let _serial = serial();
    // `source` is provenance. Naming a file that was deleted a moment later
    // would send anyone who read the field to a path that never resolves.
    let (srv, _engine) = server_with(part_reply());
    run(&srv, json!({"content": b64(STL), "name": "part.stl"})).await;
    assert_eq!(features(&srv).await[0]["source"], json!("part.stl"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_text_format_can_be_sent_as_its_own_text() {
    let _serial = serial();
    // STEP, OBJ and ASCII STL are text an agent holds as a string, so base64 first would only be undone here.
    let (srv, engine) = server_with(part_reply());
    let out = run(
        &srv,
        json!({"content": String::from_utf8_lossy(STL), "name": "part.stl",
               "encoding": "text"}),
    )
    .await;
    assert!(!is_error(&out), "{}", text_of(&out));
    assert_eq!(engine.calls()[0].saw.as_deref(), Some(STL));
}

#[tokio::test(flavor = "multi_thread")]
async fn text_sent_as_base64_says_which_argument_would_have_worked() {
    let _serial = serial();
    // The likeliest mistake: "invalid base64" alone would not say the encoding argument was the problem.
    let (srv, engine) = server_with(part_reply());
    let out = run(&srv, json!({"content": "ISO-10303-21;\nHEADER;\n", "name": "asm.step"})).await;
    assert!(is_error(&out));
    assert!(text_of(&out).contains("text"), "{}", text_of(&out));
    assert!(engine.calls().is_empty(), "went to the engine with nothing to read");
    assert!(features(&srv).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn content_that_is_not_even_ascii_still_says_base64() {
    let _serial = serial();
    // Not a codec error at a character offset the caller never sees: say it is not base64
    // and name the argument that takes text.
    let (srv, engine) = server_with(part_reply());
    let out = run(&srv, json!({"content": "éééé", "name": "p.step"})).await;
    assert!(is_error(&out));
    let said = text_of(&out);
    assert!(said.contains("base64") && said.contains("text"), "{said}");
    assert!(engine.calls().is_empty());
    assert!(srv.uploads().await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn base64_wrapped_in_newlines_is_still_base64() {
    let _serial = serial();
    // The control for the refusal above: encoders wrap at 76 columns and a strict decode refuses a newline.
    let (srv, engine) = server_with(part_reply());
    let body: Vec<u8> = STL.repeat(40);
    let enc = b64(&body);
    let wrapped: Vec<String> = enc.as_bytes().chunks(76).map(|c| String::from_utf8_lossy(c).into_owned()).collect();
    let out = run(&srv, json!({"content": wrapped.join("\n"), "name": "part.stl"})).await;
    assert!(!is_error(&out), "{}", text_of(&out));
    assert_eq!(engine.calls()[0].saw.as_deref(), Some(body.as_slice()));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_has_to_arrive_one_way_or_the_other() {
    let _serial = serial();
    let (srv, engine) = server_with(part_reply());
    let out = run(&srv, json!({})).await;
    assert!(is_error(&out));
    assert!(text_of(&out).contains("path") && text_of(&out).contains("content"));
    assert!(engine.calls().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_cannot_arrive_both_ways_at_once() {
    let _serial = serial();
    // Refused rather than resolved: importing the file the caller did not mean looks like success
    // until the measurements come out wrong.
    let (srv, engine) = server_with(part_reply());
    let path = a_file(".step");
    let out = run(&srv, json!({"path": path.to_string_lossy(), "content": b64(STL)})).await;
    let _ = std::fs::remove_file(&path);
    assert!(is_error(&out));
    assert!(engine.calls().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_name_is_what_gives_inline_content_its_format() {
    let _serial = serial();
    let (srv, engine) = server_with(part_reply());
    run(&srv, json!({"content": b64(STL), "name": "part.3mf"})).await;
    assert_eq!(engine.calls()[0].payload["format"], json!("3mf"));
}

#[tokio::test(flavor = "multi_thread")]
async fn content_with_no_name_at_all_is_read_as_step() {
    let _serial = serial();
    let (srv, engine) = server_with(part_reply());
    run(&srv, json!({"content": b64(b"ISO-10303-21;")})).await;
    assert_eq!(engine.calls()[0].payload["format"], json!("step"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_format_argument_still_names_the_file_it_writes() {
    let _serial = serial();
    // With no `name` the format supplies the extension: `imported.stl` reads better in a log than `imported`.
    let (srv, engine) = server_with(part_reply());
    run(&srv, json!({"content": b64(STL), "format": "stl"})).await;
    let call = &engine.calls()[0];
    assert_eq!(call.payload["format"], json!("stl"));
    let path = call.payload["path"].as_str().unwrap_or_default().to_string();
    assert_eq!(
        Path::new(&path).file_name().map(|f| f.to_string_lossy().into_owned()),
        Some("imported.stl".into()),
        "{path}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_name_cannot_write_outside_the_directory_made_for_it() {
    let _serial = serial();
    // `name` is a string from the model and it becomes a path here, so a
    // separator in it must not be one.
    let (srv, engine) = server_with(part_reply());
    run(&srv, json!({"content": b64(STL), "name": "../../../evil.step"})).await;
    let path = engine.calls()[0].payload["path"].as_str().unwrap_or_default().to_string();
    let path = Path::new(&path);
    let parent = path.parent().expect("a spool directory");
    assert!(
        parent.file_name().is_some_and(|n| n.to_string_lossy().starts_with("fundacad-import-")),
        "{}",
        path.display()
    );
    let base = path.file_name().expect("a file name").to_string_lossy().into_owned();
    assert!(!base.contains('/') && !base.contains('\\'), "{base}");
    assert!(base.contains("evil"), "{base}");
}

#[tokio::test(flavor = "multi_thread")]
async fn content_too_large_to_send_inline_points_at_path() {
    let _serial = serial();
    // The cap is on the MESSAGE, not the file; moved small here, as the assertion is about the refusal.
    let (srv, engine) = server_with(part_reply());
    let (inline, unpacked) = upload::set_caps(STL.len() - 1, upload::max_unpacked_bytes());
    let out = run(&srv, json!({"content": b64(STL), "name": "p.stl"})).await;
    assert!(is_error(&out));
    assert!(text_of(&out).contains("path"), "{}", text_of(&out));
    assert!(engine.calls().is_empty());

    // The control: the same bytes under a cap that fits go through, so what was
    // refused above is the size and not the mechanism.
    upload::set_caps(STL.len(), upload::max_unpacked_bytes());
    let (srv2, _e2) = server_with(part_reply());
    let ok = run(&srv2, json!({"content": b64(STL), "name": "p.stl"})).await;
    upload::set_caps(inline, unpacked);
    assert!(!is_error(&ok), "{}", text_of(&ok));
}

fn gzip(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    e.write_all(data).expect("in memory");
    e.finish().expect("in memory")
}

fn a_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            z.start_file(*name, options).expect("in memory");
            z.write_all(data).expect("in memory");
        }
        z.finish().expect("in memory");
    }
    buf.into_inner()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_gzipped_file_is_unpacked_before_the_engine_sees_it() {
    let _serial = serial();
    let (srv, engine) = server_with(part_reply());
    let out = run(&srv, json!({"content": b64(&gzip(STL)), "name": "part.stl", "compression": "gzip"})).await;
    assert!(!is_error(&out), "{}", text_of(&out));
    assert_eq!(engine.calls()[0].saw.as_deref(), Some(STL), "the engine was handed the archive");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_name_ending_gz_says_so_without_being_told() {
    let _serial = serial();
    // And the format has to come from what is INSIDE: "gz" is not a format, and
    // a file called part.stl.gz is a part.stl.
    let (srv, engine) = server_with(part_reply());
    run(&srv, json!({"content": b64(&gzip(STL)), "name": "part.stl.gz"})).await;
    assert_eq!(engine.calls()[0].payload["format"], json!("stl"));
    assert_eq!(engine.calls()[0].saw.as_deref(), Some(STL));
    assert_eq!(features(&srv).await[0]["source"], json!("part.stl"));
}

#[tokio::test(flavor = "multi_thread")]
async fn gzip_is_recognised_on_sight() {
    let _serial = serial();
    // Nothing this reads begins 1f 8b, so a gzip is spotted by its first two bytes rather than read as a corrupt STEP.
    let (srv, engine) = server_with(part_reply());
    run(&srv, json!({"content": b64(&gzip(STL)), "name": "part.stl"})).await;
    assert_eq!(engine.calls()[0].saw.as_deref(), Some(STL));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_3mf_is_passed_through_although_it_is_a_zip() {
    let _serial = serial();
    // THE control for sniffing: a 3MF *is* a zip the engine reads as one, so it must not be unpacked.
    let blob = a_zip(&[("3D/3dmodel.model", b"<model/>")]);
    let (srv, engine) = server_with(part_reply());
    run(&srv, json!({"content": b64(&blob), "name": "part.3mf"})).await;
    assert_eq!(engine.calls()[0].payload["format"], json!("3mf"));
    assert_eq!(engine.calls()[0].saw.as_deref(), Some(blob.as_slice()), "unpacked a 3MF and handed over its contents");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_zipped_step_is_taken_out_of_the_archive() {
    let _serial = serial();
    let step = b"ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n";
    let (srv, engine) = server_with(part_reply());
    let out = run(
        &srv,
        json!({"content": b64(&a_zip(&[("asm.step", step)])), "name": "asm.zip",
               "compression": "zip"}),
    )
    .await;
    assert!(!is_error(&out), "{}", text_of(&out));
    assert_eq!(engine.calls()[0].saw.as_deref(), Some(&step[..]));
}

#[tokio::test(flavor = "multi_thread")]
async fn stpz_is_a_zipped_step_by_name() {
    let _serial = serial();
    // ISO 10303-21's own spelling for a zipped STEP. The zip took the inner
    // extension away, so the suffix has to carry the format itself.
    let step = b"ISO-10303-21;\nEND-ISO-10303-21;\n";
    let (srv, engine) = server_with(part_reply());
    run(&srv, json!({"content": b64(&a_zip(&[("asm.stp", step)])), "name": "asm.stpz"})).await;
    assert_eq!(engine.calls()[0].payload["format"], json!("step"));
    assert_eq!(engine.calls()[0].saw.as_deref(), Some(&step[..]));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_gzip_stpz_is_unpacked_as_gzip() {
    let _serial = serial();
    // What FreeCAD and KiCad write under the same suffix.
    let step = b"ISO-10303-21;\nEND-ISO-10303-21;\n";
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut gz, step).unwrap();
    let (srv, engine) = server_with(part_reply());
    let out = run(&srv, json!({"content": b64(&gz.finish().unwrap()), "name": "asm.stpz"})).await;
    assert!(!is_error(&out), "{}", text_of(&out));
    assert_eq!(engine.calls()[0].payload["format"], json!("step"));
    assert_eq!(engine.calls()[0].saw.as_deref(), Some(&step[..]));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_format_comes_from_the_file_inside_a_plain_zip() {
    let _serial = serial();
    // A ".zip" says nothing about what it holds, and nobody said either, so the
    // only thing left that knows is the entry's own name.
    let (srv, engine) = server_with(part_reply());
    run(&srv, json!({"content": b64(&a_zip(&[("thing.stl", STL)])), "name": "bundle.zip"})).await;
    assert_eq!(engine.calls()[0].payload["format"], json!("stl"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_zip_of_several_files_is_refused_by_name() {
    let _serial = serial();
    // Which entry was meant has a right answer this process does not have.
    let blob = a_zip(&[("a.step", b"ISO-10303-21;"), ("b.stl", STL)]);
    let (srv, engine) = server_with(part_reply());
    let out = run(&srv, json!({"content": b64(&blob), "name": "two.zip", "compression": "zip"})).await;
    assert!(is_error(&out));
    let said = text_of(&out);
    assert!(said.contains("a.step") && said.contains("b.stl"), "{said}");
    assert!(engine.calls().is_empty());
    assert!(features(&srv).await.is_empty());

    // The control: naming the format answers the question, so the same archive
    // goes through. The refusal is the ambiguity, not the archive.
    let (srv2, engine2) = server_with(part_reply());
    let out = run(
        &srv2,
        json!({"content": b64(&blob), "name": "two.zip", "compression": "zip",
               "format": "stl"}),
    )
    .await;
    assert!(!is_error(&out), "{}", text_of(&out));
    assert_eq!(engine2.calls()[0].saw.as_deref(), Some(STL));
}

#[tokio::test(flavor = "multi_thread")]
async fn compression_none_overrules_a_name_that_says_otherwise() {
    let _serial = serial();
    // The escape hatch for a file really called .gz that is not compressed.
    let blob = gzip(STL);
    let (srv, engine) = server_with(part_reply());
    run(&srv, json!({"content": b64(&blob), "name": "part.stl.gz", "compression": "none"})).await;
    assert_eq!(engine.calls()[0].saw.as_deref(), Some(blob.as_slice()), "unpacked it after being told not to");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_gzip_that_is_not_one_is_refused_pointing_at_the_argument() {
    let _serial = serial();
    let (srv, engine) = server_with(part_reply());
    let out = run(&srv, json!({"content": b64(STL), "name": "part.stl", "compression": "gzip"})).await;
    assert!(is_error(&out));
    assert!(text_of(&out).contains("compression"), "{}", text_of(&out));
    assert!(engine.calls().is_empty());
    assert!(features(&srv).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn what_comes_out_of_an_archive_is_capped() {
    let _serial = serial();
    // A few hundred bytes of gzip expand to a gigabyte of zeroes, so a limit on what ARRIVES is no limit.
    let fat = vec![b'0'; 4096];
    let (srv, engine) = server_with(part_reply());
    let (inline, unpacked) = upload::set_caps(upload::max_inline_bytes(), 1024);
    let out = run(&srv, json!({"content": b64(&gzip(&fat)), "name": "p.stl", "compression": "gzip"})).await;
    assert!(is_error(&out), "{}", text_of(&out));
    assert!(engine.calls().is_empty());

    // The control: the same archive under a cap that fits goes through, so what
    // was refused is the size and not the gzip.
    upload::set_caps(upload::max_inline_bytes(), fat.len());
    let (srv2, engine2) = server_with(part_reply());
    let ok = run(&srv2, json!({"content": b64(&gzip(&fat)), "name": "p.stl", "compression": "gzip"})).await;
    upload::set_caps(inline, unpacked);
    assert!(!is_error(&ok), "{}", text_of(&ok));
    assert_eq!(engine2.calls()[0].saw.as_deref(), Some(fat.as_slice()));
}

/// Encode the WHOLE file once and split the text, which is what the tool asks
/// for and what an agent splitting its own output does.
async fn in_pieces(srv: &FundaCad, blob: &[u8], parts: usize, first: Value) -> Vec<rmcp::model::CallToolResult> {
    let enc = b64(blob);
    let step = enc.len().div_ceil(parts);
    let mut outs = Vec::new();
    let mut uid = String::new();
    for i in 0..parts {
        let slice = &enc[(i * step).min(enc.len())..((i + 1) * step).min(enc.len())];
        let mut a = json!({"content": slice, "part": i + 1, "parts": parts}).as_object().cloned().unwrap_or_default();
        if i == 0 {
            for (k, v) in first.as_object().into_iter().flatten() {
                a.insert(k.clone(), v.clone());
            }
        } else {
            a.insert("upload".into(), json!(uid));
        }
        let out = run(srv, Value::Object(a)).await;
        if i == 0 && !is_error(&out) && parts > 1 {
            uid = upload_id(&out);
        }
        outs.push(out);
    }
    outs
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_split_across_calls_arrives_whole() {
    let _serial = serial();
    let (srv, engine) = server_with(part_reply());
    let body = STL.repeat(200);
    let outs = in_pieces(&srv, &body, 4, json!({"name": "part.stl"})).await;
    assert!(!is_error(outs.last().expect("four pieces")), "{}", text_of(&outs[3]));
    assert_eq!(engine.calls().len(), 1, "asked the engine more than once");
    assert_eq!(engine.calls()[0].saw.as_deref(), Some(body.as_slice()));
    assert_eq!(features(&srv).await.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_is_imported_until_the_last_piece() {
    let _serial = serial();
    // A half-arrived file leaves the document untouched, so live mode offers the app nothing
    // rather than a body that is not the part.
    let (srv, engine) = server_with(part_reply());
    let enc = b64(&STL.repeat(200));
    let out = run(&srv, json!({"content": &enc[..100], "part": 1, "parts": 3, "name": "p.stl"})).await;
    assert!(!is_error(&out), "{}", text_of(&out));
    assert!(engine.calls().is_empty(), "read a file that had not finished arriving");
    assert!(features(&srv).await.is_empty());
    assert!(text_of(&out).to_lowercase().contains("part 2"), "{}", text_of(&out));
    let id = upload_id(&out);
    assert!(srv.uploads().await.iter().any(|(k, _)| *k == id));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_pieces_have_to_arrive_in_order() {
    let _serial = serial();
    // Buffering a gap would mean holding the pieces until it filled, and a gap
    // that never fills looks exactly like one that has not filled yet.
    let (srv, _engine) = server_with(part_reply());
    let enc = b64(&STL.repeat(200));
    let first = run(&srv, json!({"content": &enc[..100], "part": 1, "parts": 3, "name": "p.stl"})).await;
    let uid = upload_id(&first);
    let out = run(&srv, json!({"content": &enc[100..200], "part": 3, "parts": 3, "upload": uid})).await;
    assert!(is_error(&out));
    assert!(text_of(&out).contains("part 2"), "{}", text_of(&out));

    // The control: the piece that WAS expected is taken, on the same upload.
    let out = run(&srv, json!({"content": &enc[100..200], "part": 2, "parts": 3, "upload": uid})).await;
    assert!(!is_error(&out), "{}", text_of(&out));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_piece_that_names_no_upload_is_refused() {
    let _serial = serial();
    let (srv, engine) = server_with(part_reply());
    let enc = b64(&STL.repeat(200));
    run(&srv, json!({"content": &enc[..100], "part": 1, "parts": 2, "name": "p.stl"})).await;
    let out = run(&srv, json!({"content": &enc[100..], "part": 2, "parts": 2})).await;
    assert!(is_error(&out));
    assert!(text_of(&out).contains("upload"), "{}", text_of(&out));
    assert!(engine.calls().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_piece_that_disagrees_about_how_many_there_are_is_refused() {
    let _serial = serial();
    // The declared count says the file is complete; renegotiating it could end an upload early,
    // and the reader may accept a truncated STEP.
    let (srv, engine) = server_with(part_reply());
    let enc = b64(&STL.repeat(200));
    let first = run(&srv, json!({"content": &enc[..100], "part": 1, "parts": 3, "name": "p.stl"})).await;
    let uid = upload_id(&first);
    let out = run(&srv, json!({"content": &enc[100..], "part": 2, "parts": 2, "upload": uid})).await;
    assert!(is_error(&out));
    assert!(text_of(&out).contains('3'), "{}", text_of(&out));
    assert!(engine.calls().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn separately_encoded_pieces_are_caught_at_the_first_one() {
    let _serial = serial();
    // Encoding each piece rather than splitting the encoding joins into a file that is not the file;
    // base64 padding in the middle is the signature.
    let (srv, _engine) = server_with(part_reply());
    let out = run(&srv, json!({"content": b64(STL), "part": 1, "parts": 2, "name": "p.stl"})).await;
    assert!(is_error(&out), "{}", text_of(&out));
    assert!(text_of(&out).contains("split"), "{}", text_of(&out));
    assert!(srv.uploads().await.is_empty(), "left the upload open after refusing its first piece");
}

#[tokio::test(flavor = "multi_thread")]
async fn part_and_parts_go_together() {
    let _serial = serial();
    let (srv, _engine) = server_with(part_reply());
    let out = run(&srv, json!({"content": b64(STL), "part": 1, "name": "p.stl"})).await;
    assert!(is_error(&out));
    assert!(text_of(&out).contains("parts"));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_upload_nobody_came_back_for_is_swept() {
    let _serial = serial();
    // This process outlives any one conversation, so an upload abandoned
    // halfway would hold its directory for as long as the host runs.
    let (srv, _engine) = server_with(part_reply());
    let enc = b64(&STL.repeat(200));
    let first = run(&srv, json!({"content": &enc[..100], "part": 1, "parts": 9, "name": "p.stl"})).await;
    let id = upload_id(&first);
    let dir = srv.uploads().await.into_iter().find(|(k, _)| *k == id).map(|(_, d)| d).expect("the upload is open");
    assert!(dir.is_dir());

    srv.age_uploads(Duration::from_secs(upload::UPLOAD_IDLE_SECONDS + 1)).await; // time passes
    run(&srv, json!({"content": &enc[..100], "part": 1, "parts": 9, "name": "q.stl"})).await;
    assert!(!srv.uploads().await.iter().any(|(k, _)| *k == id), "kept an upload nobody came back for");
    assert!(!dir.exists(), "left its directory behind");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_piece_leaves_nothing_open() {
    let _serial = serial();
    let (srv, _engine) = server_with(part_reply());
    let enc = b64(&STL.repeat(200));
    let first = run(&srv, json!({"content": &enc[..100], "part": 1, "parts": 3, "name": "p.stl"})).await;
    let uid = upload_id(&first);
    let where_ = srv.uploads().await.into_iter().find(|(k, _)| *k == uid).map(|(_, d)| d).expect("the upload is open");
    let out = run(&srv, json!({"content": 12345, "part": 2, "parts": 3, "upload": uid})).await;
    assert!(is_error(&out));
    assert!(!srv.uploads().await.iter().any(|(k, _)| *k == uid));
    assert!(!where_.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_inline_cap_counts_every_piece_and_not_each_one() {
    let _serial = serial();
    // Pieces must not get around the inline limit, and the refusal comes at the piece
    // that crosses it, not after spooling.
    let (srv, engine) = server_with(part_reply());
    let body = STL.repeat(200);
    let (inline, unpacked) = upload::set_caps(body.len() / 2, upload::max_unpacked_bytes());
    let outs = in_pieces(&srv, &body, 4, json!({"name": "part.stl"})).await;
    upload::set_caps(inline, unpacked);
    let first_bad =
        outs.iter().position(is_error).unwrap_or_else(|| panic!("{:?}", outs.iter().map(text_of).collect::<Vec<_>>()));
    assert_eq!(first_bad, 2, "{:?}", outs.iter().map(text_of).collect::<Vec<_>>());
    assert!(engine.calls().is_empty());
    assert!(srv.uploads().await.is_empty(), "left the over-large upload open");
}

#[tokio::test(flavor = "multi_thread")]
async fn compressed_and_in_pieces_at_once() {
    let _serial = serial();
    // A STEP gzips about tenfold and pieces lift one message's ceiling,
    // which together make a real part importable this way.
    let mut step = b"ISO-10303-21;\n".to_vec();
    for _ in 0..400 {
        step.extend_from_slice(b"#1=CARTESIAN_POINT('',(0.,0.,0.));\n");
    }
    let packed = gzip(&step);
    assert!(packed.len() < step.len() / 4, "the fixture does not compress");
    let (srv, engine) = server_with(part_reply());
    let outs = in_pieces(&srv, &packed, 3, json!({"name": "asm.step.gz"})).await;
    assert!(!is_error(&outs[2]), "{}", text_of(&outs[2]));
    assert_eq!(engine.calls()[0].payload["format"], json!("step"));
    assert_eq!(engine.calls()[0].saw.as_deref(), Some(step.as_slice()));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_path_says_what_to_do_about_it() {
    let _serial = serial();
    // An agent told only "no such file" may invent a stand-in and model against it, self-consistent and wrong,
    // so the refusal carries the third move.
    let (srv, _engine) = server_with(part_reply());
    let out = run(&srv, json!({"path": std::env::temp_dir().join("nope.step").to_string_lossy()})).await;
    let said = text_of(&out);
    assert!(is_error(&out));
    assert!(said.contains("No such file"), "{said}");
    assert!(said.to_lowercase().contains("ask"), "{said}");
    assert!(said.contains("Import Mesh"), "{said}");
    assert!(said.contains("stand-in"), "{said}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_long_upload_is_told_what_it_is_costing() {
    let _serial = serial();
    // Inline content is the model's output, its binding limit; said on the first piece, while there is still a choice.
    let (srv, _engine) = server_with(part_reply());
    let enc = b64(&STL.repeat(400));
    let first = run(&srv, json!({"content": &enc[..100], "part": 1, "parts": 9, "name": "p.stl"})).await;
    assert!(!is_error(&first));
    assert!(text_of(&first).contains("message"), "{}", text_of(&first));
    assert!(text_of(&first).contains("Import Mesh"), "{}", text_of(&first));

    // Not again on the pieces after it: by then it would only be telling an
    // agent that what it is halfway through was a bad idea.
    let second = run(
        &srv,
        json!({"content": &enc[100..200], "part": 2, "parts": 9,
               "upload": upload_id(&first)}),
    )
    .await;
    assert!(!text_of(&second).contains("Import Mesh"), "{}", text_of(&second));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_upload_of_a_few_pieces_is_left_alone() {
    let _serial = serial();
    // The control. Two or three pieces is what the feature is FOR, and warning
    // about it would train an agent to ignore the warning that matters.
    let (srv, _engine) = server_with(part_reply());
    let enc = b64(&STL.repeat(400));
    let first = run(&srv, json!({"content": &enc[..100], "part": 1, "parts": 3, "name": "p.stl"})).await;
    assert!(!is_error(&first));
    assert!(!text_of(&first).contains("Import Mesh"), "{}", text_of(&first));
}

#[test]
fn an_imported_feature_validates_clean() {
    let _serial = serial();
    // `geom` and `source` are strings in a document whose other strings name parameters, and must not report problems.
    let mut doc = json!({"parameters": {}, "features": [{
        "id": "f1", "type": "import", "format": "step", "name": "asm",
        "geom": "dcbb8a24", "source": "C:\\parts\\asm.step", "solid": true}]})
    .as_object()
    .cloned()
    .expect("an object");
    assert_eq!(fundacad_mcp::model::validate(&mut doc), Vec::<String>::new());
    // The control: the exemption is by field NAME, so a genuinely bad reference
    // in a numeric field on the same feature is still caught.
    doc["features"][0]["distance"] = json!("nope");
    let problems = fundacad_mcp::model::validate(&mut doc);
    assert!(problems.iter().any(|p| p.contains("distance")), "{problems:?}");
}

#[test]
fn it_is_offered_to_the_app_like_any_other_edit() {
    let _serial = serial();
    // In live mode a mutator's result reaches the app as one undo step;
    // an import not listed would stay in the agent's copy.
    assert!(fundacad_mcp::server::MUTATORS.contains(&"doc_import"));
}
