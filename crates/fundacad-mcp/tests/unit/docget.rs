use fundacad_mcp::docget::*;
use serde_json::{json, Map, Value};

fn obj(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap()
}

fn grid_ids(n: usize) -> Map<String, Value> {
    let mut ids = obj(json!({"bx1:0": "body1", "cy1:0": "body2", "bx2:0": "body3"}));
    for i in 0..n {
        ids.insert(format!("sep1:{i}"), json!(format!("body{}", i + 4)));
    }
    ids
}

#[test]
fn runs_of_body_ids_read_as_one_range_and_come_back_whole() {
    let ids = grid_ids(2999);
    let folded = fold_body_ids(&ids);
    assert_eq!(
        Value::Object(folded.clone()),
        json!({"bx1:0": "body1", "cy1:0": "body2", "bx2:0": "body3", "sep1:0..sep1:2998": "body4..body3002"})
    );
    let back = unfold_body_ids(&folded).unwrap();
    assert_eq!(back, ids);
    assert_eq!(back.keys().collect::<Vec<_>>(), ids.keys().collect::<Vec<_>>(), "the order is kept");
}

#[test]
fn a_short_map_and_a_broken_run_are_kept_as_they_are() {
    let short = grid_ids(5);
    assert_eq!(fold_body_ids(&short), short);

    let mut ids = grid_ids(20);
    ids.insert("sep1:5".into(), json!("body99"));
    let folded = fold_body_ids(&ids);
    assert_eq!(folded.get("sep1:0..sep1:4"), Some(&json!("body4..body8")));
    assert_eq!(folded.get("sep1:5"), Some(&json!("body99")));
    assert_eq!(folded.get("sep1:6..sep1:19"), Some(&json!("body10..body23")));
    assert_eq!(unfold_body_ids(&folded).unwrap(), ids);
}

#[test]
fn a_range_that_does_not_count_up_alike_is_refused() {
    let why = unfold_body_ids(&obj(json!({"sep1:0..sep1:9": "body4..body9"}))).unwrap_err();
    assert!(why.contains("does not count up alike"), "{why}");
    let why = unfold_body_ids(&obj(json!({"sep1:0..cy1:9": "body4..body13"}))).unwrap_err();
    assert!(why.contains("does not count up alike"), "{why}");
}

#[test]
fn a_range_of_more_than_a_million_bodies_is_refused() {
    let why = unfold_body_ids(&obj(json!({"sep1:0..sep1:5000000": "body1..body5000001"}))).unwrap_err();
    assert!(why.contains(&format!("more than {MOST_IN_RANGE}")), "{why}");
}

#[test]
fn a_key_with_dots_and_a_plain_body_is_not_a_range() {
    let ids = obj(json!({"a..b:0": "body1"}));
    assert_eq!(unfold_body_ids(&ids).unwrap(), ids);
}

fn import(nodes: usize) -> Value {
    let list: Vec<Value> = (0..nodes).map(|i| json!({"name": format!("n{i}"), "parent": 0})).collect();
    json!([{"type": "import", "id": "f1", "nodes": list.clone(), "parts": list}, {"type": "box", "id": "bx1"}])
}

#[test]
fn an_import_s_long_lists_are_left_out_and_taken_back_from_the_open_document() {
    let features = import(3007);
    let shown = leave_out_lists(&features);
    assert_eq!(shown[0]["nodes"], json!("3007 nodes left out, doc_get full true lists them"));
    assert_eq!(shown[0]["parts"], json!("3007 parts left out, doc_get full true lists them"));
    assert_eq!(shown[1], features[1]);

    let open = obj(json!({"features": features}));
    let mut next = obj(json!({"features": shown}));
    take_back_lists(&open, &mut next).unwrap();
    assert_eq!(next["features"], open["features"]);
}

#[test]
fn a_short_import_list_is_shown() {
    let features = import(30);
    assert_eq!(leave_out_lists(&features), features);
}

#[test]
fn a_left_out_list_with_no_feature_to_take_it_from_is_refused() {
    let mut next = obj(json!({"features": leave_out_lists(&import(40))}));
    let why = take_back_lists(&obj(json!({"features": []})), &mut next).unwrap_err();
    assert!(why.contains("doc_get with full true"), "{why}");
}

#[test]
fn lines_put_one_feature_to_a_line_and_read_back_as_the_same_json() {
    let doc = obj(json!({
        "features": [{"type": "box", "length": 2, "id": "bx1"}, {"type": "move", "dx": 1.5, "bodies": ["body1"], "id": "mv1"}],
        "parameters": {},
        "bodyIds": {"bx1:0": "body1"},
        "version": 10
    }));
    let out = lines(&doc);
    assert_eq!(
        out,
        "{\n \"features\": [\n  {\"type\": \"box\", \"length\": 2, \"id\": \"bx1\"},\n  {\"type\": \"move\", \"dx\": 1.5, \
         \"bodies\": [\"body1\"], \"id\": \"mv1\"}\n ],\n \"parameters\": {},\n \"bodyIds\": {\n  \"bx1:0\": \"body1\"\n },\n \
         \"version\": 10\n}"
    );
    let back: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(back, Value::Object(doc));
}
