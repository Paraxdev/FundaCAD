// A document session owns every piece of work started for one open document. Ending it, on New, Open, discard or
// close, disposes all of it at once, so nothing of the old document ever lands in the next one.

export class SessionEnded extends Error {
  override readonly name = "SessionEnded";
  constructor(message = "the document this work belonged to was closed") {
    super(message);
  }
}

export const isSessionEnded = (e: unknown): boolean => e instanceof Error && e.name === "SessionEnded";

export type SessionEndReason = "new" | "open" | "discard" | "close" | "reload";

let seq = 0;
const newId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `doc-${Date.now().toString(36)}-${(++seq).toString(36)}`;

export class DocumentSession {
  readonly id = newId();
  private readonly controller = new AbortController();
  private disposers: (() => void)[] = [];
  private live = true;
  private why: SessionEndReason | null = null;

  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get alive(): boolean {
    return this.live;
  }
  get endedBy(): SessionEndReason | null {
    return this.why;
  }

  /** Runs `dispose` when the session ends, after every disposer registered later. Returns an unregister. */
  own(dispose: () => void): () => void {
    if (!this.live) {
      dispose();
      return () => {};
    }
    this.disposers.push(dispose);
    return () => {
      const i = this.disposers.indexOf(dispose);
      if (i >= 0) this.disposers.splice(i, 1);
    };
  }

  listen(off: () => void): () => void {
    return this.own(off);
  }

  /** Settles like `p` while the session lives, and rejects with SessionEnded once it has ended. */
  step<T>(p: Promise<T>): Promise<T> {
    if (!this.live) {
      p.catch(() => {});
      return Promise.reject(new SessionEnded());
    }
    return new Promise<T>((resolve, reject) => {
      const off = this.own(() => reject(new SessionEnded()));
      p.then(
        (v) => {
          off();
          if (this.live) resolve(v);
          else reject(new SessionEnded());
        },
        (e) => {
          off();
          reject(this.live ? e : new SessionEnded());
        },
      );
    });
  }

  timeout(fn: () => void, ms: number): () => void {
    if (!this.live) return () => {};
    const t = setTimeout(() => {
      off();
      if (this.live) fn();
    }, ms);
    const off = this.own(() => clearTimeout(t));
    return () => {
      clearTimeout(t);
      off();
    };
  }

  end(reason: SessionEndReason): void {
    if (!this.live) return;
    this.live = false;
    this.why = reason;
    this.controller.abort(new SessionEnded());
    const list = this.disposers.reverse();
    this.disposers = [];
    for (const dispose of list) {
      try {
        dispose();
      } catch (e) {
        // One broken part must not keep the rest of the document's work alive.
        console.error("A document session disposer failed:", e);
      }
    }
  }
}

export class SessionHost {
  private cur = new DocumentSession();
  private readonly beginListeners = new Set<(s: DocumentSession) => void>();

  get current(): DocumentSession {
    return this.cur;
  }

  /** Ends the current session synchronously, then starts the next one. */
  begin(reason: SessionEndReason): DocumentSession {
    this.cur.end(reason);
    this.cur = new DocumentSession();
    for (const fn of [...this.beginListeners]) fn(this.cur);
    return this.cur;
  }

  /** `fn` runs for every session begun from now on, the place a per document part registers its disposers. */
  onBegin(fn: (s: DocumentSession) => void): () => void {
    this.beginListeners.add(fn);
    return () => this.beginListeners.delete(fn);
  }
}
