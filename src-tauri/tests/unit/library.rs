use fundacad_lib::library::{list_dir, stat_all, stat_one, FileStat, ListResult, LIST_CAP, LIST_DEPTH, STAT_CAP};

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-library-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn an_existing_file_has_its_time_and_size() {
    let dir = temp_dir("stat");
    let file = dir.join("a.funda");
    std::fs::write(&file, b"{}").unwrap();
    let st = stat_one(file.to_str().unwrap());
    assert!(st.exists);
    assert_eq!(st.size, Some(2));
    assert!(st.mtime_ms.unwrap() > 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_missing_file_or_a_folder_does_not_exist() {
    let dir = temp_dir("missing");
    let gone = stat_one(dir.join("gone.funda").to_str().unwrap());
    assert_eq!(gone, FileStat { path: gone.path.clone(), exists: false, mtime_ms: None, size: None });
    assert!(!stat_one(dir.to_str().unwrap()).exists);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_batch_is_capped_and_keeps_order() {
    let paths: Vec<String> = (0..STAT_CAP + 20).map(|i| format!("Z:/nowhere/{i}.funda")).collect();
    let out = stat_all(&paths);
    assert_eq!(out.len(), STAT_CAP);
    assert_eq!(out[3].path, "Z:/nowhere/3.funda");
}

fn names(r: &ListResult, root: &std::path::Path) -> Vec<String> {
    r.files
        .iter()
        .map(|f| std::path::Path::new(&f.path).strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"))
        .collect()
}

#[test]
fn a_folder_lists_its_documents_and_those_of_its_subfolders() {
    let dir = temp_dir("list");
    for f in ["a.funda", "b.FUNDAB", "c.neocad", "d.sindri", "notes.json", "e.stl", ".funda", "sub/f.funda"] {
        let p = dir.join(f);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"{}").unwrap();
    }
    std::fs::create_dir_all(dir.join("x.funda")).unwrap();
    let r = list_dir(dir.to_str().unwrap()).unwrap();
    assert_eq!(names(&r, &dir), ["a.funda", "b.FUNDAB", "c.neocad", "d.sindri", "sub/f.funda"]);
    assert!(!r.truncated);
    assert!(r.files.iter().all(|f| f.exists && f.size == Some(2)));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn listing_stops_at_the_depth_limit_and_skips_dot_folders() {
    let dir = temp_dir("deep");
    let mut p = dir.clone();
    for level in 0..=LIST_DEPTH + 1 {
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join(format!("l{level}.funda")), b"{}").unwrap();
        p = p.join("d");
    }
    std::fs::create_dir_all(dir.join(".git")).unwrap();
    std::fs::write(dir.join(".git/hidden.funda"), b"{}").unwrap();
    let r = list_dir(dir.to_str().unwrap()).unwrap();
    let got = names(&r, &dir);
    assert_eq!(got.len(), LIST_DEPTH + 1);
    assert!(got.iter().all(|n| !n.contains("hidden")));
    assert!(got.last().unwrap().ends_with(&format!("l{LIST_DEPTH}.funda")));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_listing_is_capped_and_says_so() {
    let dir = temp_dir("cap");
    for i in 0..LIST_CAP + 3 {
        std::fs::write(dir.join(format!("{i:05}.funda")), b"").unwrap();
    }
    let r = list_dir(dir.to_str().unwrap()).unwrap();
    assert_eq!(r.files.len(), LIST_CAP);
    assert!(r.truncated);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_missing_folder_or_a_file_is_an_error() {
    let dir = temp_dir("nofolder");
    std::fs::write(dir.join("a.funda"), b"").unwrap();
    assert!(list_dir(dir.join("gone").to_str().unwrap()).is_err());
    assert!(list_dir(dir.join("a.funda").to_str().unwrap()).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn it_serialises_as_the_webview_reads_it() {
    let st = FileStat { path: "a".into(), exists: true, mtime_ms: Some(5), size: Some(1) };
    assert_eq!(serde_json::to_string(&st).unwrap(), r#"{"path":"a","exists":true,"mtimeMs":5,"size":1}"#);
}
