use fundacad_geom::fem::adapt::*;

#[test]
fn each_mode_has_its_plan() {
    assert_eq!(Refine::Off.plan(), Plan { passes: 0, cap_share: 0.0, work_factor: 0.0, min_edge_share: 0.0 });
    assert_eq!(Refine::Standard.plan(), Plan { passes: 1, cap_share: 1.0, work_factor: 2.2, min_edge_share: 0.25 });
    assert_eq!(Refine::Fine.plan(), Plan { passes: 3, cap_share: 1.0, work_factor: 6.0, min_edge_share: 0.125 });
}

#[test]
fn the_next_cap_stops_on_the_passes_the_budget_and_too_little_growth() {
    let standard = Refine::Standard.plan();
    // The Wall bracket: Off's 23774 elements grow by 15% in the one pass the work allows.
    assert_eq!(next_cap(&standard, 30_000, &[23_774], 23_774), Some(27_353));
    assert_eq!(next_cap(&standard, 30_000, &[23_774, 27_353], 23_774), None);
    assert_eq!(next_cap(&standard, 30_000, &[9554], 21_000), Some(30_000));
    assert_eq!(next_cap(&standard, 30_000, &[], 21_000), None);
    assert_eq!(next_cap(&Refine::Off.plan(), 30_000, &[9554], 21_000), None);
    let fine = Refine::Fine.plan();
    assert_eq!(next_cap(&fine, 60_000, &[9554, 20_000, 35_000], 42_000), Some(60_000));
    assert_eq!(next_cap(&fine, 60_000, &[9554, 20_000, 35_000, 60_000], 42_000), None);

    let even = Plan { passes: 2, cap_share: 1.0, work_factor: 1.0, min_edge_share: 0.25 };
    for (done, reference) in [(7_310, 13_377), (6_002, 17_453)] {
        let cap = next_cap(&even, 1_000_000, &[done], reference).unwrap();
        let left = work(reference) - work(done);
        assert!(work(cap) <= left && work(cap + 1) > left, "cap {cap} for {done} of {reference}");
    }
    assert_eq!(next_cap(&even, 1_000_000, &[13_377], 13_377), None);
    assert_eq!(next_cap(&even, 1_000_000, &[9_000, 9_000], 13_377), None);

    assert_eq!(next_cap(&standard, 30_000, &[27_272], 100_000), Some(30_000));
    assert_eq!(next_cap(&standard, 30_000, &[27_273], 100_000), None);
}

#[test]
fn marking_takes_the_first_then_the_largest_errors_until_theta() {
    let eta = [3.0, 4.0, 4.0, 0.5, 12.0, 1.0];
    let eligible = [true, true, true, true, false, true];
    assert_eq!(mark(&eta, &eligible, &[], 0.5), vec![1, 2]);
    assert_eq!(mark(&eta, &eligible, &[5, 4, 5], 0.5), vec![5, 1, 2]);
    assert_eq!(mark(&eta, &eligible, &[], 1.0), vec![1, 2, 0, 5, 3]);
    assert_eq!(mark(&eta, &[false; 6], &[1], 0.5), Vec::<u32>::new());
    assert_eq!(mark(&[0.0; 3], &[true; 3], &[1], 0.5), Vec::<u32>::new());
    assert_eq!(mark(&[], &[], &[], 0.5), Vec::<u32>::new());

    let even = [2.0, 2.0, 2.0, 2.0];
    assert_eq!(mark(&even, &[true; 4], &[], 0.5), vec![0, 1]);
    assert_eq!(mark(&even, &[true; 4], &[], 0.500001), vec![0, 1, 2]);
}

#[test]
fn the_peak_is_unsettled_past_a_tenth() {
    assert_eq!(unsettled(&[]), None);
    assert_eq!(unsettled(&[12.6]), None);
    assert_eq!(unsettled(&[9.01, 10.0]), None);
    assert_eq!(unsettled(&[9.0, 10.0]), None);
    let moved = unsettled(&[13.0, 8.99, 10.0]).unwrap();
    assert!((moved - 0.101).abs() < 1e-12, "{moved}");
    let fell = unsettled(&[14.4, 12.0]).unwrap();
    assert!((fell - 0.2).abs() < 1e-12, "{fell}");
}

#[test]
fn a_pass_predicted_past_the_limit_is_over_time() {
    let next = 2.0 * 2f64.powf(1.3);
    assert!(over_time(10.0, 2.0, 10_000, 20_000, 10.0 + next - 1e-9));
    assert!(!over_time(10.0, 2.0, 10_000, 20_000, 10.0 + next + 1e-9));
    assert!(!over_time(0.4, 0.6, 9_554, 24_000, 60.0));
}

#[test]
fn the_reach_is_the_most_a_split_tets_gap_passes_the_peak() {
    let peak = 15.08;
    let top = [15.08, 12.6, 9.3, 14.1];
    let gap = [2.61, 3.9, 7.4, 0.35];
    // The split tet at the peak reaches its whole gap, one below it only what passes the peak.
    assert_eq!(reach(peak, &top, &gap, &[true, false, false, false]), 2.61 / peak);
    assert_eq!(reach(peak, &top, &gap, &[false, true, false, false]), (3.9 - (peak - 12.6)) / peak);
    assert_eq!(reach(peak, &top, &gap, &[false, false, true, true]), (7.4 - (peak - 9.3)) / peak);
    assert_eq!(reach(peak, &top, &gap, &[true, true, true, true]), 2.61 / peak);
    // A gap that ends exactly at the peak or short of it reaches nothing.
    assert_eq!(reach(15.0, &[12.5], &[2.5], &[true]), 0.0);
    assert_eq!(reach(15.0, &[12.5], &[2.75], &[true]), 0.25 / 15.0);
    assert_eq!(reach(peak, &top, &gap, &[false, false, false, true]), 0.0);
    assert_eq!(reach(peak, &top, &gap, &[false; 4]), 0.0);
    assert_eq!(reach(peak, &top, &gap, &[true]), 2.61 / peak);
    assert_eq!(reach(peak, &[], &[], &[]), 0.0);
    assert_eq!(reach(0.0, &[0.0], &[3.0], &[true]), 0.0);
}
