//! The inline BREP of a stored import is read from memory, so it imports even
//! when the temp folder cannot be written. Its own binary: it repoints the
//! temp folder for the whole process.

use base64::Engine;
use fundacad_geom::features::import::brep_b64_to_shape;
use fundacad_geom::kernel;
use opencascade::progress::ProgressRange;
use opencascade::shape_io::BrepWriteOptions;

#[test]
fn an_inline_brep_imports_with_no_writable_temp_folder() {
    let options = BrepWriteOptions { with_triangles: false, with_normals: false, version: 0 };
    let text =
        kernel::make_box(3.0, 3.0, 3.0).expect("cube").to_brep_text(options, &ProgressRange::detached()).expect("text");
    let body: Vec<&str> = text.lines().skip_while(|l| !l.starts_with("CASCADE")).collect();
    let b64 = base64::engine::general_purpose::STANDARD.encode(body.join("\n") + "\n");

    let missing = std::env::temp_dir().join(format!("fundacad-no-temp-{}", std::process::id())).join("absent");
    for var in ["TMP", "TEMP", "TMPDIR"] {
        std::env::set_var(var, &missing);
    }
    assert_eq!(std::env::temp_dir(), missing);
    let shape = brep_b64_to_shape(&b64).expect("read from memory");
    assert!((kernel::volume(&shape) - 27.0).abs() < 1e-6);
}
