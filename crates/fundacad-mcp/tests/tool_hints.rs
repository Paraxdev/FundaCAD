//! Every tool says what it does to the world, so a host can ask before a write
//! and run a read without asking. A new tool fails here until it is classified.

use fundacad_mcp::link::EngineLink;
use fundacad_mcp::server::FundaCad;

/// (read only, destructive, idempotent, open world)
const TABLE: &[(&str, (bool, bool, bool, bool))] = &[
    ("schema", (true, false, true, false)),
    ("doc_get", (true, false, true, false)),
    ("inspect", (true, false, true, false)),
    ("measure", (true, false, true, false)),
    ("view", (true, false, true, false)),
    ("build", (true, false, true, false)),
    ("interference", (true, false, true, false)),
    ("section", (true, false, true, false)),
    ("stress", (true, false, true, false)),
    ("printability", (true, false, true, false)),
    ("ui_read", (true, false, true, false)),
    ("ui_shot", (true, false, true, false)),
    ("doc_new", (false, true, true, false)),
    ("doc_open", (false, true, true, false)),
    ("doc_set", (false, true, true, false)),
    ("doc_save", (false, true, true, false)),
    ("export", (false, true, true, false)),
    ("doc_import", (false, false, false, false)),
    ("feature_add", (false, false, false, false)),
    ("param_set", (false, true, true, false)),
    ("param_remove", (false, true, true, false)),
    ("feature_update", (false, true, true, false)),
    ("feature_remove", (false, true, true, false)),
    ("feature_move", (false, true, true, false)),
    ("sketch_merge", (false, true, true, false)),
    ("edit", (false, true, false, false)),
    ("ui_do", (false, true, false, false)),
    ("ui_open", (false, false, true, false)),
    ("ui_close", (false, true, true, false)),
];

#[test]
fn every_tool_carries_the_hints_of_the_table() {
    let tools = FundaCad::with_link(EngineLink::private()).with_ui().tools();
    let mut offered: Vec<String> = tools.iter().map(|t| t.name.to_string()).collect();
    offered.sort();
    let mut classified: Vec<String> = TABLE.iter().map(|(n, _)| (*n).to_string()).collect();
    classified.sort();
    assert_eq!(offered, classified, "a tool is offered that the table does not classify, or the reverse");
    for tool in &tools {
        let want = TABLE.iter().find(|(n, _)| *n == tool.name).expect("checked above").1;
        let a = tool
            .annotations
            .as_ref()
            .unwrap_or_else(|| panic!("{} has no annotations", tool.name));
        let got = (a.read_only_hint, a.destructive_hint, a.idempotent_hint, a.open_world_hint);
        assert_eq!(
            got,
            (Some(want.0), Some(want.1), Some(want.2), Some(want.3)),
            "{}: (readOnly, destructive, idempotent, openWorld)",
            tool.name
        );
    }
}

#[test]
fn the_file_writers_are_never_read_only() {
    let tools = FundaCad::with_link(EngineLink::private()).with_ui().tools();
    for name in ["doc_save", "export", "ui_do"] {
        let tool = tools.iter().find(|t| t.name == name).expect("offered");
        assert_eq!(tool.annotations.as_ref().and_then(|a| a.read_only_hint), Some(false), "{name}");
    }
}
