use fundacad_geom::import::{too_large_message, MAX_IMPORT_BREP_FILE_BYTES, MAX_IMPORT_FILE_BYTES};

const MIB: u64 = 1024 * 1024;

#[test]
fn a_text_mesh_past_the_cap_is_pointed_at_binary_stl() {
    assert_eq!(
        too_large_message("obj", 417 * MIB),
        "file is 417 MiB, too large to import (limit 256 MiB). Export the model as binary STL, often several times \
         smaller, or decimate the mesh first."
    );
    for fmt in ["off", "vrml", "x3d", "amf"] {
        assert!(too_large_message(fmt, 300 * MIB).contains("binary STL"), "{fmt}");
    }
}

#[test]
fn a_binary_or_compressed_mesh_past_the_cap_is_told_to_decimate() {
    for fmt in ["stl", "3mf", "glb", "gltf", "ply", "fbx", "3ds"] {
        assert_eq!(
            too_large_message(fmt, MAX_IMPORT_FILE_BYTES + MIB),
            "file is 257 MiB, too large to import (limit 256 MiB). Decimate the mesh in the app that made it and \
             export it again.",
            "{fmt}"
        );
    }
}

#[test]
fn a_brep_file_past_the_cap_is_told_to_split_or_mesh_it() {
    for fmt in ["step", "stp", "stpz", "iges", "igs", "brep", "xbf", "fcstd"] {
        assert_eq!(
            too_large_message(fmt, MAX_IMPORT_BREP_FILE_BYTES + 10 * MIB),
            "file is 1034 MiB, too large to import (limit 1024 MiB). Export the assembly as several smaller files, \
             or export a binary STL of it and import that.",
            "{fmt}"
        );
    }
}
