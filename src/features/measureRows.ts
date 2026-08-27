// The Measure (Inspect) readout, as a pure function of what has been picked.
//
// Split out of measureTool.ts when the panel's markup moved to
// components/overlays/MeasureReadout.vue. The tool keeps the picking, the
// shortest-distance search and the viewport marker; this is only the part that
// turns the result into labelled, unit-formatted lines — which is also the only
// part of that file a headless test could ever reach.

import * as THREE from "three";
import { getUnit, toDisplay, displayRound } from "../ui/units";

/** What the tool has picked, stripped of the ids and edge references it keeps
 *  for highlighting. `size` is an area (mm²) on a face and a length (mm) on an
 *  edge — the unit differs, which is exactly why `kind` travels with it. */
export type MeasureProbe =
  | { kind: "face"; point: THREE.Vector3; dir: THREE.Vector3; area: number }
  | { kind: "edge"; point: THREE.Vector3; dir: THREE.Vector3; length: number };

/** The closest pair between two probes, as closestPair() computes it. */
export interface ClosestPair {
  d: number;
  pa: THREE.Vector3;
  pb: THREE.Vector3;
}

export interface MeasureRow {
  k: string;
  v: string;
}

export function measureRows(
  a: MeasureProbe | undefined,
  b: MeasureProbe | undefined,
  near: ClosestPair | null,
): MeasureRow[] {
  const unit = getUnit();
  const f = toDisplay(1); // display units per mm (area uses f²)
  const L = (mm: number) => `${displayRound(toDisplay(mm))} ${unit}`;
  const A = (mm2: number) => `${displayRound(mm2 * f * f)} ${unit}²`;
  const xyz = (v: THREE.Vector3) => `${displayRound(toDisplay(v.x))}, ${displayRound(toDisplay(v.y))}, ${displayRound(toDisplay(v.z))}`;

  const rows: MeasureRow[] = [];
  const push = (k: string, v: string) => rows.push({ k, v });

  if (!a) {
    push("", "Pick a face or edge");
  } else if (!b || !near) {
    if (a.kind === "face") push("Area", A(a.area));
    else push("Length", L(a.length));
    push("At", xyz(a.point));
  } else {
    const delta = near.pb.clone().sub(near.pa);
    push("Distance", L(near.d));
    push("ΔX ΔY ΔZ", xyz(delta));
    push("Centers", L(a.point.distanceTo(b.point)));
    push("Angle", `${displayRound(THREE.MathUtils.radToDeg(a.dir.angleTo(b.dir)))}°`);
  }
  return rows;
}
