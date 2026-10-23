import { SIZE as CUBE_SIZE, MARGIN as CUBE_MARGIN } from "../viewport/viewCube";
import { RIGHT_CARDS, clearOfCards, type Box } from "./promptPlacement";

const GAP = 12;
const MIN_HEIGHT = 120;

/** A panel's own scroller keeps at least this much of itself in view, so its form stays usable. */
const SCROLLER_MIN = 140;

export interface Slot {
  id: string;
  top: number;
  /** Null when the panel keeps its natural height. */
  maxHeight: number | null;
  /** Shrunk to its header to leave room for the others, a click opens it again. */
  folded?: true;
}

export interface StackPanel {
  id: string;
  height: number;
  /** The least this panel is cut to, `minHeight` when unset. */
  floor?: number | undefined;
  /** Its header's height, when it can fold to it. */
  head?: number | undefined;
  /** Higher was used more recently, folds go lowest first and never to the highest. Defaults to the order. */
  rank?: number;
}

/** Where the column starts: just under the view cube's square. */
export function stackTop(area: Box): number {
  return area.top + CUBE_MARGIN + CUBE_SIZE + GAP;
}

/** The water level that fills `left`: each panel takes it, clamped between its floor and its height. */
function waterLevel(items: readonly { h: number; f: number }[], left: number): number {
  const at = (l: number) => items.reduce((s, p) => s + Math.min(p.h, Math.max(p.f, l)), 0);
  if (at(0) >= left) return 0;
  let lo = 0;
  for (const x of [...new Set(items.flatMap((p) => [p.f, p.h]))].sort((a, b) => a - b)) {
    if (x > lo && at(x) >= left) {
      const slope = items.filter((p) => p.f <= lo && p.h >= x).length;
      return lo + (left - at(lo)) / slope;
    }
    lo = Math.max(lo, x);
  }
  return Infinity;
}

/** Stacks panels in order from `top`. When they would pass `bottom`, the tallest give up height first, never below
 *  their floor, so short panels stay whole and the others scroll. When even the floors do not fit, the least recently
 *  used panels fold to their headers, and only then does the column pass the bottom. */
export function layoutStack(
  panels: readonly StackPanel[],
  top: number,
  bottom: number,
  gap = GAP,
  minHeight = MIN_HEIGHT,
): Slot[] {
  const room = bottom - top - gap * Math.max(0, panels.length - 1);
  const folded = new Set<number>();
  let level = Infinity;
  if (panels.reduce((s, p) => s + p.height, 0) > room) {
    const floors = panels.map((p) => Math.min(p.height, p.floor ?? minHeight));
    const rank = (i: number) => panels[i]!.rank ?? i;
    const byUse = panels.map((_, i) => i).sort((a, b) => rank(a) - rank(b));
    const need = () => floors.reduce((s, f, i) => s + (folded.has(i) ? panels[i]!.head! : f), 0);
    for (const i of byUse.slice(0, -1)) {
      if (need() <= room) break;
      const head = panels[i]!.head;
      if (head !== undefined && head < floors[i]!) folded.add(i);
    }
    const left = room - [...folded].reduce((s, i) => s + panels[i]!.head!, 0);
    const rest = panels.map((p, i) => ({ h: p.height, f: floors[i]! })).filter((_, i) => !folded.has(i));
    level = waterLevel(rest, left);
  }
  let y = top;
  return panels.map((p, i) => {
    if (folded.has(i)) {
      const slot: Slot = { id: p.id, top: Math.round(y), maxHeight: Math.floor(p.head!), folded: true };
      y += p.head! + gap;
      return slot;
    }
    const cap = Math.max(level, Math.min(p.height, p.floor ?? minHeight));
    const capped = p.height > cap;
    const slot = { id: p.id, top: Math.round(y), maxHeight: capped ? Math.floor(cap) : null };
    y += (capped ? cap : p.height) + gap;
    return slot;
  });
}

const open: { id: string; el: HTMLElement; used: number; onClick: (e: MouseEvent) => void }[] = [];
let observer: ResizeObserver | null = null;
let frame = 0;
let uses = 0;

function natural(el: HTMLElement): number {
  return el.scrollHeight + (el.offsetHeight - el.clientHeight);
}

/** A panel whose step scrolls inside it ([data-panel-scroll]) keeps its fixed rows and some of the step. */
function scrollerFloor(el: HTMLElement): number | undefined {
  const inner = el.querySelector<HTMLElement>("[data-panel-scroll]");
  if (!inner) return undefined;
  return Math.max(MIN_HEIGHT, el.offsetHeight - inner.offsetHeight + Math.min(inner.scrollHeight, SCROLLER_MIN));
}

function header(el: HTMLElement): number | undefined {
  const first = el.firstElementChild;
  if (!first) return undefined;
  const cs = getComputedStyle(el);
  const bottom = first.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
  return Math.ceil(bottom + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0));
}

function place() {
  frame = 0;
  // A panel with its own scroller reports the height it was last capped to, so measure it uncapped.
  for (const p of open) p.el.style.maxHeight = "";
  const layer = document.getElementById("float-layer");
  const area = (layer ?? document.body).getBoundingClientRect();
  const box: Box = { left: area.left, right: area.right, top: area.top, bottom: area.bottom };
  const top = stackTop(box);
  const free = clearOfCards(box, { top, bottom: box.bottom }, CUBE_MARGIN, 0);
  const slots = layoutStack(
    open.map((p) => ({
      id: p.id,
      height: natural(p.el),
      floor: scrollerFloor(p.el),
      head: header(p.el),
      rank: p.used,
    })),
    top,
    box.bottom - CUBE_MARGIN,
  );
  slots.forEach((s, i) => {
    const el = open[i]!.el;
    const { style } = el;
    style.top = `${s.top}px`;
    style.right = `${Math.round(area.right - free.right)}px`;
    style.maxHeight = s.maxHeight === null ? "" : `${s.maxHeight}px`;
    el.toggleAttribute("data-capped", s.maxHeight !== null && !s.folded);
    el.toggleAttribute("data-folded", !!s.folded);
  });
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(place);
}

export const panelStack = {
  add(id: string, el: HTMLElement) {
    if (!open.length) {
      observer = new ResizeObserver(schedule);
      window.addEventListener("resize", schedule);
    }
    const entry = {
      id,
      el,
      used: ++uses,
      onClick: (e: MouseEvent) => {
        if (!el.hasAttribute("data-folded") || (e.target as Element | null)?.closest("button")) return;
        entry.used = ++uses;
        place();
      },
    };
    open.push(entry);
    el.addEventListener("click", entry.onClick);
    observer?.observe(el);
    for (const c of document.querySelectorAll(RIGHT_CARDS)) observer?.observe(c);
    place();
  },
  remove(id: string) {
    const i = open.findIndex((p) => p.id === id);
    if (i < 0) return;
    const { el, onClick } = open[i]!;
    observer?.unobserve(el);
    el.removeEventListener("click", onClick);
    el.removeAttribute("data-folded");
    open.splice(i, 1);
    if (open.length) return place();
    observer?.disconnect();
    observer = null;
    window.removeEventListener("resize", schedule);
    cancelAnimationFrame(frame);
    frame = 0;
  },
  ids: () => open.map((p) => p.id),
};
