// Painting visibility down a list of eyes: a drag gives every row it crosses the state its first click chose, within
// the starting category. A fast drag skips rows, so the gap between painted rows is filled; the target is a value, not
// a toggle, fixed at the press. `apply` is called once per step, so a flick over a hundred bodies is one write.

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
