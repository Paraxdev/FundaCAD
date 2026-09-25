//! The durable geometry blob store, replaces the Python engine's `blobstore.py`: one
//! `<blake2b-128 hex>.bbrep` file per content hash, published by rename.

use blake2::digest::{Update, VariableOutput};
use blake2::Blake2bVar;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

pub fn hash_bytes(data: &[u8]) -> String {
    let mut h = Blake2bVar::new(16).expect("16 is a valid blake2b digest size");
    h.update(data);
    let mut out = [0u8; 16];
    h.finalize_variable(&mut out).expect("the digest buffer is 16 bytes");
    out.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_hash(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `FUNDACAD_BLOB_DIR` when set and not empty, else
/// `$XDG_DATA_HOME/fundacad/blobs` or `~/.local/share/fundacad/blobs`.
pub fn default_root() -> PathBuf {
    if let Some(dir) = std::env::var_os("FUNDACAD_BLOB_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("XDG_DATA_HOME")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .unwrap_or_default();
            PathBuf::from(home).join(".local").join("share")
        });
    base.join("fundacad").join("blobs")
}

pub struct BlobStore {
    pub root: PathBuf,
}

impl BlobStore {
    pub fn open(root: impl Into<PathBuf>) -> std::io::Result<BlobStore> {
        let root = root.into();
        std::fs::create_dir_all(&root)?;
        Ok(BlobStore { root })
    }

    pub fn path_for(&self, digest: &str) -> Option<PathBuf> {
        is_hash(digest).then(|| self.root.join(format!("{digest}.bbrep")))
    }

    /// Stores `data` and returns the hash of exactly these bytes.
    pub fn put_bytes(&self, data: &[u8]) -> std::io::Result<String> {
        let digest = hash_bytes(data);
        let dest = self.root.join(format!("{digest}.bbrep"));
        if dest.exists() {
            return Ok(digest);
        }
        atomic_write(&self.root, &dest, data)?;
        Ok(digest)
    }

    /// The stored bytes, None when absent or when they no longer hash to their
    /// name, in which case the corrupt file is removed.
    pub fn get_bytes(&self, digest: &str) -> Option<Vec<u8>> {
        let path = self.path_for(digest)?;
        let data = std::fs::read(&path).ok()?;
        if hash_bytes(&data) != digest {
            let _ = std::fs::remove_file(&path);
            return None;
        }
        Some(data)
    }
}

fn atomic_write(dir: &Path, dest: &Path, data: &[u8]) -> std::io::Result<()> {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let tmp = dir.join(format!("{:032x}{}.tmp", nonce, std::process::id()));
    let written = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, dest)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// The most a `blobRead` reply or a `blobWrite` request carries, well under the
/// frame cap once base64 has grown it by a third.
pub const TRANSFER_CHUNK: u64 = 16 * 1024 * 1024;
const MAX_BLOB: u64 = 8 << 30;

fn hash_arg<'a>(req: &'a serde_json::Map<String, serde_json::Value>) -> Result<&'a str, String> {
    req.get("hash")
        .and_then(serde_json::Value::as_str)
        .filter(|h| is_hash(h))
        .ok_or_else(|| "a blob request needs `hash`, 32 lowercase hex digits".to_string())
}

fn u64_arg(req: &serde_json::Map<String, serde_json::Value>, key: &str) -> u64 {
    req.get(key).and_then(serde_json::Value::as_u64).unwrap_or(0)
}

/// The blob ops, so a client that cannot see this process's disk (an MCP server
/// with a different profile, a sandbox, another user) can still save and open
/// imported geometry. `blobHas` sorts hashes into have and missing, `blobRead`
/// hands back one range of a blob, and `blobWrite` takes a blob in order, range
/// by range, publishing it only once the whole of it hashes to its name.
pub fn blob_op(
    op: &str,
    req: &serde_json::Map<String, serde_json::Value>,
    store: &BlobStore,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    use base64::Engine as _;
    use serde_json::{json, Value};
    let b64 = &base64::engine::general_purpose::STANDARD;
    let mut out = serde_json::Map::new();
    match op {
        "blobHas" => {
            let (mut have, mut missing) = (Vec::new(), Vec::new());
            for h in req.get("hashes").and_then(Value::as_array).into_iter().flatten() {
                let Some(h) = h.as_str() else { continue };
                match store.path_for(h) {
                    Some(p) if p.is_file() => have.push(h.to_string()),
                    _ => missing.push(h.to_string()),
                }
            }
            out.insert("have".into(), json!(have));
            out.insert("missing".into(), json!(missing));
        }
        "blobRead" => {
            let h = hash_arg(req)?;
            let offset = u64_arg(req, "offset");
            // Not verified here: the reader hashes the whole blob once it has it.
            let file = store.path_for(h).and_then(|p| std::fs::File::open(p).ok());
            let Some(mut file) = file else {
                out.insert("missing".into(), json!(true));
                return Ok(out);
            };
            let io = |e: std::io::Error| format!("cannot read blob {h}: {e}");
            let size = file.metadata().map_err(io)?.len();
            let start = offset.min(size);
            let len = TRANSFER_CHUNK.min(size - start) as usize;
            let mut buf = vec![0u8; len];
            file.seek(std::io::SeekFrom::Start(start)).map_err(io)?;
            file.read_exact(&mut buf).map_err(io)?;
            out.insert("size".into(), json!(size));
            out.insert("offset".into(), json!(start));
            out.insert("data".into(), json!(b64.encode(&buf)));
        }
        "blobWrite" => {
            let h = hash_arg(req)?;
            let offset = u64_arg(req, "offset");
            let total = u64_arg(req, "total");
            if total > MAX_BLOB {
                return Err("a blob over 8 GiB was refused".into());
            }
            let data = req
                .get("data")
                .and_then(Value::as_str)
                .and_then(|d| b64.decode(d).ok())
                .ok_or("blobWrite needs `data`, base64")?;
            let dest = store.root.join(format!("{h}.bbrep"));
            if dest.exists() {
                out.insert("stored".into(), json!(true));
                return Ok(out);
            }
            let part = store.root.join(format!("{h}.bbrep.part"));
            let io = |e: std::io::Error| format!("cannot write {}: {e}", part.display());
            let mut f = if offset == 0 {
                std::fs::File::create(&part).map_err(io)?
            } else {
                let f = std::fs::OpenOptions::new().append(true).open(&part).map_err(io)?;
                if f.metadata().map_err(io)?.len() != offset {
                    return Err(format!("blobWrite for {h} arrived out of order, start again at 0"));
                }
                f
            };
            f.write_all(&data).map_err(io)?;
            drop(f);
            let received = offset + data.len() as u64;
            if received < total {
                out.insert("stored".into(), json!(false));
                out.insert("received".into(), json!(received));
                return Ok(out);
            }
            let whole = std::fs::read(&part).map_err(io)?;
            let _ = std::fs::remove_file(&part);
            if received != total || hash_bytes(&whole) != h {
                return Err(format!("the bytes sent for {h} do not hash to it, nothing was stored"));
            }
            store.put_bytes(&whole).map_err(|e| format!("cannot store {h}: {e}"))?;
            out.insert("stored".into(), json!(true));
        }
        other => return Err(format!("unknown blob op: {other}")),
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use serde_json::{json, Map, Value};

    fn req(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    fn scratch(tag: &str) -> BlobStore {
        let dir = std::env::temp_dir().join(format!("fundacad-blobop-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        BlobStore::open(dir).unwrap()
    }

    #[test]
    fn a_blob_written_in_ranges_reads_back_whole() {
        let from = scratch("from");
        let to = scratch("to");
        let data: Vec<u8> = (0..100_000u32).map(|i| (i * 7 % 251) as u8).collect();
        let h = from.put_bytes(&data).unwrap();
        let has = blob_op("blobHas", &req(json!({"hashes": [h, "0".repeat(32)]})), &to).unwrap();
        assert_eq!(has["missing"].as_array().unwrap().len(), 2);

        let b64 = base64::engine::general_purpose::STANDARD;
        for (i, piece) in data.chunks(30_000).enumerate() {
            let r = blob_op(
                "blobWrite",
                &req(json!({"hash": h, "offset": i * 30_000, "total": data.len(),
                            "data": b64.encode(piece)})),
                &to,
            )
            .unwrap();
            assert_eq!(r["stored"], json!(i == 3));
        }
        assert_eq!(to.get_bytes(&h).unwrap(), data);

        let r = blob_op("blobRead", &req(json!({"hash": h})), &to).unwrap();
        assert_eq!(r["size"], json!(data.len()));
        assert_eq!(b64.decode(r["data"].as_str().unwrap()).unwrap(), data);
    }

    #[test]
    fn bytes_that_do_not_match_their_hash_are_never_published() {
        let to = scratch("bad");
        let h = hash_bytes(b"the real bytes");
        let b64 = base64::engine::general_purpose::STANDARD;
        let r = blob_op(
            "blobWrite",
            &req(json!({"hash": h, "offset": 0, "total": 5, "data": b64.encode(b"forge")})),
            &to,
        );
        assert!(r.is_err());
        assert!(to.get_bytes(&h).is_none());
        let r = blob_op("blobRead", &req(json!({"hash": h})), &to).unwrap();
        assert_eq!(r["missing"], json!(true));
        assert!(blob_op("blobRead", &req(json!({"hash": "../../etc"})), &to).is_err());
    }
}
