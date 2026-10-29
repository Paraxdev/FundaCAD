//! What a tool that writes a file is allowed to write over.

use std::path::Path;

fn fits(path: &Path, exts: &[&str]) -> bool {
    path.extension().is_some_and(|e| exts.contains(&e.to_string_lossy().to_ascii_lowercase().as_str()))
}

/// None when `path`, and the file it leads to, both end in one of `exts` (any case), else the refusal.
pub fn extension_refusal(path: &Path, exts: &[&str], what: &str) -> Option<String> {
    let listed = exts.iter().map(|e| format!(".{e}")).collect::<Vec<_>>().join(" or ");
    if !fits(path, exts) {
        let ending = exts.first().map_or(String::new(), |e| format!(" Give a path ending in .{e}."));
        return Some(format!("{} is refused: {what} writes only {listed} files.{ending}", path.display()));
    }
    let target = crate::scope::canonical(path)?;
    if !fits(&target, exts) {
        return Some(format!(
            "{} is refused: it leads to {}, and {what} writes only {listed} files.",
            path.display(),
            target.display()
        ));
    }
    None
}
