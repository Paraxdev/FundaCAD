use fundacad_geom::bench::*;

#[test]
fn a_tracked_thread_names_the_phases_it_is_inside() {
    phase("untracked", || assert_eq!(doing(), None));
    let _t = track_this_thread();
    phase_named("chamfer", || {
        phase("blend_section", || {
            assert_eq!(doing().as_deref(), Some("chamfer > blend_section"));
        });
        assert_eq!(doing().as_deref(), Some("chamfer"));
    });
    assert_eq!(doing(), None);
}
