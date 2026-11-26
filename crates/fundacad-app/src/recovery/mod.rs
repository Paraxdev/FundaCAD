//! Crash autosave and recovery, FundaCAD 1's src/io/recovery.ts. While the document has unsaved changes a snapshot
//! is written 30 s after the last edit, at most 2 min behind a busy session. It goes once nothing is unsaved, and on
//! start what a crashed app left is offered back.

pub mod store;
#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use gpui::*;

use crate::files::Files;
use crate::overlay::{self, Choice, Toast};
use crate::viewport::Viewport;
use store::{Envelope, Own};

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
    /// The change count the last snapshot was taken at, None when no snapshot of this document is on disk.
    written: Option<u64>,
    /// The change count, and when it was first seen, so edits are timed to the poll.
    seen: Option<u64>,
    last_edit: Option<Instant>,
    oldest_unwritten: Option<Instant>,
    writing: bool,
    failures: u32,
    /// A crashed app's snapshot that was recovered, kept until this one writes its own or the work is saved.
    adopted: Option<String>,
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
        written: None,
        seen: None,
        last_edit: None,
        oldest_unwritten: None,
        writing: false,
        failures: 0,
        adopted: None,
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
        a.clear();
        a.own = None;
    });
}

impl Autosave {
    fn clear(&mut self) {
        if let Some(own) = &self.own {
            own.clear();
        }
        self.drop_adopted();
        self.written = None;
        self.last_edit = None;
        self.oldest_unwritten = None;
    }

    fn drop_adopted(&mut self) {
        if let (Some(id), Some(own)) = (self.adopted.take(), &self.own) {
            store::discard(own.dir(), &id);
        }
    }

    fn tick(&mut self, cx: &mut Context<Self>) {
        if self.own.is_none() || self.writing {
            return;
        }
        let (dirty, source) = {
            let f = self.files.read(cx);
            (f.dirty(), f.path().map(PathBuf::from))
        };
        if !dirty {
            if self.written.is_some() || self.adopted.is_some() {
                self.clear();
            }
            self.seen = None;
            return;
        }
        let viewport = self.viewport.read(cx);
        let changes = viewport.changes();
        let now = Instant::now();
        if self.seen != Some(changes) {
            self.seen = Some(changes);
            self.last_edit = Some(now);
            self.oldest_unwritten.get_or_insert(now);
        }
        if self.written == Some(changes) {
            return;
        }
        let (Some(last), Some(oldest)) = (self.last_edit, self.oldest_unwritten) else { return };
        if !due(now, last, oldest) {
            return;
        }
        let Some(doc) = viewport.doc().cloned() else { return };
        let blob_dir = viewport.blob_dir().map(PathBuf::from);
        let Some(own) = &self.own else { return };
        let (dir, id) = (own.dir().to_path_buf(), own.id().to_owned());
        let envelope = Envelope { source, saved_at: store::now_ms() };
        self.writing = true;
        let task =
            cx.background_spawn(async move { store::write_slot(&dir, &id, &doc, blob_dir.as_deref(), &envelope) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |a, cx| a.wrote(changes, result, cx));
        })
        .detach();
    }

    fn wrote(&mut self, changes: u64, result: Result<(), String>, cx: &mut Context<Self>) {
        self.writing = false;
        match result {
            Ok(()) => {
                self.written = Some(changes);
                self.oldest_unwritten = None;
                self.failures = 0;
                self.drop_adopted();
            }
            Err(e) => {
                log::warn!("autosave failed: {e}");
                self.failures += 1;
                if warn_now(self.failures) {
                    overlay::toast(cx, Toast::error("Autosave keeps failing, unsaved work may not be recoverable"));
                }
            }
        }
    }
}

fn offer_leftover(autosave: Entity<Autosave>, dir: PathBuf, window: &mut Window, cx: &mut App) {
    let own = autosave.read(cx).own.as_ref().map(|o| o.id().to_owned());
    let Some(first) = store::leftovers(&dir, own.as_deref()).into_iter().next() else { return };
    let files = autosave.read(cx).files.clone();
    let question = store::question(&first.envelope, store::now_ms());
    let choices =
        vec![Choice::primary("Recover").hint("restore the snapshot"), Choice::danger("Discard").hint("delete it")];
    let answer = overlay::confirm(window, cx, question, choices);
    window
        .spawn(cx, async move |cx| {
            // Escape keeps the snapshot for the next start.
            match answer.recv().await.ok().flatten() {
                Some(0) => {
                    let _ = cx.update(|window, cx| {
                        let opened = files.update(cx, |f, cx| f.open_unsaved(&first.doc, window, cx));
                        if opened {
                            autosave.update(cx, |a, _| a.adopted = Some(first.id.clone()));
                            overlay::toast(cx, Toast::info("Recovered unsaved work, use Save As to keep it"));
                        }
                    });
                }
                Some(_) => store::discard(&dir, &first.id),
                None => {}
            }
        })
        .detach();
}
