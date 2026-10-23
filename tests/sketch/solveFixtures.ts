// Entity builders and a deep closeTo matcher for the sketch solver tests.
import { expect } from "vitest";
import type { ResolvedEntity } from "../../src/sketch/snap";

export const SRC = { kind: "sketchCurve", sketch: "s0", entity: "e0" } as const;

export const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity => ({
  type: "line",
  id,
  x1,
  y1,
  x2,
  y2,
});
export const circle = (id: string, x: number, y: number, radius: number): ResolvedEntity => ({
  type: "circle",
  id,
  x,
  y,
  radius,
});
export const arc = (
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  mx: number,
  my: number,
): ResolvedEntity => ({ type: "arc", id, x1, y1, x2, y2, mx, my });
export const pt = (id: string, x: number, y: number): ResolvedEntity => ({ type: "point", id, x, y });

export const pl = (id: string, x1: number, y1: number, x2: number, y2: number) =>
  ({ type: "projected", id, source: SRC, curve: { kind: "line", x1, y1, x2, y2 } }) as ResolvedEntity;
export const pc = (id: string, x: number, y: number, r: number) =>
  ({ type: "projected", id, source: SRC, curve: { kind: "circle", x, y, r } }) as ResolvedEntity;
export const pa = (id: string, x1: number, y1: number, x2: number, y2: number, mx: number, my: number) =>
  ({ type: "projected", id, source: SRC, curve: { kind: "arc", x1, y1, x2, y2, mx, my } }) as ResolvedEntity;

/** an arc of radius r about (cx, cy) running CCW from direction angle a0 to a1 (radians) */
export const arcAt = (
  id: string,
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  projected = false,
): ResolvedEntity => {
  const m = (a0 + a1) / 2;
  const xy = [
    cx + r * Math.cos(a0),
    cy + r * Math.sin(a0),
    cx + r * Math.cos(a1),
    cy + r * Math.sin(a1),
    cx + r * Math.cos(m),
    cy + r * Math.sin(m),
  ] as const;
  return projected ? pa(id, ...xy) : arc(id, ...xy);
};

/** every number in v replaced by a closeTo matcher, so a whole solve result can be compared with toEqual */
export function near(v: unknown, digits = 6): unknown {
  if (typeof v === "number") return expect.closeTo(v, digits);
  if (Array.isArray(v)) return v.map((x) => near(x, digits));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, near(x, digits)]));
  return v;
}
