//! A document open on the engine worker through fundacad-client, or a plain STL.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Arc;

use fundacad_client::{Client, Doc, Event, Options, WorkerCommand};
use serde_json::Value;

use crate::viewport::mesh;
use crate::viewport::scene::Body;

pub enum Opened {
    Stl(Body),
    Doc(Session),
}

/// The app's copy of the document beside the worker's. Every edit runs on both, so the two stay equal.
pub struct Session {
    pub client: Client,
    pub events: Receiver<Event>,
    pub doc: Doc,
    pub blob_dir: PathBuf,
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.blob_dir);
    }
}

impl Session {
    /// The revision the edit made, None when it left the document as it was.
    pub fn edit(
        &mut self,
        f: impl Fn(&mut Doc) -> Result<(), String> + Send + Sync + 'static,
    ) -> Result<Option<u64>, String> {
        let f = Arc::new(f);
        let before = self.doc.clone();
        f(&mut self.doc)?;
        let edited = self.client.edit(move |d| f(d));
        if edited.is_err() {
            self.doc = before;
        }
        edited
    }
}

/// `wake` runs on the engine thread after every event.
pub fn open(path: &Path, wake: impl Fn() + Send + Sync + 'static) -> Result<Opened, String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext == "stl" {
        let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        return mesh::load_stl(&bytes).map(Opened::Stl);
    }
    let blob_dir = session_blob_dir();
    let read =
        fundacad_format::read_document(path, &blob_dir).and_then(|text| match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(doc)) => Ok(doc),
            _ => Err(format!("{} is not a document", path.display())),
        });
    match read.and_then(|doc| start_in(doc, blob_dir.clone(), wake)) {
        Ok(session) => Ok(Opened::Doc(session)),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&blob_dir);
            Err(e)
        }
    }
}

/// A document that is in no file yet, such as a new one.
pub fn start(doc: Doc, wake: impl Fn() + Send + Sync + 'static) -> Result<Session, String> {
    start_in(doc, session_blob_dir(), wake)
}

/// Each session has its own folder: the one it replaces removes its folder as it drops.
fn session_blob_dir() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join("fundacad-app-blobs").join(format!("{}-{n}", std::process::id()))
}

fn start_in(doc: Doc, blob_dir: PathBuf, wake: impl Fn() + Send + Sync + 'static) -> Result<Session, String> {
    let command = WorkerCommand::locate().map_err(|e| format!("no engine: {e}, set FUNDACAD_ENGINE_EXE"))?;
    let options = Options { blob_dir: Some(blob_dir.clone()), notify: Some(Arc::new(wake)), ..Default::default() };
    let (client, events) = Client::spawn(command, options).map_err(|e| format!("the engine did not start: {e}"))?;
    client.load(doc.clone())?;
    Ok(Session { client, events, doc, blob_dir })
}
