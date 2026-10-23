use fundacad_geom::import::mesh::*;

#[test]
fn obj_faces_fan_and_count_back() {
    let (pos, idx) = obj_triangles("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1/1 2/2 3/3 -1\n").unwrap();
    assert_eq!(pos.len(), 12);
    assert_eq!(idx, [0, 1, 2, 0, 2, 3]);
    assert_eq!(obj_triangles("v 0 0 0\nf 1 2 3\n").unwrap_err(), "the OBJ file references vertices that do not exist");
    assert_eq!(obj_triangles("# nothing\n").unwrap_err(), "no triangles found in the OBJ file");
}
