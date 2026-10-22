use fundacad_core::hole_standards::*;

#[test]
fn standards_fill_what_they_define() {
    let m3 = standard_dims("counterbore", None, Some("M3"), None);
    assert_eq!(m3.diameter, Some(3.4));
    assert_eq!((m3.cb_diameter, m3.cb_depth), (Some(6.5), Some(3.4)));
    assert_eq!(standard_dims("simple", Some("tap"), Some("M5"), None).diameter, Some(4.2));
    assert_eq!(standard_dims("simple", None, Some("M8"), Some("loose")).diameter, Some(10.0));
    assert_eq!(standard_dims("simple", None, Some("M8"), Some("snug")).diameter, Some(9.0));
    assert_eq!(standard_dims("simple", Some("custom"), Some("M8"), None).diameter, None);
    let ins = standard_dims("insert", None, Some("M8"), None);
    assert_eq!((ins.diameter, ins.lead_in), (None, Some(INSERT_LEAD_IN)));
    let cs = standard_dims("countersink", None, Some("M4"), Some("close"));
    assert_eq!((cs.diameter, cs.cs_diameter, cs.cs_angle), (Some(4.3), Some(9.2), Some(90.0)));
}

#[test]
fn the_coarse_sizes_run_to_m20_and_m12_is_one_of_them() {
    assert_eq!(SIZES, ["M2", "M2.5", "M3", "M4", "M5", "M6", "M8", "M10", "M12", "M16", "M20"]);
    let m12 = standard_dims("counterbore", None, Some("M12"), None);
    assert_eq!((m12.diameter, m12.cb_diameter, m12.cb_depth), (Some(13.5), Some(20.0), Some(12.6)));
    assert_eq!(standard_dims("simple", Some("tap"), Some("M12"), None).diameter, Some(10.2));
    assert_eq!(standard_dims("countersink", None, Some("M12"), None).cs_diameter, Some(27.2));
}
