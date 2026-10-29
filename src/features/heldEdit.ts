/** Tells watchers when a tool's held edit (let go of, not entered) turns on or off. */
export class HeldSignal {
  private shown = false;
  private readonly watchers = new Set<() => void>();

  on(fn: () => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  sync(held: boolean) {
    if (held === this.shown) return;
    this.shown = held;
    for (const fn of this.watchers) fn();
  }
}
