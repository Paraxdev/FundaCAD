use fundacad_mcp::mesh::MeshBody;
use fundacad_mcp::section::*;
use serde_json::Value;

#[test]
fn a_rectangle_with_a_hole() {
    // 20 x 10 centred on (5, 0), with a 4 x 2 hole in the middle.
    let outer = vec![[-5.0, -5.0], [15.0, -5.0], [15.0, 5.0], [-5.0, 5.0]];
    let hole = vec![[3.0, -1.0], [3.0, 1.0], [7.0, 1.0], [7.0, -1.0]];
    let p = properties(&[outer, hole]);
    assert!((p.area - 192.0).abs() < 1e-9);
    assert!((p.centroid[0] - 5.0).abs() < 1e-9 && p.centroid[1].abs() < 1e-9);
    // bh^3/12 less the hole's.
    assert!((p.iu - (20.0 * 1000.0 / 12.0 - 4.0 * 8.0 / 12.0)).abs() < 1e-9, "{}", p.iu);
    assert!((p.iv - (10.0 * 8000.0 / 12.0 - 2.0 * 64.0 / 12.0)).abs() < 1e-9, "{}", p.iv);
    assert!(p.iuv.abs() < 1e-9);
    assert_eq!((p.cu, p.cv), (10.0, 5.0));
}

#[test]
fn a_shape_along_the_diagonal_has_a_product_of_inertia() {
    let p = properties(&[vec![[0.0, 0.0], [2.0, 0.0], [2.0, 1.0], [0.0, 1.0]]]);
    assert!(p.iuv.abs() < 1e-12);
    let l = properties(&[vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]]);
    // A right triangle with legs 1 lying along u = v: Ixy about its
    // centroid is +1/72.
    assert!((l.iuv - 1.0 / 72.0).abs() < 1e-12, "{}", l.iuv);
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

#[test]
fn a_plane_needs_a_place() {
    let m = |v: Value| v.as_object().cloned().unwrap();
    assert!(plane_of(&m(serde_json::json!({"axis": "Z"}))).is_err());
    assert!(plane_of(&m(serde_json::json!({"axis": "W", "at": 1}))).is_err());
    let p = plane_of(&m(serde_json::json!({"origin": [0, 0, 0], "normal": [0, 0, 2]}))).unwrap();
    assert_eq!(cross(p.u, p.v), [0.0, 0.0, 1.0]);
    // `at` moves the plane, and the label says where it went.
    let p = plane_of(&m(serde_json::json!({"origin": [0, 0, 0], "normal": [0, 0, 1], "at": 10}))).unwrap();
    assert_eq!(p.origin, [0.0, 0.0, 10.0]);
    assert_eq!(p.label, "the plane through (0, 0, 10) normal to (0, 0, 1)");
}

#[test]
fn small_moments_keep_four_figures() {
    let m = |v: Value| v.as_object().cloned().unwrap();
    let plane = plane_of(&m(serde_json::json!({"axis": "Z", "at": 0}))).unwrap();
    // A 1 wide rectangle's area is its height, printed with the moments' four figure format.
    for (area, shown) in [(4.9087e-6, "4.909e-06"), (3.0680e-7, "3.068e-07"), (1666.6667, "1667")] {
        let cut = Cut { loops: vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, area], [0.0, area]]], ..Default::default() };
        let text = report("body1", "", &plane, &cut, false);
        assert!(text.starts_with(&format!("body1: area {shown} mm2 in 1 piece\n")), "{text}");
    }
}

#[test]
fn one_open_chain_is_one_chain_whatever_order_its_triangles_come_in() {
    // A strip standing across z = 0, three squares wide, its middle
    // square's triangles listed first.
    let positions: Vec<f32> = vec![
        0.0, 0.0, -1.0, 1.0, 0.0, -1.0, 2.0, 0.0, -1.0, 3.0, 0.0, -1.0, // bottom row
        0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 2.0, 0.0, 1.0, 3.0, 0.0, 1.0, // top row
    ];
    let indices = vec![1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6];
    let body = MeshBody { info: Default::default(), positions, indices, face_ids: vec![], edges: vec![] };
    let m = |v: Value| v.as_object().cloned().unwrap();
    let plane = plane_of(&m(serde_json::json!({"axis": "Z", "at": 0}))).unwrap();
    let c = cut(&body, &plane);
    assert!(c.loops.is_empty());
    assert_eq!(c.open.len(), 1, "{:?}", c.open);
    assert_eq!(c.open[0].len(), 7, "{:?}", c.open);
}
