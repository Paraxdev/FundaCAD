//! Not rebuilding what has not changed, rebuild_cache.py and `rebuild_cached`. A rebuild resumes at the longest
//! unchanged chain key prefix from an in process snapshot ring or a disk checkpoint, payloads are kept likewise.

pub mod checkpoint;
pub mod keys;
pub mod meshes;
pub mod store;
pub mod timing;

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use fundacad_core::CadDocument;
use fundacad_protocol::MeshResult;
use serde_json::{json, Map, Value};

use crate::builder::{self, Cancelled, Rebuild, Snapshot, State, Tap, Watch};
use crate::import::blobstore::{self, BlobStore};
use crate::mesh::{self, MeshBody};
use checkpoint::{Modified, Persist};
use store::GeomStore;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Source {
    #[default]
    Full,
    Ram,
    Disk,
}

/// What the last rebuild and mesh took from the caches.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CacheStats {
    pub source: Source,
    /// The first feature replayed, the timeline length when nothing was.
    pub resumed_at: usize,
    pub replayed: Vec<usize>,
    pub checkpoints_written: usize,
    pub mesh_ram_hits: usize,
    pub mesh_disk_hits: usize,
    pub meshed: usize,
    pub copy: Duration,
    pub replay: Duration,
    /// The slowest replayed feature, as its index and time.
    pub slowest: Option<(usize, Duration)>,
    pub mesh_time: Duration,
}

pub struct RebuildCache {
    store: Option<GeomStore>,
    env: String,
    ring_keys: Vec<String>,
    ring: Vec<Option<Snapshot>>,
    /// `FUNDACAD_RAM_SNAP_WINDOW`: snapshots kept, counted back from the tip.
    pub window: usize,
    /// Replay time between two disk checkpoints.
    pub budget_ms: f64,
    /// A build at least this slow leaves a checkpoint at its tip.
    pub tip_after: Duration,
    /// A payload at least this slow to build is written to disk.
    pub mesh_persist_after: Duration,
    brep_sigs: HashMap<String, String>,
    proj_quiet: bool,
    stored: Modified,
    payloads: meshes::Payloads,
    pub stats: CacheStats,
}

struct CacheTap<'a> {
    keep_from: usize,
    snaps: Vec<(usize, Snapshot)>,
    replayed: Vec<usize>,
    slowest: Option<(usize, Duration)>,
    persist: Option<Persist<'a>>,
}

impl Tap for CacheTap<'_> {
    fn after_feature(&mut self, index: usize, state: &State<'_>, elapsed: Duration) {
        self.replayed.push(index);
        if self.slowest.is_none_or(|(_, t)| elapsed > t) {
            self.slowest = Some((index, elapsed));
        }
        if index >= self.keep_from {
            self.snaps.push((index, state.snapshot()));
        }
        if let Some(p) = self.persist.as_mut() {
            p.tick(index, state, elapsed);
        }
    }
}

impl RebuildCache {
    pub fn new(store: Option<GeomStore>) -> RebuildCache {
        RebuildCache {
            store,
            env: keys::env_sig(),
            ring_keys: Vec::new(),
            ring: Vec::new(),
            window: 300,
            budget_ms: 1000.0,
            tip_after: Duration::from_millis(500),
            mesh_persist_after: meshes::PERSIST_MIN,
            brep_sigs: HashMap::new(),
            proj_quiet: false,
            stored: HashMap::new(),
            payloads: meshes::Payloads::default(),
            stats: CacheStats::default(),
        }
    }

    /// The engine's cache: disk checkpoints under `store::default_root` unless
    /// `FUNDACAD_DISK_CACHE=0`, brought under budget once when opened.
    pub fn from_env() -> RebuildCache {
        let store = match std::env::var("FUNDACAD_DISK_CACHE").as_deref() {
            Ok("0") => None,
            _ => GeomStore::open(store::default_root()).ok(),
        };
        if let Some(s) = &store {
            s.evict_to_budget(None);
        }
        let mut cache = RebuildCache::new(store);
        if let Some(w) = std::env::var("FUNDACAD_RAM_SNAP_WINDOW").ok().and_then(|w| w.parse().ok()) {
            cache.window = w;
        }
        cache
    }

    pub fn store(&self) -> Option<&GeomStore> {
        self.store.as_ref()
    }

    pub fn chain_keys(&mut self, raw: &Value) -> Vec<String> {
        self.keys_given(raw, &absent_geometry(raw))
    }

    fn keys_given(&mut self, raw: &Value, absent: &BTreeSet<String>) -> Vec<String> {
        #[cfg(feature = "plugins")]
        let plugins = crate::plugins::feature_identities();
        #[cfg(not(feature = "plugins"))]
        let plugins = HashMap::new();
        keys::chain_keys(raw, &self.env, &plugins, absent, &mut self.brep_sigs)
    }

    /// `reset_cache` and the mesh cache: this process forgets, the disk does not.
    pub fn reset(&mut self) {
        self.ring_keys.clear();
        reap(std::mem::take(&mut self.ring));
        self.payloads.clear();
        self.brep_sigs.clear();
    }

    /// `_compute_all_job`: every tier dropped for this document, disk included.
    pub fn purge(&mut self, raw: &Value) {
        let keys = self.chain_keys(raw);
        self.reset();
        if let Some(s) = &self.store {
            s.purge(&keys);
        }
    }

    /// `rebuild_cached`.
    pub fn rebuild(&mut self, doc: &CadDocument, raw: &Value, watch: &dyn Watch) -> Result<Rebuild, Cancelled> {
        let entered = Instant::now();
        let absent = absent_geometry(raw);
        let keys = self.keys_given(raw, &absent);
        let n = keys.len();
        let mut resume: Option<(usize, Snapshot)> = None;
        let mut source = Source::Full;
        let mut modified = Modified::new();

        // Never resume past the first sketch that projects, its unapplied update is not derivable from the document.
        // The RAM tier may pass the cap when this prefix's previous build emitted no updates at all.
        let cap = projection_cap(raw);
        let mut common = keys.iter().zip(&self.ring_keys).take_while(|(a, b)| a == b).count();
        if let Some(cap) = cap {
            if !(self.proj_quiet && common > cap) {
                common = common.min(cap);
            }
        }
        if common > 0 {
            if let Some(Some(snap)) = self.ring.get(common - 1) {
                if builder::ids_resumable(doc, snap) {
                    let mut snap = snap.clone();
                    snap.bodies = snap.bodies.iter().map(builder::Body::detached).collect();
                    resume = Some((common, snap));
                    source = Source::Ram;
                }
            }
        }
        if resume.is_none() {
            if let Some(store) = &self.store {
                if let Some((start, snap, m)) = checkpoint::restore(store, &keys[..cap.unwrap_or(n)]) {
                    if builder::ids_resumable(doc, &snap) {
                        resume = Some((start, snap));
                        modified = m;
                        source = Source::Disk;
                    }
                }
            }
        }
        let start = resume.as_ref().map_or(0, |r| r.0);
        // An unchanged body keeps the key the last build stored it under, or every checkpoint after a resume
        // rewrites its blob under a new name (1097 blobs, 438 MB on a big part).
        if source == Source::Ram && start > 0 {
            if let Some((_, snap)) = &resume {
                for b in &snap.bodies {
                    let key = match self.stored.get(&b.id) {
                        Some((ident, key)) if *ident == b.identity() => key.clone(),
                        _ => keys::blob_key(&keys[start - 1], &b.id),
                    };
                    modified.insert(b.id.clone(), (b.identity(), key));
                }
            }
        }
        if n > 0 {
            eprintln!(
                "[rebuild-cached] features={n} resume_from={start} src={}",
                match source {
                    Source::Full => "full",
                    Source::Ram => "RAM",
                    Source::Disk => "disk",
                }
            );
        }

        // A disk resume at a snapshot is held in RAM from here on, or every
        // later ask of this document reads the checkpoint back again.
        let restored =
            (source == Source::Disk).then(|| resume.as_ref().map(|(at, snap)| (*at, snap.clone()))).flatten();

        let began = Instant::now();
        let copy = began.duration_since(entered);
        let mut tap = CacheTap {
            keep_from: n.saturating_sub(self.window),
            snaps: Vec::new(),
            replayed: Vec::new(),
            slowest: None,
            persist: self.store.as_ref().filter(|_| n > 0).map(|store| Persist {
                store,
                watch,
                keys: &keys,
                modified,
                acc_ms: 0.0,
                budget_ms: self.budget_ms,
                written: 0,
                last_saved: None,
            }),
        };
        let built = builder::rebuild_from(doc, raw, watch, resume, &mut tap);
        let elapsed = began.elapsed();

        // A blob arrived or was dropped as corrupt during this build, so the keys no longer say what the imports
        // read and nothing is kept under them, including the checkpoints a cancelled build left.
        if absent_geometry(raw) != absent {
            let replayed = std::mem::take(&mut tap.replayed);
            drop(tap);
            self.reset();
            self.stored.clear();
            if let Some(s) = &self.store {
                s.purge(&keys);
            }
            self.stats = CacheStats { source, resumed_at: start, replayed, ..CacheStats::default() };
            return built;
        }
        let r = built?;

        let mut old = std::mem::take(&mut self.ring);
        let mut ring: Vec<Option<Snapshot>> = if source == Source::Ram {
            let tail = old.split_off(start.min(old.len()));
            reap(tail);
            old
        } else {
            reap(old);
            (0..start).map(|_| None).collect()
        };
        ring.resize_with(start, || None);
        let fresh = std::mem::take(&mut tap.snaps);
        for (i, snap) in fresh {
            ring.resize_with(i, || None);
            ring.push(Some(snap));
        }
        ring.resize_with(n, || None);
        if let Some((at, snap)) = restored {
            if let Some(slot @ None) = at.checked_sub(1).and_then(|i| ring.get_mut(i)) {
                *slot = Some(snap);
            }
        }
        let beyond: Vec<Snapshot> =
            ring.iter_mut().take(n.saturating_sub(self.window)).filter_map(Option::take).collect();
        reap(beyond);

        let mut written = 0;
        if let Some(mut p) = tap.persist.take() {
            let slow = elapsed >= self.tip_after || p.acc_ms >= self.tip_after.as_secs_f64() * 1000.0;
            if slow && p.last_saved != Some(n - 1) {
                if let Some(Some(tip)) = ring.last() {
                    p.save(n - 1, tip);
                }
            }
            written = p.written;
            self.stored = p.modified;
        } else {
            self.stored.clear();
        }
        let (replayed, slowest) = (tap.replayed, tap.slowest);
        self.proj_quiet = r.projection_updates.is_empty();
        self.ring = ring;
        self.ring_keys = keys;
        self.stats = CacheStats {
            source,
            resumed_at: start,
            replayed,
            checkpoints_written: written,
            copy,
            replay: elapsed,
            slowest,
            ..CacheStats::default()
        };
        Ok(r)
    }

    /// The bodies a feature added after the document's last one starts from,
    /// when a build in this process left them: never a replay or a disk read.
    pub fn held(&mut self, raw: &Value) -> Option<Vec<builder::Body>> {
        let keys = self.chain_keys(raw);
        let Some(last) = keys.len().checked_sub(1) else {
            return Some(Vec::new());
        };
        if self.ring_keys.get(..keys.len()) != Some(&keys[..]) {
            return None;
        }
        self.ring.get(last)?.as_ref().map(|s| s.bodies.clone())
    }

    /// The viewport payloads of a rebuild's bodies, reusing what either tier holds.
    pub fn mesh(
        &mut self,
        r: &Rebuild,
        tolerance: f64,
        known: &Map<String, Value>,
        on_body: &mut dyn FnMut(usize, usize),
    ) -> MeshResult {
        let bodies: Vec<MeshBody<'_>> = r
            .bodies
            .iter()
            .map(|b| {
                let mut m = crate::reply::mesh_body(b);
                m.identity = Some(b.identity);
                m.mesh_key = self.stored.get(&b.id).map(|(_, key)| key.clone());
                m
            })
            .collect();
        self.payloads.reset_counters();
        let result = {
            let mut tiered = meshes::Tiered {
                payloads: &mut self.payloads,
                store: self.store.as_ref(),
                persist_after: self.mesh_persist_after,
            };
            mesh::mesh_result_full(&bodies, tolerance, known, &mut tiered, on_body)
        };
        let live: HashSet<&str> = r.bodies.iter().map(|b| b.id.as_str()).collect();
        self.payloads.retain(&live);
        self.stats.mesh_ram_hits = self.payloads.ram_hits;
        self.stats.mesh_disk_hits = self.payloads.disk_hits;
        self.stats.meshed = self.payloads.meshed;
        self.stats.mesh_time = self.payloads.mesh_time;
        result
    }
}

/// The stored geometry the document's imports name and the blob store lacks.
fn absent_geometry(raw: &Value) -> BTreeSet<String> {
    let store = BlobStore { root: blobstore::default_root() };
    raw.get("features")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(keys::stored_geometry)
        .filter(|g| !store.has(g))
        .map(str::to_owned)
        .collect()
}

/// The index of the first sketch holding a projected entity, builder.py's
/// `proj_cap`.
fn projection_cap(raw: &Value) -> Option<usize> {
    raw.get("features").and_then(Value::as_array)?.iter().position(|f| {
        f.get("type").and_then(Value::as_str) == Some("sketch")
            && f.get("entities")
                .and_then(Value::as_array)
                .is_some_and(|es| es.iter().any(|e| e.get("type").and_then(Value::as_str) == Some("projected")))
    })
}

/// Frees `old` on a background thread: dropping a big build's snapshots took 0.6 s at 1,000 bodies, all in
/// front of the next reply. OCCT handle counts are atomic, so shapes still shared with the ring are safe.
fn reap<T: Send + 'static>(old: T) {
    type Garbage = Box<dyn Send>;
    static REAPER: OnceLock<Option<Mutex<mpsc::Sender<Garbage>>>> = OnceLock::new();
    let tx = REAPER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Garbage>();
        std::thread::Builder::new()
            .name("cache-reaper".into())
            .spawn(move || rx.into_iter().for_each(drop))
            .ok()
            .map(|_| Mutex::new(tx))
    });
    let garbage: Garbage = Box::new(old);
    if let Some(tx) = tx {
        if let Err(back) = tx.lock().unwrap_or_else(|p| p.into_inner()).send(garbage) {
            drop(back.0);
        }
    }
}

/// The engine process's cache, created on first use.
pub fn global() -> &'static Mutex<RebuildCache> {
    static CACHE: OnceLock<Mutex<RebuildCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(RebuildCache::from_env()))
}

/// The cache counters as a JSON object, for logs and test hooks.
pub fn stats_json(s: &CacheStats) -> Value {
    json!({
        "source": format!("{:?}", s.source).to_lowercase(),
        "resumedAt": s.resumed_at,
        "replayed": s.replayed.len(),
        "checkpointsWritten": s.checkpoints_written,
        "meshRamHits": s.mesh_ram_hits,
        "meshDiskHits": s.mesh_disk_hits,
        "meshed": s.meshed,
    })
}

#[cfg(test)]
mod tests {
    use super::reap;
    use std::sync::mpsc;
    use std::thread::{self, ThreadId};
    use std::time::Duration;

    struct Noisy(mpsc::Sender<ThreadId>);
    impl Drop for Noisy {
        fn drop(&mut self) {
            let _ = self.0.send(thread::current().id());
        }
    }

    #[test]
    fn an_old_ring_is_freed_off_the_request_thread() {
        let (tx, rx) = mpsc::channel();
        reap(vec![Some(Noisy(tx.clone())), None, Some(Noisy(tx))]);
        let me = thread::current().id();
        for _ in 0..2 {
            let on = rx.recv_timeout(Duration::from_secs(10)).expect("the reaper dropped it");
            assert_ne!(on, me);
        }
    }
}
