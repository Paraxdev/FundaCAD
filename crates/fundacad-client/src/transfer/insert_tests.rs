use super::insert::*;
use serde_json::{json, Map, Value};

fn obj(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

#[test]
fn stamps_match_fundacad_1() {
    assert_eq!(document_stamp(""), "811c9dc5010001930");
    assert_eq!(document_stamp("{\"features\":[]}"), "de6ba15228f8961cf");
    assert_eq!(document_stamp("Ünïcødé 𝔸 bracket"), "71bf97b55de9a40e12");
}

#[test]
fn base_names_drop_one_extension() {
    assert_eq!(base_name("C:\\a\\Bracket.v2.funda"), "Bracket.v2");
    assert_eq!(base_name("/a/plain"), "plain");
    assert_eq!(base_name("/a/.funda"), "Document");
    assert_eq!(base_name("odd."), "odd.");
}

#[test]
fn the_source_builds_to_its_rollback_without_suppressed() {
    let text = r#"{"name":"src","parameters":{"w":4},"features":[{"id":"f1"},{"id":"f2"},{"id":"f3"}],
        "rollback":2,"suppressed":["f1"],"bodyVisibility":{},"camera":{}}"#;
    let doc = buildable_source(text).unwrap();
    assert_eq!(Value::Object(doc), json!({"parameters": {"w": 4}, "features": [{"id": "f2"}]}));
    let shown = buildable_source(r#"{"features":[],"bodyVisibility":{"body1":false}}"#).unwrap();
    assert_eq!(shown.get("bodyVisibility"), Some(&json!({"body1": false})));
    assert!(buildable_source("[1]").is_err());
    assert!(buildable_source("{").is_err());
}

#[test]
fn an_insert_appends_or_links_the_baked_geometry() {
    let stat = LinkStat::Found(FileStat { size: 120, mtime_ms: 1_700_000_000_123.0 });
    let source = Source { path: "D:/parts/hinge.funda", text: "{}", stat };
    let baked = obj(json!({"geom": {"blob": "x"}, "solid": true, "parts": [1], "name": "ignored"}));
    let appended = insert_feature("f9", &source, InsertMode::Append, &baked);
    assert_eq!(
        appended,
        json!({"id": "f9", "type": "import", "format": "step", "name": "hinge", "source": "D:/parts/hinge.funda",
               "geom": {"blob": "x"}, "solid": true, "parts": [1]})
    );
    let linked = insert_feature("f9", &source, InsertMode::Link, &baked);
    assert_eq!(
        linked["link"],
        json!({"path": "D:/parts/hinge.funda", "stamp": document_stamp("{}"), "size": 120, "mtime": 1_700_000_000_123.0})
    );
    let unstated = Source { stat: LinkStat::Unknown, ..source };
    assert_eq!(insert_feature("f9", &unstated, InsertMode::Link, &baked)["link"].as_object().unwrap().len(), 2);
}

#[test]
fn refresh_and_unlink_touch_only_linked_imports() {
    let mut doc = obj(json!({"features": [
        {"id": "f1", "type": "box"},
        {"id": "f2", "type": "import", "geom": {"old": 1}, "nodes": [0], "link": {"path": "a.funda", "stamp": "s"}},
        {"id": "f3", "type": "import", "geom": {}},
    ]}));
    let source = Source { path: "a.funda", text: "new", stat: LinkStat::Missing };
    let baked = obj(json!({"geom": {"new": 2}, "solid": false}));
    refresh_link(&mut doc, "f2", &source, &baked).unwrap();
    let f2 = &doc["features"][1];
    assert_eq!(f2["geom"], json!({"new": 2}));
    assert_eq!(f2["solid"], json!(false));
    assert_eq!(f2["link"]["stamp"], json!(document_stamp("new")));
    assert_eq!(refresh_link(&mut doc, "f3", &source, &baked), Err(InsertError::NotLinked));
    assert_eq!(refresh_link(&mut doc, "f1", &source, &baked), Err(InsertError::NotLinked));
    unlink(&mut doc, "f2");
    assert!(doc["features"][1].get("link").is_none());
    assert_eq!(doc["features"][1]["geom"], json!({"new": 2}));
}

#[test]
fn stale_links_go_by_size_and_time_alone() {
    let link = |id: &str, path: &str, extra: Value| {
        let mut l = obj(json!({"path": path, "stamp": "s"}));
        l.extend(obj(extra));
        json!({"id": id, "type": "import", "link": l})
    };
    let doc = obj(json!({"features": [
        link("same", "same.funda", json!({"size": 10, "mtime": 5.0})),
        link("grew", "grew.funda", json!({"size": 10, "mtime": 5.0})),
        link("touched", "touched.funda", json!({"size": 10, "mtime": 5.0})),
        link("gone", "gone.funda", json!({"size": 10, "mtime": 5.0})),
        link("old", "same.funda", json!({})),
        link("blind", "blind.funda", json!({"size": 10, "mtime": 5.0})),
        {"id": "plain", "type": "import"},
        {"id": "box", "type": "box", "link": {"path": "gone.funda"}},
    ]}));
    let stale = stale_links(&doc, |p| match p {
        "same.funda" => LinkStat::Found(FileStat { size: 10, mtime_ms: 5.0 }),
        "grew.funda" => LinkStat::Found(FileStat { size: 11, mtime_ms: 5.0 }),
        "touched.funda" => LinkStat::Found(FileStat { size: 10, mtime_ms: 6.0 }),
        "gone.funda" => LinkStat::Missing,
        _ => LinkStat::Unknown,
    });
    assert_eq!(
        stale,
        StaleLinks {
            changed: vec!["grew".into()],
            missing: vec!["gone".into()],
            unknown: vec!["touched".into(), "old".into(), "blind".into()],
        }
    );
}

#[test]
fn a_file_stats_found_or_missing() {
    let dir = std::env::temp_dir().join(format!("fc-insert-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("a.funda");
    std::fs::write(&file, b"12345").unwrap();
    match stat_file(file.to_str().unwrap()) {
        LinkStat::Found(s) => assert_eq!(s.size, 5),
        other => panic!("{other:?}"),
    }
    assert_eq!(stat_file(dir.join("none.funda").to_str().unwrap()), LinkStat::Missing);
    let _ = std::fs::remove_dir_all(&dir);
    assert!(same_path("C:\\A\\b.funda", "c:/a/B.FUNDA"));
}
