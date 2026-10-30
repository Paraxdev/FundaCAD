use fundacad_lib::plugins::bundle::OFFICIAL_IDS;

#[test]
fn the_official_ids_are_the_shipped_plugins_that_run_in_the_window() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins");
    let mut shipped = Vec::new();
    for entry in std::fs::read_dir(&root).expect("the repo plugins dir").flatten() {
        let Ok(text) = std::fs::read_to_string(entry.path().join("manifest.json")) else { continue };
        let manifest: serde_json::Value = serde_json::from_str(&text).expect("a shipped manifest parses");
        if matches!(manifest["kind"].as_str(), Some("builtin" | "process")) {
            shipped.push(manifest["id"].as_str().expect("a shipped manifest has an id").to_string());
        }
    }
    shipped.sort();
    let mut listed: Vec<String> = OFFICIAL_IDS.iter().map(|s| s.to_string()).collect();
    listed.sort();
    assert!(!shipped.is_empty());
    assert_eq!(listed, shipped);
}
