//! A document open on the engine worker through fundacad-client, or a plain STL.

use std::path::{Path, PathBuf};
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
    pub client: Arc<Client>,
    pub events: Receiver<Event>,
    pub doc: Doc,
    pub path: PathBuf,
    blob_dir: PathBuf,
}

/// What work beside the view needs of the open document: its engine link, its file and where its blobs unpack.
#[derive(Clone)]
pub struct Link {
    pub client: Arc<Client>,
    pub path: PathBuf,
    pub blob_dir: PathBuf,
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.blob_dir);
    }
}

impl Session {
    pub fn link(&self) -> Link {
        Link { client: self.client.clone(), path: self.path.clone(), blob_dir: self.blob_dir.clone() }
    }

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
    let command = WorkerCommand::locate().map_err(|e| format!("no engine: {e}, set FUNDACAD_ENGINE_EXE"))?;
    let blob_dir = std::env::temp_dir().join("fundacad-app-blobs").join(std::process::id().to_string());
    let options = Options { blob_dir: Some(blob_dir.clone()), notify: Some(Arc::new(wake)), ..Default::default() };
    let text = fundacad_format::read_document(path, &blob_dir)?;
    let doc = match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(doc)) => doc,
        _ => return Err(format!("{} is not a document", path.display())),
    };
    let (client, events) = Client::spawn(command, options).map_err(|e| format!("the engine did not start: {e}"))?;
    client.load(doc.clone())?;
    Ok(Opened::Doc(Session { client: Arc::new(client), events, doc, blob_dir, path: path.to_path_buf() }))
}
