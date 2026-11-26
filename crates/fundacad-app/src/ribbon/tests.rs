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
