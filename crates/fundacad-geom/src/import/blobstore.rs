//! The durable geometry blob store, replaces `sidecar/blobstore.py`: one
//! `<blake2b-128 hex>.bbrep` file per content hash, published by rename.

use blake2::digest::{Update, VariableOutput};
use blake2::Blake2bVar;
use std::io::Write;
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
