// The window's half of the live session (live_session.py holds the shared state): publish what is open, collect
// an attached assistant's proposals and apply them through the store as one undo step with a rebuild. Nothing
// here may write without going through `apply`. One call per tick does both halves, slowly while nobody is
// attached. No Vue import: the headless suite reaches this file.

import type { CadDocument } from "../types";
import type { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import type { GuideSession } from "../ui/guide/guideSession";

/** Publish rate while nobody is attached: cheap, yet a newly connected assistant sees this window quickly. */
export const IDLE_INTERVAL_MS = 3000;

/** Rate while someone is attached, which bounds how stale the assistant's view of a person's edits can be. */
export const ACTIVE_INTERVAL_MS = 700;

/** How long fast ticking outlasts a guest's last sighting, longer than one tool call so thinking between calls
 *  does not drop back to the idle rate. */
export const ACTIVE_LINGER_MS = 20000;

/** Applied-proposal ids kept for publishing; an assistant checks for its own within seconds. */
export const APPLIED_MEMORY = 16;

/** Guide mode's own poll while a step or a wait is up. It carries no document,
 *  so it can be quick enough that Next feels answered. */
export const GUIDE_INTERVAL_MS = 200;

/** How long the guide poll keeps going after the guide went quiet, so the
 *  assistant's next step after a Next press shows without waiting for a document tick. */
export const GUIDE_LINGER_MS = 10000;

export interface LiveState {
  /** Is this window publishing at all? */
  sharing: boolean;
  /** Who is attached, by the name they gave. Empty while nobody is. */
  guests: string[];
  /** The last edit taken from an assistant, for a line of UI that says what just happened. */
  lastEdit: { note: string | null; by: string; at: number } | null;
}

type Listener = (s: LiveState) => void;

/** One proposal as the engine hands it over. Only the fields this reads. */
interface Proposal {
  id: string;
  name: string;
  note: string | null;
  document: CadDocument;
  /** The document session the assistant read, set by an engine that knows sessions. */
  doc?: string;
  /** A whole other document (the assistant's doc_new, doc_open or doc_set), not an edit of the open one. */
  replaces?: boolean;
}

export const REFUSED_WHILE_IMPORTING =
  "an import is still being read into the open document, so it was not replaced, nothing was applied; wait for the import or cancel it in History";

export class LiveSessionHost {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeDoc: (() => void) | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private revision = 0;
  private lastGuestSeen = 0;
  /** Ids of the proposals this window took, most recent last: the acknowledgement an assistant waits on. Not the
   *  revision (a person's edits move it) and not the document, which is migrated and normalised on the way in. */
  private applied: string[] = [];
  /** Proposals this window turned down, with why, so the assistant reports the reason instead of timing out. */
  private refused: { id: string; message: string }[] = [];
  private state: LiveState = { sharing: false, guests: [], lastEdit: null };
  private listeners = new Set<Listener>();
  private guide: GuideSession | null = null;
  private guideTimer: ReturnType<typeof setTimeout> | null = null;
  private guideInFlight: Promise<void> | null = null;
  private guideBusyAt = -Infinity;
  private unsubscribeGuide: (() => void) | null = null;

  constructor(
    private readonly store: DocumentStore,
    private readonly geometry: GeometryBackend,
    /** May an assistant's edit be applied? Injected for tests, and read at use so switching to "read" mid-session
     *  stops the very next proposal. */
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

  /** Guide mode rides this loop: its commands come back from `session_guide`
   *  and its state goes out in the next one, never in the document publish. */
  attachGuide(guide: GuideSession): void {
    this.unsubscribeGuide?.();
    this.guide = guide;
    let seen = guide.state;
    this.unsubscribeGuide = guide.subscribe((st) => {
      if (st === seen) return;
      seen = st;
      if (this.running) this.scheduleGuide(0);
    });
  }

  /** One guide round trip. Public so a test can step it by hand. */
  guideTick(): Promise<void> {
    if (!this.running || !this.guide) return Promise.resolve();
    if (this.guideInFlight) return this.guideInFlight;
    this.guideInFlight = this.runGuideTick();
    return this.guideInFlight;
  }

  private async runGuideTick(): Promise<void> {
    const guide = this.guide!;
    try {
      const res = await this.geometry.session?.("session_guide", { state: guide.state });
      const commands = res && Array.isArray(res["commands"]) ? (res["commands"] as unknown[]) : [];
      guide.apply(commands);
    } catch {
      // As for the document tick, a missed round trip is caught up by the next one.
    } finally {
      this.guideInFlight = null;
      if (guide.active) this.guideBusyAt = this.now();
      if (this.now() - this.guideBusyAt < GUIDE_LINGER_MS) this.scheduleGuide(GUIDE_INTERVAL_MS);
    }
  }

  private scheduleGuide(ms: number): void {
    if (!this.running) return;
    if (this.guideTimer !== null) {
      if (ms > 0) return;
      clearTimeout(this.guideTimer);
    }
    this.guideTimer = setTimeout(() => {
      this.guideTimer = null;
      void this.guideTick();
    }, ms);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Every change bumps the revision, not only an assistant's: the engine refuses a proposal whose base moved, so a
    // user dragging a face while an agent writes loses that race loudly. A counter, since a hash can wrongly match.
    this.unsubscribeDoc = this.store.onDocChange(() => {
      this.revision += 1;
    });
    this.emit({ sharing: true });
    void this.tick();
  }

  /** Stop publishing and tell the engine, so an assistant does not keep reading a part nobody has open. Best
   *  effort: the engine drops the host when the socket closes anyway. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.unsubscribeDoc?.();
    this.unsubscribeDoc = null;
    if (this.guideTimer !== null) {
      clearTimeout(this.guideTimer);
      this.guideTimer = null;
    }
    this.guide?.reset();
    this.emit({ sharing: false, guests: [] });
    await this.geometry.session?.("session_release").catch(() => null);
  }

  /** One publish-and-collect, public for tests. A call during one in flight awaits it, since the timer and an
   *  explicit caller can arrive together and the caller must not run on as if its round trip had completed. */
  tick(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runTick();
    return this.inFlight;
  }

  private async runTick(): Promise<void> {
    try {
      // The cut is the user's view, and an assistant's edit sends back the whole document it pulled: with the cut
      // in it, an edit made against an older publish would put back a cut the user has since moved or turned off.
      const { sectionView: _view, ...document } = this.store.toObject();
      const session = this.store.session;
      const res = await this.geometry.session?.("session_host", {
        doc: session.id,
        document,
        revision: this.revision,
        title: this.store.filePath ?? null,
        status: this.buildStatus(),
      });
      // Proposals collected for a document closed during the round trip are dropped, the assistant is told by the
      // next publish naming another document.
      if (res && session.alive) await this.collect(res);
      // Not awaited: an engine older than guide mode queues the op behind a build.
      void this.guideTick();
    } catch {
      // A dropped socket or engine restart is one missed tick; the next publish carries the whole document again.
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

  /** Take one assistant's edit through `loadDocument`, the file open path plus undo, so it is validated like a
   *  person's and one Ctrl+Z away. The doc change it emits bumps the revision in `start`, even for an identical
   *  document, so a no-op edit is acknowledged instead of timing out. */
  private apply(p: Proposal): void {
    if (!p || typeof p !== "object" || !p.document || !Array.isArray(p.document.features)) {
      // Skip a malformed proposal without bumping the revision, so the assistant's wait times out and says so.
      return;
    }
    if (p.doc !== undefined && p.doc !== this.store.session.id) return;
    if (!this.allowEdits()) {
      // Sharing read-only. The assistant is told via `canEdit` and refuses first; this is the check at the point of
      // action, the one that must be right if they disagree.
      this.lastGuestSeen = this.now();
      return;
    }
    // The import lands in whatever document is open when its read ends, so it would land in the assistant's.
    if (p.replaces && this.store.importRunning) {
      this.refused = [...this.refused, { id: p.id, message: REFUSED_WHILE_IMPORTING }].slice(-APPLIED_MEMORY);
      this.lastGuestSeen = this.now();
      return;
    }
    this.store.loadDocument(p.document, { replace: true });
    this.applied = [...this.applied, p.id].slice(-APPLIED_MEMORY);
    this.lastGuestSeen = this.now();
    this.emit({ lastEdit: { note: p.note ?? null, by: p.name, at: this.now() } });
  }

  /** The last build's outcome, enough for the assistant to know its edit broke something without its own rebuild. */
  private buildStatus(): Record<string, unknown> {
    const b = this.store.buildState;
    return {
      // Lets an assistant refuse an edit up front, naming the setting, instead of waiting out a silent drop.
      canEdit: this.allowEdits(),
      applied: this.applied,
      refused: this.refused,
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
