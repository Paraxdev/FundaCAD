// A menu at the cursor drawn as a ring. Item 0 sits at the top and the rest
// follow clockwise. Two ways to drive it: a gesture (the button or key that
// opened it is still held, moving picks, releasing runs) or clicks.

import type { CtxItem } from "../stores/contextMenu";

/** Pointer travel inside this radius picks nothing. */
export const RADIAL_DEADZONE_PX = 24;
/** Ring radius the items are drawn at. */
export const RADIAL_RADIUS_PX = 84;
/** Dragging this far out over an item with children opens its ring there. */
export const RADIAL_SUBMENU_PX = 130;

/** The item a pointer offset points at, or null inside the dead zone. */
export function pickRadial(count: number, dx: number, dy: number, deadzone = RADIAL_DEADZONE_PX): number | null {
  if (count <= 0 || Math.hypot(dx, dy) < deadzone) return null;
  const turn = (Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI);
  return Math.round(turn / ((2 * Math.PI) / count)) % count;
}

/** Where item `i` of `count` is drawn, relative to the centre. */
export function radialSlot(i: number, count: number, r = RADIAL_RADIUS_PX): { x: number; y: number } {
  const a = (i / count) * 2 * Math.PI;
  return { x: Math.sin(a) * r, y: -Math.cos(a) * r };
}

export type RadialTrigger = { pointerId: number } | { key: string };

export interface RadialState {
  x: number;
  y: number;
  items: CtxItem[];
  hot: number | null;
  /** Still held: release picks. */
  gesture: RadialTrigger | null;
}

/** One open ring and its submenus. The host draws `state`; the window listeners
 *  feed it. Closing always ends a lit row's hover. */
export class RadialSession {
  state: RadialState;
  private hovered: CtxItem | null = null;
  private closed = false;

  constructor(
    x: number, y: number, items: CtxItem[], gesture: RadialTrigger | null,
    private readonly onChange: (s: RadialState | null) => void,
  ) {
    this.state = { x, y, items: items.filter((it) => !it.separator), hot: null, gesture };
    onChange(this.state);
  }

  get open(): boolean {
    return !this.closed;
  }

  private setHot(hot: number | null) {
    if (hot === this.state.hot) return;
    const it = hot === null ? null : this.state.items[hot] ?? null;
    if (it !== this.hovered) {
      this.hovered?.onHover?.(false);
      this.hovered = it;
      it?.onHover?.(true);
    }
    this.state = { ...this.state, hot };
    this.onChange(this.state);
  }

  private ring(x: number, y: number, items: CtxItem[], gesture: RadialTrigger | null) {
    this.setHot(null);
    this.state = { x, y, items: items.filter((it) => !it.separator), hot: null, gesture };
    this.onChange(this.state);
  }

  private hit(x: number, y: number): number | null {
    return pickRadial(this.state.items.length, x - this.state.x, y - this.state.y);
  }

  move(x: number, y: number) {
    if (this.closed) return;
    const hot = this.hit(x, y);
    this.setHot(hot);
    const it = hot === null ? null : this.state.items[hot];
    if (this.state.gesture && it?.children?.length && !it.disabled
      && Math.hypot(x - this.state.x, y - this.state.y) >= RADIAL_SUBMENU_PX) {
      this.ring(x, y, it.children, this.state.gesture);
    }
  }

  /** Run (or open) whatever is under (x, y). */
  private choose(x: number, y: number): boolean {
    const hot = this.hit(x, y);
    if (hot === null) return false;
    const it = this.state.items[hot]!;
    if (it.disabled) return true;
    if (it.children?.length) {
      this.ring(x, y, it.children, null);
      return true;
    }
    this.close();
    it.onClick?.();
    return true;
  }

  /** The held button or key came up. */
  release(x: number, y: number) {
    if (this.closed || !this.state.gesture) return;
    const wasKey = "key" in this.state.gesture;
    this.state = { ...this.state, gesture: null };
    if (this.choose(x, y)) return;
    // A key tapped without a move leaves the ring up to click; a drag let go
    // in the middle is a change of mind.
    if (wasKey) this.onChange(this.state);
    else this.close();
  }

  click(x: number, y: number) {
    if (this.closed || this.state.gesture) return;
    if (!this.choose(x, y)) this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.hovered?.onHover?.(false);
    this.hovered = null;
    this.onChange(null);
  }
}
