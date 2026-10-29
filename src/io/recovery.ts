// Crash-recovery autosave. Rust owns the snapshot files (recovery_* commands) outside the webview's fs scope;
// this decides when: 30 s after the last edit, at most 2 min behind, only while dirty or a drag is held. A save
// clears the slot.

import type { DocumentSession } from "../document/session";
import type { DocumentStore } from "../document/store";
import { toast } from "../ui/toast";
import { safeMode } from "../ui/safeMode";

const IDLE_MS = 30_000; // quiet period after the last edit
const MAX_MS = 120_000; // never lag a busy session by more than this

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** slot name for a document path (sanitized server-side too). Safe mode
 *  writes its own, so the snapshots it did not offer are still there after it. */
export function slotFor(path: string | null): string {
  return (safeMode() ? "safe-" : "") + baseSlot(path);
}

function baseSlot(path: string | null): string {
  if (!path) return "untitled";
  const base = (path.split(/[\\/]/).pop() ?? "doc").replace(/\.[^.]+$/, "");
  // tiny stable hash so same-named files in different dirs get distinct slots
  let h = 5381;
  for (let i = 0; i < path.length; i++) h = ((h << 5) + h + path.charCodeAt(i)) >>> 0;
  return `${base}_${h.toString(36)}`;
}

interface Envelope {
  source: string | null; // where the document was last saved (null = untitled)
  savedAt: number;
  doc: unknown; // the full store.toObject() payload
}

interface Snapshot {
  session: DocumentSession;
  slot: string;
  json: string;
}

/** A tool edit let go of but not entered, which a save enters first. */
export interface HeldEdit {
  readonly pending: boolean;
  /** A drag still under the hand, which `confirmHeld` leaves alone. */
  readonly dragging: boolean;
  onHeldChange(fn: () => void): () => void;
  confirmHeld(): void;
}

export interface Autosave {
  /** A held edit counts as unsaved work, and a snapshot enters it first, so the copy holds what the user sees.
   *  Called once per tool that can hold one. */
  watchHeld(edit: HeldEdit): void;
}

export function installAutosave(store: DocumentStore): Autosave {
  if (!isTauri()) return { watchHeld() {} };
  const heldEdits: HeldEdit[] = [];
  let idleTimer: (() => void) | null = null;
  let oldestEdit: number | null = null;
  let writing = false;
  let rerun = false;
  let held: Snapshot | null = null; // an ended document's last snapshot, waiting for the write in flight
  const givenUp = new WeakSet<DocumentSession>();
  let failCount = 0; // consecutive autosave failures; warn once at 3, reset on success
  let warned = false;
  let wrote: Snapshot | null = null; // the open document's last snapshot on disk

  const failed = (e: unknown) => {
    console.warn("autosave failed:", e);
    failCount++;
    if (failCount >= 3 && !warned) {
      warned = true;
      toast("Autosave keeps failing, unsaved work may not be recoverable", {
        kind: "error",
        timeout: 8000,
      });
    }
  };

  // One compact stringify, synchronously, so the snapshot cannot see a half-applied edit or the next document's path.
  const take = (): Snapshot | null => {
    try {
      const env: Envelope = { source: store.filePath, savedAt: Date.now(), doc: store.toObject() };
      return { session: store.session, slot: slotFor(store.filePath), json: JSON.stringify(env) };
    } catch (e) {
      failed(e);
      return null;
    }
  };

  const persist = async (snap: Snapshot) => {
    writing = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (givenUp.has(snap.session)) return;
      await invoke("recovery_write", { slot: snap.slot, json: snap.json });
      // A Discard while the write was in flight cleared the slot before the write landed.
      if (givenUp.has(snap.session)) await invoke("recovery_clear", { slot: snap.slot });
      else if (snap.session === store.session) {
        // An undo back to the saved state while the write was in flight.
        if (store.dirty) wrote = snap;
        else await invoke("recovery_clear", { slot: snap.slot });
      }
      failCount = 0;
      warned = false;
    } catch (e) {
      failed(e);
    } finally {
      writing = false;
      const next = held;
      held = null;
      if (next) void persist(next);
      else if (rerun) {
        rerun = false;
        write();
      }
    }
  };

  const write = () => {
    for (const h of heldEdits) h.confirmHeld();
    idleTimer?.();
    idleTimer = null;
    oldestEdit = null;
    // Entered once it has been let go and left alone for another quiet period.
    if (heldEdits.some((h) => h.dragging)) schedule();
    if (!store.dirty) return;
    if (writing) {
      rerun = true;
      return;
    }
    const snap = take();
    if (snap) void persist(snap);
  };

  const schedule = () => {
    if (!store.dirty && !heldEdits.some((h) => h.pending)) return;
    const now = Date.now();
    if (oldestEdit == null) oldestEdit = now;
    idleTimer?.();
    // debounce on idle, but a busy session still snapshots every MAX_MS
    const wait = Math.min(IDLE_MS, Math.max(0, oldestEdit + MAX_MS - now));
    // The document's session owns the timer, so an edit of one document never times the next one's snapshot.
    idleTimer = store.session.timeout(write, wait);
  };
  store.sessions.onBegin(() => {
    idleTimer = null;
    oldestEdit = null;
  });
  // Work the user gave up (Discard, Don't save) is never offered at the next start. A document thrown away without
  // asking, by a plugin's doc_new, keeps its snapshot, with the edits its ended idle timer would have written.
  // Read while the session ends, before the path is replaced.
  const onEnd = (s: DocumentSession) =>
    s.own(() => {
      if (s.endedBy === "reload" || !store.dirty) return;
      if (store.givenUp) {
        givenUp.add(s);
        void clearRecovery(store.filePath);
        return;
      }
      if (oldestEdit == null) return;
      const snap = take();
      if (snap && writing) held = snap;
      else if (snap) void persist(snap);
    });
  onEnd(store.session);
  store.sessions.onBegin(onEnd);

  store.onDocChange(schedule);
  store.onMeta(schedule);
  // Undo or redo back to the saved state leaves nothing to recover, so the snapshot of the unsaved state goes.
  store.onMeta(() => {
    if (store.dirty || wrote?.session !== store.session) return;
    const slot = wrote.slot;
    wrote = null;
    idleTimer?.();
    idleTimer = null;
    oldestEdit = null;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("recovery_clear", { slot })).catch(() => {});
  });

  return {
    watchHeld(edit) {
      heldEdits.push(edit);
      edit.onHeldChange(schedule);
    },
  };
}

/** Drop the recovery snapshots of a document that was just saved. */
export async function clearRecovery(path: string | null) {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("recovery_clear", { slot: slotFor(path) });
    await invoke("recovery_clear", { slot: slotFor(null) });
  } catch {
    /* best-effort */
  }
}

/** On launch: if any snapshot exists, offer to restore the newest one. */
export async function checkRecovery(store: DocumentStore) {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const slots = await invoke<[string, number][]>("recovery_list");
    if (!slots.length) return;
    const first = slots[0];
    if (!first) return;
    const [slot, mtime] = first;
    const raw = await invoke<string | null>("recovery_read", { slot });
    if (!raw) return;
    const env = JSON.parse(raw) as Envelope;
    const age = Math.max(1, Math.round((Date.now() - (env.savedAt || mtime)) / 60000));
    const from = env.source ? env.source.split(/[\\/]/).pop() : "an unsaved document";
    const { choose } = await import("../ui/choice");
    const pick = await choose<"recover" | "discard">(`Recover unsaved work? (${from}, ~${age} min old)`, [
      { value: "recover", label: "Recover", hint: "restore the snapshot" },
      { value: "discard", label: "Discard", hint: "delete it" },
    ]);
    if (pick === "recover") {
      store.load(JSON.stringify(env.doc));
      toast("Recovered unsaved work, use Save As to keep it", { kind: "info", timeout: 8000 });
    } else if (pick === "discard") {
      await invoke("recovery_clear", { slot });
    }
    // pick === null (Esc): keep the snapshot for next launch, load nothing
  } catch (e) {
    console.warn("recovery check failed:", e);
  }
}
