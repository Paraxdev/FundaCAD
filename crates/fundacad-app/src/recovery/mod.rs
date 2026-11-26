//! Crash autosave and recovery, FundaCAD 1's src/io/recovery.ts. While the document has unsaved changes a snapshot
//! is written 30 s after the last edit, at most 2 min behind a busy session. It goes once nothing is unsaved, and on
//! start what a crashed app left is offered back.

mod clock;
pub mod store;
#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::*;

use crate::files::Files;
use crate::overlay::{self, Choice, Toast};
use crate::viewport::Viewport;
use clock::{Clock, Next, Wrote};
use store::{Envelope, Leftover, Own};

const IDLE: Duration = Duration::from_secs(30);
const MAX: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_secs(5);
const FAILS_BEFORE_WARNING: u32 = 3;
const DIR: &str = "recovery";

pub fn dir() -> Option<PathBuf> {
    // Unit tests pass their own folder, so none ever writes a lock into the real config folder.
    if cfg!(test) {
        return None;
    }
    crate::settings::config_dir().map(|d| d.join(DIR))
}

/// Whether a snapshot is due: the edits have rested for `IDLE`, or the oldest one not in a snapshot is `MAX` old.
pub fn due(now: Instant, last_edit: Instant, oldest_unwritten: Instant) -> bool {
    now.saturating_duration_since(last_edit) >= IDLE || now.saturating_duration_since(oldest_unwritten) >= MAX
}

/// The counts of consecutive failures at which the warning toast shows, once until a write works again.
pub fn warn_now(failures: u32) -> bool {
    failures == FAILS_BEFORE_WARNING
}

pub struct Autosave {
    files: Entity<Files>,
    viewport: Entity<Viewport>,
    own: Option<Own>,
    clock: Clock,
    /// Set as the work is given up, so a write still running does not bring the slot back.
    stop: Arc<AtomicBool>,
}

/// Holds the autosave for the app's life, nothing else keeps it.
struct Current(Entity<Autosave>);

impl Global for Current {}

pub fn install(viewport: &Entity<Viewport>, files: &Entity<Files>, window: &mut Window, cx: &mut App) {
    if let Some(dir) = dir() {
        install_in(dir, viewport, files, window, cx);
    }
}

fn install_in(dir: PathBuf, viewport: &Entity<Viewport>, files: &Entity<Files>, window: &mut Window, cx: &mut App) {
    let id = format!("{}-{}", std::process::id(), store::now_ms());
    let own = match Own::claim(&dir, id) {
        Ok(own) => Some(own),
        Err(e) => {
            log::warn!("autosave is off: {e}");
            None
        }
    };
    let autosave = cx.new(|_| Autosave {
        files: files.clone(),
        viewport: viewport.clone(),
        own,
        clock: Clock::default(),
        stop: Arc::default(),
    });
    cx.set_global(Current(autosave.clone()));
    let weak = autosave.downgrade();
    window
        .spawn(cx, async move |cx| loop {
            cx.background_executor().timer(POLL).await;
            if weak.update(cx, |a, cx| a.tick(cx)).is_err() {
                return;
            }
        })
        .detach();
    let offer = autosave.clone();
    window.defer(cx, move |window, cx| offer_leftover(offer, dir, window, cx));
}

/// The work is in a file or given up, so nothing is left to recover. Called as the window closes.
pub fn give_up(cx: &mut App) {
    let Some(autosave) = cx.try_global::<Current>().map(|c| c.0.clone()) else { return };
    autosave.update(cx, |a, _| {
        a.stop.store(true, Ordering::SeqCst);
        a.clear();
        a.own = None;
    });
}

impl Autosave {
    fn clear(&mut self) {
        let adopted = self.clock.clear();
        self.delete(adopted);
    }

    fn delete(&self, adopted: Option<String>) {
        let Some(own) = &self.own else { return };
        own.clear();
        if let Some(id) = adopted {
            store::discard(own.dir(), &id);
        }
    }

    fn tick(&mut self, cx: &mut Context<Self>) {
        if self.own.is_none() {
            return;
        }
        let (dirty, source) = {
            let f = self.files.read(cx);
            (f.dirty(), f.path().map(PathBuf::from))
        };
        let viewport = self.viewport.read(cx);
        let changes = match self.clock.next(dirty, viewport.changes(), Instant::now()) {
            Next::Wait => return,
            Next::Clear { adopted } => return self.delete(adopted),
            Next::Write(changes) => changes,
        };
        let (Some(doc), Some(own)) = (viewport.doc().cloned(), &self.own) else {
            self.clock.writing = false;
            return;
        };
        let blob_dir = viewport.blob_dir().map(PathBuf::from);
        let (dir, id) = (own.dir().to_path_buf(), own.id().to_owned());
        let envelope = Envelope { source, saved_at: store::now_ms() };
        let stop = self.stop.clone();
        let task = cx
            .background_spawn(async move { store::write_slot(&dir, &id, &doc, blob_dir.as_deref(), &envelope, &stop) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |a, cx| a.wrote(changes, result, cx));
        })
        .detach();
    }

    fn wrote(&mut self, changes: u64, result: Result<(), String>, cx: &mut Context<Self>) {
        if let Err(e) = &result {
            log::warn!("autosave failed: {e}");
        }
        match self.clock.wrote(changes, result.is_ok()) {
            Wrote::Kept { adopted: Some(id) } => {
                if let Some(own) = &self.own {
                    store::discard(own.dir(), &id);
                }
            }
            Wrote::Kept { adopted: None } => {}
            Wrote::Failed { warn } => {
                if warn {
                    overlay::toast(cx, Toast::error("Autosave keeps failing, unsaved work may not be recoverable"));
                }
            }
        }
    }
}

/// Opens a leftover as unsaved work, and keeps its slot until this app has a snapshot of its own.
fn recover(autosave: &Entity<Autosave>, first: &Leftover, window: &mut Window, cx: &mut App) {
    let files = autosave.read(cx).files.clone();
    if files.update(cx, |f, cx| f.open_unsaved(&first.doc, window, cx)) {
        crate::home::set(cx, false);
        adopt(autosave, first.id.clone(), cx);
    }
}

fn adopt(autosave: &Entity<Autosave>, id: String, cx: &mut App) {
    autosave.update(cx, |a, _| a.clock.adopted = Some(id));
    overlay::toast(cx, Toast::info("Recovered unsaved work, use Save As to keep it"));
}

fn offer_leftover(autosave: Entity<Autosave>, dir: PathBuf, window: &mut Window, cx: &mut App) {
    let own = autosave.read(cx).own.as_ref().map(|o| o.id().to_owned());
    store::sweep(&dir, own.as_deref());
    let Some(first) = store::leftovers(&dir, own.as_deref()).into_iter().next() else { return };
    let question = store::question(&first.envelope, store::now_ms());
    let choices =
        vec![Choice::primary("Recover").hint("restore the snapshot"), Choice::danger("Discard").hint("delete it")];
    let answer = overlay::confirm(window, cx, question, choices);
    window
        .spawn(cx, async move |cx| {
            // Escape keeps the snapshot for the next start.
            match answer.recv().await.ok().flatten() {
                Some(0) => {
                    let _ = cx.update(|window, cx| recover(&autosave, &first, window, cx));
                }
                Some(_) => store::discard(&dir, &first.id),
                None => {}
            }
        })
        .detach();
}
