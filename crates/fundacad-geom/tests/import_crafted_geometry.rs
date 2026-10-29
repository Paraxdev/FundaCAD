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

fn v3_cube_bytes() -> Vec<u8> {
    let cube = kernel::make_box(10.0, 10.0, 10.0).expect("cube");
    xcaf::to_bin_v3(&cube).expect("v3 bytes")
}

/// The binary reader is the path a stored blob takes, yet only the header test
/// reached it before. `BinTools_ShapeSet::Read` takes the shape-table marker
/// with an unbounded `IS >> char[255]`; an over-long marker overran the buffer,
/// and C++20 bounds the read so the mismatched marker is an Err instead.
#[test]
fn a_binary_marker_longer_than_the_buffer_is_an_error() {
    let blob = v3_cube_bytes();
    let marker = b"TShapes";
    let pos = blob.windows(marker.len()).position(|w| w == marker).expect("marker present");
    let mut forged = blob[..pos].to_vec();
    forged.extend(std::iter::repeat(b'S').take(400));
    forged.extend_from_slice(&blob[pos + marker.len()..]);
    assert!(blob_to_shape(&forged).is_err());
    a_valid_cube_still_imports();
}

/// The binary reader resolves a subshape reference through an index into the
/// shape table. A reference is `<orientation byte><4-byte little-endian table
/// index><4-byte little-endian location index>`, and the blob ends with the one
/// that names the top-level shape. Forging that index past the table must come
/// back as an Err with the engine still up, never a wrong shape.
///
/// This guards refusal and liveness, not the range check itself: on the MSVC
/// kernel an out-of-range read is turned into a catchable failure whether the
/// kernel keeps its bounds checks or not, so a checked and an unchecked kernel
/// both refuse this. The marker test above is the one that crashes an unchecked
/// kernel, by overrunning a stack buffer rather than a map.
#[test]
fn a_binary_subshape_index_past_the_table_is_an_error() {
    let mut blob = v3_cube_bytes();
    let index = blob.len() - 8;
    blob[index..index + 4].copy_from_slice(&2_000_000_000u32.to_le_bytes());
    assert!(blob_to_shape(&blob).is_err());
    a_valid_cube_still_imports();
}

/// The four bytes after the index are the reference's location index, resolved
/// through the location table by the same lookup. A location past that table is
/// refused the same way, see the note on the subshape index above.
#[test]
fn a_binary_location_index_past_the_table_is_an_error() {
    let mut blob = v3_cube_bytes();
    let location = blob.len() - 4;
    blob[location..location + 4].copy_from_slice(&2_000_000_000u32.to_le_bytes());
    assert!(blob_to_shape(&blob).is_err());
    a_valid_cube_still_imports();
}

/// `read_blob` and `get_blob` reach the binary reader through `from_bin` without
/// going by `blob_to_shape`, so the header guard lives in `from_bin` to cover
/// every caller, not only the import feature.
#[test]
fn from_bin_refuses_any_header_but_the_one_the_app_writes() {
    let v3 = v3_cube_bytes();
    assert!(xcaf::from_bin(&v3).is_ok());

    let header = b"Open CASCADE Topology V3 (c)";
    let pos = v3.windows(header.len()).position(|w| w == header).expect("header present");
    for other in [b"Open CASCADE Topology V1 (c)", b"Open CASCADE Topology V2 (c)", b"Open CASCADE Topology V4 (c)"] {
        let mut forged = v3.clone();
        forged[pos..pos + header.len()].copy_from_slice(other);
        assert!(
            matches!(xcaf::from_bin(&forged), Err(opencascade::Error::BrepBadHeader)),
            "a non-V3 header reached the reader"
        );
    }
}
