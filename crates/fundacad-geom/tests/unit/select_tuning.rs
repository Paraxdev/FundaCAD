use fundacad_geom::select::tuning::*;

#[test]
fn the_shipped_file_overrides_the_tie_band() {
    let t = Tuning::shipped();
    assert_eq!(Tuning::default().tie_band, 0.15);
    assert_eq!(t.tie_band, 0.05);
    assert_eq!(t.nearest_tie_band, 0.02);
    assert_eq!(t.w_rank, 2.0);
}

#[test]
fn configure_keeps_missing_keys_and_ignores_unknown_ones() {
    let mut t = Tuning::default();
    t.configure(&serde_json::json!({"W_POS": 7, "BOGUS": 1, "TIE_BAND": "x"}));
    assert_eq!(t.w_pos, 7.0);
    assert_eq!(t.tie_band, 0.15);
}
