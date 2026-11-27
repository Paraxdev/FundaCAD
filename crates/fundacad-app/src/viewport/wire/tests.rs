use fundacad_client::Body;

use super::*;

#[test]
fn each_polyline_becomes_its_segments() {
    let mut b = Body::default();
    b.edges.points = [[0., 0., 0.], [1., 0., 0.], [5., 5., 5.], [6., 5., 5.], [6., 6., 5.], [9., 9., 9.]]
        .iter()
        .flatten()
        .copied()
        .collect();
    b.edges.counts = vec![2, 3, 1];
    assert_eq!(
        segments(&b),
        vec![[0., 0., 0.], [1., 0., 0.], [5., 5., 5.], [6., 5., 5.], [6., 5., 5.], [6., 6., 5.]]
    );
    assert!(segments(&Body::default()).is_empty());
}
