use super::*;

#[test]
fn the_head_of_a_request_is_read_from_its_prefix() {
    let h = |id: Option<&str>, op: Option<&str>, target: Option<&str>, soft: bool| Head {
        id: id.map(Into::into),
        op: op.map(Into::into),
        target: target.map(Into::into),
        soft,
        ..Head::default()
    };
    let big = format!(r#"{{"id":"a","op":"rebuild","document":{{"x":"{}"}}}}"#, "y".repeat(10_000));
    assert_eq!(head(&big), h(Some("a"), Some("rebuild"), None, false));
    assert_eq!(head(r#"{"id":"c","op":"cancel","target":"a"}"#), h(Some("c"), Some("cancel"), Some("a"), false));
    assert_eq!(
        head(r#"{"id":"c","op":"cancel","target":"a","soft":true}"#),
        h(Some("c"), Some("cancel"), Some("a"), true)
    );
    assert_eq!(head(r#"{"op":"ping"}"#), h(None, Some("ping"), None, false));
    assert_eq!(head("not json"), Head::default());
}

#[test]
fn the_head_names_the_document_a_request_belongs_to() {
    let big = format!(r#"{{"id":"a","op":"rebuild","doc":"D1","document":{{"x":"{}"}}}}"#, "y".repeat(10_000));
    let doc = |id: &str, op: &str, doc: Option<&str>, all: bool| Head {
        id: Some(id.into()),
        op: Some(op.into()),
        doc: doc.map(Into::into),
        all,
        ..Head::default()
    };
    assert_eq!(head(&big), doc("a", "rebuild", Some("D1"), false));
    let no_doc = format!(r#"{{"id":"a","op":"rebuild","document":{{"x":"{}"}},"tolerance":0.1}}"#, "y".repeat(600));
    assert_eq!(head(&no_doc), doc("a", "rebuild", None, false));
    assert_eq!(head(r#"{"id":"e","op":"doc_end","doc":"D1"}"#), doc("e", "doc_end", Some("D1"), false));
    assert_eq!(head(r#"{"id":"e","op":"doc_end","all":true}"#), doc("e", "doc_end", None, true));
}

#[test]
fn a_document_end_reaches_only_that_documents_requests_and_a_reattach_ends_them_all() {
    let in_flight: HashMap<String, Option<String>> = [
        ("a1".to_owned(), Some("A".to_owned())),
        ("a2".to_owned(), Some("A".to_owned())),
        ("b1".to_owned(), Some("B".to_owned())),
        ("fonts".to_owned(), None),
    ]
    .into();
    assert_eq!(ended_by(&in_flight, Some("A")), ["a1", "a2"]);
    assert_eq!(ended_by(&in_flight, Some("C")), Vec::<String>::new());
    assert_eq!(ended_by(&in_flight, None), ["a1", "a2", "b1", "fonts"]);
    let end: Value = serde_json::from_str(&end_all_request(4)).unwrap();
    assert_eq!(end, serde_json::json!({"id": "relay-attach-4", "op": "doc_end", "all": true}));
}

#[test]
fn only_a_cancel_that_reached_a_running_job_is_a_hit() {
    let ack = |s: &str| Message::Text(s.into());
    assert!(cancel_hit(&ack(r#"{"id": "c", "ok": true, "result": {"cancelled": true}}"#)));
    assert!(!cancel_hit(&ack(r#"{"id": "c", "ok": true, "result": {"cancelled": false}}"#)));
    assert!(!cancel_hit(&ack(r#"{"id": "c", "ok": false, "error": {"message": "x"}}"#)));
    assert!(!cancel_hit(&Message::Binary(vec![0, 0, 0, 0])));
}

#[test]
fn only_the_last_frame_of_a_stream_is_final() {
    let frame = |h: &str| {
        let mut v = (h.len() as u32).to_le_bytes().to_vec();
        v.extend_from_slice(h.as_bytes());
        v
    };
    assert!(binary_is_final(&frame(r#"{"id":"a","ok":true}"#)));
    assert!(!binary_is_final(&frame(r#"{"id":"a","stream":{"seq":0,"final":false}}"#)));
    assert!(binary_is_final(&frame(r#"{"id":"a","stream":{"seq":2,"final":true}}"#)));
}

#[test]
fn every_status_frame_keeps_its_request_in_flight_and_only_a_reply_ends_it() {
    let id = Value::String("r-7".into());
    let behind = serde_json::json!({"op": "import", "doc": "A"});
    let statuses = [
        envelope::queued(&id, &behind),
        envelope::started(&id),
        r#"{"id": "r-7", "status": "building", "feature": "f3", "meshed": 2, "meshTotal": 5}"#.to_owned(),
        r#"{"id": "r-7", "status": "importing", "phase": 1, "label": "part.step", "pct": 40}"#.to_owned(),
    ];
    let statuses: Vec<bool> = statuses.iter().map(|t| text_is_terminal(t)).collect();
    assert_eq!(statuses, [false, false, false, false]);
    let named = r#"{"id": "r-7", "ok": true, "result": {"label": "\"status\": \"building\""}}"#;
    let big = format!(r#"{{"id": "r-7", "ok": true, "result": {{"x": "{}"}}}}"#, "y".repeat(70_000));
    let replies = [envelope::ok(&id, &serde_json::json!({"bodies": 3})), envelope::cancelled(&id), named.into(), big];
    let replies: Vec<bool> = replies.iter().map(|t| text_is_terminal(t)).collect();
    assert_eq!(replies, [true, true, true, true]);
    let padded = |len: usize| {
        let shell = r#"{"id": "r-7", "status": "importing", "label": ""}"#.len();
        format!(r#"{{"id": "r-7", "status": "importing", "label": "{}"}}"#, "p".repeat(len - shell))
    };
    assert_eq!([padded(64 * 1024), padded(64 * 1024 + 1)].map(|t| text_is_terminal(&t)), [false, true]);
}
