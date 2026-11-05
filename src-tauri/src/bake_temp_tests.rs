use super::*;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-bake-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn each_bake_gets_a_fresh_name_in_its_own_directory() {
    let dir = bake_dir(&scratch("fresh"));
    let a = fresh_path(&dir).unwrap();
    let b = fresh_path(&dir).unwrap();
    assert_ne!(a, b);
    assert_eq!(a.parent(), Some(dir.as_path()));
    assert!(is_bake_name(a.file_name().unwrap().to_str().unwrap()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    }
    let _ = std::fs::remove_dir_all(dir.parent().unwrap());
}

#[test]
fn remove_drops_a_bake_and_accepts_one_already_gone() {
    let dir = bake_dir(&scratch("remove"));
    let p = fresh_path(&dir).unwrap();
    std::fs::write(&p, b"ISO-10303-21;").unwrap();
    let raw = p.to_string_lossy().into_owned();
    remove(&dir, &raw).unwrap();
    assert!(!p.exists());
    remove(&dir, &raw).unwrap();
    let _ = std::fs::remove_dir_all(dir.parent().unwrap());
}

#[test]
fn remove_refuses_a_path_it_did_not_name() {
    let root = scratch("refuse");
    let dir = bake_dir(&root);
    std::fs::create_dir_all(&dir).unwrap();
    let other = root.join("keep.step");
    std::fs::write(&other, b"x").unwrap();
    let foreign = dir.join("keep.step");
    std::fs::write(&foreign, b"x").unwrap();
    let nested = root.join(format!("{PREFIX}{}{SUFFIX}", "a".repeat(32)));
    std::fs::write(&nested, b"x").unwrap();
    for p in [&other, &foreign, &nested] {
        assert!(remove(&dir, &p.to_string_lossy()).is_err());
        assert!(p.exists());
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn sweep_removes_only_bakes_past_their_lifetime() {
    let dir = bake_dir(&scratch("sweep"));
    let bake = fresh_path(&dir).unwrap();
    std::fs::write(&bake, b"x").unwrap();
    let other = dir.join("notes.txt");
    std::fs::write(&other, b"x").unwrap();
    sweep(&dir, SystemTime::now());
    assert!(bake.exists());
    sweep(&dir, SystemTime::now() + BAKE_LIFETIME + Duration::from_secs(60));
    assert!(!bake.exists());
    assert!(other.exists());
    let _ = std::fs::remove_dir_all(dir.parent().unwrap());
}
