use glam::Vec3;

use super::*;
use crate::viewport::camera::Camera;

#[test]
fn nice_step_rounds_to_one_two_or_five() {
    assert_eq!(nice_step(1.2), 1.0);
    assert_eq!(nice_step(3.0), 2.0);
    assert_eq!(nice_step(6.0), 5.0);
    assert!((nice_step(0.08) - 0.1).abs() < 1e-6);
    assert_eq!(nice_step(0.0), 1.0);
    assert_eq!(nice_step(f32::NAN), 1.0);
}

#[test]
fn a_cell_aims_for_sixty_four_pixels() {
    assert_eq!(cell(10.0 / 64.0), 10.0);
    assert_eq!(cell(0.1), 5.0);
}

#[test]
fn ground_cells_come_in_whole_major_cells_within_the_limits() {
    assert_eq!(ground_cells(1.0, 1000.0, 10.0), 300.0);
    assert_eq!(ground_cells(1.0, 10.0, 10.0), 40.0);
    assert_eq!(ground_cells(1.0, 1e6, 1.0), 600.0);
    assert_eq!(ground_cells(1.0, 1000.0, 0.0), 40.0);
    assert_eq!(ground_cells(1.0, 1001.0, 10.0) % 5.0, 0.0);
}

#[test]
fn the_grid_recentres_in_whole_major_cells() {
    let g = Grid::at(Vec3::new(123.0, -77.0, 9.0), 10.0 / 64.0, 1000.0, 0x9a9ff0);
    assert_eq!(g.cell, 10.0);
    assert_eq!(g.centre, [100.0, -100.0]);
    let [at, cells] = g.uniform(-4.0);
    assert_eq!(at[2], -4.0);
    assert_eq!(cells[..2], [10.0, 50.0]);
    let quiet = look::linear(GRID_MAJOR, 1.0);
    assert!(g.major[2] > shown_raw(quiet)[2], "majors lean toward the accent");
    assert!(g.minor[0] < look::linear(GRID_MINOR, 1.0)[0], "the grid shows as dark as FundaCAD 1's raw shader");
}

#[test]
fn muted_pulls_toward_grey() {
    assert_eq!(muted(0x808080, 0.3), 0x808080);
    assert_eq!(muted(0xff0000, 0.0), 0xff0000);
    let m = muted(0xff5a5a, 1.0);
    assert_eq!(m >> 16, m & 0xff);
}

#[test]
fn the_glyph_shrinks_only_over_a_small_model() {
    assert_eq!(glyph_scale(64.0, None, 1.0, 0.3), 1.0);
    assert_eq!(glyph_scale(64.0, Some(1000.0), 1.0, 0.3), 1.0);
    assert!((glyph_scale(64.0, Some(100.0), 1.0, 0.3) - 45.0 / 64.0).abs() < 1e-6);
    assert_eq!(glyph_scale(64.0, Some(1.0), 1.0, 0.3), 0.3);
}

#[test]
fn the_triad_draws_three_fading_arms_and_a_dot_twice() {
    let cam = Camera::default();
    let [ghost, solid] = triad(&View::new(&cam, 800.0), None);
    assert_eq!(ghost.len(), solid.len());
    assert_eq!(solid.len(), 3 * 6 + 12 * 3);
    let root = solid[0].color[3];
    assert!((root - TRIAD_OPACITY).abs() < 1e-6);
    assert!((solid[1].color[3] - TRIAD_OPACITY * 0.2).abs() < 1e-6, "an arm fades to its tip");
    assert!((ghost[0].color[3] - TRIAD_OCCLUDED_OPACITY).abs() < 1e-6);
    let tip = Vec3::from(solid[1].position).length();
    let per_px = View::new(&cam, 800.0).px(Vec3::ZERO);
    assert!((tip / per_px - TRIAD_LENGTH_PX).abs() < 1.0, "the arm is 64 pixels long, {}", tip / per_px);
}
