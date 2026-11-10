import { cubeSize, MARGIN as CUBE_MARGIN } from "../viewport/viewCube";
import { onA11yPrefsChange } from "./a11yPrefs";
import { underZoom } from "./anchor";
import { pageZoom } from "./interfaceSize";
import { LEFT_CARDS, RIGHT_CARDS, cardRects, promptInsets, seenRect, type Box } from "./promptPlacement";

const GAP = 12;
const MIN_HEIGHT = 120;

/** A panel's own scroller keeps at least this much of itself in view, so its form stays usable. */
const SCROLLER_MIN = 140;
/** The least of its scroller a panel keeps once even the floors would pass the window's bottom. */
const SCROLLER_LEAST = 40;

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
  /** What it is cut to when the floors do not fit even after the folds, so the column stays in the window. `floor` when unset. */
  least?: number | undefined;
  /** Its header's height, when it can fold to it. */
  head?: number | undefined;
  /** Higher was used more recently, folds go lowest first and never to the highest. Defaults to the order. */
  rank?: number;
}

/** Where the column starts: just under the view cube's square. */
export function stackTop(area: Box): number {
  return area.top + CUBE_MARGIN + cubeSize() + GAP;
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
  let floors = panels.map((p) => Math.min(p.height, p.floor ?? minHeight));
  if (panels.reduce((s, p) => s + p.height, 0) > room) {
    const rank = (i: number) => panels[i]!.rank ?? i;
    const byUse = panels.map((_, i) => i).sort((a, b) => rank(a) - rank(b));
    const need = () => floors.reduce((s, f, i) => s + (folded.has(i) ? panels[i]!.head! : f), 0);
    for (const i of byUse.slice(0, -1)) {
      if (need() <= room) break;
      const head = panels[i]!.head;
      if (head !== undefined && head < floors[i]!) folded.add(i);
    }
    if (need() > room) floors = panels.map((p, i) => Math.min(floors[i]!, p.least ?? floors[i]!));
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
    const cap = Math.max(level, floors[i]!);
    const capped = p.height > cap;
    const slot = { id: p.id, top: Math.round(y), maxHeight: capped ? Math.floor(cap) : null };
    y += (capped ? cap : p.height) + gap;
    return slot;
  });
}

// `min` holds the inline min-width a panel had before place() capped it to its column, `cap` the one place() set.
interface Open {
  id: string;
  el: HTMLElement;
  used: number;
  min?: string | undefined;
  cap?: string | undefined;
  onClick: (e: MouseEvent) => void;
}
const open: Open[] = [];
let observer: ResizeObserver | null = null;
let arrivals: MutationObserver | null = null;
let offPrefs: (() => void) | null = null;
let frame = 0;
let uses = 0;

/** Gives a capped panel its inline min-width back, unless another writer replaced the cap since. */
function uncap(p: Open) {
  if (p.min !== undefined && p.el.style.minWidth === p.cap) p.el.style.minWidth = p.min;
  p.min = p.cap = undefined;
}

function natural(el: HTMLElement): number {
  return el.scrollHeight + (el.offsetHeight - el.clientHeight);
}

/** A panel whose step scrolls inside it ([data-panel-scroll]) keeps its fixed rows and some of the step. */
function scrollerFloors(el: HTMLElement): { floor?: number; least?: number } {
  const inner = el.querySelector<HTMLElement>("[data-panel-scroll]");
  if (!inner) return {};
  const fixed = el.offsetHeight - inner.offsetHeight;
  const keep = (step: number) => Math.max(MIN_HEIGHT, fixed + Math.min(inner.scrollHeight, step));
  return { floor: keep(SCROLLER_MIN), least: keep(SCROLLER_LEAST) };
}

function header(el: HTMLElement, z: number): number | undefined {
  const first = el.firstElementChild;
  if (!first) return undefined;
  const cs = getComputedStyle(el);
  const bottom = (first.getBoundingClientRect().bottom - el.getBoundingClientRect().top) / z;
  return Math.ceil(bottom + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0));
}

export interface Column {
  top: number;
  bottom: number;
  free: Box;
}

export interface Cards {
  left: readonly Box[];
  right: readonly Box[];
}

const span = (c: Column) => c.free.right - c.free.left;

/** The height a card above a shelf is cut to so the shelf offers `need` down to `bottom`, never under the card's own
 *  `least`. Null when the shelf already offers it or the card has nothing to give. */
export function yieldedHeight(
  card: { top: number; bottom: number },
  bottom: number,
  need: number,
  least: number,
  gap: number,
): number | null {
  const cut = Math.max(least, bottom - need - gap - card.top);
  return cut < card.bottom - card.top ? cut : null;
}

/** The part of `box` a column from `top` down can use without sliding under a card. */
function clear(box: Box, cards: Cards, top: number): Box {
  const { left, right } = promptInsets(box, { top, bottom: box.bottom }, cards, CUBE_MARGIN, 0);
  return { ...box, left: box.left + left, right: box.right - right };
}

/** The columns a panel can take: left of the right cards, then each shelf at least MIN_HEIGHT tall right of the cards
 *  beside it, highest first. `box`, `cards` and the columns share one pixel space. */
export function stackColumns(box: Box, cards: Cards): Column[] {
  const top = stackTop(box);
  const bottom = box.bottom - CUBE_MARGIN;
  const list = [{ top, bottom, free: clear(box, cards, top) }];
  const tops = [top, ...cards.right.map((c) => c.bottom + CUBE_MARGIN)];
  for (const t of [...new Set(tops)].sort((a, b) => a - b)) {
    if (t < top || bottom - t < MIN_HEIGHT) continue;
    const rail = clear(box, cards, t).left;
    const left = cards.right
      .filter((c) => c.right > c.left && c.bottom > t)
      .reduce((l, c) => Math.max(l, Math.round(c.right + CUBE_MARGIN)), rail);
    list.push({ top: t, bottom, free: { ...box, left, right: box.right - CUBE_MARGIN } });
  }
  return list;
}

/** stackColumns under the root zoom `z` (pageZoom): the layer and the cards come in window pixels, the columns go out
 *  in the CSS pixels that the panels' top, right and max-height take. */
export function columnsUnderZoom(area: Box, cards: Cards, z: number): Column[] {
  const under = (bs: readonly Box[]) => bs.map((b) => underZoom(b, z));
  return stackColumns(underZoom(area, z), { left: under(cards.left), right: under(cards.right) });
}

/** Each panel's column: the first its min-width fits, else the widest. A lower shelf in use reaches across the columns
 *  above it, so each of those stops short of it, and one cut under MIN_HEIGHT hands its panels on to the next. */
function assign(cols: Column[], mins: readonly number[]): Column[] {
  const floor = cols[0]!.bottom;
  let live = cols;
  for (;;) {
    const widest = live.reduce((w, c) => (span(c) > span(w) ? c : w));
    const at = mins.map((min) => live.find((c) => span(c) >= min) ?? widest);
    const used = live.filter((c) => at.includes(c));
    for (const c of used) {
      c.bottom = floor;
      for (const d of used)
        if (d.top > c.top && d.free.left < c.free.right && c.free.left < d.free.right)
          c.bottom = Math.min(c.bottom, d.top - GAP);
    }
    // The lowest column in use is never cut, so `live` never runs out.
    const short = used.find((c) => c.bottom < floor && c.bottom - c.top < MIN_HEIGHT);
    if (!short) return at;
    live = live.filter((c) => c !== short);
  }
}

/** Gives each card whose list scrolls inside it ([data-card-scroll]) its whole height back, and returns those cards
 *  with their list and its scroll. A card may be cut to give the shelf under it room. */
function uncut() {
  const lists = [...document.querySelectorAll<HTMLElement>(RIGHT_CARDS)].flatMap((card) => {
    const list = card.querySelector<HTMLElement>("[data-card-scroll]");
    return list ? [[card, list, list.scrollTop] as const] : [];
  });
  for (const [card] of lists) card.style.maxHeight = "";
  return lists;
}

function place() {
  frame = 0;
  // The browser clamps a list's scroll to its uncut box at the next layout, so it is put back once the cut is decided.
  const lists = uncut();
  // A panel with its own scroller reports the height it was last capped to, so measure it uncapped.
  for (const p of open) {
    p.el.style.maxHeight = "";
    p.el.style.maxWidth = "";
    uncap(p);
  }
  const z = pageZoom();
  const area = (document.getElementById("float-layer") ?? document.body).getBoundingClientRect();
  // The root's clientWidth stays in window pixels under its own zoom, like the rects.
  const viewWidth = document.documentElement.clientWidth / z;
  const mins = open.map((p) => parseFloat(getComputedStyle(p.el).minWidth) || 0);
  const uncapped = open.map((p) => scrollerFloors(p.el));
  let floors = uncapped;
  const lay = () => {
    const cols = columnsUnderZoom(area, { left: cardRects(LEFT_CARDS), right: cardRects(RIGHT_CARDS) }, z);
    const base = cols[0]!.bottom;
    return { cols, base, at: assign(cols, mins) };
  };
  // Right anchored and under the float layer, so a panel wider than the span would hide under the rail or a card.
  // Only a panel that is too wide gets the cap, so a panel's own min and max width hold otherwise.
  const fit = (l: ReturnType<typeof lay>) => {
    for (const p of open) {
      p.el.style.maxWidth = "";
      uncap(p);
    }
    open.forEach((p, i) => {
      const room = Math.max(0, Math.floor(span(l.at[i]!)));
      if (mins[i]! > room) {
        p.min = p.el.style.minWidth;
        p.el.style.minWidth = `${room}px`;
        p.cap = p.el.style.minWidth;
      }
      if (p.el.offsetWidth > room) p.el.style.maxWidth = `${room}px`;
    });
  };
  // A panel with a scroller is short when its column is too narrow for it or a shelf offers less than its least, `over`
  // is what its column lacks of that least. Measured at the width the layout gives it, where capped rows wrap taller.
  const judge = (l: ReturnType<typeof lay>) => {
    fit(l);
    floors = open.map((p) => scrollerFloors(p.el));
    let short = 0;
    let over = 0;
    open.forEach((_, i) => {
      const least = floors[i]!.least;
      const c = l.at[i]!;
      if (least === undefined) return;
      if (span(c) < mins[i]! || (c !== l.cols[0] && c.bottom - c.top < least)) short++;
      over += Math.max(0, least - (c.bottom - c.top));
    });
    return { short, over };
  };
  const needed = (fs: typeof floors) => Math.max(MIN_HEIGHT, ...fs.map((f) => f.least ?? 0));
  let now = lay();
  const before = judge(now);
  if (before.short) {
    const cuttable = lists.map(([card, list]) => ({
      card,
      least: card.offsetHeight - list.offsetHeight + Math.min(list.scrollHeight, SCROLLER_LEAST),
      box: underZoom(seenRect(card), z),
    }));
    const cutTo = (need: number) => {
      for (const c of cuttable) {
        const h = yieldedHeight(c.box, now.base, need, c.least, CUBE_MARGIN);
        c.card.style.maxHeight = h === null ? "" : `${Math.floor(h)}px`;
      }
    };
    // The shelf the cut opens can be narrower than the panel's natural width, so the cut grows once to the least
    // measured in that shelf.
    let need = needed(uncapped);
    let cut = now;
    let after = before;
    for (let grow = 0; grow < 2; grow++) {
      cutTo(need);
      cut = lay();
      after = judge(cut);
      if (needed(floors) <= need) break;
      need = needed(floors);
    }
    // A cut that leaves as many panels short is still kept when it leaves them less far past their columns.
    if (after.short < before.short || (after.short === before.short && after.over < before.over)) now = cut;
    else {
      for (const c of cuttable) c.card.style.maxHeight = "";
      now = lay();
    }
  }
  for (const [, list, top] of lists) if (list.scrollTop !== top) list.scrollTop = top;
  const { cols, at } = now;
  fit(now);
  for (const c of cols.filter((c) => at.includes(c))) {
    const here = open.filter((_, i) => at[i] === c);
    const slots = layoutStack(
      here.map((p) => ({
        id: p.id,
        height: natural(p.el),
        ...scrollerFloors(p.el),
        head: header(p.el, z),
        rank: p.used,
      })),
      c.top,
      c.bottom,
    );
    slots.forEach((s, i) => {
      const el = here[i]!.el;
      const { style } = el;
      style.top = `${s.top}px`;
      // Fixed, so right counts from the viewport edge, not the layer, which ends at the Render dock.
      style.right = `${Math.round(viewWidth - c.free.right)}px`;
      style.maxHeight = s.maxHeight === null ? "" : `${s.maxHeight}px`;
      el.toggleAttribute("data-capped", s.maxHeight !== null && !s.folded);
      el.toggleAttribute("data-folded", !!s.folded);
    });
  }
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(place);
}

export const panelStack = {
  add(id: string, el: HTMLElement) {
    if (!open.length) {
      observer = new ResizeObserver(schedule);
      window.addEventListener("resize", schedule);
      offPrefs = onA11yPrefsChange(schedule);
      // A card that opens after the panel (History) moves the shelves without resizing anything observed.
      arrivals = new MutationObserver(() => {
        for (const c of document.querySelectorAll(RIGHT_CARDS)) observer?.observe(c);
        schedule();
      });
      const right = document.querySelector(".float-right");
      if (right) arrivals.observe(right, { childList: true });
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
    // The Render dock narrows the layer and moves the cards without resizing them.
    const layer = document.getElementById("float-layer");
    if (layer) observer?.observe(layer);
    place();
  },
  remove(id: string) {
    const i = open.findIndex((p) => p.id === id);
    if (i < 0) return;
    const entry = open[i]!;
    const { el, onClick } = entry;
    uncap(entry);
    observer?.unobserve(el);
    el.removeEventListener("click", onClick);
    el.removeAttribute("data-folded");
    open.splice(i, 1);
    if (open.length) return place();
    uncut();
    observer?.disconnect();
    observer = null;
    arrivals?.disconnect();
    arrivals = null;
    window.removeEventListener("resize", schedule);
    offPrefs?.();
    offPrefs = null;
    cancelAnimationFrame(frame);
    frame = 0;
  },
  ids: () => open.map((p) => p.id),
};
