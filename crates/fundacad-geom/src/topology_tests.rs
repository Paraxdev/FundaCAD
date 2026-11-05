use glam::DVec3;

use super::{min_rect, spread};

fn turned(points: &[[f64; 2]], degrees: f64, at: [f64; 2]) -> Vec<[f64; 2]> {
    let (s, c) = degrees.to_radians().sin_cos();
    points.iter().map(|p| [p[0] * c - p[1] * s + at[0], p[0] * s + p[1] * c + at[1]]).collect()
}

fn assert_sides(got: Option<[f64; 2]>, want: [f64; 2]) {
    let got = got.expect("a rectangle");
    assert!((got[0] - want[0]).abs() < 1e-6 && (got[1] - want[1]).abs() < 1e-6, "{got:?} against {want:?}");
}

#[test]
fn no_points_have_no_rectangle_and_one_point_has_no_size() {
    assert_eq!(min_rect(&[]), None);
    assert_eq!(min_rect(&[[3.5, -7.25]]), Some([0.0, 0.0]));
    assert_eq!(min_rect(&[[3.5, -7.25], [3.5, -7.25]]), Some([0.0, 0.0]));
}

#[test]
fn points_on_a_slanted_line_are_as_long_as_their_ends_apart() {
    let line: Vec<[f64; 2]> = (0..6).map(|k| [11.0 + 3.0 * f64::from(k), -4.0 + 4.0 * f64::from(k)]).collect();
    assert_sides(min_rect(&line), [25.0, 0.0]);
}

#[test]
fn a_rectangle_turned_at_any_angle_reports_its_own_sides() {
    let corners = [[0.0, 0.0], [50.0, 0.0], [50.0, 30.0], [0.0, 30.0]];
    for degrees in [0.0, 1.0, 30.0, 45.0, 60.0, 89.0, 90.0, 137.5, 211.0, 359.0] {
        assert_sides(min_rect(&turned(&corners, degrees, [37.5, -12.25])), [50.0, 30.0]);
    }
}

#[test]
fn a_square_is_measured_along_its_sides_not_its_diagonal() {
    let corners = [[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]];
    assert_sides(min_rect(&turned(&corners, 45.0, [-3.0, 8.0])), [20.0, 20.0]);
}

#[test]
fn inner_points_and_repeats_change_nothing() {
    let mut points = vec![[0.0, 0.0], [40.0, 0.0], [40.0, 10.0], [0.0, 10.0]];
    points.extend([[20.0, 5.0], [1.0, 1.0], [40.0, 0.0], [20.0, 0.0], [40.0, 10.0 + 1e-9]]);
    assert_sides(min_rect(&turned(&points, 17.0, [5.0, 5.0])), [40.0, 10.0]);
}

#[test]
fn an_l_shape_takes_its_outer_box_not_a_side_of_the_notch() {
    let l = [[0.0, 0.0], [30.0, 0.0], [30.0, 10.0], [10.0, 10.0], [10.0, 25.0], [0.0, 25.0]];
    assert_sides(min_rect(&turned(&l, 33.0, [90.0, -70.0])), [30.0, 25.0]);
}

#[test]
fn a_finely_sampled_circle_is_its_diameter_each_way() {
    let circle: Vec<[f64; 2]> = (0..720)
        .map(|k| {
            let t = (f64::from(k) / 2.0).to_radians();
            [8.0 + 12.5 * t.cos(), -3.0 + 12.5 * t.sin()]
        })
        .collect();
    let got = min_rect(&circle).unwrap();
    assert!((got[0] - 25.0).abs() < 1e-3 && (got[1] - 25.0).abs() < 1e-3, "{got:?}");
}

#[test]
fn a_triangle_rests_on_the_side_that_gives_the_smallest_rectangle() {
    let triangle = [[0.0, 0.0], [10.0, 0.0], [2.0, 4.0]];
    let got = min_rect(&turned(&triangle, 21.0, [14.0, 9.0])).unwrap();
    assert!((got[0] * got[1] - 40.0).abs() < 1e-9, "{got:?}");
}

#[test]
fn spread_is_measured_along_a_slanted_axis() {
    let axis = DVec3::new(3.0, 4.0, 12.0) / 13.0;
    let at = DVec3::new(7.0, -2.0, 5.5);
    let points = [at + axis * 2.0, at + axis * 9.5, at + axis * 4.0];
    assert!((spread(points.into_iter(), axis).unwrap() - 7.5).abs() < 1e-12);
    assert_eq!(spread(std::iter::empty(), axis), None);
    assert_eq!(spread(std::iter::once(at), axis), Some(0.0));
}
