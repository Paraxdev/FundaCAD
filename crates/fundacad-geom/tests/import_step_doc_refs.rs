//! A STEP file can name other documents (PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS, APPLIED_DOCUMENT_REFERENCE),
//! which OCCT's XCAF reader would open and read beside it. FundaCAD imports only the file it was given.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use fundacad_geom::import::{self, blobstore::BlobStore};
use serde_json::{Map, Value};

fn dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("fundacad-import-doc-refs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("FUNDACAD_BLOB_DIR", &dir);
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures");
        std::fs::copy(fixtures.join("loose_faces_mixed.step"), dir.join("sibling.stp")).unwrap();
        dir
    })
}

const PD: &str = "#5 = PRODUCT_DEFINITION('design','',#6,#9);";

/// inside_out_cube.step, a six face cube, with `pd` in place of its product definition and `extra` records added.
fn main_file(name: &str, pd: &str, extra: &str) -> PathBuf {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures");
    let text = std::fs::read_to_string(fixtures.join("inside_out_cube.step")).unwrap();
    assert!(text.contains(PD));
    let end = text.rfind("ENDSEC;").unwrap();
    let text = format!("{}{extra}\n{}", &text[..end], &text[end..]).replace(PD, pd);
    let out = dir().join(name);
    std::fs::write(&out, text).unwrap();
    out
}

fn import(path: &Path) -> Result<Map<String, Value>, String> {
    let store = BlobStore::open(dir()).unwrap();
    import::import_geometry(path.to_str().unwrap(), "step", &store)
}

fn notes(out: &Map<String, Value>) -> Vec<String> {
    out.get("notes")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn faces(out: &Map<String, Value>) -> u64 {
    out.get("faces").and_then(Value::as_u64).unwrap()
}

const DOCUMENT: &str = "#90001 = DOCUMENT('d1','sibling.stp','',#90002);\n#90002 = DOCUMENT_TYPE('');";

#[test]
fn a_product_with_associated_documents_imports_only_its_own_shape() {
    let file = main_file(
        "pdwad.step",
        "#5 = PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS('design','',#6,#9,(#90001));",
        DOCUMENT,
    );
    let out = import(&file).unwrap();
    assert_eq!(faces(&out), 6, "only the cube of the file itself is imported");
    assert!(
        notes(&out).iter().any(|n| n.contains("1 external document")),
        "the import says the document was not loaded: {:?}",
        notes(&out)
    );
}

#[test]
fn an_applied_document_reference_is_left_out_with_a_note() {
    let extra = format!(
        "{DOCUMENT}\n#90003 = DOCUMENT_FILE('sibling.stp','sibling.stp','',#90002,'',$);\n\
         #90004 = APPLIED_DOCUMENT_REFERENCE(#90003,'',(#5));"
    );
    let out = import(&main_file("adr.step", PD, &extra)).unwrap();
    assert_eq!(faces(&out), 6);
    assert!(notes(&out).iter().any(|n| n.contains("1 external document")), "{:?}", notes(&out));
}

#[test]
fn a_document_reference_inside_a_complex_entity_is_refused() {
    let extra = format!(
        "{DOCUMENT}\n#90003 = DOCUMENT_FILE('sibling.stp','sibling.stp','',#90002,'',$);\n\
         #90004 = ( APPLIED_DOCUMENT_REFERENCE(#90003,'',(#5)) REPRESENTATION_ITEM('') );"
    );
    let err = import(&main_file("complex.step", PD, &extra)).unwrap_err();
    assert_eq!(err, "this STEP file names an external document inside a complex entity, which FundaCAD does not read");
}

/// Comments running longer than the scan holds of one record, so the record they open is read past in pieces.
/// Each is short, since OCCT's lexer cannot hold one token that long.
fn long_comment() -> String {
    "/* x */\n".repeat((8 << 20) + 16)
}

const FILE: &str = "#90003 = DOCUMENT_FILE('sibling.stp','sibling.stp','',#90002,'',$);\n";
const APPLIED: &str = "#90004 = APPLIED_DOCUMENT_REFERENCE(#90003,'',(#5));\n";

#[test]
fn a_record_too_long_to_hold_is_copied_whole_into_the_file_read() {
    let file = main_file("long_record.step", PD, &format!("{DOCUMENT}\n{FILE}{APPLIED}{}", long_comment()));
    let out = import(&file);
    let _ = std::fs::remove_file(&file);
    let out = out.unwrap();
    assert_eq!(
        (faces(&out), notes(&out)),
        (
            6,
            vec![
                "1 solid was inside out, its faces pointed into the material, so it was turned outward".to_string(),
                "1 external document named by this STEP file was not loaded, FundaCAD reads only the file itself."
                    .into()
            ]
        )
    );
}

#[test]
fn a_record_too_long_to_hold_that_names_a_document_is_refused() {
    let file = main_file("long_record_ref.step", PD, &format!("{DOCUMENT}\n{FILE}{}{APPLIED}", long_comment()));
    let err = import(&file).unwrap_err();
    let _ = std::fs::remove_file(&file);
    assert_eq!(
        err,
        "FundaCAD could not check this STEP file before reading it: a record FundaCAD cannot read to its end names \
         one of the entities it checks"
    );
}
