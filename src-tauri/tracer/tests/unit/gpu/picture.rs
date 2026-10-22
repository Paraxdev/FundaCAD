use fundacad_tracer::picture_refusal;

#[test]
fn a_picture_over_the_binding_limit_is_refused_with_a_size_that_fits() {
    let limit = 128 * 1024 * 1024;
    assert_eq!(picture_refusal(1920, 1080, limit), None);
    let why = picture_refusal(3840, 2160, limit).expect("a 4K picture fits 128 MiB bindings");
    assert!(why.contains("253 MiB") && why.contains("128 MiB"), "{why}");
    let fit: Vec<u32> = why
        .split("take it at ")
        .nth(1)
        .unwrap()
        .split(" or")
        .next()
        .unwrap()
        .split('x')
        .map(|s| s.parse().unwrap())
        .collect();
    assert_eq!(picture_refusal(fit[0], fit[1], limit), None, "{why}");
}
