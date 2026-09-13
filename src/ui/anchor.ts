// Where a popover goes beside the element that opened it: on the requested side
// when it fits, on the opposite side when it does not, and always inside the
// window.

export type Side = "right" | "left" | "bottom" | "top";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

const OPPOSITE: Record<Side, Side> = { right: "left", left: "right", bottom: "top", top: "bottom" };

function spot(a: Rect, box: Size, side: Side, gap: number, align: "start" | "center"): { left: number; top: number } {
  const midX = (a.left + a.right) / 2 - box.width / 2;
  const midY = (a.top + a.bottom) / 2 - box.height / 2;
  switch (side) {
    case "right": return { left: a.right + gap, top: align === "start" ? a.top : midY };
    case "left": return { left: a.left - gap - box.width, top: align === "start" ? a.top : midY };
    case "bottom": return { left: align === "start" ? a.left : midX, top: a.bottom + gap };
    case "top": return { left: align === "start" ? a.left : midX, top: a.top - gap - box.height };
  }
}

function fits(p: { left: number; top: number }, box: Size, win: Size, margin: number): boolean {
  return p.left >= margin && p.top >= margin && p.left + box.width <= win.width - margin && p.top + box.height <= win.height - margin;
}

export function placeBeside(
  anchor: Rect,
  box: Size,
  side: Side,
  win: Size,
  opts: { gap?: number; margin?: number; align?: "start" | "center" } = {},
): { left: number; top: number; side: Side } {
  const gap = opts.gap ?? 8;
  const margin = opts.margin ?? 8;
  const align = opts.align ?? "start";
  let chosen = side;
  let p = spot(anchor, box, side, gap, align);
  if (!fits(p, box, win, margin)) {
    const flipped = spot(anchor, box, OPPOSITE[side], gap, align);
    if (fits(flipped, box, win, margin)) {
      p = flipped;
      chosen = OPPOSITE[side];
    }
  }
  const clamp = (v: number, size: number, max: number) => Math.max(margin, Math.min(v, max - margin - size));
  return { left: clamp(p.left, box.width, win.width), top: clamp(p.top, box.height, win.height), side: chosen };
}
