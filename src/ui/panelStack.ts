import { SIZE as CUBE_SIZE, MARGIN as CUBE_MARGIN } from "../viewport/viewCube";
import { RIGHT_CARDS, clearOfCards, type Box } from "./promptPlacement";

const GAP = 12;
const MIN_HEIGHT = 120;

export interface Slot {
  id: string;
  top: number;
  /** Null when the panel keeps its natural height. */
  maxHeight: number | null;
}

/** Where the column starts: just under the view cube's square. */
export function stackTop(area: Box): number {
  return area.top + CUBE_MARGIN + CUBE_SIZE + GAP;
}

/** Stacks panels in order from `top`. When they would pass `bottom`, the tallest give up height first, never below
 *  `minHeight`, so short panels stay whole and the others scroll. */
export function layoutStack(
  panels: readonly { id: string; height: number }[],
  top: number,
  bottom: number,
  gap = GAP,
  minHeight = MIN_HEIGHT,
): Slot[] {
  const room = bottom - top - gap * Math.max(0, panels.length - 1);
  let cap = Infinity;
  if (panels.reduce((s, p) => s + p.height, 0) > room) {
    // Water level: every panel taller than it is cut to it, the rest of the room goes to the shorter ones.
    const hs = panels.map((p) => p.height).sort((a, b) => a - b);
    let left = room;
    for (let i = 0; i < hs.length; i++) {
      const share = left / (hs.length - i);
      if (hs[i]! >= share) {
        cap = share;
        break;
      }
      left -= hs[i]!;
    }
    cap = Math.max(minHeight, cap);
  }
  let y = top;
  return panels.map((p) => {
    const capped = p.height > cap;
    const slot = { id: p.id, top: Math.round(y), maxHeight: capped ? Math.floor(cap) : null };
    y += (capped ? cap : p.height) + gap;
    return slot;
  });
}

const open: { id: string; el: HTMLElement }[] = [];
let observer: ResizeObserver | null = null;
let frame = 0;

function natural(el: HTMLElement): number {
  return el.scrollHeight + (el.offsetHeight - el.clientHeight);
}

function place() {
  frame = 0;
  const layer = document.getElementById("float-layer");
  const area = (layer ?? document.body).getBoundingClientRect();
  const box: Box = { left: area.left, right: area.right, top: area.top, bottom: area.bottom };
  const top = stackTop(box);
  const free = clearOfCards(box, { top, bottom: box.bottom }, CUBE_MARGIN, 0);
  const slots = layoutStack(
    open.map((p) => ({ id: p.id, height: natural(p.el) })),
    top,
    box.bottom - CUBE_MARGIN,
  );
  slots.forEach((s, i) => {
    const el = open[i]!.el;
    const { style } = el;
    style.top = `${s.top}px`;
    style.right = `${Math.round(area.right - free.right)}px`;
    style.maxHeight = s.maxHeight === null ? "" : `${s.maxHeight}px`;
    el.toggleAttribute("data-capped", s.maxHeight !== null);
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
    open.push({ id, el });
    observer?.observe(el);
    for (const c of document.querySelectorAll(RIGHT_CARDS)) observer?.observe(c);
    place();
  },
  remove(id: string) {
    const i = open.findIndex((p) => p.id === id);
    if (i < 0) return;
    observer?.unobserve(open[i]!.el);
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
