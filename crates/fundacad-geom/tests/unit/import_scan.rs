use fundacad_geom::import::mesh::MAX_IMPORT_TRIANGLES;
use fundacad_geom::import::scan::*;

#[test]
fn the_route_is_decided_by_the_triangle_count() {
    assert_eq!(route(MAX_IMPORT_TRIANGLES), Route::Editable);
    assert_eq!(route(MAX_IMPORT_TRIANGLES + 1), Route::Scan);
    assert_eq!(route(MAX_SCAN_TRIANGLES), Route::Scan);
    match route(MAX_SCAN_TRIANGLES + 1) {
        Route::Refused(why) => assert!(why.contains("10,000,000"), "{why}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn weld_merges_shared_corners_and_drops_collapsed_triangles() {
    let pos = [
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 1.0, 0.0,
    ];
    let idx: Vec<u32> = (0..9).collect();
    let (p, i) = weld(&pos, &idx);
    assert_eq!(p.len() / 3, 4);
    assert_eq!(i.len() / 3, 2);
}
