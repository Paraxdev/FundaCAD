// Sharing the open document with an assistant.
//
// The MCP server in `mcp/` used to be unable to reach this window at all. It
// started an engine of its own, worked on a copy, and handed the result back as
// a file you had to open. Everything an agent did was a round trip through the
// disk, and nothing it did was visible while it did it.
//
// This is the window's half of the live session. The sidecar holds the shared
// state (sidecar/live_session.py); this publishes what is open, collects what
// an attached assistant has asked for, and applies it the same way a person's
// edit is applied — through the document store, as one undo step, with a
// rebuild after it. That last part is the whole point: an agent's edit is not a
// special kind of change, it is a change.
//
// WHAT THIS IS NOT: a channel the assistant can write down. It can only offer a
// document, and this decides whether to take it. The asymmetry lives in the
// sidecar and is enforced there; the reason it is worth restating here is that
// nothing in this file should ever grow a path that writes without going
// through `apply`.
//
// THE LOOP. One call per tick does both halves — publish and collect — because
// they are one round trip and the idle case (live editing on, nobody attached)
// is the common one. It ticks slowly until someone is there and quickly while
// they are, so an idle window costs one small message every few seconds.
//
// No Vue import, deliberately: this is reachable from the headless suite, and
// the surfaces that draw the indicator subscribe to it rather than the reverse.

import type { CadDocument } from "../types";
import type { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";

/** How often to publish while nobody is attached. Slow enough to be free, quick
 *  enough that an assistant that has just connected does not sit through a long
 *  wait before this window appears to it. */
export const IDLE_INTERVAL_MS = 3000;

/** …and while someone is. The assistant's own reads are what it waits on, so
 *  this bounds how stale its view of a person's edits can be. */
export const ACTIVE_INTERVAL_MS = 700;

/** How long after the last sighting of a guest to keep ticking quickly. Longer
 *  than one tool call, so an assistant thinking between calls does not drop the
 *  window back to the idle rate and then wait for it. */
export const ACTIVE_LINGER_MS = 20000;

/** How many applied-proposal ids to keep publishing. An assistant checks for its
 *  own within seconds; more than a handful is memory kept for a client that has
 *  already timed out. */
export const APPLIED_MEMORY = 16;

export interface LiveState {
  /** Is this window publishing at all? */
  sharing: boolean;
  /** Who is attached, by the name they gave. Empty while nobody is. */
  guests: string[];
  /** The last edit taken from an assistant, for a line of UI that says what
   *  just happened without the user having to watch the timeline. */
  lastEdit: { note: string | null; by: string; at: number } | null;
}

type Listener = (s: LiveState) => void;

/** One proposal as the sidecar hands it over. Only the fields this reads. */
interface Proposal {
  id: string;
  name: string;
  note: string | null;
  document: CadDocument;
}

export class LiveSessionHost {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeDoc: (() => void) | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private revision = 0;
  private lastGuestSeen = 0;
  /** Ids of the proposals this window has actually taken, most recent last.
   *
   *  This is the acknowledgement an assistant waits on, and it has to be an ID
   *  rather than "the revision moved" or "the document matches". The revision
   *  moves for a person's edits too, and the document CANNOT be compared: it is
   *  migrated and normalised on the way in and gains `version`, `suppressed` and
   *  the visibility overlays on the way back out, so what is published is never
   *  byte-identical to what was offered even when the edit was taken verbatim.
   *  Comparing them would have reported every single edit as a lost race. */
  private applied: string[] = [];
  private state: LiveState = { sharing: false, guests: [], lastEdit: null };
  private listeners = new Set<Listener>();

  constructor(
    private readonly store: DocumentStore,
    private readonly geometry: GeometryBackend,
    /** May an assistant's edit be applied? Injected rather than imported so the
     *  loop stays testable without localStorage, and read at the moment of use
     *  rather than captured at start, so turning the setting down to "read"
     *  mid-session stops the very next proposal. */
    private readonly allowEdits: () => boolean = () => true,
    /** Injected so a test can drive the loop without a real clock. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Current state, and a subscription. Fires immediately, like the store's own
   *  listeners, so a component that mounts mid-session paints correctly. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  get snapshot(): LiveState {
    return this.state;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // The revision is what makes an assistant's edit safe: it names the document
    // the edit was written against, and the sidecar refuses a proposal whose
    // base has moved. So it has to move on EVERY change, not only on the ones
    // an assistant caused — a user dragging a face while an agent writes an edit
    // is exactly the race this exists to lose loudly.
    //
    // A counter, not a hash: two documents that differ only in a field this
    // window has not thought about would hash the same, and "the same document"
    // is a claim with a wrong answer. "Something changed" has no wrong answer.
    this.unsubscribeDoc = this.store.onDocChange(() => {
      this.revision += 1;
    });
    this.emit({ sharing: true });
    void this.tick();
  }

  /** Stop publishing, and tell the sidecar so — an assistant that keeps reading
   *  a document no window is sharing would be measuring a part nobody has open.
   *  Best-effort: the sidecar drops the host when the socket closes anyway, so a
   *  failed release costs nothing but a few seconds of a stale answer. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.unsubscribeDoc?.();
    this.unsubscribeDoc = null;
    this.emit({ sharing: false, guests: [] });
    await this.geometry.session?.("session_release").catch(() => null);
  }

  /** One publish-and-collect. Public so a test can step the loop by hand.
   *
   *  A call made while one is already in flight AWAITS that one rather than
   *  returning at once. Returning early looked equivalent and is not: the timer
   *  and an explicit caller can arrive together, and a caller that got back an
   *  already-resolved promise would carry on as though a round trip it never
   *  saw had completed. */
  tick(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runTick();
    return this.inFlight;
  }

  private async runTick(): Promise<void> {
    try {
      const res = await this.geometry.session?.("session_host", {
        document: this.store.toObject(),
        revision: this.revision,
        title: this.store.filePath ?? null,
        status: this.buildStatus(),
      });
      if (res) await this.collect(res);
    } catch {
      // A dropped socket, a sidecar mid-restart. The reconnect is the geometry
      // client's job; here it is one missed tick, and the next one re-publishes
      // from scratch because every publish carries the whole document.
    } finally {
      this.inFlight = null;
      this.schedule();
    }
  }

  private schedule(): void {
    if (!this.running) return;
    const active = this.now() - this.lastGuestSeen < ACTIVE_LINGER_MS;
    this.timer = setTimeout(() => void this.tick(), active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS);
  }

  private async collect(res: Record<string, unknown>): Promise<void> {
    const guests = Array.isArray(res["guests"]) ? (res["guests"] as string[]) : [];
    if (guests.length) this.lastGuestSeen = this.now();
    this.emit({ guests });

    const proposals = Array.isArray(res["proposals"]) ? (res["proposals"] as Proposal[]) : [];
    for (const p of proposals) this.apply(p);
  }

  /** Take one assistant's edit.
   *
   *  Through `loadDocument`, which is the same path a file open takes: it pushes
   *  undo, migrates, and schedules a rebuild. So the edit is one Ctrl+Z away and
   *  it goes through the same validation a person's does. Anything that bypassed
   *  that to be faster would be an edit the user cannot take back.
   *
   *  Nothing bumps the revision here. `loadDocument` emits a document change
   *  and the subscription in `start` counts it, which is also what counts a
   *  person's edits — one counter, one place, so the two can never drift into
   *  disagreeing about whether the document moved. It fires even when the
   *  proposed document is identical to what was already open, which is what
   *  lets an assistant's no-op edit be acknowledged instead of timing out. */
  private apply(p: Proposal): void {
    if (!p || typeof p !== "object" || !p.document || !Array.isArray(p.document.features)) {
      // A malformed proposal is not something to guess at. Skipping it without
      // bumping the revision lets the assistant's own wait time out and say so,
      // which is more useful than this window silently accepting nothing.
      return;
    }
    if (!this.allowEdits()) {
      // The window is sharing read-only. The assistant is told the same thing
      // through `canEdit` in the published status and refuses before it gets
      // this far — this is the check at the point of ACTION, which is the one
      // that has to be right if the two ever disagree.
      this.lastGuestSeen = this.now();
      return;
    }
    this.store.loadDocument(p.document);
    // Bounded: this is a receipt an assistant checks within seconds of offering,
    // not a history. Anything older than the last handful is being kept for a
    // client that has already given up waiting.
    this.applied = [...this.applied, p.id].slice(-APPLIED_MEMORY);
    this.lastGuestSeen = this.now();
    this.emit({ lastEdit: { note: p.note ?? null, by: p.name, at: this.now() } });
  }

  /** What the assistant is told about the last build: whether it worked and
   *  which feature did not. Enough for it to know its edit broke something
   *  without asking for a whole rebuild of its own. */
  private buildStatus(): Record<string, unknown> {
    const b = this.store.buildState;
    return {
      // Published so an assistant can refuse an edit up front with a message
      // that names the setting, instead of offering one that is dropped in
      // silence and waiting out its own timeout to find out.
      canEdit: this.allowEdits(),
      applied: this.applied,
      building: b.building,
      errorFeatureId: b.errorFeatureId ?? null,
      errorMessage: b.errorMessage ?? null,
      bodies: b.result?.bodies?.length ?? 0,
    };
  }

  private emit(patch: Partial<LiveState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }
}
