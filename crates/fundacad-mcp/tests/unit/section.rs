use fundacad_mcp::budget::Page;
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

fn z0() -> Plane {
    plane_of(serde_json::json!({"axis": "Z", "at": 0}).as_object().unwrap()).unwrap()
}

fn square_at(x: f64, y: f64, side: f64) -> Cut {
    let h = side / 2.0;
    Cut { loops: vec![vec![[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]]], ..Default::default() }
}

/// `n` pins, each a 2 mm square section at its own place, and the rows the server lists them as.
fn pin_rows(n: usize, outline: bool) -> Vec<fundacad_mcp::budget::Row> {
    let plane = z0();
    (0..n)
        .map(|i| {
            let (id, name) =
                (format!("body{}", i + 1), if i == 0 { "Pin".to_string() } else { format!("Pin {}", i + 1) });
            let cut = square_at(i as f64 * 2.5, 0.0, 2.0);
            let text = report(&id, &name, &plane, &cut, outline);
            fundacad_mcp::budget::Row { id, name, same: alike(&plane, &cut, outline), text }
        })
        .collect()
}

#[test]
fn the_same_section_elsewhere_is_alike_and_another_shape_is_not() {
    let plane = z0();
    for outline in [false, true] {
        let here = alike(&plane, &square_at(0.0, 0.0, 2.0), outline);
        assert_eq!(here, alike(&plane, &square_at(147.5, -120.0, 2.0), outline));
        assert_ne!(here, alike(&plane, &square_at(0.0, 0.0, 3.0), outline));
        assert!(!here.contains("centroid ("), "{here}");
    }
}

#[test]
fn a_short_section_lists_every_body_as_before() {
    let rows = pin_rows(10, true);
    let texts: Vec<String> = rows.iter().map(|r| r.text.clone()).collect();
    assert_eq!(listing(rows, 40.0, Page { offset: 0, limit: 30 }, false, false), texts);
}

#[test]
fn alike_bodies_fold_after_the_count_and_keep_the_first_centroid() {
    let out = listing(pin_rows(3000, false), 12000.0, Page { offset: 0, limit: 30 }, false, true).join("\n");
    assert!(out.starts_with("3000 bodies cut, 12000 mm2 in all, bodies with the same section"), "{out}");
    assert!(out.contains("Outline points left out of a long list: pass outline true"), "{out}");
    assert!(out.contains("body1 \"Pin\": area 4 mm2 in 1 piece (and 2999 more alike: body2..body3000, named \"Pin 2\"..\"Pin 3000\")"), "{out}");
    assert!(out.contains("centroid (0, 0) in the plane"), "{out}");
    assert!(!out.contains("showing body rows"), "{out}");
    assert!(out.len() < 1200, "{} bytes: {out}", out.len());
}

#[test]
fn full_gives_every_body_its_own_block_and_a_page_reaches_the_last() {
    let out = listing(pin_rows(40, true), 160.0, Page::all(), true, false);
    assert_eq!(out[0], "40 bodies cut, 160 mm2 in all");
    assert_eq!(out.iter().filter(|l| l.contains(": area 4 mm2")).count(), 40);
    assert!(out[40].contains("\n  loop 1 (outline, 4 points): [[96.5,-1],"), "{}", out[40]);
    let last = listing(pin_rows(40, true), 160.0, Page { offset: 35, limit: 5 }, true, false).join("\n");
    assert!(last.contains("body40 \"Pin 40\": area 4 mm2"), "{last}");
    assert!(last.ends_with("showing body rows 36 to 40 of 40"), "{last}");
    let first = listing(pin_rows(40, true), 160.0, Page { offset: 0, limit: 5 }, true, false).join("\n");
    assert!(
        first.ends_with("showing body rows 1 to 5 of 40: pass offset 5 for the next 5, or limit 0 for all"),
        "{first}"
    );
}

#[test]
fn bodies_with_another_section_stay_apart() {
    let plane = z0();
    let mut rows = pin_rows(12, false);
    let cut = square_at(50.0, 0.0, 3.0);
    rows.push(fundacad_mcp::budget::Row {
        id: "body13".into(),
        name: "Pin 13".into(),
        same: alike(&plane, &cut, false),
        text: report("body13", "Pin 13", &plane, &cut, false),
    });
    let out = listing(rows, 57.0, Page { offset: 0, limit: 30 }, false, false).join("\n");
    assert!(out.contains("(and 11 more alike: body2..body12, named"), "{out}");
    assert!(out.contains("body13 \"Pin 13\": area 9 mm2 in 1 piece\n"), "{out}");
}
