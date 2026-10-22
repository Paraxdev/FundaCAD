// Body first picking: the first click on a body takes the body, a click on a chosen body, or one the cursor paused
// over, takes the face or edge under the cursor.

export type SelectPolicy = "auto" | "faces" | "bodies";

export interface ClickState {
  /** the body under the cursor */
  bodyId: string | null;
  additive: boolean;
  /** bodies selected whole */
  selectedBodies: readonly string[];
  /** bodies that own a selected face or edge */
  drilledBodies: ReadonlySet<string>;
}

/** "body" selects the body whole, "part" lets the face and edge pick run. */
export function clickTakes(s: ClickState): "body" | "part" {
  if (s.bodyId === null) return "part";
  if (s.selectedBodies.length) {
    return !s.additive && s.selectedBodies.includes(s.bodyId) ? "part" : "body";
  }
  if (s.drilledBodies.has(s.bodyId)) return "part";
  return s.additive && s.drilledBodies.size ? "part" : "body";
}

/** A click on a body the cursor has rested on for the hover delay takes the part under it straight away. */
export class DwellIntent {
  private cur: { bodyId: string; since: number } | null = null;

  /** The cursor is over `bodyId`, or over no body. True when this starts a new
   *  pause, the moment to arm a timer for the relight. */
  hover(bodyId: string | null, now: number): boolean {
    if (bodyId === null) {
      this.cur = null;
      return false;
    }
    if (this.cur?.bodyId === bodyId) return false;
    this.cur = { bodyId, since: now };
    return true;
  }

  /** A drag with a button held (an orbit, a box) is not a pause, so an earlier hover must not count after it (FI-3: the
   *  first click after an orbit depended on how long the orbit took). */
  held(): void {
    this.cur = null;
  }

  clear(): void {
    this.cur = null;
  }

  isOn(bodyId: string): boolean {
    return this.cur?.bodyId === bodyId;
  }

  dwelt(bodyId: string, now: number, dwellMs: number): boolean {
    return this.cur?.bodyId === bodyId && now - this.cur.since >= dwellMs;
  }
}
