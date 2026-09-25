// What a click takes when the viewport picks body first, then faces: the first
// click on a body takes the body, and a click on a body that is already chosen
// takes the face or edge under the cursor instead.

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

/** The body the cursor rests on and since when, the "or pause over it" half of
 *  the rule above: a click on a body the cursor has stayed on for the hover
 *  delay takes the part under it straight away. */
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

  /** The pointer moved with a button held, an orbit or a box. That is not a
   *  pause, so a hover from before it must not count after it (FI-3: the first
   *  click after an orbit took a face or the whole body depending on how long
   *  the orbit took). */
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
