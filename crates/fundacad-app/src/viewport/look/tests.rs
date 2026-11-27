use super::*;

fn display(f: impl FnOnce(&mut Display)) -> Look {
    let mut d = Display::default();
    f(&mut d);
    Look::of(&d)
}

#[test]
fn realtime_and_path_traced_draw_lit_and_solid() {
    assert_eq!(display(|_| {}), Look { shading: Shading::Lit, faces: Faces::Solid });
    assert_eq!(display(|d| d.view_mode = ViewMode::Pathtraced).shading, Shading::Lit);
    assert_eq!(display(|_| {}).uniform(), [0.0, 0.0, 0.0, 1.0]);
}

#[test]
fn matcap_carries_its_style_and_tint() {
    let l = display(|d| {
        d.view_mode = ViewMode::Matcap;
        d.matcap = Matcap::Metal;
        d.matcap_tint = true;
    });
    assert_eq!(l.shading, Shading::Matcap { style: Matcap::Metal, tint: true });
    assert_eq!(l.uniform(), [1.0, 2.0, 1.0, 1.0]);
    let plain = display(|d| d.view_mode = ViewMode::Matcap);
    assert_eq!(plain.uniform()[1..3], [0.0, 0.0]);
}

#[test]
fn xray_blends_at_fundacad_1s_opacity() {
    let l = display(|d| d.xray = true);
    assert_eq!(l.faces, Faces::SeeThrough(XRAY_OPACITY));
    assert!(l.blended() && !l.wire());
    assert_eq!(l.uniform()[3], 0.35);
}

#[test]
fn wireframe_hides_the_faces_and_wins_over_xray() {
    for xray in [false, true] {
        let l = display(|d| {
            d.wireframe = true;
            d.xray = xray;
        });
        assert_eq!(l.faces, Faces::Hidden);
        assert!(l.blended() && l.wire());
        assert_eq!(l.uniform()[3], 0.0);
    }
}

#[test]
fn modes_combine_with_matcap() {
    let l = display(|d| {
        d.view_mode = ViewMode::Matcap;
        d.matcap = Matcap::Wax;
        d.xray = true;
    });
    assert_eq!(l.uniform(), [1.0, 3.0, 0.0, 0.35]);
}

#[test]
fn the_wire_colour_is_linearised() {
    let [r, g, b, a] = linear(EDGE_WIRE, 1.0);
    assert!((r - 0.552).abs() < 0.005 && (g - 0.617).abs() < 0.005 && (b - 0.694).abs() < 0.005, "{r} {g} {b}");
    assert_eq!(a, 1.0);
    assert_eq!(linear(0xffffff, 0.5), [1.0, 1.0, 1.0, 0.5]);
    assert_eq!(linear(0, 1.0)[0], 0.0);
}
