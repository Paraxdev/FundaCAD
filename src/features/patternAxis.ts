// Where a circular pattern turns: "origin" is stored as "X", "Y" or "Z", "centre" as a line through the body's middle,
// "picked" as a line plus `axisRef`, which fundacad-geom features/pattern.rs re-resolves every rebuild.

import type { Axis3, Selector, Vec3 } from "../types";
import { axisVector } from "./patternMath";
import { patternAxisDatum } from "../document/optionFields";

export type AxisPlace = "origin" | "centre" | "picked";

export interface AxisLineValue {
  origin: Vec3;
  dir: Vec3;
}

export interface PickedAxis extends AxisLineValue {
  ref: Selector;
}
/** Features turn about their body, whole bodies about the origin: a copy about its own middle sits on itself. */
/** Features turn about their body. Whole bodies turn about the origin, since a copy about its own middle sits on itself. */
export function defaultAxisPlace(featuresMode: boolean): AxisPlace {
  return featuresMode ? "centre" : "origin";
}

/** The engine's `canonical` rule, largest component positive, so both sides give the same line. */
export function canonicalDir(d: Vec3): Vec3 {
  const len = Math.hypot(d[0], d[1], d[2]);
  if (!(len > 1e-12)) return [0, 0, 0];
  const u: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
  const a = u.map(Math.abs);
  const k = a[0]! >= a[1]! && a[0]! >= a[2]! ? 0 : a[1]! >= a[2]! ? 1 : 2;
  return u[k]! < 0 ? [-u[0] + 0, -u[1] + 0, -u[2] + 0] : u;
}

export function circularAxisFields(
  place: AxisPlace,
  named: Axis3,
  centre: Vec3,
  picked: PickedAxis | null,
): { axis: Axis3 | AxisLineValue; axisRef?: Selector } {
  if (place === "picked" && picked) {
    return { axis: { origin: picked.origin, dir: picked.dir }, axisRef: picked.ref };
  }
  if (place === "centre") {
    return { axis: { origin: round6(centre), dir: axisVector(named) } };
  }
  return { axis: named };
}

export function axisLine(place: AxisPlace, named: Axis3, centre: Vec3, picked: PickedAxis | null): AxisLineValue {
  if (place === "picked" && picked) return { origin: picked.origin, dir: picked.dir };
  return { origin: place === "centre" ? centre : [0, 0, 0], dir: axisVector(named) };
}

/** The pattern's stored axis as words, for the prompt and the properties row. */
export function describeAxis(axis: unknown, axisRef: unknown, datumName?: (id: string) => string | undefined): string {
  if (axisRef) return "picked on the model";
  if (axis === "X" || axis === "Y" || axis === "Z") return `${axis} through the origin`;
  const datum = patternAxisDatum(axis);
  if (datum != null) return datumName?.(datum) ?? datum;
  const line = axis as Partial<AxisLineValue> | null;
  if (line && Array.isArray(line.origin) && Array.isArray(line.dir)) {
    const o = line.origin.map((v) => +v.toFixed(2)).join(", ");
    return `line through (${o})`;
  }
  return "Z through the origin";
}

function round6(v: Vec3): Vec3 {
  return v.map((x) => Math.round(x * 1e6) / 1e6 + 0) as Vec3;
}
