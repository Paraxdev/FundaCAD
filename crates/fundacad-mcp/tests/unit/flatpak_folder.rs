use fundacad_mcp::flatpak_folder::*;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Not tempfile's default `.tmpXXXX`, whose dot the scope rules treat as hidden.
fn dir() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("fpfolder-").tempdir().unwrap()
}

struct FakeAsker {
    answer: Result<Answer, String>,
    asked: Mutex<Vec<PathAsk>>,
}

impl FakeAsker {
    fn answering(answer: Result<Answer, String>) -> FakeAsker {
        FakeAsker { answer, asked: Mutex::new(Vec::new()) }
    }

    fn asked(&self) -> Vec<PathAsk> {
        self.asked.lock().unwrap().clone()
    }
}

impl AskUser for FakeAsker {
    fn ask(&self, ask: PathAsk) -> impl std::future::Future<Output = Result<Answer, String>> + Send {
        self.asked.lock().unwrap().push(ask);
        std::future::ready(self.answer.clone())
    }
}

/// A sandbox whose folder and portal mount are both under one temp dir.
fn sandbox(root: &Path) -> Sandbox {
    let folder = root.join("Documents").join(FOLDER_NAME);
    let mount = root.join("doc");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::create_dir_all(&mount).unwrap();
    Sandbox { folder, mounts: vec![mount] }
}

fn save(path: PathBuf) -> PathAsk {
    PathAsk::new(AskKind::Save, "doc_save", path, &["funda"])
}

#[test]
fn documents_dir_reads_the_xdg_line_and_expands_home() {
    let home = Path::new("/home/me");
    let text =
        "# written by xdg-user-dirs-update\nXDG_DESKTOP_DIR=\"$HOME/Desktop\"\nXDG_DOCUMENTS_DIR=\"$HOME/Dokumente\"\n";
    assert_eq!(documents_dir(text, home), Some(home.join("Dokumente")));
    assert_eq!(documents_dir("XDG_DOCUMENTS_DIR=\"/data/docs\"", home), Some(PathBuf::from("/data/docs")));
    assert_eq!(documents_dir("XDG_DOCUMENTS_DIR=\"$HOME/My \\$ Docs\"", home), Some(home.join("My $ Docs")));
}

#[test]
fn documents_dir_is_none_when_unset_relative_or_home_itself() {
    let home = Path::new("/home/me");
    assert_eq!(documents_dir("XDG_DESKTOP_DIR=\"$HOME/Desktop\"", home), None);
    assert_eq!(documents_dir("XDG_DOCUMENTS_DIR=\"$HOME/\"", home), None);
    assert_eq!(documents_dir("XDG_DOCUMENTS_DIR=\"$HOME\"", home), None);
    assert_eq!(documents_dir("XDG_DOCUMENTS_DIR=\"/home/me\"", home), None);
    assert_eq!(documents_dir("XDG_DOCUMENTS_DIR=\"Documents\"", home), None);
    assert_eq!(documents_dir("XDG_DOCUMENTS_DIR=\"$HOMEWORK\"", home), None);
    assert_eq!(documents_dir("# XDG_DOCUMENTS_DIR=\"$HOME/Old\"", home), None);
}

#[test]
fn documents_folder_falls_back_to_documents_under_home() {
    let home = Path::new("/home/me");
    assert_eq!(documents_folder(home, None), home.join("Documents").join("FundaCAD"));
    assert_eq!(documents_folder(home, Some("")), home.join("Documents").join("FundaCAD"));
    assert_eq!(documents_folder(home, Some("XDG_DOCUMENTS_DIR=\"$HOME/Docs\"")), home.join("Docs").join("FundaCAD"));
}

#[test]
fn choose_folder_takes_the_one_folder_the_sandbox_shows_only_when_the_primary_is_missing() {
    let primary = PathBuf::from("/home/me/Documents/FundaCAD");
    let other = PathBuf::from("/home/me/Dokumente/FundaCAD");
    let third = PathBuf::from("/home/me/Work/FundaCAD");
    assert_eq!(choose_folder(primary.clone(), &[]), primary);
    assert_eq!(choose_folder(primary.clone(), &[primary.clone()]), primary);
    assert_eq!(choose_folder(primary.clone(), &[other.clone()]), other);
    assert_eq!(choose_folder(primary.clone(), &[other.clone(), primary.clone()]), primary);
    assert_eq!(choose_folder(primary.clone(), &[other, third]), primary);
}

#[test]
fn inside_holds_the_folder_and_the_portal_mount_only() {
    let root = dir();
    let sb = sandbox(root.path());
    assert!(sb.inside(&sb.folder.join("bracket.funda")));
    assert!(sb.inside(&sb.folder.join("parts").join("new.step")));
    assert!(sb.inside(&sb.folder));
    assert!(sb.inside(&sb.mounts[0].join("ab12").join("picked.funda")));
    assert!(!sb.inside(&root.path().join("Documents").join("bracket.funda")));
    assert!(!sb.inside(&root.path().join("Documents").join("FundaCAD2").join("a.funda")));
    assert!(!sb.inside(&root.path().join("elsewhere.funda")));
}

#[cfg(unix)]
#[test]
fn a_link_in_the_folder_that_leads_out_is_outside() {
    let root = dir();
    let sb = sandbox(root.path());
    let away = root.path().join("away");
    std::fs::create_dir_all(&away).unwrap();
    std::os::unix::fs::symlink(&away, sb.folder.join("out")).unwrap();
    std::os::unix::fs::symlink(root.path().join("gone"), sb.folder.join("dangling")).unwrap();
    assert!(!sb.inside(&sb.folder.join("out").join("a.funda")));
    assert!(!sb.inside(&sb.folder.join("dangling")));
}

#[test]
fn decide_goes_inside_asks_with_a_window_and_refuses_without_one() {
    assert_eq!(decide(true, true, true), Decision::Go);
    assert_eq!(decide(true, true, false), Decision::Go);
    assert_eq!(decide(true, false, true), Decision::Ask);
    assert_eq!(decide(true, false, false), Decision::Refuse);
}

#[test]
fn decide_changes_nothing_outside_the_flatpak() {
    for inside in [true, false] {
        for window in [true, false] {
            assert_eq!(decide(false, inside, window), Decision::Go);
        }
    }
}

#[tokio::test]
async fn a_path_inside_the_folder_is_used_without_asking() {
    let root = dir();
    let sb = sandbox(root.path());
    let asker = FakeAsker::answering(Ok(Answer::Declined));
    let path = sb.folder.join("bracket.funda");
    assert_eq!(reach(save(path.clone()), Some(&sb), true, &asker).await, Ok(path.clone()));
    assert_eq!(reach(save(path.clone()), Some(&sb), false, &asker).await, Ok(path));
    assert!(asker.asked().is_empty());
}

#[tokio::test]
async fn a_path_outside_with_a_window_asks_and_uses_the_pick() {
    let root = dir();
    let sb = sandbox(root.path());
    let picked = sb.mounts[0].join("ab12").join("bracket.funda");
    let asker = FakeAsker::answering(Ok(Answer::Picked(picked.clone())));
    let asked = root.path().join("bracket.funda");
    let ask = PathAsk::new(AskKind::Open, "doc_import", asked.clone(), &["step", "stp"]);
    assert_eq!(reach(ask, Some(&sb), true, &asker).await, Ok(picked));
    let sent = asker.asked();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].kind, AskKind::Open);
    assert_eq!(sent[0].tool, "doc_import");
    assert_eq!(sent[0].path, asked);
    assert_eq!(sent[0].exts, vec!["step".to_owned(), "stp".to_owned()]);
}

#[tokio::test]
async fn a_cancel_in_the_window_says_the_user_declined() {
    let root = dir();
    let sb = sandbox(root.path());
    let asker = FakeAsker::answering(Ok(Answer::Declined));
    let asked = root.path().join("bracket.funda");
    let err = reach(save(asked.clone()), Some(&sb), true, &asker).await.unwrap_err();
    assert!(err.contains("declined"), "{err}");
    assert!(err.contains("nothing was written"), "{err}");
    assert!(err.contains(&asked.display().to_string()), "{err}");
    let open = PathAsk::new(AskKind::Open, "doc_open", asked, &["funda"]);
    let err = reach(open, Some(&sb), true, &asker).await.unwrap_err();
    assert!(err.contains("nothing was opened"), "{err}");
}

#[tokio::test]
async fn a_path_outside_without_a_window_is_refused_with_the_folder_named() {
    let root = dir();
    let sb = sandbox(root.path());
    let asker = FakeAsker::answering(Ok(Answer::Picked(root.path().join("x.funda"))));
    let err = reach(save(root.path().join("bracket.funda")), Some(&sb), false, &asker).await.unwrap_err();
    assert!(err.contains("Flatpak"), "{err}");
    assert!(err.contains(&sb.folder.display().to_string()), "{err}");
    assert!(asker.asked().is_empty());
}

#[tokio::test]
async fn a_window_that_stops_hosting_before_it_answers_gives_the_folder_refusal() {
    let root = dir();
    let sb = sandbox(root.path());
    let asker = FakeAsker::answering(Ok(Answer::NoWindow));
    let err = reach(save(root.path().join("bracket.funda")), Some(&sb), true, &asker).await.unwrap_err();
    assert!(err.contains(&sb.folder.display().to_string()), "{err}");
}

#[tokio::test]
async fn an_asker_error_reaches_the_tool_as_it_is() {
    let root = dir();
    let sb = sandbox(root.path());
    let asker = FakeAsker::answering(Err("engine lost".into()));
    let err = reach(save(root.path().join("bracket.funda")), Some(&sb), true, &asker).await.unwrap_err();
    assert_eq!(err, "engine lost");
}

#[tokio::test]
async fn outside_the_flatpak_every_path_is_used_as_given() {
    let root = dir();
    let asker = FakeAsker::answering(Ok(Answer::Declined));
    let path = root.path().join("anywhere.funda");
    for window in [true, false] {
        assert_eq!(reach(save(path.clone()), None, window, &asker).await, Ok(path.clone()));
    }
    assert!(asker.asked().is_empty());
}
