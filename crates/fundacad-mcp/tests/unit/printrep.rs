use fundacad_mcp::budget::Page;
use fundacad_mcp::printrep::*;
use serde_json::{json, Value};

const HEAD: &str =
    "Printability, +Z up as modelled, bed at z = -1.5; nozzle 0.4, layer 0.2, overhang 45 deg, gap 0.2, bridge 10 mm:";

struct Part {
    id: String,
    name: String,
    area: u32,
    y: f64,
    open: u32,
}

fn overhang(area: u32, y: f64) -> String {
    format!(
        "  overhang F4: {area} mm2 needs support, leaning up to 90 deg, from 0.5 mm above the bed. focus {{at: [0, {y}, -1], size: 6}}"
    )
}

/// The engine's reply for `parts` and a hub, with body3 clean and counted in the quiet line, as it reads
/// for a pin pattern.
fn result(parts: &[Part]) -> Value {
    let mut lines = vec![HEAD.to_string()];
    let mut bodies = vec![];
    let mut findings = vec![];
    let hub = Part { id: "body2".into(), name: "Hub".into(), area: 314, y: 60.0, open: 0 };
    let clean = Part { id: "body3".into(), name: "Spacer".into(), area: 0, y: 0.0, open: 0 };
    let mut all: Vec<&Part> = parts.iter().collect();
    all.insert(1.min(all.len()), &hub);
    all.push(&clean);
    for p in all {
        bodies.push(
            json!({"id": p.id, "name": p.name, "openEdges": p.open, "solids": 1, "insideOut": false, "fault": null}),
        );
        if p.area == 0 {
            continue;
        }
        lines.push(format!("{} \"{}\": 1 overhang", p.id, p.name));
        lines.push(overhang(p.area, p.y));
        findings.push(json!({"kind": "overhang", "body": p.id}));
    }
    lines.push("1 other bodies: nothing found".into());
    json!({"report": lines.join("\n"), "bodies": bodies, "findings": findings})
}

fn pins(n: usize, id_of: impl Fn(usize) -> usize, area_of: impl Fn(usize) -> u32) -> Vec<Part> {
    (1..=n)
        .map(|k| Part {
            id: format!("body{}", if k == 1 { 1 } else { id_of(k) }),
            name: if k == 1 { "Pin".into() } else { format!("Pin {k}") },
            area: area_of(k),
            y: 2.5 * (k as f64 - 1.0),
            open: 0,
        })
        .collect()
}

fn report(r: &Value) -> &str {
    r["report"].as_str().unwrap()
}

fn default_page() -> Page {
    Page { offset: 0, limit: 30 }
}

#[test]
fn a_short_report_reads_as_the_engine_wrote_it() {
    let r = result(&pins(4, |k| k + 2, |_| 4));
    assert_eq!(condensed(&r, default_page(), false, true), report(&r));
    let nothing = json!({"report": "Nothing built to check.", "bodies": [], "findings": []});
    assert_eq!(condensed(&nothing, default_page(), false, true), "Nothing built to check.");
}

#[test]
fn alike_pins_fold_into_one_row_after_the_counts() {
    let r = result(&pins(40, |k| k + 2, |_| 4));
    let out = condensed(&r, default_page(), false, true);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines[0], HEAD);
    assert!(lines[1].starts_with("41 of 42 bodies have findings: 41 overhangs; alike bodies in one row"), "{out}");
    assert!(lines[1].contains("bodies [id] shows one alone"), "{out}");
    assert_eq!(lines[2], "body1 \"Pin\": 1 overhang (and 39 more alike: body4..body42, named \"Pin 2\"..\"Pin 40\")");
    assert_eq!(lines[3], overhang(4, 0.0), "the first pin keeps its focus");
    assert!(lines[4].starts_with("body2 \"Hub\": 1 overhang"), "{out}");
    assert!(!out.contains("focus {at: [0, 5, -1]"), "{out}");
    assert!(out.ends_with("1 other bodies: nothing found"), "{out}");
    assert!(out.len() < 1000, "{} bytes: {out}", out.len());
}

#[test]
fn full_lists_every_body_block_with_its_own_focus() {
    let r = result(&pins(40, |k| k + 2, |_| 4));
    let out = condensed(&r, Page::all(), true, true);
    assert!(out.contains("41 of 42 bodies have findings: 41 overhangs\n"), "{out}");
    assert!(!out.contains("alike") && !out.contains("(and "), "{out}");
    assert!(
        out.contains("body42 \"Pin 40\": 1 overhang\n") && out.contains("focus {at: [0, 97.5, -1], size: 6}"),
        "{out}"
    );
    assert_eq!(out.lines().filter(|l| l.starts_with("body")).count(), 41);
}

#[test]
fn a_page_of_body_rows_asks_for_the_next_and_reaches_the_last() {
    let r = result(&pins(40, |k| k + 2, |_| 4));
    let out = condensed(&r, Page { offset: 0, limit: 5 }, true, true);
    assert_eq!(out.lines().filter(|l| l.starts_with("body")).count(), 5);
    assert!(
        out.contains("\nshowing body rows 1 to 5 of 41: pass offset 5 for the next 5, or limit 0 for all\n"),
        "{out}"
    );
    let last = condensed(&r, Page { offset: 40, limit: 5 }, true, true);
    assert!(
        last.contains("body42 \"Pin 40\": 1 overhang") && last.contains("showing body rows 41 to 41 of 41"),
        "{last}"
    );
    let past = condensed(&r, Page { offset: 99, limit: 5 }, true, true);
    assert!(past.contains("no body rows from offset 99: there are 41"), "{past}");
}

#[test]
fn bodies_that_differ_beyond_their_position_stay_apart() {
    let r = result(&pins(40, |k| k + 2, |k| if k % 2 == 0 { 5 } else { 4 }));
    let out = condensed(&r, default_page(), false, true);
    let heads: Vec<&str> = out.lines().filter(|l| l.starts_with("body")).collect();
    assert_eq!(heads.len(), 3, "{out}");
    assert!(heads[0].contains("(and 19 more alike: body5, body7, body9, "), "{out}");
    assert!(heads[2].starts_with("body4 \"Pin 2\": 1 overhang (and 19 more alike:"), "{out}");
}

#[test]
fn only_the_focus_position_is_set_aside() {
    assert_eq!(unplaced("a. focus {at: [1, 2.5, -3], size: 6}"), "a. focus {size: 6}");
    assert_eq!(
        unplaced("a. focus {at: [1, 2, 3], size: 6}, b. focus {at: [4, 5, 6], size: 7}"),
        "a. focus {size: 6}, b. focus {size: 7}"
    );
    assert_eq!(unplaced("a. focus {at: [1, 2"), "a. focus {at: [1, 2");
}

#[test]
fn a_fold_over_scattered_ids_caps_them_and_says_how_to_list_all() {
    let r = result(&pins(200, |k| 2 * k + 10, |_| 4));
    let out = condensed(&r, default_page(), false, true);
    let head = out.lines().nth(2).unwrap();
    assert!(head.contains("(and 199 more alike: body14, body16, body18"), "{head}");
    assert!(head.contains(" more, full true lists every body"), "{head}");
    assert!(head.len() < 400, "{} chars: {head}", head.len());
}

#[test]
fn open_shells_are_counted_only_when_that_check_ran() {
    let mut parts = pins(20, |k| k + 2, |_| 4);
    parts[3].open = 4;
    parts[7].open = 2;
    let r = result(&parts);
    assert!(condensed(&r, default_page(), false, true).contains("21 overhangs, 2 open shells;"));
    assert!(!condensed(&r, default_page(), false, false).contains("open shell"));
}
