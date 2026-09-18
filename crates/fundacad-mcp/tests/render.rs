//! The rasteriser `view` draws with. A port of
//! the Python MCP server's `test_render.py`.
//!
//! Everything here is arrays in, array out, so the whole of it is testable by
//! counting pixels, which is the reason the renderer is pure of the wire and of
//! files.

use fundacad_mcp::render::{self as r, Canvas, Rgb, Vec3, ViewRequest};
use serde_json::{json, Value};

fn box_mesh(size: [f64; 3], centre: [f64; 3], ident: &str) -> Value {
    let [sx, sy, sz] = size;
    let [cx, cy, cz] = centre;
    let (hx, hy, hz) = (sx / 2.0, sy / 2.0, sz / 2.0);
    let v = [
        [cx - hx, cy - hy, cz - hz],
        [cx + hx, cy - hy, cz - hz],
        [cx + hx, cy + hy, cz - hz],
        [cx - hx, cy + hy, cz - hz],
        [cx - hx, cy - hy, cz + hz],
        [cx + hx, cy - hy, cz + hz],
        [cx + hx, cy + hy, cz + hz],
        [cx - hx, cy + hy, cz + hz],
    ];
    let faces = [
        [0, 3, 2],
        [0, 2, 1],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 0, 4],
        [3, 4, 7],
    ];
    json!({
        "id": ident,
        "positions": v.iter().flatten().copied().collect::<Vec<f64>>(),
        "indices": faces.iter().flatten().copied().collect::<Vec<i64>>(),
        "faceIds": (0..12).map(|k| k / 2).collect::<Vec<i64>>(),
        "edges": []
    })
}

fn cube(ident: &str) -> Value {
    box_mesh([20.0, 20.0, 20.0], [0.0; 3], ident)
}

fn request(width: u32, height: u32, view: &str) -> ViewRequest {
    ViewRequest {
        width,
        height,
        view: Some(view.into()),
        draw_edges: true,
        section: Value::Null,
        focus: Value::Null,
        ..ViewRequest::default()
    }
}

fn draw(meshes: &[Value], req: &ViewRequest) -> Canvas {
    r::render(meshes, req).expect("these fixtures section cleanly")
}

/// How many pixels are not the background.
fn painted(c: &Canvas) -> usize {
    (0..c.h)
        .flat_map(|y| (0..c.w).map(move |x| (x, y)))
        .filter(|(x, y)| off_background(c.pixel(*x, *y)))
        .count()
}

fn off_background(p: Rgb) -> bool {
    let bg = r::BACKGROUND;
    (0..3)
        .map(|k| (i32::from(p[k]) - i32::from(bg[k])).abs())
        .sum::<i32>()
        > 12
}

fn same(a: &Canvas, b: &Canvas) -> bool {
    a.color == b.color
}

fn channel_sum(c: &Canvas, rows: std::ops::Range<u32>, channel: usize) -> i64 {
    rows.flat_map(|y| (0..c.w).map(move |x| (x, y)))
        .map(|(x, y)| i64::from(c.pixel(x, y)[channel]))
        .sum()
}

// --- the camera --------------------------------------------------------------

#[test]
fn the_basis_is_orthonormal_for_every_named_view() {
    for (name, _) in r::NAMED_VIEWS {
        let b = r::view_basis(r::direction_for(Some(name), None, None));
        for i in 0..3 {
            for j in 0..3 {
                let dot: f64 = (0..3).map(|k| b[i][k] * b[j][k]).sum();
                let want = if i == j { 1.0 } else { 0.0 };
                assert!((dot - want).abs() < 1e-9, "{name}: {dot}");
            }
        }
    }
}

#[test]
fn looking_straight_down_does_not_collapse() {
    // The control for the up-vector fallback. World up is +Z, so a top view has
    // it parallel to the view direction and the obvious cross product is zero,
    // without the fallback the whole image is one pixel wide.
    for name in ["top", "bottom"] {
        let canvas = draw(&[cube("b1")], &request(120, 120, name));
        assert!(
            painted(&canvas) > 5000,
            "{name} view painted {} pixels",
            painted(&canvas)
        );
    }
}

#[test]
fn world_up_lands_in_the_upper_half_of_the_image() {
    // Screen y runs down and world up runs up, so the projection negates. Get
    // that wrong and every render is upside down, which nothing else here would
    // notice: a box looks the same either way.
    let tall = box_mesh([20.0, 20.0, 6.0], [0.0, 0.0, 30.0], "b1");
    let flat = box_mesh([20.0, 20.0, 6.0], [0.0, 0.0, -30.0], "b2");
    let canvas = draw(&[tall, flat], &request(200, 200, "front"));
    // BODY_COLORS[0] is bluish and [1] is reddish, so the second body being in
    // the LOWER half is what a correct projection produces.
    let reds_top = channel_sum(&canvas, 0..100, 0);
    let reds_bottom = channel_sum(&canvas, 100..200, 0);
    assert!(
        reds_bottom > reds_top,
        "the body at z = -30 was not drawn at the bottom"
    );
}

#[test]
fn the_fit_puts_everything_on_screen_with_a_margin() {
    let pts: [Vec3; 3] = [[-50.0, -30.0, 10.0], [50.0, 30.0, -10.0], [0.0; 3]];
    for (name, _) in r::NAMED_VIEWS {
        let basis = r::view_basis(r::direction_for(Some(name), None, None));
        let v: Vec<Vec3> = pts.iter().map(|p| r::to_view(*p, &basis)).collect();
        let (centre, scale) = r::fit_scale(&v, 400, 300, 0.06);
        for p in &v {
            let s = r::project(*p, centre, scale, 400, 300);
            assert!(s[0] > 0.0 && s[0] < 400.0, "{name}: {s:?}");
            assert!(s[1] > 0.0 && s[1] < 300.0, "{name}: {s:?}");
        }
    }
}

#[test]
fn focus_frames_the_size_it_was_asked_for() {
    // A window `size` mm across on the shorter side, so a 1.5 mm thread on a
    // 200 mm part is actually visible.
    let big = box_mesh([200.0; 3], [0.0; 3], "b1");
    let wide = draw(&[big.clone()], &request(200, 200, "front"));
    let mut close_req = request(200, 200, "front");
    close_req.focus = json!({"at": [0, 0, 0], "size": 20});
    let close = draw(&[big], &close_req);
    assert!(
        painted(&wide) < 200 * 200,
        "the fitted view should leave a margin"
    );
    assert_eq!(
        painted(&close),
        200 * 200,
        "a 20mm window on a 200mm box must fill the frame"
    );
}

// --- the raster --------------------------------------------------------------

#[test]
fn nothing_in_gives_a_clean_background() {
    let canvas = draw(&[], &request(40, 30, "iso"));
    assert_eq!(painted(&canvas), 0);
    assert_eq!((canvas.w, canvas.h), (40, 30));
    assert_eq!(canvas.color.len(), 40 * 30 * 3);
}

#[test]
fn a_box_covers_the_expected_share_of_a_front_view() {
    // A cube seen square on fills the fitted frame edge to edge in one axis.
    // The margin is 6% each side, so the painted width is 88% of the image.
    let canvas = draw(&[cube("b1")], &request(200, 200, "front"));
    let lit = (0..200).filter(|x| off_background(canvas.pixel(*x, 100))).count();
    assert!(lit >= 170, "painted {lit} of 200 px across the middle");
}

#[test]
fn the_nearer_surface_wins() {
    // Two boxes, one behind the other, with the FAR one drawn second. Without a
    // depth test the far one paints over the near one and the colours swap.
    let near = box_mesh([20.0; 3], [0.0, -40.0, 0.0], "b1");
    let far = box_mesh([20.0; 3], [0.0, 40.0, 0.0], "b2");
    let canvas = draw(&[near, far], &request(200, 200, "front"));
    let mid = canvas.pixel(100, 100);
    // BODY_COLORS[0] is the bluish one: blue channel above red.
    assert!(
        mid[2] > mid[0],
        "the far body painted over the near one: {mid:?}"
    );
}

#[test]
fn the_control_for_the_depth_test() {
    // Swap which body is nearer and the answer must swap too, or the test above
    // is passing on the draw order rather than on the depth.
    let far = box_mesh([20.0; 3], [0.0, 40.0, 0.0], "b1");
    let near = box_mesh([20.0; 3], [0.0, -40.0, 0.0], "b2");
    let canvas = draw(&[far, near], &request(200, 200, "front"));
    let mid = canvas.pixel(100, 100);
    assert!(
        mid[0] > mid[2],
        "the near body (reddish) did not win: {mid:?}"
    );
}

#[test]
fn a_highlighted_face_is_painted_and_only_that_face() {
    fn orange(c: &Canvas) -> usize {
        (0..c.h)
            .flat_map(|y| (0..c.w).map(move |x| (x, y)))
            .filter(|(x, y)| {
                let p = c.pixel(*x, *y);
                p[0] > 120 && i32::from(p[0]) > i32::from(p[2]) + 40 && p[1] < p[0]
            })
            .count()
    }
    let plain = draw(&[cube("b1")], &request(200, 200, "front"));
    let mut lit_req = request(200, 200, "front");
    lit_req.highlight = Some(("b1".into(), vec![2]));
    let lit = draw(&[cube("b1")], &lit_req);
    let mut away = request(200, 200, "front");
    away.highlight = Some(("b1".into(), vec![5]));
    let hidden = draw(&[cube("b1")], &away);

    assert_eq!(orange(&plain), 0, "nothing should be orange without a highlight");
    assert!(
        orange(&lit) > 1000,
        "the highlighted face painted {} pixels",
        orange(&lit)
    );
    assert_eq!(
        orange(&hidden),
        0,
        "a face pointing away from the camera must not show through the body"
    );
}

#[test]
fn the_inside_of_a_surface_is_drawn_darker() {
    // What makes a cutaway readable. With both sides shaded alike a bore and a
    // boss look identical, which is the one thing a section is for.
    let base: Rgb = [200, 200, 200];
    let out: u32 = r::shade(base, [0.0, 0.0, 1.0]).iter().map(|c| u32::from(*c)).sum();
    let inside: u32 = r::shade(base, [0.0, 0.0, -1.0])
        .iter()
        .map(|c| u32::from(*c))
        .sum();
    assert!(f64::from(inside) < f64::from(out) * 0.8);
}

// --- sections ----------------------------------------------------------------

fn rows_painted(c: &Canvas) -> usize {
    (0..c.h)
        .filter(|y| (0..c.w).any(|x| off_background(c.pixel(x, *y))))
        .count()
}

fn cols_painted(c: &Canvas) -> usize {
    (0..c.w)
        .filter(|x| (0..c.h).any(|y| off_background(c.pixel(*x, y))))
        .count()
}

#[test]
fn a_section_removes_the_half_it_was_told_to() {
    let whole = draw(&[cube("b1")], &request(200, 200, "front"));
    let mut cut_req = request(200, 200, "front");
    cut_req.section = json!({"axis": "Z", "keep": "below"});
    let cut = draw(&[cube("b1")], &cut_req);
    // A front view of a box cut on Z shows half the height, and the fit then
    // scales that half back up, so the test is on the SHAPE, not the area.
    assert!(painted(&whole) > 0 && painted(&cut) > 0);
    assert!(
        rows_painted(&whole) as f64 > rows_painted(&cut) as f64 * 1.4,
        "{} vs {}",
        rows_painted(&whole),
        rows_painted(&cut)
    );
    assert!(
        cols_painted(&cut) as f64 > rows_painted(&cut) as f64 * 1.5,
        "the remaining half should be wider than it is tall"
    );
}

#[test]
fn a_section_that_misses_the_model_removes_nothing() {
    // The control. `at` far outside the model must leave the render untouched,
    // or the test above could be passing on any change at all.
    let whole = draw(&[cube("b1")], &request(200, 200, "front"));
    let mut missed_req = request(200, 200, "front");
    missed_req.section = json!({"axis": "Z", "at": 500, "keep": "below"});
    let missed = draw(&[cube("b1")], &missed_req);
    assert!(same(&whole, &missed));
}

#[test]
fn the_default_cut_is_through_the_middle_wherever_the_part_sits() {
    let box_high = box_mesh([20.0; 3], [0.0, 0.0, 137.0], "b1");
    let bounds = r::model_bounds(&[&box_high]);
    let plane = r::section_plane(&json!({"axis": "Z"}), bounds)
        .expect("Z is a known axis")
        .expect("a section was asked for");
    let (normal, offset) = plane;
    assert!(
        (normal[0]).abs() < 1e-9 && (normal[1]).abs() < 1e-9 && (normal[2] - 1.0).abs() < 1e-9
    );
    assert!((offset - 137.0).abs() < 1e-9, "{offset}");
}

#[test]
fn the_two_sides_of_a_cut_are_different_pictures() {
    // The half that survives has to depend on which half was asked for.
    //
    // The vocabulary was "above"/"over"/"+" against everything else, so `max`,
    // the word `at`, `min` and `max` elsewhere invite, silently meant `below`.
    // Both sides rendered identical images and the reply said "keeping max"
    // over a picture of the other half. Asserting on the PAIR is what catches
    // that; a test of one side alone passes either way.
    let shot = |word: &str| {
        let mut req = request(160, 160, "front");
        req.section = json!({"axis": "Y", "at": 0, "keep": word});
        draw(&[cube("b1")], &req)
    };
    let low: Vec<Canvas> = ["below", "min", "near", "-"].iter().map(|w| shot(w)).collect();
    let high: Vec<Canvas> = ["above", "max", "far", "+"].iter().map(|w| shot(w)).collect();
    for (group, name) in [(&low, "low"), (&high, "high")] {
        for other in &group[1..] {
            assert!(same(&group[0], other), "{name} synonyms disagree");
        }
    }
    assert!(!same(&low[0], &high[0]), "both sides drew the same half");
}

#[test]
fn a_keep_word_that_is_not_a_side_is_refused() {
    // Guessing is what made the bug above invisible: the picture was wrong and
    // nothing said so. A word this does not know has no safe reading, so it has
    // to stop rather than pick one.
    let mut req = request(80, 80, "front");
    req.section = json!({"axis": "Y", "keep": "middle"});
    let out = r::render(&[cube("b1")], &req);
    let Err(message) = out else {
        panic!("keep='middle' was accepted and quietly given a meaning");
    };
    assert!(
        message.contains("middle") && message.contains("max"),
        "{message}"
    );
}

#[test]
fn clipping_a_triangle_keeps_the_right_area() {
    let (a, b, c) = ([0.0; 3], [10.0, 0.0, 0.0], [0.0, 10.0, 0.0]);
    let n = [1.0, 0.0, 0.0];
    let parts = r::clip_triangle(a, b, c, n, 5.0);
    let area: f64 = parts
        .iter()
        .map(|[p0, p1, p2]| {
            let u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
            let v = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
            let cr = [
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            ];
            0.5 * (cr[0] * cr[0] + cr[1] * cr[1] + cr[2] * cr[2]).sqrt()
        })
        .sum();
    // the kept region is the triangle minus the corner beyond x = 5
    assert!((area - (50.0 - 12.5)).abs() < 1e-9, "{area}");
    assert!(
        r::clip_triangle(a, b, c, n, -1.0).is_empty(),
        "nothing should survive a plane before it"
    );
    assert_eq!(
        r::clip_triangle(a, b, c, n, 50.0).len(),
        1,
        "everything should survive a plane past it"
    );
}

#[test]
fn clipping_a_segment() {
    let (a, b) = ([0.0; 3], [10.0, 0.0, 0.0]);
    let kept = r::clip_segment(a, b, [1.0, 0.0, 0.0], 4.0).expect("half of it survives");
    assert!((kept.1[0] - 4.0).abs() < 1e-9);
    assert!(r::clip_segment(a, b, [1.0, 0.0, 0.0], -1.0).is_none());
}

// --- input shapes ------------------------------------------------------------

#[test]
fn a_polyline_is_read_flat_nested_or_wrapped() {
    let flat = r::polyline_points(&json!([0, 0, 0, 1, 1, 1]));
    let nested = r::polyline_points(&json!([[0, 0, 0], [1, 1, 1]]));
    let wrapped = r::polyline_points(&json!({"points": [0, 0, 0, 1, 1, 1], "body": "b1"}));
    assert_eq!(flat, nested);
    assert_eq!(flat, wrapped);
    assert!(r::polyline_points(&Value::Null).is_empty());
    assert!(r::polyline_points(&json!([1, 2])).is_empty());
}

#[test]
fn only_the_named_bodies_are_drawn() {
    fn reddish(c: &Canvas) -> usize {
        (0..c.h)
            .flat_map(|y| (0..c.w).map(move |x| (x, y)))
            .filter(|(x, y)| {
                let p = c.pixel(*x, *y);
                i32::from(p[0]) > i32::from(p[2]) + 15 && p[0] > 60
            })
            .count()
    }
    let a = box_mesh([20.0; 3], [-30.0, 0.0, 0.0], "b1");
    let b = box_mesh([20.0; 3], [30.0, 0.0, 0.0], "b2");
    let both = draw(&[a.clone(), b.clone()], &request(200, 200, "front"));
    let mut one_req = request(200, 200, "front");
    one_req.bodies = Some(vec!["b1".into()]);
    let one = draw(&[a, b], &one_req);
    // BODY_COLORS[1] is the reddish one, and b2 is the only body wearing it
    assert!(
        reddish(&both) > 1000,
        "the second body should be visible when both are drawn"
    );
    assert_eq!(reddish(&one), 0, "the filtered-out body was drawn anyway");
    assert!(painted(&one) > 1000, "the kept body was not drawn");
    let mid = one.pixel(100, 100);
    assert!(mid[2] > mid[0], "the kept body should keep its own colour");
}
