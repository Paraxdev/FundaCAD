import { reflectedRect } from "./pattern";
import type { ResolvedEntity } from "./snap";

export interface Pt {
  x: number;
  y: number;
}

export function reflectPoint(x: number, y: number, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
  const px = a.x + t * dx,
    py = a.y + t * dy;
  return { x: 2 * px - x, y: 2 * py - y };
}

function reflectAngle(deg: number, a: Pt, b: Pt): number {
  const theta = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return (((2 * theta - deg) % 360) + 360) % 360;
}

/** Null for projected geometry, which is a fixed reference and never copied. */
export function reflectEntity(e: ResolvedEntity, a: Pt, b: Pt, id: string): ResolvedEntity | null {
  const rp = (x: number, y: number) => reflectPoint(x, y, a, b);
  const c = e.construction ? { construction: true } : {};
  switch (e.type) {
    case "line": {
      const p1 = rp(e.x1, e.y1),
        p2 = rp(e.x2, e.y2);
      return { type: "line", id, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, ...c };
    }
    case "circle": {
      const ctr = rp(e.x, e.y);
      return { type: "circle", id, radius: e.radius, x: ctr.x, y: ctr.y, ...c };
    }
    case "rectangle": {
      const ctr = rp(e.x, e.y);
      return { type: "rectangle", id, ...reflectedRect(e, b.x - a.x, b.y - a.y), x: ctr.x, y: ctr.y, ...c };
    }
    case "arc": {
      // A reflection flips the turning sense, so the through point is reflected with the ends.
      const p1 = rp(e.x1, e.y1),
        p2 = rp(e.x2, e.y2),
        m = rp(e.mx, e.my);
      return { type: "arc", id, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, mx: m.x, my: m.y, ...c };
    }
    case "spline":
      return { type: "spline", id, points: e.points.map((q) => rp(q.x, q.y)), ...c };
    case "bspline":
      return { ...e, id, poles: e.poles.map((q) => rp(q.x, q.y)) };
    case "text": {
      // Only the anchor moves, the glyphs read the right way round.
      const at = rp(e.x, e.y);
      return { ...e, id, x: at.x, y: at.y };
    }
    case "polygon": {
      const ctr = rp(e.x, e.y);
      const angle = reflectAngle(e.angle, a, b);
      return { type: "polygon", id, x: ctr.x, y: ctr.y, radius: e.radius, sides: e.sides, angle, ...c };
    }
    case "slot": {
      const p1 = rp(e.x1, e.y1),
        p2 = rp(e.x2, e.y2);
      return { type: "slot", id, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, width: e.width, ...c };
    }
    case "point": {
      const q = rp(e.x, e.y);
      return { type: "point", id, x: q.x, y: q.y, ...c };
    }
    case "projected":
      return null;
  }
}

/** The reflected copies of `ids` in entity order; the axis entity itself is never copied. */
export function mirrorCopies(
  entities: readonly ResolvedEntity[],
  ids: ReadonlySet<string>,
  axis: { id: string | null; a: Pt; b: Pt },
  newId: () => string,
): ResolvedEntity[] {
  const out: ResolvedEntity[] = [];
  for (const e of entities) {
    if (!ids.has(e.id) || e.id === axis.id) continue;
    const r = reflectEntity(e, axis.a, axis.b, newId());
    if (r) out.push(r);
  }
  return out;
}
