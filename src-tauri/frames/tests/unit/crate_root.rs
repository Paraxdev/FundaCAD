use fundacad_frames::{frame_size, MAX_SIDE};

#[test]
fn a_frame_size_over_the_limit_is_refused() {
    assert_eq!(frame_size(0, 0), Ok((1, 1)));
    assert_eq!(frame_size(MAX_SIDE, 1080), Ok((MAX_SIDE, 1080)));
    assert!(frame_size(MAX_SIDE + 1, 1).is_err());
    assert!(frame_size(1, u32::MAX).is_err());
}
