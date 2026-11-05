use fundacad_lib::recovery;

fn dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("fundacad-recovery-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn every_listed_slot_reads_back_including_legacy_names() {
    let d = dir("legacy");
    std::fs::write(d.join("old.neocad"), "{\"a\":1}").unwrap();
    std::fs::write(d.join("older.sindri"), "{\"b\":2}").unwrap();
    recovery::write(&d, "new", "{\"c\":3}").unwrap();
    let slots = recovery::list(&d).unwrap();
    assert_eq!(slots.len(), 3);
    for (slot, _) in &slots {
        assert!(recovery::read(&d, slot).unwrap().is_some(), "{slot} is listed but does not read back");
    }
    assert_eq!(recovery::read(&d, "old").unwrap().as_deref(), Some("{\"a\":1}"));
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn clearing_a_slot_removes_its_legacy_snapshot() {
    let d = dir("clear");
    std::fs::write(d.join("old.neocad"), "{}").unwrap();
    recovery::write(&d, "old", "{\"new\":true}").unwrap();
    assert_eq!(recovery::list(&d).unwrap().len(), 1);
    assert_eq!(recovery::read(&d, "old").unwrap().as_deref(), Some("{\"new\":true}"));
    recovery::clear(&d, "old").unwrap();
    assert!(recovery::list(&d).unwrap().is_empty());
    assert_eq!(recovery::read(&d, "old").unwrap(), None);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_slot_name_cannot_leave_the_recovery_dir() {
    let d = dir("names");
    recovery::write(&d, "../x/y", "{}").unwrap();
    assert_eq!(recovery::list(&d).unwrap()[0].0, "___x_y");
    assert!(recovery::write(&d, "", "{}").is_err());
    let _ = std::fs::remove_dir_all(&d);
}
