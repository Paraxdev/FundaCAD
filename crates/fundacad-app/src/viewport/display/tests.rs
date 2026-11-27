use std::f32::consts::FRAC_PI_2;

use super::*;
use crate::viewport::views::View;

fn looking(view: View) -> Camera {
    let (yaw, pitch) = view.angles();
    Camera { yaw, pitch, ..Default::default() }
}

#[test]
fn view_modes_step_round_both_ways() {
    assert_eq!(ViewMode::Realtime.step(false), ViewMode::Pathtraced);
    assert_eq!(ViewMode::Pathtraced.step(false), ViewMode::Matcap);
    assert_eq!(ViewMode::Matcap.step(true), ViewMode::Pathtraced);
}

#[test]
fn automatic_is_orthographic_only_straight_on() {
    for v in [View::Front, View::Back, View::Left, View::Right, View::Top, View::Bottom] {
        assert!(Projection::Auto.ortho_for(&looking(v)), "{v:?}");
    }
    assert!(!Projection::Auto.ortho_for(&looking(View::Iso)));
    assert!(!Projection::Auto.ortho_for(&Camera { yaw: FRAC_PI_2 + 0.1, pitch: 0., ..Default::default() }));
    assert!(Projection::Ortho.ortho_for(&looking(View::Iso)));
    assert!(!Projection::Persp.ortho_for(&looking(View::Front)));
}

#[test]
fn the_master_switch_hides_every_overlay_and_keeps_their_own() {
    let mut d = Display::default();
    d.overlays.set(OverlayKind::Edges, false);
    assert!(!d.shows(OverlayKind::Edges));
    assert!(d.shows(OverlayKind::Origin));
    d.overlays.on = false;
    assert!(!d.shows(OverlayKind::Origin));
    d.overlays.on = true;
    assert!(!d.shows(OverlayKind::Edges), "turning overlays back on keeps a kind switched off");
}

#[test]
fn overlays_read_fundacad_1s_saved_shape() {
    let o: Overlays = serde_json::from_str(r#"{"on":false,"kinds":{"edges":false,"sketchLabels":true}}"#).unwrap();
    assert!(!o.on);
    assert!(!o.kind(OverlayKind::Edges));
    assert!(o.kind(OverlayKind::SketchLabels));
    assert!(o.kind(OverlayKind::Grid), "a kind it never saved is on");
}

#[test]
fn display_round_trips_through_the_settings_store() {
    let mut d = Display::load();
    d.view_mode = ViewMode::Matcap;
    d.matcap = Matcap::Wax;
    d.projection = Projection::Auto;
    d.sketch.snap = false;
    d.xray = true;
    d.save();
    let back = Display::load();
    assert_eq!(back.view_mode, ViewMode::Matcap);
    assert_eq!(back.matcap, Matcap::Wax);
    assert_eq!(back.projection, Projection::Auto);
    assert!(!back.sketch.snap);
    assert!(!back.xray, "X-ray lasts only for the run");
}

#[test]
fn an_orthographic_camera_keeps_the_target_scale() {
    let cam = Camera::default();
    let (p, o) = (cam.projection(1.5), cam.ortho(1.5));
    let at = cam.view().transform_point3(cam.target + cam.view().row(1).truncate() * 0.5);
    let (a, b) = (p.project_point3(at), o.project_point3(at));
    assert!((a.y - b.y).abs() < 1e-3, "{a} vs {b}");
}

#[test]
fn an_open_sketch_draws_flat_whatever_the_pick() {
    publish(Projection::Persp);
    set_sketch_flat(true);
    assert_eq!(projection(), Projection::Ortho);
    set_sketch_flat(false);
    assert_eq!(projection(), Projection::Persp);
    assert_eq!(Projection::default(), Projection::Auto, "FundaCAD 1's rig starts on auto");
}
