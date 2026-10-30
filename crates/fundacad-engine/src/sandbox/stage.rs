//! Exports are written into the engine's own folder first, then the shell copies them where the user saves, so the
//! engine never needs to write the user's folders. Only the pure part lives here: the shell does the copying.

use fundacad_protocol::pyjson::truthy;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf, MAIN_SEPARATOR};

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
