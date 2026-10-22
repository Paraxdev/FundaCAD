use fundacad_geom::select::entity::*;

#[test]
fn rounding_matches_python() {
    // round(0.125, 2), round(2.675, 2), round(0.0625, 3), round(-0.0001, 3)
    assert_eq!(py_round(0.125, 2), 0.12);
    assert_eq!(py_round(2.675, 2), 2.67);
    assert_eq!(py_round(0.0625, 3), 0.062);
    assert_eq!(py_round(0.375, 2), 0.38);
    assert_eq!(key_bits(&[py_round(-0.0001, 3), 0.0, 0.0, 0.0]), key_bits(&[0.0; 4]));
    assert_eq!(format!("{:.2}", 0.125), "0.12");
}
