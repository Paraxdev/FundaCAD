// Crash-recovery autosave. Rust owns the snapshot files (recovery_* commands) outside the webview's fs scope;
// this decides when: 30 s after the last edit, at most 2 min behind, only while dirty. A save clears the slot.

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

export function installAutosave(store: DocumentStore) {
  if (!isTauri()) return;
  let idleTimer: (() => void) | null = null;
  let oldestEdit: number | null = null;
  let writing = false;
  let failCount = 0; // consecutive autosave failures; warn once at 3, reset on success
  let warned = false;

  const write = async () => {
    idleTimer?.();
    idleTimer = null;
    oldestEdit = null;
    if (!store.dirty || writing) return;
    const session = store.session;
    writing = true;
    try {
      // One compact stringify, synchronously before any await, so the snapshot cannot see a half-applied edit.
      const env: Envelope = {
        source: store.filePath,
        savedAt: Date.now(),
        doc: store.toObject(),
      };
      const json = JSON.stringify(env);
      // The slot is the snapshot's own, even when another document is opened while the module loads.
      const slot = slotFor(store.filePath);
      const { invoke } = await import("@tauri-apps/api/core");
      // Its document was given up while the module loaded, and the slot was cleared for it.
      if (!session.alive) return;
      await invoke("recovery_write", { slot, json });
      failCount = 0;
      warned = false;
    } catch (e) {
      console.warn("autosave failed:", e);
      failCount++;
      if (failCount >= 3 && !warned) {
        warned = true;
        toast("Autosave keeps failing, unsaved work may not be recoverable", {
          kind: "error",
          timeout: 8000,
        });
      }
    } finally {
      writing = false;
    }
  };

  const schedule = () => {
    if (!store.dirty) return;
    const now = Date.now();
    if (oldestEdit == null) oldestEdit = now;
    idleTimer?.();
    // debounce on idle, but a busy session still snapshots every MAX_MS
    const wait = Math.min(IDLE_MS, Math.max(0, oldestEdit + MAX_MS - now));
    // The document's session owns the timer, so an edit of one document never times the next one's snapshot.
    idleTimer = store.session.timeout(() => void write(), wait);
  };
  store.sessions.onBegin(() => {
    idleTimer = null;
    oldestEdit = null;
  });
  // Work the user gave up (Discard, Don't save) is never offered at the next start. A document thrown away without
  // asking, by a plugin's doc_new, keeps its snapshot. Read while the session ends, before the path is replaced.
  const forgetOnEnd = (s: DocumentSession) =>
    s.own(() => {
      if (s.endedBy !== "reload" && store.dirty && store.givenUp) void clearRecovery(store.filePath);
    });
  forgetOnEnd(store.session);
  store.sessions.onBegin(forgetOnEnd);

  store.onDocChange(schedule);
  store.onMeta(schedule);
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
