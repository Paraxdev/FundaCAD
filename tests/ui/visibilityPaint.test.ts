// Dragging across eyes to show or hide many rows (src/ui/visibilityPaint.ts).
import { describe, expect, it } from "vitest";
import { VisibilityPaint } from "../../src/ui/visibilityPaint";

/** A category's rows with their state, and every write the controller made. */
function harness(rows: Record<string, Record<string, boolean>>) {
  const writes: { category: string; changes: [string, boolean][] }[] = [];
  const paint = new VisibilityPaint((category, changes) => {
    writes.push({ category, changes: [...changes] });
    for (const [k, v] of changes) rows[category]![k] = v;
  });
  const order = (c: string) => Object.keys(rows[c]!);
  return { paint, writes, rows, order };
}

describe("VisibilityPaint", () => {
  it("gives the pressed row the opposite state and the run the same state", () => {
    const h = harness({ s: { a: true, b: false, c: true, d: true } });
    h.paint.begin("s", "a", true);
    h.paint.over("s", "b", h.order("s"));
    h.paint.over("s", "c", h.order("s"));
    h.paint.end();
    // b was already hidden: it stays hidden rather than flipping back on
    expect(h.rows.s).toEqual({ a: false, b: false, c: false, d: true });
  });

  it("starting on a hidden row shows the run", () => {
    const h = harness({ s: { a: false, b: true, c: false } });
    h.paint.begin("s", "a", false);
    h.paint.over("s", "c", h.order("s"));
    expect(h.rows.s).toEqual({ a: true, b: true, c: true });
  });

  it("paints every row a fast drag skipped, in one write, downwards and upwards", () => {
    const h = harness({ s: { a: true, b: true, c: true, d: true, e: true } });
    h.paint.begin("s", "a", true);
    h.paint.over("s", "e", h.order("s")); // one frame: a straight to e
    expect(h.writes.at(-1)).toEqual({
      category: "s", changes: [["b", false], ["c", false], ["d", false], ["e", false]],
    });

    const up = harness({ s: { a: true, b: true, c: true, d: true, e: true } });
    up.paint.begin("s", "e", true);
    up.paint.over("s", "b", up.order("s"));
    expect(up.writes.at(-1)).toEqual({ category: "s", changes: [["d", false], ["c", false], ["b", false]] });
  });

  it("leaves rows of another category alone", () => {
    const h = harness({ s: { a: true, b: true }, bodies: { x: true } });
    h.paint.begin("s", "a", true);
    h.paint.over("bodies", "x", h.order("bodies"));
    expect(h.rows.bodies).toEqual({ x: true });
    // and coming back into the category carries on from the last painted row
    h.paint.over("s", "b", h.order("s"));
    expect(h.rows.s).toEqual({ a: false, b: false });
  });

  it("does nothing after the button comes up", () => {
    const h = harness({ s: { a: true, b: true } });
    h.paint.begin("s", "a", true);
    h.paint.end();
    expect(h.paint.active).toBe(false);
    h.paint.over("s", "b", h.order("s"));
    expect(h.rows.s!.b).toBe(true);
  });

  it("Alt-click shows only that row, and a second Alt-click restores the rest", () => {
    const h = harness({ s: { a: true, b: false, c: true } });
    const state = () => new Map(Object.entries(h.rows.s!));
    h.paint.toggleSolo("s", "b", state());
    expect(h.rows.s).toEqual({ a: false, b: true, c: false });
    h.paint.toggleSolo("s", "b", state());
    expect(h.rows.s).toEqual({ a: true, b: false, c: true });
    // a solo and its restore are one write each, not one per row
    expect(h.writes).toHaveLength(2);
  });

  it("an ordinary change after a solo forgets it, so a later Alt-click solos again", () => {
    const h = harness({ s: { a: true, b: true, c: true } });
    const state = () => new Map(Object.entries(h.rows.s!));
    h.paint.toggleSolo("s", "a", state());
    h.paint.begin("s", "c", false); // show c by hand
    h.paint.end();
    h.paint.toggleSolo("s", "a", state());
    // a fresh solo, not a restore of the stale pre-solo state
    expect(h.rows.s).toEqual({ a: true, b: false, c: false });
  });
});
