use fundacad_engine::sandbox::stage::{stage, Delivery};
use serde_json::{json, Map, Value};
use std::path::{PathBuf, MAIN_SEPARATOR as SEP};

fn dir() -> PathBuf {
    std::env::temp_dir().join("engine-tmp").join("exports").join("7")
}

fn staged(name: &str) -> String {
    dir().join(name).to_str().unwrap().to_string()
}

fn sent(text: &str) -> Map<String, Value> {
    serde_json::from_str(text).unwrap()
}

fn reply(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

#[test]
fn a_request_that_writes_no_export_goes_out_as_it_is() {
    for text in [
        r#"{"id":1,"op":"build","document":{}}"#,
        r#"{"id":2,"op":"import","path":"/home/alice/part.step"}"#,
        r#"{"id":3,"op":"export","format":"step"}"#,
        r#"{"id":4,"op":"export","path":7}"#,
        "not json",
    ] {
        assert!(stage(text, &dir()).unwrap().is_none(), "{text}");
    }
}

#[test]
fn an_export_keeps_its_file_name_inside_the_stage() {
    for (op, path) in [("export", "/home/alice/parts/Bracket.step"), ("exportWith", r"C:\Users\alice\Bracket.step")] {
        let text = json!({"id": 5, "op": op, "format": "step", "path": path, "document": {"features": []}}).to_string();
        let s = stage(&text, &dir()).unwrap().unwrap();
        let req = sent(&s.request);
        assert_eq!(req["path"], json!(staged("Bracket.step")), "{op}");
        assert_eq!((&req["id"], &req["op"], &req["format"]), (&json!(5), &json!(op), &json!("step")));
        assert_eq!(req["document"], json!({"features": []}));
        assert_eq!(s.target(), path);
    }
}

#[test]
fn a_repeated_or_escaped_key_is_read_the_way_the_worker_reads_it() {
    let text = r#"{"id":6,"\u006fp":"\u0065xport","path":"/tmp/a.stl","path":"/home/alice/b.stl"}"#;
    let s = stage(text, &dir()).unwrap().unwrap();
    assert_eq!(s.target(), "/home/alice/b.stl");
    assert_eq!(s.request.matches("\"path\"").count(), 1);
    assert_eq!(sent(&s.request)["path"], json!(staged("b.stl")));
}

#[test]
fn a_path_that_names_no_file_is_refused() {
    for path in ["", "/home/alice/", r"C:\Users\alice\", "/home/alice/..", "/home/alice/.", ".."] {
        let text = json!({"id": 1, "op": "export", "path": path}).to_string();
        assert!(stage(&text, &dir()).is_err(), "{path:?}");
    }
    if cfg!(windows) {
        let text = json!({"id": 1, "op": "export", "path": "C:part.step"}).to_string();
        assert!(stage(&text, &dir()).is_err(), "a drive relative name leaves the stage");
    }
}

#[test]
fn a_finished_export_names_the_users_file_and_is_copied_there() {
    let target = "/home/alice/parts/Bracket.step";
    let s = stage(&json!({"id": 1, "op": "export", "path": target}).to_string(), &dir()).unwrap().unwrap();
    let mut r = reply(json!({"id": 1, "path": staged("Bracket.step"), "warnings": [{"message": "skipped a body"}]}));
    let d = s.settle(&mut r).unwrap();
    assert_eq!(d, Some(Delivery::File { from: staged("Bracket.step").into(), to: target.into() }));
    assert_eq!(r["path"], json!(target));
    assert_eq!(r["warnings"], json!([{"message": "skipped a body"}]));
}

#[test]
fn a_separate_export_fills_a_new_folder_named_after_the_file() {
    let target = "/home/alice/parts/my.lamp.step";
    let text = json!({"id": 1, "op": "export", "path": target, "separate": true}).to_string();
    let s = stage(&text, &dir()).unwrap().unwrap();
    let base = staged("my.lamp");
    let mut r = reply(json!({"id": 1, "path": base, "paths": [
        format!("{base}{SEP}Shade.step"), format!("{base}{SEP}Foot.step"),
    ]}));
    let d = s.settle(&mut r).unwrap();
    let real = "/home/alice/parts/my.lamp";
    let files = ["Shade.step", "Foot.step"]
        .map(|n| (PathBuf::from(format!("{base}{SEP}{n}")), PathBuf::from(format!("{real}{SEP}{n}"))));
    assert_eq!(d, Some(Delivery::Folder { folder: real.into(), files: files.to_vec() }));
    assert_eq!(r["path"], json!(real));
    assert_eq!(r["paths"], json!([format!("{real}{SEP}Shade.step"), format!("{real}{SEP}Foot.step")]));
}

#[test]
fn only_an_export_with_one_file_per_body_writes_a_folder() {
    let text = json!({"id": 1, "op": "exportWith", "path": "/home/alice/a.svg", "separate": true}).to_string();
    let s = stage(&text, &dir()).unwrap().unwrap();
    let mut r = reply(json!({"id": 1, "path": staged("a.svg")}));
    assert!(matches!(s.settle(&mut r).unwrap(), Some(Delivery::File { .. })));
}

#[test]
fn a_reply_that_points_outside_the_stage_is_refused() {
    let one = stage(&json!({"id": 1, "op": "export", "path": "/home/alice/a.stl"}).to_string(), &dir()).unwrap();
    let one = one.unwrap();
    let base = staged("a");
    for bad in [
        json!({"path": "/home/alice/.ssh/id_rsa"}),
        json!({"path": staged("b.stl")}),
        json!({"path": staged("a.stl"), "paths": [staged("a.stl")]}),
    ] {
        assert!(one.settle(&mut reply(bad.clone())).is_err(), "{bad}");
    }
    let text = json!({"id": 1, "op": "export", "path": "/home/alice/a.stl", "separate": 1}).to_string();
    let sep = stage(&text, &dir()).unwrap().unwrap();
    for bad in [
        json!({"path": staged("b"), "paths": []}),
        json!({"path": base, "paths": [format!("{base}{SEP}..{SEP}x.stl")]}),
        json!({"path": base, "paths": [format!("{base}{SEP}..")]}),
        json!({"path": base, "paths": [format!("{base}{SEP}deep{SEP}x.stl")]}),
        json!({"path": base, "paths": [format!("{base}/x.stl"), format!("{base}\\y.stl")]}),
        json!({"path": base, "paths": ["/etc/passwd"]}),
        json!({"path": base, "paths": [3]}),
        json!({"path": base}),
    ] {
        assert!(sep.settle(&mut reply(bad.clone())).is_err(), "{bad}");
    }
}

#[test]
fn a_failed_export_copies_nothing_and_names_the_users_folder() {
    let text = json!({"id": 1, "op": "export", "path": "/home/alice/Lamp.step", "separate": true}).to_string();
    let s = stage(&text, &dir()).unwrap().unwrap();
    let base = staged("Lamp");
    let mut r = reply(json!({"id": 1, "error": {"message": format!("could not create {base}: denied")}}));
    assert_eq!(s.settle(&mut r).unwrap(), None);
    assert_eq!(r["error"]["message"], json!("could not create /home/alice/Lamp: denied"));
    assert_eq!(s.settle(&mut reply(json!({"id": 1, "cancelled": true}))).unwrap(), None);
}
