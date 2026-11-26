use std::path::PathBuf;

use super::picker::keep_exts;

#[test]
fn only_the_asked_extensions_are_kept_whatever_their_case() {
    let paths = ["C:/a/part.STL", "C:/a/notes.txt", "C:/a/noext", "C:/a/b.step"].map(PathBuf::from).to_vec();
    assert_eq!(keep_exts(paths, &["stl", "step"]), ["C:/a/part.STL", "C:/a/b.step"]);
}
