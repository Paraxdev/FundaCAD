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

#[test]
fn a_pass_is_settled_only_below_a_reach_a_measured_pass_stayed_under() {
    // The holed plate at 3 mm moved the peak 2.8% at 0.0976, the closest pass left skipped.
    assert!(settled(0.0976));
    assert!(settled(0.0999));
    assert!(!settled(0.10));
    assert!(!settled(0.1001));
    // The 6.5 mm fin of the test block, and the deep round groove, whose pass moved the peak 10% at 0.189.
    assert!(!settled(0.1176));
    assert!(!settled(0.1892));
    assert!(settled(0.0));
}

#[test]
fn the_solve_time_grows_as_the_work_and_turns_back_into_elements() {
    let at = solve_seconds(40_000);
    assert!(at > 0.0);
    assert!((solve_seconds(80_000) / at - 2f64.powf(1.3)).abs() < 1e-9);
    assert!(elements_within(at).abs_diff(40_000) <= 1);
    assert_eq!(elements_within(f64::INFINITY), usize::MAX);
    assert_eq!(elements_within(0.0), 0);
}

#[test]
fn the_release_clock_matches_the_measured_runs_and_prices_a_compact_part_higher() {
    for (elements, seconds) in [(67_688, 5.5), (99_316, 8.7), (179_240, 21.4)] {
        let said = release_seconds(elements);
        assert!((said / seconds - 1.0).abs() < 0.25, "{elements}: {said} against {seconds}");
    }
    assert!(release_seconds(80_000) < solve_seconds(80_000) / 3.0);
    assert!(release_compact_seconds(50_000) >= 3.0 * release_seconds(50_000));
    assert!(release_elements_within(release_seconds(120_000)).abs_diff(120_000) <= 1);
    assert_eq!(release_elements_within(f64::INFINITY), usize::MAX);
}

#[test]
fn the_release_clock_quotes_the_times_the_button_and_the_retry_ceiling_say() {
    let said = |n| release_seconds(n).ceil() as u64;
    assert_eq!([said(47_715), said(100_000), said(176_497), said(220_000)], [4, 9, 19, 26]);
    assert_eq!(release_compact_seconds(100_000).ceil() as u64, 36);
    assert_eq!(release_elements_within(15.0), 148_133);
}

#[test]
fn the_memory_a_thin_walled_part_holds_covers_the_measured_runs() {
    assert_eq!(elements_in_memory(0), 0);
    for (elements, gb) in
        [(58_210, 1.5), (98_261, 2.7), (147_619, 4.5), (199_205, 6.4), (298_265, 12.6), (338_650, 14.5)]
    {
        let said = elements_in_memory((gb * 1e9) as u64) as f64;
        assert!((said / elements as f64 - 1.0).abs() < 0.15, "{elements}: {said} in {gb} GB");
    }
    assert!((215_000..225_000).contains(&elements_in_memory(fundacad_geom::fem::solve::FINER_MEMORY_CAP)));
}
