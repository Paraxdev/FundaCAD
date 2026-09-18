//! The durable checkpoint store, the Python engine's `geomstore.py`: one binary BREP blob
//! per body state, mesh artifacts, and a checkpoint record per chain key.
//!
//! Where geomstore keeps its checkpoint rows in SQLite, a record here is the
//! file `checkpoints/<chain key>.json`. Every lookup geomstore makes is by
//! chain key, which a filename answers in one stat, the rename that
//! publishes a blob publishes a record atomically too, and a record's mtime is
//! its last access. That leaves nothing an index would add but a second copy
//! of the truth to fall out of step, and a WAL beside the cache.
//!
//! Everything is soft state: a missing, short or unreadable file is a miss,
//! never an error and never wrong geometry.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use opencascade::primitives::Shape;
use opencascade::xcaf;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CACHE_MIN: u64 = 512 << 20;
pub const CACHE_MAX: u64 = 8 << 30;
const BBREP: &str = ".bbrep";

/// A body of a checkpoint, `{body_id, name, blob_key, ...}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub body_id: String,
    pub name: String,
    pub blob_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_ref: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub intact: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub face_colors: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part_color: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mesh_passes: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub feat_index: usize,
    pub manifest: Vec<ManifestEntry>,
    /// Datums, errors, diagnostics, body id events, owners, fingerprints.
    pub state: Value,
    /// Wall time it took to replay from the previous checkpoint.
    pub replay_ms: f64,
    /// Sum of the referenced blob sizes when written.
    pub bytes: u64,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Stats {
    pub checkpoints: usize,
    pub blobs: usize,
    pub bytes: u64,
}

pub fn default_root() -> PathBuf {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .unwrap_or_default();
            PathBuf::from(home).join(".cache")
        });
    // Apart from the Python engine's `geom`: its SQLite eviction reclaims every blob
    // no row of its own references, which would be all of these.
    base.join("fundacad").join("engine-geom")
}

fn is_key(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

pub struct GeomStore {
    pub root: PathBuf,
    blobs: PathBuf,
    meshes: PathBuf,
    checkpoints: PathBuf,
    tmp: PathBuf,
}

impl GeomStore {
    pub fn open(root: impl Into<PathBuf>) -> std::io::Result<GeomStore> {
        let root = root.into();
        let store = GeomStore {
            blobs: root.join("blobs"),
            meshes: root.join("meshes"),
            checkpoints: root.join("checkpoints"),
            tmp: root.join("tmp"),
            root,
        };
        for d in [&store.blobs, &store.meshes, &store.checkpoints, &store.tmp] {
            fs::create_dir_all(d)?;
        }
        // Writes only ever publish by rename, so nothing references a temp file.
        for e in fs::read_dir(&store.tmp).into_iter().flatten().flatten() {
            let _ = fs::remove_file(e.path());
        }
        Ok(store)
    }

    fn blob_path(&self, key: &str) -> PathBuf {
        self.blobs.join(&key[..2.min(key.len())]).join(format!("{key}{BBREP}"))
    }

    fn mesh_path(&self, key: &str) -> PathBuf {
        let clean: String = key
            .chars()
            .map(|c| if c.is_ascii_hexdigit() || c == '-' { c } else { '-' })
            .collect();
        self.meshes.join(format!("{clean}.bin"))
    }

    fn checkpoint_path(&self, chain_key: &str) -> Option<PathBuf> {
        is_key(chain_key).then(|| self.checkpoints.join(format!("{chain_key}.json")))
    }

    fn atomic_write(&self, dest: &Path, data: &[u8]) -> std::io::Result<()> {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let tmp = self.tmp.join(format!("{nonce:x}-{}.tmp", std::process::id()));
        let written = (|| {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(data)?;
            f.sync_all()?;
            drop(f);
            fs::rename(&tmp, dest)
        })();
        if written.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        written
    }

    fn iter_blobs(&self) -> Vec<(String, PathBuf, u64)> {
        let mut out = Vec::new();
        for shard in fs::read_dir(&self.blobs).into_iter().flatten().flatten() {
            for e in fs::read_dir(shard.path()).into_iter().flatten().flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if let Some(key) = name.strip_suffix(BBREP) {
                    let size = e.metadata().map_or(0, |m| m.len());
                    out.push((key.to_owned(), e.path(), size));
                }
            }
        }
        out
    }

    /// Stores a body under `key`, a no-op when the key exists (same key, same body).
    pub fn put_blob(&self, key: &str, shape: &Shape) -> std::io::Result<u64> {
        if !is_key(key) {
            return Err(std::io::Error::other("not a cache key"));
        }
        let dest = self.blob_path(key);
        if let Ok(m) = fs::metadata(&dest) {
            return Ok(m.len());
        }
        let data = xcaf::to_bin_v3(shape).map_err(|e| std::io::Error::other(e.to_string()))?;
        self.atomic_write(&dest, &data)?;
        Ok(data.len() as u64)
    }

    pub fn has_blob(&self, key: &str) -> bool {
        is_key(key) && self.blob_path(key).exists()
    }

    /// The stored body, None when missing or unreadable, which removes the file.
    pub fn get_blob(&self, key: &str) -> Option<Shape> {
        if !is_key(key) {
            return None;
        }
        let path = self.blob_path(key);
        let data = fs::read(&path).ok()?;
        match xcaf::from_bin(&data) {
            Ok(s) if !crate::kernel::is_null(&s) => Some(s),
            _ => {
                let _ = fs::remove_file(&path);
                None
            }
        }
    }

    pub fn put_mesh(&self, key: &str, payload: &[u8]) -> std::io::Result<()> {
        self.atomic_write(&self.mesh_path(key), payload)
    }

    /// The artifact, stamped as used so eviction drops the least recently used.
    pub fn get_mesh(&self, key: &str) -> Option<Vec<u8>> {
        let path = self.mesh_path(key);
        let data = fs::read(&path).ok()?;
        touch(&path);
        Some(data)
    }

    fn mesh_entries(&self) -> (Vec<(SystemTime, u64, PathBuf)>, u64) {
        let mut total = 0;
        let mut out = Vec::new();
        for e in fs::read_dir(&self.meshes).into_iter().flatten().flatten() {
            if !e.file_name().to_string_lossy().ends_with(".bin") {
                continue;
            }
            if let Ok(m) = e.metadata() {
                total += m.len();
                out.push((m.modified().unwrap_or(SystemTime::UNIX_EPOCH), m.len(), e.path()));
            }
        }
        (out, total)
    }

    /// Upserts the record; an existing pin survives.
    pub fn save_checkpoint(&self, chain_key: &str, mut cp: Checkpoint) -> std::io::Result<()> {
        let path = self
            .checkpoint_path(chain_key)
            .ok_or_else(|| std::io::Error::other("not a cache key"))?;
        cp.bytes = cp
            .manifest
            .iter()
            .filter_map(|e| fs::metadata(self.blob_path(&e.blob_key)).ok())
            .map(|m| m.len())
            .sum();
        if let Some(old) = self.read_checkpoint(chain_key) {
            cp.pinned |= old.pinned;
        }
        let data = serde_json::to_vec(&cp).map_err(std::io::Error::other)?;
        self.atomic_write(&path, &data)
    }

    fn read_checkpoint(&self, chain_key: &str) -> Option<Checkpoint> {
        let data = fs::read(self.checkpoint_path(chain_key)?).ok()?;
        serde_json::from_slice(&data).ok()
    }

    fn remove_checkpoint(&self, chain_key: &str) {
        if let Some(p) = self.checkpoint_path(chain_key) {
            let _ = fs::remove_file(p);
        }
    }

    /// The deepest restorable checkpoint among `chain_keys` (index i is the key
    /// after feature i). A record whose blobs went missing is removed and the
    /// walk goes on to a shallower one.
    pub fn find_checkpoint(&self, chain_keys: &[String]) -> Option<(String, Checkpoint)> {
        for key in chain_keys.iter().rev() {
            let Some(path) = self.checkpoint_path(key) else {
                continue;
            };
            if !path.exists() {
                continue;
            }
            match self.read_checkpoint(key) {
                Some(cp) if cp.manifest.iter().all(|e| self.has_blob(&e.blob_key)) => {
                    touch(&path);
                    return Some((key.clone(), cp));
                }
                _ => self.remove_checkpoint(key),
            }
        }
        None
    }

    pub fn pin(&self, chain_key: &str, pinned: bool) {
        if let Some(mut cp) = self.read_checkpoint(chain_key) {
            cp.pinned = pinned;
            if let (Some(path), Ok(data)) = (self.checkpoint_path(chain_key), serde_json::to_vec(&cp)) {
                let _ = self.atomic_write(&path, &data);
            }
        }
    }

    fn all_checkpoints(&self) -> Vec<(String, Checkpoint)> {
        let mut out = Vec::new();
        for e in fs::read_dir(&self.checkpoints).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(key) = name.strip_suffix(".json") else {
                continue;
            };
            match self.read_checkpoint(key) {
                Some(cp) => out.push((key.to_owned(), cp)),
                None => {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
        out
    }

    /// Compute All: the given checkpoints and every blob no other one references.
    pub fn purge(&self, chain_keys: &[String]) -> usize {
        let doomed: std::collections::HashSet<&str> = chain_keys.iter().map(String::as_str).collect();
        let all = self.all_checkpoints();
        let survivors: std::collections::HashSet<String> = all
            .iter()
            .filter(|(k, _)| !doomed.contains(k.as_str()))
            .flat_map(|(_, cp)| cp.manifest.iter().map(|e| e.blob_key.clone()))
            .collect();
        let mut removed = 0;
        for (key, cp) in all.iter().filter(|(k, _)| doomed.contains(k.as_str())) {
            self.remove_checkpoint(key);
            for e in &cp.manifest {
                if !survivors.contains(&e.blob_key) && fs::remove_file(self.blob_path(&e.blob_key)).is_ok() {
                    removed += 1;
                }
            }
        }
        removed
    }

    /// Brings the blobs under `byte_cap`: orphans first, then unpinned
    /// checkpoints in order of bytes per replay millisecond, a record always
    /// removed before its blobs. Returns the checkpoints evicted.
    pub fn evict(&self, byte_cap: u64) -> usize {
        let mut rows = self.all_checkpoints();
        let mut refcount: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for (_, cp) in &rows {
            for e in &cp.manifest {
                *refcount.entry(e.blob_key.clone()).or_default() += 1;
            }
        }
        let mut total = 0;
        for (key, path, size) in self.iter_blobs() {
            if refcount.get(&key).copied().unwrap_or(0) == 0 {
                let _ = fs::remove_file(path);
            } else {
                total += size;
            }
        }
        if total <= byte_cap {
            return 0;
        }
        rows.retain(|(_, cp)| !cp.pinned);
        rows.sort_by(|a, b| {
            let rate = |cp: &Checkpoint| cp.bytes as f64 / cp.replay_ms.max(1.0);
            rate(&b.1).total_cmp(&rate(&a.1))
        });
        let mut evicted = 0;
        for (key, cp) in rows {
            if total <= byte_cap {
                break;
            }
            self.remove_checkpoint(&key);
            evicted += 1;
            for e in &cp.manifest {
                let n = refcount.entry(e.blob_key.clone()).or_default();
                *n = n.saturating_sub(1);
                if *n == 0 {
                    let path = self.blob_path(&e.blob_key);
                    total = total.saturating_sub(fs::metadata(&path).map_or(0, |m| m.len()));
                    let _ = fs::remove_file(path);
                }
            }
        }
        evicted
    }

    /// Least recently used meshes out until they fit `byte_cap`.
    pub fn evict_meshes(&self, byte_cap: u64) -> usize {
        let (mut entries, mut total) = self.mesh_entries();
        if total <= byte_cap {
            return 0;
        }
        entries.sort();
        let mut removed = 0;
        for (_, size, path) in entries {
            if total <= byte_cap {
                break;
            }
            if fs::remove_file(path).is_ok() {
                total -= size;
                removed += 1;
            }
        }
        removed
    }

    /// A tenth of the free space plus what the cache holds, within
    /// [512 MiB, 8 GiB] and never past half; `FUNDACAD_CACHE_MAX_GB` overrides.
    pub fn cache_budget(&self) -> u64 {
        if let Some(gb) = std::env::var("FUNDACAD_CACHE_MAX_GB")
            .ok()
            .and_then(|s| s.trim().parse::<f64>().ok())
            .filter(|g| *g > 0.0)
        {
            return (gb * f64::from(1u32 << 30)) as u64;
        }
        let Some(free) = free_space(&self.root) else {
            return CACHE_MAX;
        };
        budget_for(free + self.mesh_entries().1 + self.stats().bytes)
    }

    /// Meshes absorb the whole squeeze before a checkpoint is touched, a lost
    /// mesh costs one tessellation and a lost checkpoint a replay.
    pub fn evict_to_budget(&self, byte_cap: Option<u64>) -> (usize, usize) {
        let cap = byte_cap.unwrap_or_else(|| self.cache_budget());
        let blob_bytes = self.stats().bytes;
        let meshes = self.evict_meshes(cap.saturating_sub(blob_bytes));
        let checkpoints = if blob_bytes > cap { self.evict(cap) } else { 0 };
        (meshes, checkpoints)
    }

    pub fn stats(&self) -> Stats {
        let blobs = self.iter_blobs();
        Stats {
            checkpoints: fs::read_dir(&self.checkpoints).map_or(0, |d| d.flatten().count()),
            blobs: blobs.len(),
            bytes: blobs.iter().map(|b| b.2).sum(),
        }
    }
}

pub fn budget_for(available: u64) -> u64 {
    (available / 10).clamp(CACHE_MIN, CACHE_MAX).min(available / 2)
}

fn touch(path: &Path) {
    if let Ok(f) = fs::OpenOptions::new().append(true).open(path) {
        let _ = f.set_modified(SystemTime::now());
    }
}

#[cfg(windows)]
fn free_space(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut free = 0u64;
    let ok = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(free)
}

#[cfg(unix)]
fn free_space(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    Some(st.f_bavail as u64 * st.f_frsize as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fundacad-geomstore-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn entry(body: &str, blob: &str) -> ManifestEntry {
        ManifestEntry {
            body_id: body.into(),
            name: body.into(),
            blob_key: blob.into(),
            node_ref: None,
            intact: false,
            face_colors: None,
            part_color: None,
            mesh_passes: Vec::new(),
        }
    }

    fn cp(index: usize, manifest: Vec<ManifestEntry>, replay_ms: f64) -> Checkpoint {
        Checkpoint {
            feat_index: index,
            manifest,
            state: Value::Null,
            replay_ms,
            bytes: 0,
            pinned: false,
        }
    }

    fn key(n: u8) -> String {
        format!("{n:02x}").repeat(16)
    }

    #[test]
    fn blob_round_trip_dedup_and_corruption() {
        let s = GeomStore::open(scratch("blob")).unwrap();
        let shape = crate::kernel::make_box(10.0, 10.0, 10.0).unwrap();
        let n = s.put_blob(&key(1), &shape).unwrap();
        assert!(n > 0);
        assert_eq!(s.put_blob(&key(1), &crate::kernel::make_sphere(3.0).unwrap()).unwrap(), n);
        let back = s.get_blob(&key(1)).unwrap();
        assert!((crate::kernel::volume(&back) - 1000.0).abs() < 1e-6);
        assert!(s.get_blob(&key(2)).is_none());
        fs::write(s.blob_path(&key(3)).parent().map(|p| {
            fs::create_dir_all(p).unwrap();
            s.blob_path(&key(3))
        }).unwrap(), b"garbage").unwrap();
        assert!(s.get_blob(&key(3)).is_none());
        assert!(!s.has_blob(&key(3)), "a corrupt blob is removed");
        assert!(s.get_blob("../escape").is_none());
    }

    #[test]
    fn the_deepest_restorable_checkpoint_wins() {
        let s = GeomStore::open(scratch("find")).unwrap();
        let shape = crate::kernel::make_box(1.0, 1.0, 1.0).unwrap();
        s.put_blob(&key(10), &shape).unwrap();
        s.put_blob(&key(11), &shape).unwrap();
        let keys: Vec<String> = (20..24).map(key).collect();
        s.save_checkpoint(&keys[0], cp(0, vec![entry("body1", &key(10))], 5.0)).unwrap();
        s.save_checkpoint(&keys[2], cp(2, vec![entry("body1", &key(11))], 5.0)).unwrap();
        assert_eq!(s.find_checkpoint(&keys).unwrap().1.feat_index, 2);
        fs::remove_file(s.blob_path(&key(11))).unwrap();
        assert_eq!(s.find_checkpoint(&keys).unwrap().1.feat_index, 0);
        assert!(s.read_checkpoint(&keys[2]).is_none(), "an unrestorable record is dropped");
        assert!(s.find_checkpoint(&keys[1..]).is_none());
        assert!(s.find_checkpoint(&[]).is_none());
    }

    #[test]
    fn a_temp_file_from_a_crash_is_swept() {
        let root = scratch("tmp");
        GeomStore::open(&root).unwrap();
        fs::write(root.join("tmp").join("junk.tmp"), b"x").unwrap();
        GeomStore::open(&root).unwrap();
        assert_eq!(fs::read_dir(root.join("tmp")).unwrap().count(), 0);
    }

    #[test]
    fn eviction_spares_pins_and_referenced_blobs() {
        let s = GeomStore::open(scratch("evict")).unwrap();
        let big = crate::kernel::make_sphere(50.0).unwrap();
        for n in 1..=4 {
            s.put_blob(&key(n), &big).unwrap();
        }
        s.put_blob(&key(9), &big).unwrap();
        s.save_checkpoint(&key(31), cp(0, vec![entry("a", &key(1))], 1.0)).unwrap();
        s.save_checkpoint(&key(32), cp(1, vec![entry("a", &key(2))], 1000.0)).unwrap();
        s.save_checkpoint(&key(33), cp(2, vec![entry("a", &key(3)), entry("b", &key(4))], 1.0)).unwrap();
        s.pin(&key(33), true);
        let one = fs::metadata(s.blob_path(&key(1))).unwrap().len();
        assert_eq!(s.evict(u64::MAX), 0);
        assert!(!s.has_blob(&key(9)), "an orphan blob is reclaimed first");
        let evicted = s.evict(3 * one);
        assert_eq!(evicted, 1);
        assert!(s.read_checkpoint(&key(31)).is_none(), "the cheap to replay one goes first");
        assert!(s.read_checkpoint(&key(33)).is_some());
        assert_eq!(s.evict(0), 1);
        assert!(s.read_checkpoint(&key(33)).is_some(), "a pinned checkpoint is never evicted");
        assert_eq!(s.stats().blobs, 2);
    }

    #[test]
    fn purge_keeps_blobs_another_checkpoint_needs() {
        let s = GeomStore::open(scratch("purge")).unwrap();
        let shape = crate::kernel::make_box(1.0, 2.0, 3.0).unwrap();
        s.put_blob(&key(1), &shape).unwrap();
        s.put_blob(&key(2), &shape).unwrap();
        s.save_checkpoint(&key(40), cp(0, vec![entry("a", &key(1)), entry("b", &key(2))], 1.0)).unwrap();
        s.save_checkpoint(&key(41), cp(0, vec![entry("a", &key(1))], 1.0)).unwrap();
        assert_eq!(s.purge(&[key(40)]), 1);
        assert!(s.has_blob(&key(1)) && !s.has_blob(&key(2)));
    }

    #[test]
    fn meshes_evict_least_recently_used_and_the_budget_clamps() {
        let s = GeomStore::open(scratch("mesh")).unwrap();
        s.put_mesh("aa-tv8", &[1u8; 100]).unwrap();
        s.put_mesh("bb-tv8", &[2u8; 100]).unwrap();
        let old = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        fs::OpenOptions::new().append(true).open(s.mesh_path("aa-tv8")).unwrap().set_modified(old).unwrap();
        fs::OpenOptions::new().append(true).open(s.mesh_path("bb-tv8")).unwrap().set_modified(old + std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(s.get_mesh("aa-tv8").unwrap(), vec![1u8; 100]);
        assert_eq!(s.evict_meshes(150), 1);
        assert!(s.get_mesh("aa-tv8").is_some() && s.get_mesh("bb-tv8").is_none());
        assert_eq!(budget_for(1 << 40), CACHE_MAX);
        assert_eq!(budget_for(20 << 30), 2 << 30);
        assert_eq!(budget_for(2 << 30), CACHE_MIN);
        assert_eq!(budget_for(512 << 20), 256 << 20);
        assert!(s.cache_budget() >= CACHE_MIN.min(1 << 20));
        assert_eq!(s.evict_to_budget(Some(0)), (1, 0));
    }
}
