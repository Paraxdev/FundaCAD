// Standard hole sizes, and the dimensions a hole type and size default to.
//
// Mirrors the Python engine's `hole_feature.py`, which fills in any dimension a document
// leaves out. Both test files pin the same numbers.

import type { Feature, HoleFit, HoleStandard, HoleType } from "../types";

export const HOLE_SIZES = ["M2", "M2.5", "M3", "M4", "M5", "M6", "M8", "M10"] as const;
export type HoleSize = (typeof HOLE_SIZES)[number];

export const HOLE_TYPES: readonly HoleType[] = ["simple", "counterbore", "countersink", "insert"];

/** ISO 273 clearance holes: close, normal, loose. */
export const CLEARANCE: Record<HoleSize, readonly [number, number, number]> = {
  M2: [2.2, 2.4, 2.6],
  "M2.5": [2.7, 2.9, 3.1],
  M3: [3.2, 3.4, 3.6],
  M4: [4.3, 4.5, 4.8],
  M5: [5.3, 5.5, 5.8],
  M6: [6.4, 6.6, 7.0],
  M8: [8.4, 9.0, 10.0],
  M10: [10.5, 11.0, 12.0],
};

/** Tap drill for the coarse pitch. */
export const TAP_DRILL: Record<HoleSize, number> = {
  M2: 1.6, "M2.5": 2.05, M3: 2.5, M4: 3.3, M5: 4.2, M6: 5.0, M8: 6.8, M10: 8.5,
};

/** ISO 4762 socket head cap screw: counterbore diameter and depth. */
export const COUNTERBORE: Record<HoleSize, readonly [number, number]> = {
  M2: [4.4, 2.4],
  "M2.5": [5.5, 2.9],
  M3: [6.5, 3.4],
  M4: [8.0, 4.4],
  M5: [10.0, 5.4],
  M6: [11.0, 6.4],
  M8: [15.0, 8.6],
  M10: [18.0, 10.6],
};

/** ISO 10642 90 degree countersunk head: countersink diameter at the face. */
export const COUNTERSINK: Record<HoleSize, number> = {
  M2: 4.4, "M2.5": 5.5, M3: 6.9, M4: 9.2, M5: 11.5, M6: 13.7, M8: 18.3, M10: 22.7,
};

/** Brass heat-set inserts: bore diameter and depth. */
export const INSERT: Partial<Record<HoleSize, readonly [number, number]>> = {
  M2: [3.2, 4.0],
  "M2.5": [3.6, 5.0],
  M3: [4.0, 6.0],
  M4: [5.6, 9.0],
  M5: [6.4, 10.0],
};

export const INSERT_LEAD_IN = 0.5;

const FITS: readonly HoleFit[] = ["close", "normal", "loose"];

export type HoleDimField = "diameter" | "depth" | "cbDiameter" | "cbDepth" | "csDiameter" | "csAngle" | "leadIn";
export type HoleDims = Partial<Record<HoleDimField, number>>;

export function isHoleSize(s: unknown): s is HoleSize {
  return typeof s === "string" && (HOLE_SIZES as readonly string[]).includes(s);
}

/** What the standard says for these choices; a key the standard does not
 *  define (an M8 insert, any custom hole) is absent. */
export function standardDims(
  holeType: HoleType,
  standard: HoleStandard | undefined,
  size: string | undefined,
  fit: HoleFit | undefined,
): HoleDims {
  const out: HoleDims = {};
  if (!isHoleSize(size)) {
    if (holeType === "insert") out.leadIn = INSERT_LEAD_IN;
    return out;
  }
  if (holeType === "insert") {
    const ins = INSERT[size];
    if (ins) [out.diameter, out.depth] = ins;
    out.leadIn = INSERT_LEAD_IN;
    return out;
  }
  if (standard === "tap") out.diameter = TAP_DRILL[size];
  else if (standard === undefined || standard === "clearance") {
    out.diameter = CLEARANCE[size][Math.max(0, FITS.indexOf(fit ?? "normal"))]!;
  }
  if (holeType === "counterbore") [out.cbDiameter, out.cbDepth] = COUNTERBORE[size];
  if (holeType === "countersink") {
    out.csDiameter = COUNTERSINK[size];
    out.csAngle = 90;
  }
  return out;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Stand-ins for a hole with no standard behind it, scaled off its diameter,
 *  so switching a custom hole to a counterbore never leaves a row empty. */
function customDims(holeType: HoleType, d: number): HoleDims {
  switch (holeType) {
    case "counterbore": return { cbDiameter: round2(d * 1.9), cbDepth: round2(d) };
    case "countersink": return { csDiameter: round2(d * 2), csAngle: 90 };
    case "insert": return { leadIn: INSERT_LEAD_IN };
    default: return {};
  }
}

type HoleFeature = Extract<Feature, { type: "hole" }>;

/** The patch for picking `value` in one of a hole's choice rows: the choice,
 *  and the dimensions that follow from it.
 *
 *  A size, type or standard rewrites every dimension its standard defines, a
 *  fit only the diameter. A stand-in only fills a dimension that is absent, and
 *  a dimension a parameter drives (`bound`) is never touched. */
export function holeChoicePatch(
  f: HoleFeature,
  field: string,
  value: string | boolean,
  bound: (field: HoleDimField) => boolean = () => false,
): Partial<HoleFeature> {
  const patch: Record<string, unknown> = { [field]: value };
  if (!["holeType", "standard", "size", "fit", "extent"].includes(field)) return patch as Partial<HoleFeature>;
  const next = { ...f, ...patch } as HoleFeature;
  const holeType = next.holeType ?? "simple";
  if (holeType === "insert" && next.extent === "through") next.extent = patch.extent = "blind";
  const std = holeType === "insert" || next.standard !== "custom"
    ? standardDims(holeType, next.standard, next.size, next.fit)
    : {};
  const d = std.diameter ?? (typeof next.diameter === "number" ? next.diameter : 3);
  const overwrite: readonly HoleDimField[] =
    field === "fit" ? ["diameter"] : field === "extent" ? [] : (Object.keys(std) as HoleDimField[]);
  const fill: HoleDims = { ...customDims(holeType, d) };
  if (next.extent !== "through") fill.depth = std.depth ?? round2(2 * d);
  for (const k of overwrite) if (std[k] !== undefined && !bound(k)) patch[k] = std[k];
  for (const [k, v] of Object.entries(fill) as [HoleDimField, number][]) {
    if (next[k] === undefined && patch[k] === undefined && !bound(k)) patch[k] = v;
  }
  return patch as Partial<HoleFeature>;
}

/** Whether a hole row means anything given the hole's other fields. */
export function holeFieldApplies(field: string, values: Record<string, unknown>): boolean {
  const holeType = (values.holeType as HoleType | undefined) ?? "simple";
  const insert = holeType === "insert";
  const blind = insert || values.extent !== "through";
  switch (field) {
    case "standard":
    case "extent":
      return !insert;
    case "size":
      return insert || values.standard !== "custom";
    case "fit":
      return !insert && (values.standard ?? "clearance") === "clearance";
    case "depth":
      return blind;
    case "drillPoint":
      return blind && !insert;
    case "tapped":
      return !insert && values.standard === "tap";
    case "cbDiameter":
    case "cbDepth":
      return holeType === "counterbore";
    case "csDiameter":
    case "csAngle":
      return holeType === "countersink";
    case "leadIn":
      return insert;
    default:
      return true;
  }
}

/** Read what was typed in the tool's size box: a size name ("M3", "m2.5") or a
 *  plain diameter in mm. Null for anything else. */
export function parseHoleSize(text: string): { size: HoleSize } | { diameter: number } | null {
  const t = text.trim();
  const m = /^m\s*(\d+(?:\.\d+)?)$/i.exec(t);
  if (m) {
    const name = `M${Number(m[1])}`;
    return isHoleSize(name) ? { size: name } : null;
  }
  if (/^\d*\.?\d+$/.test(t)) {
    const d = Number(t);
    return d > 0 ? { diameter: d } : null;
  }
  return null;
}

/** A complete hole of this type and size: every dimension written out, so the
 *  rows under the feature show real numbers from the moment it exists. */
export function newHoleFields(
  holeType: HoleType,
  size: HoleSize,
  extent: "blind" | "through",
  standard: "clearance" | "tap" = "clearance",
  fit: HoleFit = "normal",
): Omit<HoleFeature, "id" | "type" | "points"> {
  const std = standardDims(holeType, standard, size, fit);
  const diameter = std.diameter ?? CLEARANCE[size][1];
  return {
    holeType, standard, size, fit,
    extent: holeType === "insert" ? "blind" : extent,
    ...customDims(holeType, diameter),
    ...std,
    diameter,
    depth: std.depth ?? round2(2 * diameter),
  };
}
