// The store's async state for one document session. The rebuild loop and runBusy capture it at entry, so an old
// session's loop unwinding after the swap never touches the next document's counters.
import type { DocumentSession } from "./session";
import type { BusyState, RebuildState } from "./store";

export interface BusyOp {
  // Stable while the op runs, so History's row for it can cancel it and no other.
  key: number;
  state: BusyState;
  abort: AbortController;
  // The caller passed its own abort, so a cancel is its to carry out; no engine cancel is sent for it.
  external: boolean;
}

export class SessionState {
  /** Every runBusy op still running, newest last; the chip shows the newest. */
  busyOps: BusyOp[] = [];
  historyHeld = 0;
  // Import reads running for this document; one begun for an earlier document is counted in that one's state.
  reads = 0;
  rebuildTimer: number | null = null;
  rebuilding = false;
  rebuildQueued = false;
  // A caller arriving mid-rebuild awaits the same finish rather than a promise of its own.
  rebuildDrain: Promise<void> | null = null;
  /** The rebuild on the wire, and the id a supersede cancels. */
  inflight: { gen: number; id: string | null; cancelled: boolean; byUser?: boolean } | null = null;
  // The last preview-free build and its key: leaving a tool or undoing a refused commit shows it again without a rebuild.
  committedShown: { key: string; state: RebuildState } | null = null;
  /** A commit the kernel had not answered for yet, see verifyCommit. */
  provisional: { id: string; what: string; key: string } | null = null;
  /** Set when a preview is dropped or a refused commit undone, the only times
   *  the committed model may be shown again without asking the engine. */
  restoreArmed = false;
  paramChain: Promise<void> = Promise.resolve();
  paramPending = 0;

  constructor(readonly session: DocumentSession) {}
}
