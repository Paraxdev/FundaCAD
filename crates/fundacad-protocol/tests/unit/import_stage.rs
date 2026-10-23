use fundacad_protocol::import_stage::*;

#[test]
fn a_stage_without_a_total_has_no_fraction() {
    assert_eq!(pct(3, 10), 30);
    assert_eq!(pct(12, 10), 100);
    assert_eq!(pct(0, 0), -1);
    assert_eq!(pct(-1, 5), -1);
    assert_eq!(label(TRANSFER), "Transferring shapes");
}
