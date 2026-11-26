//! The document's file: New, Open, Save and Save As, the unsaved changes guard, the window title and recent files.

pub mod recent;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use fundacad_client::Doc;
use gpui::*;
use serde_json::{json, Value};

use crate::overlay::{self, Choice, Toast};
use crate::viewport::Viewport;

const DOC_EXT: &str = "funda";
const UNTITLED: &str = "Untitled";
const NOT_SAVABLE: &str = "Only a FundaCAD document can be saved, an STL is only shown";

/// The empty document New makes and the app starts with.
pub fn new_document() -> Doc {
    let mut d = Doc::new();
    d.insert("version".into(), json!(fundacad_core::schema::DOCUMENT_VERSION));
    d.insert("parameters".into(), json!({}));
    d.insert("paramDefs".into(), json!({}));
    d.insert("features".into(), json!([]));
    d.insert("bodyIds".into(), json!({}));
    d
}

/// The name a document shows, its file's without the extension.
pub fn shown_name(path: Option<&Path>) -> SharedString {
    path.and_then(Path::file_stem).map_or(UNTITLED.into(), |s| s.to_string_lossy().to_string().into())
}

pub fn window_title(name: &str, dirty: bool) -> String {
    format!("{name}{}, FundaCAD 2", if dirty { "*" } else { "" })
}

/// Writes `doc` as the file at `path` names, a binary .fundab or a readable .funda, with the imported geometry it uses
/// that `blob_dir` holds.
pub fn write(path: &Path, doc: &Doc, blob_dir: Option<&Path>) -> Result<(), String> {
    let mut doc = doc.clone();
    doc.remove(fundacad_format::json_doc::EMBEDDED_GEOMETRY_KEY);
    let current = fundacad_core::schema::DOCUMENT_VERSION;
    if doc.get("version").and_then(Value::as_u64).is_some_and(|v| v > u64::from(current)) {
        doc.insert("version".into(), json!(current));
    }
    let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    let blobs = blob_dir.map(|dir| geometry_in(&doc, dir)).unwrap_or_default();
    fundacad_format::container::write_document(path, &text, &blobs, &BTreeMap::new(), &[], "FundaCAD 2")
}

/// Every geometry hash the document names that has a blob in `dir`.
fn geometry_in(doc: &Doc, dir: &Path) -> BTreeMap<String, PathBuf> {
    fn walk(v: &Value, dir: &Path, out: &mut BTreeMap<String, PathBuf>) {
        match v {
            Value::String(s) if is_hash(s) => {
                let blob = dir.join(format!("{s}.bbrep"));
                if blob.is_file() {
                    out.insert(s.clone(), blob);
                }
            }
            Value::Array(a) => a.iter().for_each(|v| walk(v, dir, out)),
            Value::Object(o) => o.values().for_each(|v| walk(v, dir, out)),
            _ => {}
        }
    }
    let mut out = BTreeMap::new();
    doc.values().for_each(|v| walk(v, dir, &mut out));
    out
}

fn is_hash(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A save goes to the file as it is only when it is a .funda: Save As writes a .fundab's sections this build cannot
/// carry over, so a .fundab or an STL is saved as a new .funda.
pub fn saves_in_place(path: Option<&Path>) -> bool {
    path.and_then(Path::extension).is_some_and(|e| e.eq_ignore_ascii_case(DOC_EXT))
}

/// `name` with the .funda extension, kept when it has it already.
pub fn with_doc_ext(path: PathBuf) -> PathBuf {
    if saves_in_place(Some(&path)) {
        path
    } else {
        let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
        name.push(format!(".{DOC_EXT}"));
        path.with_file_name(name)
    }
}

/// The path on the command line, opened when the window is up.
struct Startup(Option<PathBuf>);

impl Global for Startup {}

pub fn set_startup(cx: &mut App, path: Option<PathBuf>) {
    cx.set_global(Startup(path));
}

/// The window's Files, for rows built away from it, as the recent files menu.
struct Current(WeakEntity<Files>);

impl Global for Current {}

pub fn set_current(cx: &mut App, files: &Entity<Files>) {
    cx.set_global(Current(files.downgrade()));
}

pub fn current(cx: &App) -> Option<Entity<Files>> {
    cx.try_global::<Current>()?.0.upgrade()
}

pub fn open_recent_path(path: PathBuf, window: &mut Window, cx: &mut App) {
    if let Some(files) = current(cx) {
        open_recent(files, path, window, cx);
    }
}

/// Whether what is shown differs from what was last read or written. An STL is never dirty, it cannot be saved.
pub fn is_dirty(doc: Option<&Doc>, saved: Option<&Doc>) -> bool {
    match (doc, saved) {
        (Some(doc), Some(saved)) => doc != saved,
        (Some(_), None) => true,
        (None, _) => false,
    }
}

/// What the close question's answer asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Close {
    Save,
    Discard,
    Stay,
}

pub struct Files {
    viewport: Entity<Viewport>,
    path: Option<PathBuf>,
    /// The document as last read or written, None while what is shown is not a FundaCAD document.
    saved: Option<Doc>,
    dirty: bool,
    /// The window may close without asking, the person has answered already.
    closing: bool,
    title: String,
    /// The viewport's change count `dirty` was worked out at, None when it must be worked out again.
    checked: Option<u64>,
}

impl Files {
    pub fn new(viewport: Entity<Viewport>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe_in(&viewport, window, |this, _, window, cx| this.refresh(window, cx)).detach();
        Self { viewport, path: None, saved: None, dirty: false, closing: false, title: String::new(), checked: None }
    }

    pub fn name(&self) -> SharedString {
        shown_name(self.path.as_deref())
    }

    pub fn dirty(&self) -> bool {
        self.dirty
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    fn refresh(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let viewport = self.viewport.read(cx);
        let changes = viewport.changes();
        let dirty = if self.checked == Some(changes) {
            self.dirty
        } else {
            self.checked = Some(changes);
            is_dirty(viewport.doc(), self.saved.as_ref())
        };
        let title = window_title(&self.name(), dirty);
        if dirty != self.dirty || title != self.title {
            self.dirty = dirty;
            window.set_window_title(&title);
            self.title = title;
            cx.notify();
        }
    }

    /// The document shown now is the one on disk at `path`.
    fn mark_saved(&mut self, path: Option<PathBuf>, window: &mut Window, cx: &mut Context<Self>) {
        self.saved = self.viewport.read(cx).doc().cloned();
        self.path = path;
        self.checked = None;
        self.refresh(window, cx);
    }

    fn open_now(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) -> bool {
        match self.viewport.update(cx, |v, cx| v.open(path, cx)) {
            Ok(()) => {
                recent::note(cx, path);
                self.mark_saved(Some(path.to_path_buf()), window, cx);
                true
            }
            Err(e) => {
                let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into());
                overlay::toast(cx, Toast::error(format!("Could not open {name}: {e}")));
                false
            }
        }
    }

    fn new_now(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.new_with(new_document(), window, cx)
    }

    fn new_with(&mut self, doc: Doc, window: &mut Window, cx: &mut Context<Self>) -> bool {
        match self.viewport.update(cx, |v, cx| v.open_doc(doc, cx)) {
            Ok(()) => {
                self.mark_saved(None, window, cx);
                true
            }
            Err(e) => {
                overlay::toast(cx, Toast::error(format!("Could not start a new document: {e}")));
                false
            }
        }
    }

    fn write_now(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let viewport = self.viewport.read(cx);
        let Some(doc) = viewport.doc() else {
            overlay::toast(cx, Toast::warning(NOT_SAVABLE));
            return false;
        };
        match write(&path, doc, viewport.blob_dir()) {
            Ok(()) => {
                recent::note(cx, &path);
                self.mark_saved(Some(path), window, cx);
                true
            }
            Err(e) => {
                overlay::toast(cx, Toast::error(format!("Could not save: {e}")));
                false
            }
        }
    }
}

/// Opens the command line's file, or an empty untitled document.
pub fn start(files: &Entity<Files>, window: &mut Window, cx: &mut App) {
    let path = cx.try_global::<Startup>().and_then(|s| s.0.clone());
    files.update(cx, |f, cx| {
        let opened = path.is_some_and(|p| f.open_now(&p, window, cx));
        if !opened {
            f.new_now(window, cx);
        }
    });
}

/// Any New or Open the person asked for closes Home, once it went through, as in FC1.
fn opened(done: bool, cx: &mut App) {
    if done {
        crate::home::set(cx, false);
    }
}

async fn may_discard(files: &Entity<Files>, question: String, cx: &mut AsyncWindowContext) -> bool {
    let dirty = cx.update(|_, cx| files.read(cx).dirty).unwrap_or(false);
    ask_discard(dirty, question, cx).await
}

/// Asks before unsaved changes are lost. True when the work may go.
pub(crate) async fn ask_discard(dirty: bool, question: String, cx: &mut AsyncWindowContext) -> bool {
    if !dirty {
        return true;
    }
    let choices = vec![Choice::danger("Discard").hint("lose the unsaved changes"), Choice::plain("Cancel")];
    let Ok(answer) = cx.update(|window, cx| overlay::confirm(window, cx, question, choices)) else { return false };
    answer.recv().await.ok().flatten() == Some(0)
}

pub fn new(files: Entity<Files>, window: &mut Window, cx: &mut App) {
    window
        .spawn(cx, async move |cx| {
            if may_discard(&files, "Discard unsaved changes and start a new document?".into(), cx).await {
                let _ = cx.update(|window, cx| opened(files.update(cx, |f, cx| f.new_now(window, cx)), cx));
            }
        })
        .detach();
}

/// New, starting from `doc` instead of an empty document, as Home's examples do.
pub fn new_from(files: Entity<Files>, doc: Doc, window: &mut Window, cx: &mut App) {
    window
        .spawn(cx, async move |cx| {
            if may_discard(&files, "Discard unsaved changes and start a new document?".into(), cx).await {
                let _ = cx.update(|window, cx| opened(files.update(cx, |f, cx| f.new_with(doc, window, cx)), cx));
            }
        })
        .detach();
}

pub fn open(files: Entity<Files>, window: &mut Window, cx: &mut App) {
    let dir = files.read(cx).path.as_deref().and_then(Path::parent).map(Path::to_path_buf);
    window
        .spawn(cx, async move |cx| {
            if !may_discard(&files, "Discard unsaved changes and open another document?".into(), cx).await {
                return;
            }
            let mut dialog = rfd::AsyncFileDialog::new()
                .set_title("Open")
                .add_filter("FundaCAD document", &["funda", "fundab"])
                .add_filter("STL mesh", &["stl"]);
            if let Some(dir) = dir {
                dialog = dialog.set_directory(dir);
            }
            let Some(picked) = dialog.pick_file().await else { return };
            let path = picked.path().to_path_buf();
            let _ = cx.update(|window, cx| opened(files.update(cx, |f, cx| f.open_now(&path, window, cx)), cx));
        })
        .detach();
}

/// Opens a recent file. One that is gone stays in the list until the person removes it, it may be on a drive that is
/// not plugged in.
pub fn open_recent(files: Entity<Files>, path: PathBuf, window: &mut Window, cx: &mut App) {
    if !path.exists() {
        let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into());
        let gone = path.clone();
        let toast = Toast::warning(format!("{name} is not there any more"))
            .with_action("Remove", move |_, cx| recent::forget(cx, &gone));
        overlay::toast(cx, toast);
        return;
    }
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    window
        .spawn(cx, async move |cx| {
            if may_discard(&files, format!("Discard unsaved changes and open {name}?"), cx).await {
                let _ = cx.update(|window, cx| opened(files.update(cx, |f, cx| f.open_now(&path, window, cx)), cx));
            }
        })
        .detach();
}

/// Saves, through Save As when the document has no .funda of its own yet. True once it is written.
async fn save_async(files: &Entity<Files>, force_ask: bool, cx: &mut AsyncWindowContext) -> bool {
    let Ok((path, name, savable)) = cx.update(|_, cx| {
        let f = files.read(cx);
        (f.path.clone(), f.name(), f.viewport.read(cx).doc().is_some())
    }) else {
        return false;
    };
    if !savable {
        let _ = cx.update(|_, cx| overlay::toast(cx, Toast::warning(NOT_SAVABLE)));
        return false;
    }
    let target = match path.filter(|p| !force_ask && saves_in_place(Some(p))) {
        Some(p) => p,
        None => {
            let mut dialog = rfd::AsyncFileDialog::new()
                .set_title("Save As")
                .add_filter("FundaCAD document", &[DOC_EXT])
                .set_file_name(format!("{name}.{DOC_EXT}"));
            if let Some(dir) = cx
                .update(|_, cx| files.read(cx).path.as_deref().and_then(Path::parent).map(Path::to_path_buf))
                .ok()
                .flatten()
            {
                dialog = dialog.set_directory(dir);
            }
            let Some(picked) = dialog.save_file().await else { return false };
            with_doc_ext(picked.path().to_path_buf())
        }
    };
    cx.update(|window, cx| files.update(cx, |f, cx| f.write_now(target, window, cx))).unwrap_or(false)
}

pub fn save(files: Entity<Files>, as_new: bool, window: &mut Window, cx: &mut App) {
    window
        .spawn(cx, async move |cx| {
            save_async(&files, as_new, cx).await;
        })
        .detach();
}

pub(crate) async fn ask_close(question: String, cx: &mut AsyncWindowContext) -> Close {
    let choices = vec![
        Choice::primary("Save"),
        Choice::danger("Don't save").hint("close and lose the changes"),
        Choice::plain("Cancel"),
    ];
    let Ok(answer) = cx.update(|window, cx| overlay::confirm(window, cx, question, choices)) else { return Close::Stay };
    match answer.recv().await.ok().flatten() {
        Some(0) => Close::Save,
        Some(1) => Close::Discard,
        _ => Close::Stay,
    }
}

/// Asks to save before the window closes with unsaved changes. Returns whether it may close now.
pub fn should_close(files: &Entity<Files>, window: &mut Window, cx: &mut App) -> bool {
    let f = files.read(cx);
    if f.closing || !f.dirty {
        return true;
    }
    let question = format!("Save changes to {} before closing?", f.name());
    let files = files.clone();
    window
        .spawn(cx, async move |cx| {
            let go = match ask_close(question, cx).await {
                Close::Save => save_async(&files, false, cx).await,
                Close::Discard => true,
                Close::Stay => false,
            };
            if go {
                let _ = cx.update(|window, cx| {
                    files.update(cx, |f, _| f.closing = true);
                    window.remove_window();
                });
            }
        })
        .detach();
    false
}
