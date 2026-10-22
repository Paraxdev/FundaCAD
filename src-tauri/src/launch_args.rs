//! The Tauri-free half of launch.rs: which documents a launch names, and the
//! queue they wait in for the page. No Tauri here, so
//! scripts/check-launch-args.sh can run these tests on Windows, where the
//! app's own test binary cannot start.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use url::Url;

#[derive(Default)]
pub struct LaunchPaths(Mutex<Vec<String>>);

impl LaunchPaths {
    /// Appends `paths` and says whether there were any.
    pub fn push(&self, paths: Vec<String>) -> bool {
        if paths.is_empty() {
            return false;
        }
        self.0.lock().unwrap_or_else(|e| e.into_inner()).extend(paths);
        true
    }

    pub fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

fn document(path: PathBuf) -> Option<String> {
    crate::library::is_document(&path.file_name()?.to_string_lossy()).then(|| path.to_string_lossy().into_owned())
}

/// The documents in `argv`, absolute. argv[0] and flags are skipped, a
/// `file://` URI is decoded, and anything that is not a document is left out.
/// Leaving out what is not a document also drops the pieces of an install path
/// with spaces, which the NSIS installer registers unquoted.
pub fn launch_paths(argv: impl IntoIterator<Item = OsString>, cwd: &Path) -> Vec<String> {
    argv.into_iter()
        .skip(1)
        .filter_map(|arg| {
            let arg = arg.into_string().ok()?;
            if arg.starts_with('-') {
                return None;
            }
            let path =
                if arg.starts_with("file://") { Url::parse(&arg).ok()?.to_file_path().ok()? } else { cwd.join(&arg) };
            document(path)
        })
        .collect()
}

/// The documents macOS hands a running app (Finder's Open With, a double click,
/// a drop on the Dock icon), which arrive as URLs rather than in argv.
pub fn opened_paths<'a>(urls: impl IntoIterator<Item = &'a Url>) -> Vec<String> {
    urls.into_iter().filter(|u| u.scheme() == "file").filter_map(|u| document(u.to_file_path().ok()?)).collect()
}

/// The local paths a drag's text/uri-list names, in order. Other schemes,
/// remote hosts and paths that are not UTF-8 are left out.
pub fn uri_list_paths<S: AsRef<str>>(uris: &[S]) -> Vec<String> {
    uris.iter()
        .filter_map(|u| Url::parse(u.as_ref().trim()).ok())
        .filter(|u| u.scheme() == "file")
        .filter_map(|u| u.to_file_path().ok()?.into_os_string().into_string().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<OsString> {
        a.iter().map(OsString::from).collect()
    }

    fn urls(a: &[&str]) -> Vec<Url> {
        a.iter().map(|u| Url::parse(u).unwrap()).collect()
    }

    #[cfg(unix)]
    #[test]
    fn launch_paths_keeps_documents_and_resolves_them_against_the_cwd() {
        let argv = args(&[
            "/usr/bin/fundacad",
            "part.funda",
            "/tmp/Big.FUNDAB",
            "--flag",
            "notes.txt",
            "file:///tmp/a%20b.funda",
        ]);
        assert_eq!(
            launch_paths(argv, Path::new("/home/u/cad")),
            vec!["/home/u/cad/part.funda", "/tmp/Big.FUNDAB", "/tmp/a b.funda"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn launch_paths_keeps_documents_and_resolves_them_against_the_cwd() {
        let argv = args(&[
            "fundacad.exe",
            "part.funda",
            r"C:\tmp\Big.FUNDAB",
            "--flag",
            "notes.txt",
            "file:///C:/tmp/a%20b.funda",
        ]);
        assert_eq!(
            launch_paths(argv, Path::new(r"C:\Users\u\cad")),
            vec![r"C:\Users\u\cad\part.funda", r"C:\tmp\Big.FUNDAB", r"C:\tmp\a b.funda"]
        );
    }

    #[test]
    fn launch_paths_skips_the_program_and_the_engine_modes() {
        assert!(launch_paths(args(&["fundacad", "--engine"]), Path::new("/")).is_empty());
        assert!(launch_paths(args(&["part.funda"]), Path::new("/")).is_empty());
        assert!(launch_paths(args(&["fundacad", ".funda"]), Path::new("/")).is_empty());
        // What macOS may put in argv of an app Finder starts.
        assert!(launch_paths(args(&["fundacad", "-psn_0_12345"]), Path::new("/")).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn launch_paths_reads_the_argv_the_windows_installers_register() {
        let doc = r"C:\Users\Zoë Müller\My Parts\Würfel 2 (v3).FUNDA";
        // NSIS: `$INSTDIR\fundacad.exe "%1"`, the exe unquoted, so an install
        // path with spaces reaches argv as several pieces.
        let nsis = args(&[r"C:\Users\Zoë", r"Müller\AppData\Local\FundaCAD\fundacad.exe", doc]);
        assert_eq!(launch_paths(nsis, Path::new(r"C:\Windows\System32")), vec![doc]);
        // WiX: `"[INSTALLDIR]fundacad.exe" "%1"`.
        let wix = args(&[r"C:\Program Files\FundaCAD\fundacad.exe", doc, r"\\nas\cad\a b.fundab"]);
        assert_eq!(launch_paths(wix, Path::new(r"C:\Windows\System32")), vec![doc, r"\\nas\cad\a b.fundab"]);
    }

    /// The child half of the test below: prints what it found in its own argv.
    #[test]
    fn argv_child() {
        let Ok(cwd) = std::env::var("FUNDACAD_ARGV_CHILD") else { return };
        println!("PATHS={}", launch_paths(std::env::args_os(), Path::new(&cwd)).join("|"));
    }

    /// The paths after the program in a Windows command line, as the launched
    /// process reads them: this test binary started again with that line, running
    /// only `argv_child`. The document arguments also count as libtest name
    /// filters, which --exact keeps from matching anything.
    #[cfg(windows)]
    fn through_a_windows_command_line(tail: &str, cwd: &str) -> Vec<String> {
        use std::os::windows::process::CommandExt;
        let module = module_path!();
        let child = format!("{}::argv_child", module.split_once("::").map_or(module, |(_, m)| m));
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .raw_arg(tail)
            .args(["--exact", &child, "--nocapture", "--test-threads=1"])
            .env("FUNDACAD_ARGV_CHILD", cwd)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        let line = stdout
            .lines()
            .find_map(|l| Some(l.split_once("PATHS=")?.1))
            .unwrap_or_else(|| panic!("no PATHS line:\n{stdout}"));
        line.split('|').filter(|p| !p.is_empty()).map(String::from).collect()
    }

    #[cfg(windows)]
    #[test]
    fn launch_paths_survives_windows_quoting_spaces_and_unicode() {
        let cwd = r"C:\Users\Zoë\Desktop";
        let doc = r"C:\Users\Zoë Müller\My Parts\Würfel 2 (v3).FUNDA";
        assert_eq!(through_a_windows_command_line(&format!("\"{doc}\""), cwd), vec![doc]);
        assert_eq!(through_a_windows_command_line(r#""\\nas\cad\a b.fundab""#, cwd), vec![r"\\nas\cad\a b.fundab"]);
        assert_eq!(through_a_windows_command_line(r#""rel part.funda""#, cwd), vec![format!(r"{cwd}\rel part.funda")]);
        assert_eq!(
            through_a_windows_command_line(r#""C:\a.funda" "D:\b c\d.fundab" "C:\notes.txt""#, cwd),
            vec![r"C:\a.funda", r"D:\b c\d.fundab"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn opened_paths_keeps_the_documents_among_the_urls() {
        let got = opened_paths(&urls(&[
            "file:///Users/Zo%C3%AB/My%20Parts/W%C3%BCrfel.FUNDA",
            "file:///Users/z/b.fundab",
            "file:///Users/z/notes.txt",
            "https://example.com/x.funda",
            "fundacad://open?x.funda",
        ]));
        assert_eq!(got, vec!["/Users/Zoë/My Parts/Würfel.FUNDA", "/Users/z/b.fundab"]);
    }

    #[cfg(unix)]
    #[test]
    fn uri_list_paths_decodes_the_local_files_a_file_manager_drags() {
        let got = uri_list_paths(&[
            "file:///tmp/my%20dir/p%C3%A4rt%20%C3%BC%20%231.funda",
            "file://localhost/tmp/a.funda",
            "file://otherhost/z.funda",
            "http://x/y.funda",
            "file:///home/Zo%C3%AB/%E2%9C%93%20%E9%83%A8%E5%93%81.step
",
            "file:///tmp/plain%20space.funda",
        ]);
        assert_eq!(
            got,
            vec!["/tmp/my dir/pärt ü #1.funda", "/tmp/a.funda", "/home/Zoë/✓ 部品.step", "/tmp/plain space.funda"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn opened_paths_keeps_the_documents_among_the_urls() {
        let got = opened_paths(&urls(&[
            "file:///C:/Users/Zo%C3%AB/My%20Parts/W%C3%BCrfel.FUNDA",
            "file:///C:/z/b.fundab",
            "file:///C:/z/notes.txt",
            "https://example.com/x.funda",
        ]));
        assert_eq!(got, vec![r"C:\Users\Zoë\My Parts\Würfel.FUNDA", r"C:\z\b.fundab"]);
    }

    #[test]
    fn the_queue_keeps_paths_in_order_until_the_page_takes_them() {
        let q = LaunchPaths::default();
        assert!(!q.push(vec![]), "an empty launch must not wake the page");
        assert!(q.push(vec!["a.funda".into()]));
        assert!(q.push(vec!["b.fundab".into(), "c.funda".into()]));
        assert_eq!(q.take(), vec!["a.funda", "b.fundab", "c.funda"]);
        assert!(q.take().is_empty());
    }

    /// Open With on Windows and macOS comes from bundle.fileAssociations: the
    /// NSIS and WiX installers and the app's Info.plist are written from it. The
    /// MIME types are the ones the Linux packages register, so a file has one
    /// type on every platform.
    #[test]
    fn the_installers_register_both_document_types() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mime_xml = include_str!("../../packaging/dev.fundacad.app.mime.xml");
        let desktop = include_str!("../../packaging/fundacad.desktop.hbs");
        let assoc = conf["bundle"]["fileAssociations"].as_array().expect("bundle.fileAssociations is missing");
        for (ext, mime) in [("funda", "application/x-fundacad"), ("fundab", "application/x-fundacad-bundle")] {
            let a = assoc
                .iter()
                .find(|a| a["ext"].as_array().is_some_and(|e| e.iter().any(|e| e == ext)))
                .unwrap_or_else(|| panic!(".{ext} has no file association"));
            assert_eq!(a["role"], "Editor", ".{ext}");
            assert_eq!(a["rank"], "Owner", ".{ext}");
            assert_eq!(a["mimeType"], mime, ".{ext}");
            assert!(a["name"].as_str().is_some_and(|n| !n.is_empty()), ".{ext} has no name");
            assert!(a["description"].as_str().is_some_and(|n| !n.is_empty()), ".{ext} has no description");
            assert!(a["exportedType"]["identifier"].as_str().is_some_and(|i| i.starts_with("dev.fundacad.")), ".{ext}");
            assert!(mime_xml.contains(&format!("type=\"{mime}\"")) && mime_xml.contains(&format!("\"*.{ext}\"")));
            assert!(desktop.contains(&format!("{mime};")));
        }
    }
}
