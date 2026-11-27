use super::*;

#[test]
fn a_selection_changed_mid_fade_starts_from_what_shows() {
    let mut b = Blend::default();
    b.retarget(&[(0, Some(vec![1]))], 1.0, true);
    b.retarget(&[(0, Some(vec![2]))], 1.0, false);
    assert_eq!(b.pair(0, 1), [1.0, 0.0]);
    assert_eq!(b.pair(0, 2), [0.0, 1.0]);
    b.retarget(&[(1, None)], 0.25, false);
    assert_eq!(b.pair(0, 1), [0.75, 0.0]);
    assert_eq!(b.pair(0, 2), [0.25, 0.0]);
    assert_eq!(b.pair(1, 7), [0.0, 1.0]);
}

#[test]
fn a_whole_body_blends_with_its_faces() {
    let from = Levels::of(&[(0, None)]);
    let to = Levels::of(&[(0, Some(vec![3]))]);
    let mid = from.blend(&to, 0.5);
    assert_eq!(mid.at(0, 3), 1.0);
    assert_eq!(mid.at(0, 4), 0.5);
    assert_eq!(mid.at(1, 4), 0.0);
}

#[test]
fn a_snap_lands_at_once() {
    let mut b = Blend::default();
    b.retarget(&[(0, None)], 1.0, true);
    assert_eq!(b.pair(0, 0), [1.0, 1.0]);
}

#[test]
fn settled_faces_do_not_pile_up() {
    let mut b = Blend::default();
    for f in 0..50 {
        b.retarget(&[(0, Some(vec![f]))], 1.0, false);
    }
    assert!(b.from.bodies[&0].1.len() <= 2);
}
