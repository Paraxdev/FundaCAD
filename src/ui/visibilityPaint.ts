// Painting visibility down a list of eyes.
//
// Press on a row's eye and drag across the rows below or above it, and every row
// the pointer passes gets the SAME state the first click gave: start on a shown
// row and the drag hides, start on a hidden one and it shows, however each row
// was set before. Only rows of the category the drag started in are touched, so
// a sketch drag running on into the bodies leaves the bodies alone. Alt-clicking
// an eye shows only that row in its category, and Alt-clicking it again puts the
// category back the way it was.
//
// Two things a naive version gets wrong, and why this is its own module:
//
//   * A fast drag SKIPS rows. The browser reports the pointer about once a frame,
//     so a flick from the first row to the thirtieth enters the thirtieth and
//     never the twenty-eight between. Every row between the last one painted and
//     the one entered is painted with it, in the order they are drawn.
//   * A row that is already in the target state is still in the run, but must not
//     flip. The target is decided once, at the press, and applied as a value
//     rather than as a toggle.
//
// Holds no document and no Vue: `apply` is the caller's batched setter, called
// ONCE per gesture step with every row that step changes, so a flick across a
// hundred bodies, or a solo over all of them, is one write rather than a hundred
// re-renders.

/** Set each row of `category` in `changes` to its state, as one write. */
export type ApplyVisibility = (category: string, changes: ReadonlyMap<string, boolean>) => void;

function all(keys: readonly string[], visible: boolean): Map<string, boolean> {
  return new Map(keys.map((k) => [k, visible]));
}

interface Stroke {
  category: string;
  target: boolean;
  last: string;
}

interface Solo {
  category: string;
  key: string;
  /** Each row's state before the solo, which a second Alt-click restores. */
  before: ReadonlyMap<string, boolean>;
}

export class VisibilityPaint {
  private stroke: Stroke | null = null;
  private solo: Solo | null = null;

  constructor(private readonly apply: ApplyVisibility) {}

  /** A drag is in progress. */
  get active(): boolean {
    return this.stroke !== null;
  }

  /** Press on the eye of `key`, currently `visible`: it takes the opposite state
   *  and every row the drag goes on to cross takes the same. */
  begin(category: string, key: string, visible: boolean): void {
    // any ordinary change in a category makes its remembered pre-solo state stale
    if (this.solo?.category === category) this.solo = null;
    this.stroke = { category, target: !visible, last: key };
    this.apply(category, all([key], !visible));
  }

  /** The pointer entered row `key`. `order` is the category's rows as drawn now. */
  over(category: string, key: string, order: readonly string[]): void {
    const s = this.stroke;
    if (!s || s.category !== category || s.last === key) return;
    const from = order.indexOf(s.last);
    const to = order.indexOf(key);
    let run: string[];
    if (from < 0 || to < 0) {
      run = [key];
    } else if (to > from) {
      run = order.slice(from + 1, to + 1);
    } else {
      run = order.slice(to, from).reverse();
    }
    s.last = key;
    this.apply(category, all(run, s.target));
  }

  /** The button came up, or the drag was lost. Safe to call when nothing is in
   *  progress, which is how a stray pointerup from anywhere in the window ends it. */
  end(): void {
    this.stroke = null;
  }

  /** Alt-click on the eye of `key`. `rows` is every row of the category with its
   *  current state, including rows not drawn (a body inside a collapsed folder is
   *  still one of the bodies a solo hides). */
  toggleSolo(category: string, key: string, rows: ReadonlyMap<string, boolean>): void {
    const held = this.solo;
    if (held && held.category === category && held.key === key) {
      this.solo = null;
      this.apply(category, held.before);
      return;
    }
    this.solo = { category, key, before: new Map(rows) };
    const changes = all([...rows.keys()], false);
    changes.set(key, true); // last, so a solo'd key that is also in `rows` ends up shown
    this.apply(category, changes);
  }
}
