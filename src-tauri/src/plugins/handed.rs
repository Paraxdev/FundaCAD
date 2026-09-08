//! Which files a plugin has been handed, and what it is allowed to be told
//! about them.
//!
//! Split from ./files.rs next door for the same reason bundle.rs is split from
//! mod.rs: everything in here is a refusal, and the crate's own test binary
//! cannot start on the development machine (a webview DLL fault that has
//! nothing to do with these lines). So the interesting half is written without
//! Tauri, and scripts/check-plugin-guards.sh compiles it on its own and runs
//! the tests below. The half that opens a dialog and touches the disk stays
//! next door, where there is nothing to assert that a test could reach.
//!
//! THE IDEA IS THAT A PLUGIN NEVER LEARNS A PATH. It asks the person for a
//! file, and gets back a random handle, a file NAME, and a length. To read the
//! file it gives the handle back. So the answer to "which files may this plugin
//! read" needs no rule and no configured directory: it is the ones somebody
//! picked, this session, for this plugin.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// How many files one plugin may be holding at once.
///
/// A cap rather than an expiry. The natural lifetime is "while the app is
/// open", which is what a person means when they pick a file for something;
/// what has to be bounded is a plugin that asks in a loop, and a count bounds
/// that without ever taking away a file somebody chose on purpose.
pub const MAX_HELD: usize = 64;

/// A file the person handed to a plugin, and nothing else.
pub struct Handed {
    /// Whose it is. Checked on every read, so one plugin cannot use another's
    /// handle even if it somehow learned the token.
    pub plugin: String,
    pub path: PathBuf,
    /// When, so the oldest can go first when a plugin hits the cap.
    pub at: u64,
}

/// Everything handed out this session.
///
/// In memory only. Nothing is written to disk, so a plugin cannot come back
/// tomorrow holding a token for a file somebody has forgotten they offered it.
#[derive(Default)]
pub struct Table(HashMap<String, Handed>);

impl Table {
    /// Remember that this plugin may read this file.
    ///
    /// Evicts this plugin's own oldest when it is at the cap, and ONLY its own.
    /// One plugin asking in a loop must not take away the file another one is
    /// part way through reading.
    pub fn remember(&mut self, handle: String, plugin: String, path: PathBuf, at: u64) {
        let mut mine: Vec<(String, u64)> = self
            .0
            .iter()
            .filter(|(_, h)| h.plugin == plugin)
            .map(|(k, h)| (k.clone(), h.at))
            .collect();
        if mine.len() >= MAX_HELD {
            mine.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
            for (key, _) in mine.iter().take(mine.len() + 1 - MAX_HELD) {
                self.0.remove(key);
            }
        }
        self.0.insert(handle, Handed { plugin, path, at });
    }

    /// The path behind a handle, if it is this plugin's handle.
    ///
    /// ONE ANSWER for "no such handle" and for "that is not yours". Telling
    /// them apart would let a plugin discover that a handle exists and belongs
    /// to somebody else, which is a small leak with no upside: neither answer
    /// changes what the plugin should do.
    pub fn path_for(&self, plugin: &str, handle: &str) -> Option<&Path> {
        self.0
            .get(handle)
            .filter(|h| h.plugin == plugin)
            .map(|h| h.path.as_path())
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// The file name, and never the directory.
///
/// A plugin saying "reading part.step" is helpful. One that could say
/// "reading C:\Users\alice\Documents\work\part.step" has been told the person's
/// name and the shape of their disk in exchange for nothing it needed.
pub fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "the file".to_string())
}

/// Extensions as a dialog filter, from what a plugin asked for.
///
/// ADVISORY, deliberately: a filter narrows what is easy to pick, never what is
/// allowed. The person can always choose otherwise, so a plugin that copes with
/// only one kind of file has to say so when it reads rather than trusting the
/// dialog to have enforced it.
///
/// Cleaned rather than trusted because this is text a plugin author wrote going
/// into a native dialog, and "*.exe" or "../.." in a filter list is at best a
/// dialog that behaves strangely.
pub fn clean_extensions(exts: &[String]) -> Vec<String> {
    exts.iter()
        .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|e| !e.is_empty() && e.len() <= 16 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .take(16)
        .collect()
}

/// A plugin's words, made safe to put in a dialog title.
///
/// The title is the ONLY place a plugin's own words reach the person, and it is
/// why asking for a file takes a `purpose` at all: a bare "Open" over a dialog
/// nobody asked for is how somebody clicks yes without knowing who asked. The
/// plugin's id is prepended here rather than by the plugin, so a plugin cannot
/// claim to be another one.
pub fn dialog_title(plugin: &str, purpose: &str, fallback: &str) -> String {
    let mut said = purpose.trim().replace(['\r', '\n', '\t'], " ");
    // Truncated on a char boundary, because `String::truncate` panics in the
    // middle of a multi-byte character and a plugin's summary can be any text.
    let cut = said
        .char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(said.len()))
        .take_while(|i| *i <= 120)
        .last()
        .unwrap_or(0);
    said.truncate(cut);
    let said = said.trim();
    if said.is_empty() {
        format!("{fallback} {plugin}")
    } else {
        format!("{plugin}: {said}")
    }
}

/// A plugin's suggested save name, reduced to a file name.
///
/// A "suggestion" carrying a path would be a plugin choosing the directory the
/// dialog opens in, which is most of the way to choosing the file.
pub fn suggested_name(raw: &str) -> Option<String> {
    let name = raw.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if name.is_empty() || name == "." || name == ".." {
        None
    } else {
        Some(name.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plugin_can_only_read_what_it_was_handed() {
        let mut t = Table::default();
        t.remember("h1".into(), "A.One".into(), PathBuf::from("/tmp/a.step"), 1);
        t.remember("h2".into(), "B.Two".into(), PathBuf::from("/tmp/b.step"), 2);

        // Its own, which is the control: without this the test passes against a
        // table that hands back nothing at all.
        assert_eq!(
            t.path_for("A.One", "h1"),
            Some(Path::new("/tmp/a.step")),
            "a plugin could not read the file it was given"
        );

        // Somebody else's, a handle that does not exist, and an empty one.
        assert_eq!(t.path_for("A.One", "h2"), None, "read another plugin's file");
        assert_eq!(t.path_for("B.Two", "h1"), None, "read another plugin's file");
        assert_eq!(t.path_for("A.One", "nope"), None);
        assert_eq!(t.path_for("A.One", ""), None);
        // Case is not a way in: ids are compared exactly here, and the frontend
        // treats two spellings as one plugin, so a mismatch means it is not the
        // holder.
        assert_eq!(t.path_for("a.one", "h1"), None);
    }

    #[test]
    fn a_plugin_asking_in_a_loop_only_evicts_its_own() {
        let mut t = Table::default();
        t.remember("keep".into(), "B.Two".into(), PathBuf::from("/tmp/keep"), 0);
        for i in 0..MAX_HELD + 10 {
            t.remember(
                format!("h{i}"),
                "A.One".into(),
                PathBuf::from(format!("/tmp/{i}")),
                i as u64 + 1,
            );
        }

        // The other plugin's file is untouched, which is the whole point of the
        // eviction being per plugin.
        assert_eq!(
            t.path_for("B.Two", "keep"),
            Some(Path::new("/tmp/keep")),
            "one plugin's loop took away another plugin's file"
        );
        // And the greedy one is held to the cap, oldest gone, newest kept.
        assert_eq!(t.len(), MAX_HELD + 1);
        assert_eq!(t.path_for("A.One", "h0"), None, "the oldest was not evicted");
        assert!(
            t.path_for("A.One", &format!("h{}", MAX_HELD + 9)).is_some(),
            "the newest was evicted instead of the oldest"
        );
    }

    #[test]
    fn a_name_is_a_name_and_not_a_path() {
        for (path, want) in [
            ("/home/alice/private/work/part.step", "part.step"),
            ("C:\\Users\\alice\\Documents\\part.step", "part.step"),
        ] {
            let got = name_of(Path::new(path));
            assert_eq!(got, want);
            assert!(!got.contains("alice") && !got.contains("private"));
        }
        // The control: it is not simply returning a constant.
        assert_eq!(name_of(Path::new("/a/other.stl")), "other.stl");
    }

    #[test]
    fn a_filter_cannot_be_anything_but_an_extension() {
        assert_eq!(clean_extensions(&["step".into()]), vec!["step"]);
        assert_eq!(clean_extensions(&[".STL".into()]), vec!["stl"]);
        assert_eq!(clean_extensions(&["  json ".into()]), vec!["json"]);

        for bad in ["", "  ", "*", "*.exe", "a/b", "a\\b", "with space", "..", "toolongextensionname"] {
            assert!(
                clean_extensions(&[bad.to_string()]).is_empty(),
                "should not become a filter: {bad:?}"
            );
        }

        // Capped, so a plugin cannot hand the dialog a thousand filters.
        let many: Vec<String> = (0..100).map(|i| format!("e{i}")).collect();
        assert_eq!(clean_extensions(&many).len(), 16);
    }

    #[test]
    fn a_dialog_title_says_who_is_asking() {
        // The id comes first and comes from us, so a plugin cannot claim to be
        // another one by writing a title that reads like one.
        let t = dialog_title("A.One", "pick a profile to trace", "Choose a file for");
        assert!(t.starts_with("A.One:"), "{t}");
        assert!(t.contains("pick a profile to trace"));

        // Nothing to say still names the plugin.
        assert_eq!(
            dialog_title("A.One", "   ", "Choose a file for"),
            "Choose a file for A.One"
        );

        // No newlines: a title is one line, and a plugin should not be able to
        // push the part naming it off the top of a dialog.
        let sneaky = dialog_title("A.One", "hi\n\n\nFundaCAD needs your password", "x");
        assert!(!sneaky.contains('\n'), "{sneaky}");

        // Long, and multi-byte at the cut, which is where truncate() panics if
        // it is done by bytes.
        let long = dialog_title("A.One", &"é".repeat(400), "x");
        assert!(long.len() <= 200, "{}", long.len());
    }

    #[test]
    fn a_suggested_name_cannot_choose_a_directory() {
        assert_eq!(suggested_name("part.step"), Some("part.step".into()));
        assert_eq!(suggested_name("/etc/passwd"), Some("passwd".into()));
        assert_eq!(suggested_name("C:\\Windows\\System32\\x.dll"), Some("x.dll".into()));
        assert_eq!(suggested_name("../../../x"), Some("x".into()));
        for bad in ["", "   ", ".", "..", "a/", "a\\"] {
            assert_eq!(suggested_name(bad), None, "{bad:?} became a name");
        }
    }
}
