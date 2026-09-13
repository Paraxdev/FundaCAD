// Clicking the history: one click edits a step, a double-click PEEKS at the model
// as it stood at that step, and Escape puts the model back where it was before
// the peek.
//
// Vue-free, so the two things that are easy to get wrong are testable without a
// component: the first click of a double-click must not open an editor, and
// Escape must return to the state before the peek (the tip, or wherever the
// marker was), not to "the end" regardless.

/** How long a click waits to find out whether it is the first half of a double.
 *  Short enough that an edit still feels immediate; the OS double-click window
 *  is usually 400 to 500 ms but a deliberate double lands well inside 300. */
export const DOUBLE_CLICK_MS = 280;

/** Where the history marker stood before a peek. "end" rather than the number
 *  it happened to be: a peek that began at the tip returns to the tip, even when
 *  a feature was added while peeking and the tip has moved. */
type Mark = number | "end";

export interface RollbackAccess {
  /** The current rollback index; equal to `length()` when at the tip. */
  get(): number;
  set(i: number): void;
  length(): number;
}

export class HistoryPeek {
  private before: Mark | null = null;
  /** The index this peek last set, so a move made any other way (dragging the
   *  marker, the step buttons, undo) is recognised and ends the peek. */
  private placed: number | null = null;

  constructor(private readonly rollback: RollbackAccess) {}

  get active(): boolean {
    return this.before !== null;
  }

  /** Double-click on step `i`: show the model as of that step, inclusive. The
   *  same step again releases the peek. */
  peek(i: number): void {
    const here = i + 1;
    if (this.active && this.rollback.get() === here) {
      this.release();
      return;
    }
    if (!this.active) {
      const now = this.rollback.get();
      this.before = now >= this.rollback.length() ? "end" : now;
    }
    this.placed = here;
    this.rollback.set(here);
  }

  /** Put the model back as it was before the peek. False when there is nothing
   *  to release, so the caller leaves Escape to whoever else wants it. */
  release(): boolean {
    if (this.before === null) return false;
    const to = this.before === "end" ? this.rollback.length() : this.before;
    this.before = null;
    this.placed = null;
    this.rollback.set(to);
    return true;
  }

  /** The rollback index changed. If this peek did not do it, the user moved the
   *  marker themselves, and that position is theirs: Escape must not undo it. */
  observe(index: number): void {
    if (this.before !== null && index !== this.placed) {
      this.before = null;
      this.placed = null;
    }
  }
}

/** Tells a single click from the first half of a double. The single action runs
 *  only once the double-click window has passed without a second click. */
export class ClickOrDouble<K> {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly single: (key: K) => void,
    private readonly double: (key: K) => void,
    private readonly delay = DOUBLE_CLICK_MS,
  ) {}

  /** A click event. `detail` is the browser's click count; a click with detail 0
   *  came from the keyboard or a script, has no double to wait for, and acts now. */
  click(key: K, detail: number): void {
    this.cancel();
    if (detail === 0) {
      this.single(key);
      return;
    }
    if (detail >= 2) return; // the dblclick event that follows does the work
    this.timer = setTimeout(() => {
      this.timer = null;
      this.single(key);
    }, this.delay);
  }

  dblclick(key: K): void {
    this.cancel();
    this.double(key);
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
