//! A pattern of 2000 pins, the shape of a big model: every reply stays a summary on a byte budget, and every
//! row a long reply folds or pages away is one argument off. Spawns the engine.

mod common;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use common::Mcp;
use serde_json::{json, Value};

/// Each grid engine holds a few thousand bodies, so the two tests take turns.
static ONE_GRID: Mutex<()> = Mutex::new(());

const BODIES: usize = 2002;
const LAST: &str = "body2002";

fn add(feature: Value) -> Value {
    json!({"op": "add", "feature": feature})
}

/// 2000 pins (body1 and body4..body2002, "Pin".."Pin 2000"), a hub above them and a bar through 27 of them.
fn grid() -> Mcp {
    let mut mcp = Mcp::start(&BTreeMap::new(), &std::env::temp_dir());
    let ops = json!([
        add(json!({"type": "box", "length": 2, "width": 2, "height": 2, "name": "Pin"})),
        add(json!({"type": "cylinder", "radius": 10, "height": 5, "name": "Hub"})),
        add(json!({"type": "box", "length": 20, "width": 6, "height": 3, "name": "Bar"})),
        add(json!({"type": "move", "dx": 60, "dy": 60, "dz": 20, "bodies": ["body2"]})),
        add(json!({"type": "move", "dx": 10, "dy": 10, "bodies": ["body3"]})),
        add(json!({"type": "patternRect", "countX": 40, "countY": 50, "spacingX": 2.5, "spacingY": 2.5,
                   "bodies": ["body1"]})),
        add(json!({"type": "separate", "bodies": ["body1"]})),
    ]);
    reply(&mut mcp, "edit", json!({ "ops": ops }));
    mcp
}

fn reply(mcp: &mut Mcp, tool: &str, args: Value) -> String {
    let r = mcp.call(tool, args.clone());
    assert!(!r.is_error && r.error.is_none(), "{tool} {args}: {} {:?}", r.text, r.error);
    r.text
}

fn head(text: &str) -> &str {
    &text[..text.char_indices().nth(600).map_or(text.len(), |(i, _)| i)]
}

fn face(dir: [f64; 3]) -> Value {
    json!({"kind": "face", "by": "normal", "dir": dir, "body": "body1"})
}

fn path(dir: &Path, file: &str) -> String {
    dir.join(file).to_string_lossy().into_owned()
}

#[test]
fn every_reply_on_a_pattern_of_2000_pins_stays_within_its_byte_budget() {
    let _turn = ONE_GRID.lock().unwrap_or_else(|e| e.into_inner());
    let mut mcp = grid();
    let tmp = tempfile::tempdir().expect("a temp dir");
    let stress = json!({"body": "body1", "fixed": face([0.0, 0.0, -1.0]), "material": "PLA",
                        "loads": [{"faces": [face([0.0, 0.0, 1.0])], "force": [0, 0, -10]}]});
    let probe = json!([{"op": "param", "name": "probe", "expr": "3"}, {"op": "param_remove", "name": "probe"}]);
    let calls = [
        ("build", json!({}), 600),
        ("build", json!({"full": true}), 600),
        ("inspect", json!({}), 1000),
        ("inspect", json!({"detail": true}), 8000),
        ("inspect", json!({"detail": true, "selectors": true}), 20000),
        ("inspect", json!({"body": "body1", "detail": true, "selectors": true}), 5000),
        ("measure", json!({"a": "body1"}), 600),
        ("view", json!({}), 100),
        ("interference", json!({}), 3000),
        ("printability", json!({}), 1200),
        ("section", json!({"axis": "Z", "at": 0.5}), 1500),
        ("section", json!({"axis": "Z", "at": 0.5, "outline": true}), 3000),
        ("stress", stress, 1500),
        ("export", json!({"path": path(tmp.path(), "part.stl"), "format": "stl", "separate": true}), 400),
        ("doc_get", json!({}), 1500),
        ("doc_get", json!({"features_only": true}), 1200),
        ("edit", json!({"ops": probe, "build": true}), 800),
        ("feature_add", json!({"feature": {"type": "box", "length": 1, "width": 1, "height": 1}}), 200),
        ("doc_save", json!({"path": path(tmp.path(), "grid.funda")}), 400),
    ];
    let mut over = Vec::new();
    for (tool, args, budget) in calls {
        let text = reply(&mut mcp, tool, args.clone());
        eprintln!("{tool} {args}: {} bytes of {budget}", text.len());
        if text.len() > budget {
            over.push(format!("{tool} {args}: {} bytes, budget {budget}:\n{}", text.len(), head(&text)));
        }
    }
    assert!(over.is_empty(), "over budget:\n{}", over.join("\n\n"));
}

#[test]
fn every_row_a_long_reply_folds_or_pages_away_is_one_argument_off() {
    let _turn = ONE_GRID.lock().unwrap_or_else(|e| e.into_inner());
    let mut mcp = grid();

    let built = reply(&mut mcp, "build", json!({}));
    assert!(built.starts_with(&format!("{BODIES} bodies, alike ones in one row:\n")), "{}", head(&built));
    assert!(built.contains("(and 1999 more alike: body4..body2002, named \"Pin 2\"..\"Pin 2000\")"), "{built}");

    let rows = reply(&mut mcp, "inspect", json!({"limit": 1}));
    assert!(rows.ends_with("showing rows 1 to 1 of 3: pass offset 1 for the next 1, or limit 0 for all"), "{rows}");
    let rows = reply(&mut mcp, "inspect", json!({"limit": 1, "offset": 2}));
    assert!(rows.contains("\nbody3 \"Bar\" | 20 x 6 x 3 mm") && rows.ends_with("showing rows 3 to 3 of 3"), "{rows}");
    let alone = reply(&mut mcp, "inspect", json!({"bodies": [LAST]}));
    assert!(alone.starts_with("body2002 \"Pin 2000\" | 2 x 2 x 2 mm") && !alone.contains("alike"), "{alone}");

    let page = reply(&mut mcp, "inspect", json!({"detail": true}));
    let more =
        format!("\nshowing bodies 1 to 5 of {BODIES}: pass offset 5 for the next 5, or limit 0 for all, or name one");
    assert!(page.contains(&more), "{}", head(&page));
    let page = reply(&mut mcp, "inspect", json!({"detail": true, "offset": BODIES - 1}));
    assert!(page.starts_with("body2002 \"Pin 2000\" | 2 x 2 x 2 mm"), "{}", head(&page));
    assert!(page.ends_with(&format!("showing bodies {BODIES} to {BODIES} of {BODIES}")), "{page}");
    let every = reply(&mut mcp, "inspect", json!({"detail": true, "limit": 0}));
    assert_eq!(every.lines().filter(|l| l.starts_with("body")).count(), BODIES, "limit 0 lists every body");
    assert!(!every.contains("showing bodies"));

    let one = reply(&mut mcp, "inspect", json!({"body": LAST, "detail": true, "selectors": true}));
    for f in 0..6 {
        assert!(one.contains(&format!("\n  F{f} plane | area 4 | at (")), "{one}");
    }
    assert_eq!(one.matches("\"body\":\"body2002\"").count(), 18, "6 face and 12 edge selectors: {one}");
    let top = one.lines().find(|l| l.starts_with("  F5 ")).expect("a top face");
    let xy = top.split("at (").nth(1).and_then(|s| s.split(", 1)").next()).expect("its centre");

    let cut = reply(&mut mcp, "section", json!({"axis": "Z", "at": 0.5}));
    assert!(cut.contains("Outline points left out of a long list: pass outline true"), "{cut}");
    let cut = reply(&mut mcp, "section", json!({"axis": "Z", "at": 0.5, "outline": true}));
    assert!(cut.contains("  loop 1 (outline, 4 points): [") && !cut.contains("left out"), "{cut}");
    let cut = reply(&mut mcp, "section", json!({"axis": "Z", "at": 0.5, "bodies": [LAST]}));
    assert!(cut.contains("body2002 \"Pin 2000\": area 4 mm2 in 1 piece"), "{cut}");
    assert!(cut.contains(&format!("centroid ({xy}) in the plane")), "its own centroid, {xy}: {cut}");

    let alone = reply(&mut mcp, "printability", json!({"bodies": [LAST]}));
    assert!(alone.ends_with("\nbody2002 \"Pin 2000\": nothing found"), "on a bed of its own it prints: {alone}");
    let print = reply(&mut mcp, "printability", json!({"full": true}));
    let blocks = print.lines().filter(|l| l.starts_with("body") && l.ends_with(": 1 overhang")).count();
    assert_eq!(blocks, BODIES - 1, "full lists every pin and the hub: {}", head(&print));
    assert!(!print.contains("more alike"));
    let own = format!(
        "\nbody2002 \"Pin 2000\": 1 overhang\n  overhang F4: 4 mm2 needs support, leaning up to 90 deg, \
         from 0.5 mm above the bed. focus {{at: [{xy}, -1]"
    );
    assert!(print.contains(&own), "the last pin with its own focus, {xy}");
    let one = reply(&mut mcp, "printability", json!({"full": true, "offset": BODIES - 2, "limit": 1}));
    assert!(one.contains(&format!("\nshowing body rows {0} to {0} of {0}", BODIES - 1)), "{one}");

    let clash = reply(&mut mcp, "interference", json!({"full": true}));
    assert!(clash.starts_with("27 overlapping pairs"), "{}", head(&clash));
    assert_eq!(clash.matches(" mm3 overlap, from ").count(), 27, "full lists every pair: {clash}");
    assert!(!clash.contains("more alike"));

    let tmp = tempfile::tempdir().expect("a temp dir");
    let part = path(tmp.path(), "part.stl");
    let wrote = reply(&mut mcp, "export", json!({"path": part, "format": "stl", "separate": true, "full": true}));
    assert!(wrote.starts_with(&format!("Wrote {BODIES} files to ")), "{}", head(&wrote));
    assert_eq!(wrote.lines().filter(|l| l.ends_with(" bytes)")).count(), BODIES, "{}", head(&wrote));
    assert!(wrote.contains("Pin_2000.stl (") && !wrote.contains("more alike"), "{}", head(&wrote));

    let folded = reply(&mut mcp, "doc_get", json!({}));
    let doc: Value = serde_json::from_str(&folded).expect("doc_get is JSON");
    assert_eq!(doc["bodyIds"]["sep1:0..sep1:1998"], json!("body4..body2002"), "{folded}");
    let whole: Value = serde_json::from_str(&reply(&mut mcp, "doc_get", json!({"full": true}))).expect("JSON");
    assert_eq!(whole["bodyIds"]["sep1:1998"], json!(LAST));
    assert_eq!(whole["bodyIds"].as_object().map(|m| m.len()), Some(BODIES));
    reply(&mut mcp, "doc_set", json!({ "document": doc }));
    let back: Value = serde_json::from_str(&reply(&mut mcp, "doc_get", json!({"full": true}))).expect("JSON");
    assert_eq!(back["bodyIds"], whole["bodyIds"], "doc_set spells a folded run out again");
}
