// The pure half of the Stress panel: the material presets the engine knows by
// name, turning the panel's setup into the `stress` op's options, turning its
// reply into display rows in the user's units, and the blue to red colour map
// the viewport overlay and the panel's legend share. Nothing here touches the
// viewport or the store, so all of it is testable in node.

import type { Selector, Vec3 } from "../types";
import type { StressMaterial, StressOptions, StressReply } from "../geometry/client";
import type { PanelRow } from "../stores/panels";
import { displayRound, toDisplay, type Unit } from "./units";

/** E and yield in MPa. Mirrors the engine's presets, names and values both: a
 *  preset goes over the wire by name, and the engine's table is what it uses,
 *  so these numbers are only what the panel shows next to the name. */
export interface MaterialPreset {
  name: string;
  E: number;
  nu: number;
  yield: number;
}

export const STRESS_MATERIALS: readonly MaterialPreset[] = [
  { name: "PLA", E: 3500, nu: 0.36, yield: 50 },
  { name: "PETG", E: 2100, nu: 0.38, yield: 50 },
  { name: "ABS", E: 2200, nu: 0.35, yield: 40 },
  { name: "ASA", E: 2200, nu: 0.35, yield: 45 },
  { name: "PA12 nylon", E: 1700, nu: 0.4, yield: 45 },
  { name: "PC", E: 2400, nu: 0.37, yield: 60 },
  { name: "aluminium 6061-T6", E: 69000, nu: 0.33, yield: 275 },
  { name: "steel S235", E: 210000, nu: 0.3, yield: 235 },
];

/** The dropdown's last entry, E, nu and yield typed by the user. */
export const CUSTOM_MATERIAL = "Custom";

/** The tints for fixed and loaded faces, in the view and beside the panel's rows. */
export const FIXED_MARK_COLOR = 0x4ac6ff;
export const LOAD_MARK_COLOR = 0xff9a2e;

export function cssHex(c: number): string {
  return `#${c.toString(16).padStart(6, "0")}`;
}

export type ForceDirection = "into" | "-Z" | "+Z" | "+X" | "-X" | "+Y" | "-Y" | "custom";

export const FORCE_DIRECTIONS: readonly { value: ForceDirection; label: string }[] = [
  { value: "into", label: "Into the face" },
  { value: "-Z", label: "-Z" },
  { value: "+Z", label: "+Z" },
  { value: "+X", label: "+X" },
  { value: "-X", label: "-X" },
  { value: "+Y", label: "+Y" },
  { value: "-Y", label: "-Y" },
  { value: "custom", label: "Custom vector" },
];

const AXES: Record<Exclude<ForceDirection, "into" | "custom">, Vec3> = {
  "-Z": [0, 0, -1], "+Z": [0, 0, 1], "+X": [1, 0, 0], "-X": [-1, 0, 0], "+Y": [0, 1, 0], "-Y": [0, -1, 0],
};

/** Faces taken from the selection: body-stamped selectors for the engine, the
 *  display face ids for marking them, and the faces' summed area-weighted
 *  outward normal with their area, which "into the face" reads. */
export interface StressFaceSet {
  selectors: Selector[];
  faceIds: number[];
  normalSum: Vec3;
  area: number;
}

export function emptyFaceSet(): StressFaceSet {
  return { selectors: [], faceIds: [], normalSum: [0, 0, 0], area: 0 };
}

export interface StressLoadSetup {
  id: number;
  faces: StressFaceSet;
  kind: "force" | "pressure";
  /** N, the total over the load's faces. */
  force: number;
  direction: ForceDirection;
  custom: Vec3;
  /** MPa, pushing into the surface. */
  pressure: number;
}

export interface StressSetup {
  body: string | null;
  fixed: StressFaceSet;
  loads: StressLoadSetup[];
  material: string;
  custom: { E: number; nu: number; yield: number };
  /** Element size in mm whatever the display unit, as the engine's warnings
   *  quote it; null for the engine's automatic size. */
  size: number | null;
}

export function newLoad(id: number): StressLoadSetup {
  return { id, faces: emptyFaceSet(), kind: "force", force: 100, direction: "into", custom: [0, 0, -1], pressure: 0.1 };
}

export function newSetup(body: string | null): StressSetup {
  return {
    body,
    fixed: emptyFaceSet(),
    loads: [newLoad(1)],
    material: "PLA",
    custom: { E: 2000, nu: 0.35, yield: 40 },
    size: null,
  };
}

/** The unit direction "into the face" means: minus the faces' mean outward
 *  normal. Null when the faces point too many ways to have one, a whole
 *  cylinder or a set of opposite faces, where it would be a guess. */
export function intoDirection(faces: StressFaceSet): Vec3 | null {
  const [x, y, z] = faces.normalSum;
  const len = Math.hypot(x, y, z);
  if (!(faces.area > 0) || len < 0.5 * faces.area) return null;
  // + 0 turns the -0 of a zero component into 0.
  return [-x / len + 0, -y / len + 0, -z / len + 0];
}

/** One load's force vector in N, or why it has none. */
export function forceVector(load: StressLoadSetup): Vec3 | string {
  let dir: Vec3;
  if (load.direction === "into") {
    const d = intoDirection(load.faces);
    if (!d) return "its faces point different ways, so \"into the face\" has no single direction; pick an axis, a custom vector or a pressure";
    dir = d;
  } else if (load.direction === "custom") {
    const [x, y, z] = load.custom;
    const len = Math.hypot(x, y, z);
    if (!(len > 0) || !Number.isFinite(len)) return "the custom direction is zero";
    dir = [x / len, y / len, z / len];
  } else {
    dir = AXES[load.direction];
  }
  return [dir[0] * load.force, dir[1] * load.force, dir[2] * load.force];
}

export type StressRequest = { ok: true; body: string; options: StressOptions } | { ok: false; message: string };

/** The panel's setup as the `stress` op's options, or the first thing in the
 *  way, phrased for the status line. */
export function buildStressRequest(s: StressSetup): StressRequest {
  if (!s.body) return { ok: false, message: "pick the body to analyse" };
  if (!s.fixed.selectors.length) return { ok: false, message: "set the fixed faces from a face selection" };
  if (!s.loads.length) return { ok: false, message: "add a load" };
  const loads: StressOptions["loads"] = [];
  for (const [i, l] of s.loads.entries()) {
    const which = s.loads.length > 1 ? `load ${i + 1}` : "the load";
    if (!l.faces.selectors.length) return { ok: false, message: `set the faces of ${which} from a face selection` };
    if (l.kind === "pressure") {
      if (!Number.isFinite(l.pressure) || l.pressure === 0) return { ok: false, message: `${which} needs a pressure` };
      loads.push({ faces: l.faces.selectors, pressure: l.pressure });
      continue;
    }
    if (!Number.isFinite(l.force) || l.force === 0) return { ok: false, message: `${which} needs a force` };
    const v = forceVector(l);
    if (typeof v === "string") return { ok: false, message: `${which}: ${v}` };
    loads.push({ faces: l.faces.selectors, force: v.map(roundForce) as Vec3 });
  }
  let material: StressMaterial;
  if (s.material === CUSTOM_MATERIAL) {
    const { E, nu, yield: y } = s.custom;
    // A cleared number input reads as "", which compares as 0, so check the type first.
    if (!isNum(E) || !(E > 0)) return { ok: false, message: "the custom material needs a modulus E above 0" };
    if (!isNum(nu) || !(nu >= 0 && nu < 0.5)) return { ok: false, message: "Poisson's ratio must be from 0 to below 0.5" };
    if (!isNum(y) || !(y > 0)) return { ok: false, message: "the custom material needs a yield strength above 0" };
    material = { E, nu, yield: y, name: CUSTOM_MATERIAL };
  } else {
    if (!STRESS_MATERIALS.some((m) => m.name === s.material)) return { ok: false, message: `unknown material ${s.material}` };
    material = s.material;
  }
  const options: StressOptions = { fixed: s.fixed.selectors, loads, material };
  if (s.size !== null) {
    if (!isNum(s.size) || !(s.size > 0)) return { ok: false, message: "the element size must be above 0, or blank for automatic" };
    options.size = s.size;
  }
  return { ok: true, body: s.body, options };
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// Twelve significant digits: a direction from a normal is 0.7071067811865476
// times the force, and the bytes sent should not depend on the last ulp.
function roundForce(v: number): number {
  return v === 0 ? 0 : Number(v.toPrecision(12)) + 0;
}

/** The result as panel rows, lengths in the display unit. */
export interface StressResultView {
  rows: PanelRow[];
  warnings: string[];
  /** The colour bar's ends, MPa. */
  legend: { min: number; max: number };
  /** Below 1, or no yield at all, the part is expected to yield. */
  yields: boolean;
}

function fmtPoint(p: Vec3, unit: Unit): string {
  return `${displayRound(toDisplay(p[0]))}, ${displayRound(toDisplay(p[1]))}, ${displayRound(toDisplay(p[2]))} ${unit}`;
}

/** Peak and minimum of the per-vertex von Mises field, for the legend. */
export function valueRange(values: readonly number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min <= max ? { min, max } : { min: 0, max: 0 };
}

export function formatStressResult(r: StressReply, unit: Unit): StressResultView {
  const rows: PanelRow[] = [];
  const sf = r.safetyFactor;
  rows.push({ k: "Material", v: r.material.name });
  rows.push({ k: "Peak von Mises", v: `${displayRound(r.maxVonMises.value)} MPa` });
  // Not the engine's face index: it counts the faces of a copy of the body, a
  // number nothing else in the app shows.
  rows.push({ k: "Peak at", v: fmtPoint(r.maxVonMises.at, unit) });
  rows.push({ k: "Max deflection", v: `${displayRound(toDisplay(r.maxDisplacement.value))} ${unit}` });
  rows.push({ k: "Deflection at", v: fmtPoint(r.maxDisplacement.at, unit) });
  rows.push({ k: "Safety factor", v: sf !== null && Number.isFinite(sf) ? `${displayRound(sf)}` : "none, no stress" });
  rows.push({ k: "Yield", v: `${displayRound(r.material.yield)} MPa` });
  rows.push({ k: "Applied", v: fmtForce(r.applied) });
  rows.push({ k: "Reaction", v: fmtForce(r.reaction) });
  // In mm like the element size box and the engine's warnings about it.
  rows.push({ k: "Mesh", v: `${r.mesh.elements} elements, ${displayRound(r.mesh.size)} mm` });
  const warnings = [...(r.warnings ?? [])];
  for (const e of r.errors ?? []) warnings.push(e.feature_id ? `${e.feature_id}: ${e.message}` : e.message);
  const values = r.surface?.vonMises ?? [];
  const legend = values.length ? valueRange(values) : { min: 0, max: r.maxVonMises.value };
  return { rows, warnings, legend, yields: sf !== null && sf < 1 };
}

function fmtForce(f: Vec3): string {
  return `${displayRound(f[0])}, ${displayRound(f[1])}, ${displayRound(f[2])} N`;
}

// Blue, cyan, green, yellow, red, in sRGB, evenly spaced: the usual FEA ramp,
// low stress cold and the peak hot.
const STOPS: readonly Vec3[] = [
  [0, 0, 1],
  [0, 1, 1],
  [0, 1, 0],
  [1, 1, 0],
  [1, 0, 0],
];

/** sRGB 0..1 for a value 0..1 along the ramp (clamped; NaN reads as 0). */
export function stressColor(t: number): Vec3 {
  const c = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  const x = c * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = STOPS[i]!;
  const b = STOPS[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** One sRGB triple per value, mapped over [min, max]. A flat field (max = min)
 *  is all blue rather than a division by zero. */
export function stressColors(values: readonly number[], min: number, max: number): Float32Array {
  const out = new Float32Array(values.length * 3);
  const span = max - min;
  for (let i = 0; i < values.length; i++) {
    const t = span > 0 ? ((values[i] ?? min) - min) / span : 0;
    const [r, g, b] = stressColor(t);
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return out;
}

/** The legend's CSS gradient, left (low) to right (high), from the same stops. */
export function legendGradient(): string {
  const parts = STOPS.map((s, i) => {
    const pct = (i / (STOPS.length - 1)) * 100;
    return `rgb(${s.map((v) => Math.round(v * 255)).join(", ")}) ${pct}%`;
  });
  return `linear-gradient(to right, ${parts.join(", ")})`;
}
