use fundacad_geom::import::stage::*;
use opencascade::progress::Progress;

#[test]
fn an_xcaf_sample_maps_to_parse_transfer_then_walk() {
    assert_eq!(of_xcaf_read(0.0, 0), (READ, -1, -1));
    assert_eq!(of_xcaf_read(0.0, 3), (TRANSFER, 0, 1000));
    assert_eq!(of_xcaf_read(0.475, 9), (TRANSFER, 500, 1000));
    assert_eq!(of_xcaf_read(0.95, 9), (WALK, -1, -1));
    assert_eq!(of_xcaf_read(1.0, 9), (WALK, -1, -1));
}

#[test]
fn nothing_installed_reports_nowhere() {
    report(READ, -1, -1);
    let p = Progress::new(|| false);
    assert_eq!(sampling_xcaf_read(&p, || 7), 7);
}
