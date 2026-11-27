use gpui::AssetSource as _;

use super::*;
use crate::assets::Assets;

#[test]
fn the_groups_are_ribbon_defs_model() {
    let labels: Vec<&str> = MODEL.iter().map(|g| g.label).collect();
    assert_eq!(labels, ["Create", "Modify", "Construct", "Inspect", "Insert"]);
    assert!(group("Print").is_none());
    let construct: Vec<&str> = leaves(group("Construct").unwrap()).iter().map(|t| t.action).collect();
    assert_eq!(construct.first(), Some(&"offset-plane"));
    assert_eq!(construct.len(), 12);
}

#[test]
fn every_tool_this_lane_built_is_on_the_rail() {
    let all: Vec<&str> = MODEL.iter().flat_map(leaves).map(|t| t.action).collect();
    let missing: Vec<&str> = crate::tools::TOOLS.iter().map(|t| t.id).filter(|id| *id != "primitive" && !all.contains(id)).collect();
    assert!(missing.is_empty(), "not on the rail: {missing:?}");
}

#[test]
fn every_glyph_is_in_the_icon_pack() {
    let missing: Vec<&str> = MODEL
        .iter()
        .flat_map(leaves)
        .map(|t| t.glyph)
        .filter(|g| Assets.load(&crate::ui::icon_path(g)).ok().flatten().is_none())
        .collect();
    assert!(missing.is_empty(), "missing icons: {missing:?}");
}

#[test]
fn every_label_is_a_catalog_line_and_a_tool_reads_as_its_table_entry() {
    let english = |key: &str| crate::i18n::english(key, &[]);
    let mut keys: Vec<&str> = MODEL.iter().map(|g| g.heading).collect();
    for g in MODEL {
        for i in g.items {
            if let Item::Split { label, .. } = i {
                keys.push(label);
            }
        }
        keys.extend(leaves(g).iter().map(|t| t.label));
    }
    let missing: Vec<&&str> = keys.iter().filter(|k| english(k) == **k).collect();
    assert!(missing.is_empty(), "no English line: {missing:?}");
    for item in MODEL.iter().flat_map(leaves) {
        if let Some(tool) = crate::tools::TOOLS.iter().find(|t| t.id == item.action) {
            assert_eq!(item.label, tool.label, "{}", item.action);
        }
    }
    let construct = leaves(group("Construct").unwrap());
    let named = |action: &str| english(construct.iter().find(|t| t.action == action).unwrap().label);
    assert_eq!(named("plane-points"), "Plane, 3 Pts");
    assert_eq!(named("plane-two-edges"), "Plane, 2 Edges");
    assert_eq!(named("axis-planes"), "Axis, 2 Planes");
}
