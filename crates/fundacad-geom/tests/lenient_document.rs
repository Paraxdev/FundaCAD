//! A rebuild of a document whose other sections a newer version wrote in shapes
//! this build cannot read still builds its features.

use fundacad_geom::builder::NoWatch;
use fundacad_geom::jobs::rebuild_result;
use fundacad_protocol::JobResult;
use serde_json::{json, Map};

#[test]
fn a_document_with_a_section_this_build_cannot_read_still_builds() {
    let doc = json!({"parameters": {"w": 10, "label": "wide"}, "features": [
        {"id": "b1", "type": "box", "length": "w", "width": 10, "height": 10}
    ], "versions": "a repo of a newer shape", "materials": [{"id": 3}]});
    let fields = match rebuild_result(&doc, 0.5, &Map::new(), &NoWatch) {
        JobResult::Mesh(m) => m.fields,
        JobResult::Json(m) => panic!("no bodies: {m:?}"),
    };
    assert!(!fields.contains_key("error"), "{fields:?}");
    assert!(!fields.contains_key("featureErrors"), "{fields:?}");
}
