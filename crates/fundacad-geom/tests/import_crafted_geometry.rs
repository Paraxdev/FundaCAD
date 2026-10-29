//! A crafted geometry blob must come back as an Err and leave the engine
//! running, never a wild read or an abort. Each malformed input is built here
//! from a real cube so it reaches the reader the app's own blobs reach.

mod unsound;

use fundacad_geom::features::import::{blob_to_shape, brep_b64_to_shape};
use fundacad_geom::kernel;
use opencascade::xcaf;

fn a_valid_cube_still_imports() {
    assert!(brep_b64_to_shape(&unsound::cube_brep(unsound::sound)).is_ok());
}

#[test]
fn a_subshape_index_past_the_table_is_an_error() {
    let blob = unsound::cube_brep(unsound::shape_index_past_table);
    assert!(brep_b64_to_shape(&blob).is_err());
    a_valid_cube_still_imports();
}

#[test]
fn a_reference_token_longer_than_the_buffer_is_an_error() {
    let blob = unsound::cube_brep(unsound::reference_token_past_buffer);
    assert!(brep_b64_to_shape(&blob).is_err());
    a_valid_cube_still_imports();
}

#[test]
fn a_stored_blob_is_read_only_under_the_header_the_app_writes() {
    let cube = kernel::make_box(10.0, 10.0, 10.0).expect("cube");
    let bytes = xcaf::to_bin_v3(&cube).expect("v3 bytes");
    assert!(blob_to_shape(&bytes).is_ok());

    let header = b"Open CASCADE Topology V3 (c)";
    let pos = bytes.windows(header.len()).position(|w| w == header).expect("header present");
    for other in [b"Open CASCADE Topology V1 (c)", b"Open CASCADE Topology V4 (c)"] {
        let mut forged = bytes.clone();
        forged[pos..pos + header.len()].copy_from_slice(other);
        match blob_to_shape(&forged) {
            Ok(_) => panic!("non-V3 header was accepted"),
            Err(err) => assert!(format!("{err:?}").contains("bad header"), "{err:?}"),
        }
    }
}
