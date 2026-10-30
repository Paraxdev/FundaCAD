//! Exports are written into the engine's own folder first, then the shell copies them where the user saves, so the
//! engine never needs to write the user's folders. The shell stages the request and finishes the reply with this code.

use fundacad_protocol::envelope;
use fundacad_protocol::pyjson::{self, truthy};
use serde_json::{Map, Value};
use std::fs::File;
use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use std::sync::atomic::{AtomicU64, Ordering};

/// An export request pointed into a stage folder, and what it takes to bring its reply back to the user's path.
#[derive(Debug)]
pub struct Staged {
    /// The request to send in place of the original.
    pub request: String,
    target: String,
    /// The user's path up to and with its last separator.
    parent: String,
    /// The stage folder with a trailing separator, as it is spelled in the request.
    prefix: String,
    file: String,
    separate: bool,
}

/// What the shell copies once the engine finished.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Delivery {
    File {
        from: PathBuf,
        to: PathBuf,
    },
    /// `folder` must not exist yet: create it, then copy each file into it.
    Folder {
        folder: PathBuf,
        files: Vec<(PathBuf, PathBuf)>,
    },
}

/// Points the path of an `export` or `exportWith` request into `dir` with the same file name, which the STEP writer
/// names the model after. Any other request, or one the worker would refuse anyway, gives `None` and goes out as it is.
pub fn stage(text: &str, dir: &Path) -> Result<Option<Staged>, String> {
    if !text.contains("\"path\"") && !text.contains(r"\u") {
        return Ok(None);
    }
    // Read like the worker reads it: a repeated key counts once, the last one.
    let Ok(mut req) = serde_json::from_str::<Map<String, Value>>(text) else { return Ok(None) };
    let op = req.get("op").and_then(Value::as_str).unwrap_or("");
    if op != "export" && op != "exportWith" {
        return Ok(None);
    }
    let separate = op == "export" && truthy(req.get("separate"));
    let Some(Value::String(target)) = req.get("path") else { return Ok(None) };
    let cut = target.rfind(['/', '\\']).map_or(0, |i| i + 1);
    let (parent, file) = target.split_at(cut);
    if file.is_empty() || file == "." || file == ".." {
        return Err(format!("the export path {target} names no file"));
    }
    let (target, parent, file) = (target.clone(), parent.to_string(), file.to_string());
    let staged = dir.join(&file);
    // On Windows a name like `C:part.step` would replace the folder instead of joining it.
    if staged.parent() != Some(dir) {
        return Err(format!("the export path {target} names no file"));
    }
    let staged = staged.to_str().ok_or("the engine's export folder has a name that is not text")?.to_string();
    let prefix = staged[..staged.len() - file.len()].to_string();
    req.insert("path".into(), Value::String(staged));
    let request = serde_json::to_string(&req).map_err(|e| e.to_string())?;
    Ok(Some(Staged { request, target, parent, prefix, file, separate }))
}

impl Staged {
    /// The path the user asked for.
    pub fn target(&self) -> &str {
        &self.target
    }

    /// Rewrites the engine's final reply so it names the user's files, and says what to copy there. `None` when the
    /// reply wrote nothing. A reply naming a file outside what this request may write is refused.
    pub fn settle(&self, reply: &mut Map<String, Value>) -> Result<Option<Delivery>, String> {
        if let Some(Value::Object(e)) = reply.get_mut("error") {
            if let Some(Value::String(m)) = e.get_mut("message") {
                *m = m.replace(&self.prefix, &self.parent);
            }
        }
        let Some(path) = reply.get("path").cloned() else { return Ok(None) };
        let path = path.as_str().map(str::to_string).ok_or_else(|| outside(&path))?;
        if !self.separate {
            if reply.contains_key("paths") || path != format!("{}{}", self.prefix, self.file) {
                return Err(outside(&path));
            }
            reply.insert("path".into(), Value::String(self.target.clone()));
            return Ok(Some(Delivery::File { from: PathBuf::from(path), to: PathBuf::from(&self.target) }));
        }
        let stem = stem(&self.file);
        let (staged, real) = (format!("{}{stem}", self.prefix), format!("{}{stem}", self.parent));
        let Some(Value::Array(list)) = reply.get("paths").filter(|_| path == staged) else {
            return Err(outside(&path));
        };
        let mut files = Vec::with_capacity(list.len());
        let mut named = Vec::with_capacity(list.len());
        for p in list {
            let name = p.as_str().and_then(|p| p.strip_prefix(&staged)).and_then(|p| p.strip_prefix(MAIN_SEPARATOR));
            let Some(name) = name.filter(|n| plain_name(n)) else { return Err(outside(p)) };
            let to = format!("{real}{MAIN_SEPARATOR}{name}");
            files.push((PathBuf::from(format!("{staged}{MAIN_SEPARATOR}{name}")), PathBuf::from(&to)));
            named.push(Value::String(to));
        }
        reply.insert("path".into(), Value::String(real.clone()));
        reply.insert("paths".into(), Value::Array(named));
        Ok(Some(Delivery::Folder { folder: PathBuf::from(real), files }))
    }

    /// The engine's final reply for this export, rewritten to name the user's files once they are copied there. A
    /// copy that fails turns it into an error reply.
    pub fn finish(&self, reply: &str) -> String {
        let Ok(mut msg) = serde_json::from_str::<Map<String, Value>>(reply) else { return reply.to_string() };
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let settled = if msg.get("ok") == Some(&Value::Bool(true)) {
            match msg.get_mut("result") {
                Some(Value::Object(result)) => self.settle(result),
                _ => Ok(None),
            }
        } else {
            self.settle(&mut msg)
        };
        match settled.and_then(|d| d.map_or(Ok(()), |d| d.deliver())) {
            Ok(()) => pyjson::to_string(&Value::Object(msg)),
            Err(e) => envelope::err(&id, &e, None),
        }
    }
}

impl Delivery {
    /// Copies the staged files to the user's paths.
    pub fn deliver(&self) -> Result<(), String> {
        match self {
            Delivery::File { from, to } => copy_into(from, to),
            Delivery::Folder { folder, files } => {
                if let Err(e) = std::fs::create_dir(folder) {
                    let shown = folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    return Err(if e.kind() == std::io::ErrorKind::AlreadyExists {
                        format!(
                            "{shown} already exists, the separate-bodies export writes a folder of that name. \
                             Choose another name, or move the existing folder."
                        )
                    } else {
                        format!("could not create {}: {e}", folder.display())
                    });
                }
                files.iter().try_for_each(|(from, to)| copy_into(from, to))
            }
        }
    }
}

/// Writes a part file next to `to` and renames it over, so a failed copy leaves the user's old file as it was.
fn copy_into(from: &Path, to: &Path) -> Result<(), String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let failed = |e: &dyn std::fmt::Display| format!("could not write {}: {e}", to.display());
    let mut source = open_no_link(from).map_err(|e| failed(&e))?;
    if !source.metadata().map_err(|e| failed(&e))?.is_file() {
        return Err(outside(&from.display()));
    }
    let name = to.file_name().ok_or_else(|| failed(&"the path names no file"))?.to_string_lossy();
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let part = to.with_file_name(format!(".{name}.{}.{n}.part", std::process::id()));
    let copied = File::create(&part)
        .and_then(|mut out| std::io::copy(&mut source, &mut out))
        .and_then(|_| std::fs::rename(&part, to));
    if copied.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    copied.map_err(|e| failed(&e))
}

/// A link the engine planted in its folder opens as itself, never as the file it points to, so the shell cannot be
/// made to copy another file out.
fn open_no_link(path: &Path) -> std::io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    // FILE_FLAG_OPEN_REPARSE_POINT
    #[cfg(windows)]
    std::os::windows::fs::OpenOptionsExt::custom_flags(&mut options, 0x0020_0000);
    options.open(path)
}

fn outside(path: &dyn std::fmt::Display) -> String {
    format!("the engine answered with a file outside its export folder: {path}")
}

/// The file name without its extension, split the way the export names its folder (leading dots belong to the name).
fn stem(file: &str) -> &str {
    let lead = file.len() - file.trim_start_matches('.').len();
    file[lead..].rfind('.').map_or(file, |dot| &file[..lead + dot])
}

fn plain_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\'])
}
