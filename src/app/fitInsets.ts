import { LEFT_CARDS, RIGHT_CARDS } from "../ui/promptPlacement";
import type { Insets } from "../viewport/navigator/pose";

type Edges = { left: number; right: number };

/** Pixels of `canvas` the left cards and tool rail, and the right column, cover. */
export function insetsFrom(canvas: Edges, left: readonly Edges[], right: readonly Edges[]): Insets {
  const l = left.reduce((m, r) => Math.max(m, r.right - canvas.left), 0);
  const r = right.reduce((m, c) => Math.max(m, canvas.right - c.left), 0);
  return { left: l, right: r, top: 0, bottom: 0 };
}

const rects = (sel: string) =>
  typeof document === "undefined" ? [] : [...document.querySelectorAll(sel)].map((o) => o.getBoundingClientRect());

/** Measured live, so a collapsed card or a wider column is followed. */
export function measureFitInsets(canvas: Element): Insets {
  return insetsFrom(canvas.getBoundingClientRect(), rects(LEFT_CARDS), rects(RIGHT_CARDS));
}
