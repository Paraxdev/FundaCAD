//! Not rebuilding what has not changed, the Python engine's `rebuild_cache.py` and the
//! `rebuild_cached` half of builder.py, over the store of geomstore.py.
//!
//! Two tiers resume a rebuild at the longest unchanged prefix of chain keys:
//! a ring of per-feature snapshots in this process, and disk checkpoints that
//! outlive it. Built payloads are kept the same two ways. Every hit is counted
//! in `CacheStats`, which is also logged the way the Python engine logs it.

pub mod checkpoint;
pub mod keys;
pub mod meshes;
pub mod store;

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use fundacad_core::CadDocument;
use fundacad_protocol::MeshResult;
use serde_json::{json, Map, Value};

use crate::builder::{self, Cancelled, Rebuild, Snapshot, State, Tap, Watch};
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
    mesh_keys: HashMap<String, String>,
    payloads: meshes::Payloads,
    pub stats: CacheStats,
}

struct CacheTap<'a> {
    keep_from: usize,
    snaps: Vec<(usize, Snapshot)>,
    replayed: Vec<usize>,
    persist: Option<Persist<'a>>,
}

impl Tap for CacheTap<'_> {
    fn after_feature(&mut self, index: usize, state: &State<'_>, elapsed: Duration) {
        self.replayed.push(index);
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
            mesh_keys: HashMap::new(),
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
        #[cfg(feature = "plugins")]
        let plugins = crate::plugins::feature_identities();
        #[cfg(not(feature = "plugins"))]
        let plugins = HashMap::new();
        keys::chain_keys(raw, &self.env, &plugins, &mut self.brep_sigs)
    }

    /// `reset_cache` and the mesh cache: this process forgets, the disk does not.
    pub fn reset(&mut self) {
        self.ring_keys.clear();
        self.ring.clear();
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
        let keys = self.chain_keys(raw);
        let n = keys.len();
        let mut resume: Option<(usize, Snapshot)> = None;
        let mut source = Source::Full;
        let mut modified = Modified::new();

        // Never resume PAST the first sketch that projects: an unapplied
        // projection update is not derivable from the document, so that sketch
        // runs again. The RAM tier may pass the cap when the previous build of
        // this prefix emitted no updates at all, a quiet proof.
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
                    resume = Some((common, snap.clone()));
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
        if source == Source::Ram && start > 0 {
            if let Some((_, snap)) = &resume {
                for b in &snap.bodies {
                    modified.insert(b.id.clone(), (b.identity(), keys::blob_key(&keys[start - 1], &b.id)));
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

        let began = Instant::now();
        let mut tap = CacheTap {
            keep_from: n.saturating_sub(self.window),
            snaps: Vec::new(),
            replayed: Vec::new(),
            persist: self.store.as_ref().filter(|_| n > 0).map(|store| Persist {
                store,
                keys: &keys,
                modified,
                acc_ms: 0.0,
                budget_ms: self.budget_ms,
                written: 0,
            }),
        };
        let r = builder::rebuild_from(doc, raw, watch, resume, &mut tap)?;
        let elapsed = began.elapsed();

        let mut ring: Vec<Option<Snapshot>> = if source == Source::Ram {
            std::mem::take(&mut self.ring).into_iter().take(start).collect()
        } else {
            (0..start).map(|_| None).collect()
        };
        ring.resize_with(start, || None);
        let fresh = std::mem::take(&mut tap.snaps);
        for (i, snap) in fresh {
            ring.resize_with(i, || None);
            ring.push(Some(snap));
        }
        ring.resize_with(n, || None);
        for slot in ring.iter_mut().take(n.saturating_sub(self.window)) {
            *slot = None;
        }

        let mut written = 0;
        if let Some(mut p) = tap.persist.take() {
            if elapsed >= self.tip_after || p.acc_ms >= self.tip_after.as_secs_f64() * 1000.0 {
                if let Some(Some(tip)) = ring.last() {
                    p.save(n - 1, tip);
                }
            }
            written = p.written;
            self.mesh_keys = p
                .modified
                .into_iter()
                .map(|(id, (_, key))| (id, key))
                .collect();
        } else {
            self.mesh_keys.clear();
        }
        let replayed = tap.replayed;
        self.proj_quiet = r.projection_updates.is_empty();
        self.ring = ring;
        self.ring_keys = keys;
        self.stats = CacheStats {
            source,
            resumed_at: start,
            replayed,
            checkpoints_written: written,
            ..CacheStats::default()
        };
        Ok(r)
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
                m.mesh_key = self.mesh_keys.get(&b.id).cloned();
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
        result
    }
}

/// The index of the first sketch holding a projected entity, builder.py's
/// `proj_cap`.
fn projection_cap(raw: &Value) -> Option<usize> {
    raw.get("features")
        .and_then(Value::as_array)?
        .iter()
        .position(|f| {
            f.get("type").and_then(Value::as_str) == Some("sketch")
                && f.get("entities")
                    .and_then(Value::as_array)
                    .is_some_and(|es| es.iter().any(|e| e.get("type").and_then(Value::as_str) == Some("projected")))
        })
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
