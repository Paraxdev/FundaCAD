use glam::Vec3;

use super::{add_probe, measure, Asked, Card, Inspecting, Probe, Section, Shade};

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

#[test]
fn an_opened_document_starts_a_fresh_view_with_its_saved_cut() {
    let mut doc = serde_json::Map::new();
    doc.insert("sectionView".into(), serde_json::json!({ "origin": [3.0, -2.0, 5.0], "normal": [0.0, 1.0, 0.0], "side": -1 }));
    let i = Inspecting::opened(Some(&doc));
    assert_eq!(i.section, Some(Section { normal: Vec3::Y, offset: -2.0, anchor: -2.0, flip: false }));
    assert_eq!((i.card, i.probes.len(), i.isolate.is_none()), (None, 0, true));
    assert_eq!(Inspecting::opened(Some(&serde_json::Map::new())).section, None);
    assert_eq!(Inspecting::opened(None).section, None);
}

#[test]
fn a_rebuild_drops_the_picks_and_replies_but_keeps_the_card_and_cut() {
    let cut = Section::along(2, Vec3::new(3.0, -2.0, 5.0));
    let mut i = Inspecting { card: Some(Card::Interference), section: Some(cut), isolate: Some(vec!["b2".into()]), ..Inspecting::default() };
    i.probes = vec![edge(3.0), edge(7.0)];
    i.asked = Some((Card::Interference, Asked::Busy));
    i.ticket = 4;
    i.rebuilt();
    assert_eq!((i.card, i.section, i.isolate.as_deref(), i.probes.len(), i.asked, i.ticket), (Some(Card::Interference), Some(cut), Some(&["b2".to_string()][..]), 0, None, 5));
    let mut fresh = Inspecting::default();
    fresh.rebuilt();
    assert_eq!((fresh.probes.len(), fresh.asked, fresh.ticket), (0, None, 1));
}
