use fundacad_geom::fem::SurfaceMesh;
use fundacad_geom::stress::*;

#[test]
fn the_weld_keeps_face_ids_and_drops_collapsed_triangles() {
    // Two triangles of different faces sharing an edge, given as separate copies, and a
    // sliver that collapses once welded.
    let p = [
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, // face 0
        1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, // face 1
        0.0, 0.0, 0.0, 1e-9, 0.0, 0.0, 0.0, 1.0, 0.0, // face 2, collapses
    ];
    let w = weld(&p, &[0, 1, 2, 3, 4, 5, 6, 7, 8], &[0, 1, 2]);
    assert_eq!(w.positions.len(), 4);
    assert_eq!(w.triangles, vec![[0, 1, 2], [1, 3, 2]]);
    assert_eq!(w.face_ids, vec![0, 1]);
    assert_eq!(open_edges(&w), 4);
}

#[test]
fn a_closed_tetrahedron_has_no_open_edges() {
    let m = SurfaceMesh {
        positions: vec![[0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        triangles: vec![[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]],
        face_ids: vec![0, 1, 2, 3],
    };
    assert_eq!(open_edges(&m), 0);
    let mut flipped = m.clone();
    flipped.triangles[0] = [0, 1, 2];
    assert_eq!(open_edges(&flipped), 3);
}

#[test]
fn the_default_size_follows_the_count_and_the_thickness() {
    // A 100 x 10 x 10 bar: thickness 2V/A = 4.76, the count asks for about 1.9 mm.
    let s = default_size(10_000.0, 4_200.0, DEFAULT_MAX_ELEMENTS);
    assert!(s > 1.5 && s < 2.38, "{s}");
    // A thin plate: the thickness wins.
    let plate = default_size(100.0 * 100.0 * 1.0, 2.0 * 100.0 * 100.0 + 400.0, DEFAULT_MAX_ELEMENTS);
    assert!(plate <= 2.0 * 10_000.0 / 20_400.0 / 2.0 + 1e-12, "{plate}");
}
