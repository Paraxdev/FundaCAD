use std::path::PathBuf;

use fundacad_lib::plugins::launch::first_program;

fn text(p: PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn picks_the_first_absolute_file_that_exists() {
    let dir = std::env::temp_dir().join(format!("fundacad-launch-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let real = dir.join("tool.bin");
    std::fs::write(&real, b"x").unwrap();
    let missing = text(dir.join("missing.bin"));
    let got = first_program(&[missing, "tool.bin".into(), text(dir.clone()), text(real.clone())]);
    assert_eq!(got, Some(real));
    assert_eq!(first_program(&[]), None);
    let _ = std::fs::remove_dir_all(&dir);
}
