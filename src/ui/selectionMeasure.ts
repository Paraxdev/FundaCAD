// The one-line readout for several picked things, and the measures it and the prompts share.

import { shallowRef } from "vue";
import { spellNumber } from "./measure";
import { t } from "../i18n";
import type { EntityKind } from "../features/toolCapabilities";
import { countLine } from "./selectionTools";
import { fmtLength } from "./units";

export type Pt3 = readonly [number, number, number];

/** Total length of a polyline. */
export function polylineLength(points: readonly Pt3[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    len += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return len;
}

/** Diameter of a closed polyline that is a circle, else null. A tessellated
 *  circle's vertices all sit on it, so every vertex has to be within a small
 *  fraction of the mean radius, which a rounded rectangle or an ellipse is not. */
export function circleDiameter(points: readonly Pt3[], tol = 0.01): number | null {
  if (points.length < 8) return null;
  const first = points[0]!,
    last = points[points.length - 1]!;
  const span = polylineLength(points);
  const gap = Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]);
  if (gap > span * 1e-3) return null;
  // Chord midpoints weighted by length: the engine sends a rim as two half circles with a half step where they meet,
  // and that one extra vertex pulls a plain vertex mean r / n off centre, 1.25 % on a 25 mm rim.
  let cx = 0,
    cy = 0,
    cz = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    const w = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 2;
    cx += (a[0] + b[0]) * w;
    cy += (a[1] + b[1]) * w;
    cz += (a[2] + b[2]) * w;
  }
  if (span <= 0) return null;
  cx /= span;
  cy /= span;
  cz /= span;
  const ring = points.slice(0, -1);
  const radii = ring.map((p) => Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz));
  const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
  if (mean <= 0) return null;
  return radii.every((r) => Math.abs(r - mean) <= mean * tol) ? mean * 2 : null;
}

const mm = (v: number) => `${spellNumber(Number(v.toFixed(2)))} mm`;

export interface RoundSize {
  radius: number;
  /** all the way round */
  full: boolean;
}

/** The engine's exact size of the lone selected round face once it answers, so every readout agrees with the
 *  press/pull field rather than the mesh's guess. */
export const exactRound = shallowRef<(RoundSize & { faceId: number }) | null>(null);

/** A diameter all the way round, a radius on a partial arc. */
export function roundSize({ radius, full }: RoundSize): string {
  return full ? `⌀${mm(radius * 2)}` : `R${mm(radius)}`;
}

/** The prompt for a selected round face; only a full wrap can be dragged away. */
export function roundFacePrompt(round: RoundSize): string {
  return (
    `Round face selected (${roundSize(round)}), drag the handle to resize it` +
    `${round.full ? " · drag it away to nothing to remove it" : ""} · Esc to clear`
  );
}

/** "3 faces", "2 edges · 300.74 mm". One face or edge goes through describePick once its facts are known. */
export function describeSelection(input: {
  kind: EntityKind;
  count: number;
  edges?: readonly (readonly Pt3[])[];
  bodyHint?: boolean;
}): string {
  const { kind, count } = input;
  if (count <= 0) return "";
  if (kind === "body" && input.bodyHint) return t("readout.bodiesAuto", { n: count });
  if (kind === "edge" && input.edges?.length) {
    const length = fmtLength(input.edges.reduce((s, e) => s + polylineLength(e), 0));
    const d = input.edges.length === 1 ? circleDiameter(input.edges[0]!) : null;
    return d === null
      ? t("readout.edges", { n: count, length })
      : t("readout.edgesCircle", { n: count, length, diameter: fmtLength(d) });
  }
  return countLine(kind, count);
}
