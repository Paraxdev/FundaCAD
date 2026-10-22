use fundacad_tracer::bloom::input_size;

#[test]
fn the_input_is_half_the_frame_or_the_page_side_capped() {
    assert_eq!(input_size(320, 240, 0), (160, 120));
    assert_eq!(input_size(1920, 1080, 960), (960, 540));
    assert_eq!(input_size(4000, 2000, 0), (1920, 960));
    // A trace at a third of the canvas still blooms at the canvas's side.
    assert_eq!(input_size(640, 360, 960), (960, 540));
    assert_eq!(input_size(1, 1, 0), (1, 1));
}
