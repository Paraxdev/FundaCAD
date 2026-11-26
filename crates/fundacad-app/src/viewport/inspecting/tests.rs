use glam::Vec3;

use super::{add_probe, measure, Probe, Shade};

fn edge(x: f32) -> Probe {
    measure::edge_probe(vec![Vec3::new(x, -2.0, 5.0), Vec3::new(x, 5.0, 5.0)]).unwrap()
}

#[test]
fn a_third_pick_starts_measure_over() {
    let mut probes = Vec::new();
    add_probe(&mut probes, edge(3.0));
    assert_eq!(probes, [edge(3.0)]);
    add_probe(&mut probes, edge(7.0));
    assert_eq!(probes, [edge(3.0), edge(7.0)]);
    add_probe(&mut probes, edge(9.5));
    assert_eq!(probes, [edge(9.5)]);
}

#[test]
fn shading_starts_up_z_at_45_degrees() {
    assert_eq!(Shade::default(), Shade { up: 0, threshold: 45.0 });
}
