//! A document whose other sections do not fit this build still types for a
//! build: what does not fit is left out, the features and parameters stay.

use fundacad_core::CadDocument;
use serde_json::json;

#[test]
fn a_document_that_fits_types_exactly_as_strictly() {
    let v = json!({"version": 10, "parameters": {"w": 4}, "features": [
        {"id": "b1", "type": "box", "length": "w", "width": 1, "height": 1}
    ], "futureKey": [1, 2]});
    let strict: CadDocument = serde_json::from_value(v.clone()).unwrap();
    assert_eq!(CadDocument::from_value_lenient(&v).unwrap(), strict);
}

#[test]
fn a_section_that_does_not_fit_is_left_out_and_the_rest_is_typed() {
    let v = json!({"parameters": {"w": 4}, "features": [
        {"id": "b1", "type": "box", "length": 2, "width": 1, "height": 1}
    ], "materials": [{"id": "m1", "name": 7}], "versions": "a newer repo"});
    assert!(serde_json::from_value::<CadDocument>(v.clone()).is_err());
    let doc = CadDocument::from_value_lenient(&v).unwrap();
    assert_eq!(doc.features.len(), 1);
    assert_eq!(doc.param("w"), Some(4.0));
    assert!(doc.materials.is_none());
    assert!(doc.versions.is_none());
}

#[test]
fn parameters_that_are_not_all_numbers_keep_the_numbers() {
    let v = json!({"parameters": {"w": 4, "label": "wide", "h": 2.5}, "features": []});
    let doc = CadDocument::from_value_lenient(&v).unwrap();
    assert_eq!(doc.param("w"), Some(4.0));
    assert_eq!(doc.param("h"), Some(2.5));
    assert_eq!(doc.param("label"), None);
}

#[test]
fn a_document_without_features_is_still_refused() {
    assert!(CadDocument::from_value_lenient(&json!({"parameters": {}})).is_err());
}
