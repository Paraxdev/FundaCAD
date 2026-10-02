// The pure half of the Stress panel: the material presets the engine knows by
// name, turning the panel's setup into the `stress` op's options and into the
// study the document saves, turning its reply into display rows in the user's
// units, the blue to red colour map the viewport overlay and the panel's legend
// share, and the arithmetic behind the view's handles: dragging a force arrow,
// scaling the deformed shape, and reading a value off the coloured surface.
// Nothing here touches the viewport or the store, so all of it is testable in
// node.

import type { AxisDirection, Selector, StressStudy, StressSupportType, Vec3 } from "../types";
import type { StressMaterial, StressOptions, StressReply } from "../geometry/client";
import type { PanelRow } from "../stores/panels";
import { STUDY_DEFAULTS } from "../document/stressStudy";
import { cylinderFromFace } from "../features/planeMath";
import { displayRound, toDisplay, type Unit } from "./units";

/** E and yield in MPa, density in g/cm3. Mirrors the engine's presets, names
 *  and values both: a preset goes over the wire by name, and the engine's table
 *  is what it uses, so these numbers are only what the panel shows next to the
 *  name. */
export interface MaterialPreset {
  name: string;
  E: number;
  nu: number;
  yield: number;
  density: number;
}

export const STRESS_MATERIALS: readonly MaterialPreset[] = [
  { name: "PLA", E: 3500, nu: 0.36, yield: 50, density: 1.24 },
  { name: "PETG", E: 2100, nu: 0.38, yield: 50, density: 1.27 },
  { name: "ABS", E: 2200, nu: 0.35, yield: 40, density: 1.04 },
  { name: "ASA", E: 2200, nu: 0.35, yield: 45, density: 1.07 },
  { name: "PA12 nylon", E: 1700, nu: 0.4, yield: 45, density: 1.01 },
  { name: "PC", E: 2400, nu: 0.37, yield: 60, density: 1.2 },
  { name: "aluminium 6061-T6", E: 69000, nu: 0.33, yield: 275, density: 2.7 },
  { name: "steel S235", E: 210000, nu: 0.3, yield: 235, density: 7.85 },
];

/** The dropdown's last entry, E, nu, yield and density typed by the user. */
export const CUSTOM_MATERIAL = "Custom";

/** The tints for supports and loaded faces, in the view and beside the panel's
 *  rows. Fixed keeps the blue it has always had. */
export const FIXED_MARK_COLOR = 0x4ac6ff;
export const PINNED_MARK_COLOR = 0xc58cff;
export const SLIDER_MARK_COLOR = 0x5fd68e;
export const LOAD_MARK_COLOR = 0xff9a2e;
// A saturated gold no other mark uses, so the arrow reads over a light body and
// the dark background alike; the glyphs' dark outline does the rest.
export const GRAVITY_MARK_COLOR = 0xffc83d;

export const SUPPORT_COLORS: Record<StressSupportType, number> = {
  fixed: FIXED_MARK_COLOR,
  pinned: PINNED_MARK_COLOR,
  slider: SLIDER_MARK_COLOR,
};

export const SUPPORT_KINDS: readonly { value: StressSupportType; label: string; hint: string }[] = [
  { value: "fixed", label: "Fixed", hint: "Held every way" },
  { value: "pinned", label: "Pinned", hint: "A hole or a pin: held in place, free to turn about its axis" },
  { value: "slider", label: "Slider", hint: "Held against the face, free to slide along it" },
];

export function cssHex(c: number): string {
  return `#${c.toString(16).padStart(6, "0")}`;
}

export type ForceDirection = StressStudy["loads"][number]["direction"];

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

export const GRAVITY_DIRECTIONS: readonly AxisDirection[] = ["-Z", "+Z", "+X", "-X", "+Y", "-Y"];

export const AXES: Record<AxisDirection, Vec3> = {
  "-Z": [0, 0, -1], "+Z": [0, 0, 1], "+X": [1, 0, 0], "-X": [-1, 0, 0], "+Y": [0, 1, 0], "-Y": [0, -1, 0],
};

/** Standard gravity, m/s2, what the gravity checkbox applies. */
export const GRAVITY = 9.81;

/** Faces taken from the selection: body-stamped selectors for the engine, the
 *  display face ids for marking them, and the faces' summed area-weighted
 *  outward normal with their area, which "into the face" reads. A selector the
 *  view cannot place (one written by hand or over MCP that names a face by
 *  something other than a point) is kept for the engine with no face id. */
export interface StressFaceSet {
  selectors: Selector[];
  faceIds: number[];
  normalSum: Vec3;
  area: number;
  /** How many of the selectors name a face the current model does not have
   *  (an edit took it away, or the timeline is rolled back before it). They
   *  stay in the set, and so in the saved study, for a model that has them
   *  again; until then a Run is refused. Absent means none. */
  missing?: number;
  /** How many of the selectors the view cannot place but the engine still
   *  resolves (a fingerprint whose old centre the face has moved off, a face
   *  named by its normal). Absent means every selector without a face id that
   *  is not missing. */
  unshown?: number;
}

/** The selectors of a set the engine gets but the view does not show. */
export function unshownFaces(set: StressFaceSet): number {
  return set.unshown ?? Math.max(0, set.selectors.length - set.faceIds.length - (set.missing ?? 0));
}

/** How a face set reads in the panel: its faces as the engine gets them, and
 *  what the view cannot show of them. "none" only for a set with no faces. */
export function faceCountLabel(set: StressFaceSet): string {
  const n = set.selectors.length;
  if (!n) return "none";
  const faces = `${n} face${n === 1 ? "" : "s"}`;
  const missing = set.missing ?? 0;
  if (missing) return `${faces}, ${missing === n ? (n === 1 ? "not" : "none") : `${missing} not`} found on the current model`;
  const unshown = unshownFaces(set);
  if (unshown > 0) return `${faces} (${unshown === n ? (n === 1 ? "not" : "none") : `${unshown} not`} shown in the view)`;
  return faces;
}

export function emptyFaceSet(): StressFaceSet {
  return { selectors: [], faceIds: [], normalSum: [0, 0, 0], area: 0 };
}

export interface StressSupportSetup {
  id: number;
  type: StressSupportType;
  faces: StressFaceSet;
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
  supports: StressSupportSetup[];
  loads: StressLoadSetup[];
  gravity: { on: boolean; direction: AxisDirection };
  material: string;
  custom: { E: number; nu: number; yield: number; density: number };
  /** Element size in mm whatever the display unit, as the engine's warnings
   *  quote it; null for the engine's automatic size. */
  size: number | null;
}

export function newSupport(id: number, type: StressSupportType = "fixed"): StressSupportSetup {
  return { id, type, faces: emptyFaceSet() };
}

export function newLoad(id: number): StressLoadSetup {
  return {
    id, faces: emptyFaceSet(), kind: "force", force: STUDY_DEFAULTS.force, direction: "into",
    custom: [...STUDY_DEFAULTS.custom], pressure: STUDY_DEFAULTS.pressure,
  };
}

export function newSetup(body: string | null): StressSetup {
  return {
    body,
    supports: [newSupport(1)],
    loads: [newLoad(1)],
    gravity: { on: false, direction: "-Z" },
    material: STUDY_DEFAULTS.material,
    custom: { E: STUDY_DEFAULTS.E, nu: STUDY_DEFAULTS.nu, yield: STUDY_DEFAULTS.yield, density: STUDY_DEFAULTS.density },
    size: null,
  };
}

/** The next free id in a list of rows. */
export function nextId(rows: readonly { id: number }[]): number {
  return rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
}

// --- the study the document saves ---------------------------------------------

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** A deep copy of plain JSON data. Not structuredClone: the panel's setup is a
 *  Vue proxy, which it refuses to clone. */
function copy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** The setup as the document stores it: selectors only, and every number a
 *  number. The study saves numbers only, so a field the user has just cleared
 *  keeps the value `prev` (the study saved before) has for it, the last one the
 *  user had there, and a Run refuses the blank field by name meanwhile. Only a
 *  row `prev` has not seen falls back to the default it was shown with. */
export function studyFromSetup(s: StressSetup, prev?: Readonly<StressStudy> | null): StressStudy {
  const d = STUDY_DEFAULTS;
  const pc = prev?.custom;
  return {
    body: s.body,
    supports: s.supports.map((x) => ({ id: x.id, type: x.type, faces: copy(x.faces.selectors) })),
    loads: s.loads.map((l) => {
      const was = prev?.loads.find((p) => p.id === l.id);
      const wc = was?.custom ?? d.custom;
      return {
        id: l.id,
        kind: l.kind,
        faces: copy(l.faces.selectors),
        force: num(l.force, was?.force ?? d.force),
        direction: l.direction,
        custom: [num(l.custom[0], wc[0]), num(l.custom[1], wc[1]), num(l.custom[2], wc[2])],
        pressure: num(l.pressure, was?.pressure ?? d.pressure),
      };
    }),
    gravity: { on: s.gravity.on, direction: s.gravity.direction },
    material: s.material,
    custom: {
      E: num(s.custom.E, pc?.E ?? d.E),
      nu: num(s.custom.nu, pc?.nu ?? d.nu),
      yield: num(s.custom.yield, pc?.yield ?? d.yield),
      density: num(s.custom.density, pc?.density ?? d.density),
    },
    size: typeof s.size === "number" && Number.isFinite(s.size) && s.size > 0 ? s.size : null,
  };
}

/** A setup from a saved study. `faces` turns stored selectors into a face set on
 *  the build on screen; the face ids and normals are never stored. */
export function setupFromStudy(study: StressStudy, faces: (selectors: Selector[]) => StressFaceSet): StressSetup {
  return {
    body: study.body,
    supports: study.supports.map((x) => ({ id: x.id, type: x.type, faces: faces(copy(x.faces)) })),
    loads: study.loads.map((l) => ({
      id: l.id,
      kind: l.kind,
      faces: faces(copy(l.faces)),
      force: l.force,
      direction: l.direction,
      custom: [...l.custom],
      pressure: l.pressure,
    })),
    gravity: { ...study.gravity },
    material: study.material,
    custom: { ...study.custom },
    size: study.size,
  };
}

// --- the request ----------------------------------------------------------------

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

/** One load's unit direction, or why it has none. */
export function forceDirection(load: StressLoadSetup): Vec3 | string {
  if (load.direction === "into") {
    // "Into the face" is read off the faces drawn in the view. With one of them
    // not there, the faces it has would give a direction the load may not
    // have, and none at all would read as faces pointing every way.
    const unplaced = unshownFaces(load.faces) + (load.faces.missing ?? 0);
    if (unplaced > 0) {
      return `${unplaced === 1 ? "one of its faces is" : `${unplaced} of its faces are`} not shown in the view, so ` +
        "\"into the face\" cannot be worked out; set the faces again, or pick an axis or a custom vector";
    }
    const d = intoDirection(load.faces);
    return d ?? "its faces point different ways, so \"into the face\" has no single direction; pick an axis, a custom vector or a pressure";
  }
  if (load.direction === "custom") {
    const [x, y, z] = load.custom;
    const len = Math.hypot(x, y, z);
    if (!(len > 0) || !Number.isFinite(len)) return "the custom direction is zero";
    return [x / len, y / len, z / len];
  }
  return AXES[load.direction];
}

/** One load's force vector in N, or why it has none. */
export function forceVector(load: StressLoadSetup): Vec3 | string {
  const dir = forceDirection(load);
  if (typeof dir === "string") return dir;
  return [dir[0] * load.force, dir[1] * load.force, dir[2] * load.force];
}

/** Gravity along one of the axes, m/s2, as the engine takes it. */
export function gravityVector(direction: AxisDirection): Vec3 {
  const a = AXES[direction];
  return [a[0] * GRAVITY + 0, a[1] * GRAVITY + 0, a[2] * GRAVITY + 0];
}

export type StressRequest = { ok: true; body: string; options: StressOptions } | { ok: false; message: string };

/** A load row as a fresh panel adds it, never touched: no faces and every
 *  value its default. */
function untouchedLoad(l: StressLoadSetup): boolean {
  const d = STUDY_DEFAULTS;
  return !l.faces.selectors.length && l.kind === "force" && l.force === d.force && l.direction === "into" &&
    l.pressure === d.pressure && l.custom.every((v, i) => v === d.custom[i]);
}

/** Why a face set cannot be sent as it is: faces the current model lacks. */
function missingFaces(set: StressFaceSet, which: string): string | null {
  const k = set.missing ?? 0;
  if (!k) return null;
  return `${k === 1 ? "a face" : `${k} faces`} of ${which} ${k === 1 ? "is" : "are"} not found on the current model, set the faces again`;
}

/** The panel's setup as the `stress` op's options, or the first thing in the
 *  way, phrased for the status line. */
export function buildStressRequest(s: StressSetup): StressRequest {
  if (!s.body) return { ok: false, message: "pick the body to analyse" };
  if (!s.supports.length) return { ok: false, message: "add a support" };
  const supports: NonNullable<StressOptions["supports"]> = [];
  for (const [i, x] of s.supports.entries()) {
    const which = s.supports.length > 1 ? `support ${i + 1}` : "the support";
    if (!x.faces.selectors.length) return { ok: false, message: `set the faces of ${which} from a face selection` };
    const missing = missingFaces(x.faces, which);
    if (missing) return { ok: false, message: missing };
    supports.push({ type: x.type, faces: x.faces.selectors });
  }
  // Its own weight is a load, so a body under gravity alone is a study, and
  // the blank row a fresh panel starts with is no load at all then.
  const rows = s.gravity.on ? s.loads.filter((l) => !untouchedLoad(l)) : s.loads;
  if (!rows.length && !s.gravity.on) return { ok: false, message: "add a load, or turn on gravity" };
  const loads: StressOptions["loads"] = [];
  for (const l of rows) {
    const i = s.loads.indexOf(l);
    const which = s.loads.length > 1 ? `load ${i + 1}` : "the load";
    if (!l.faces.selectors.length) return { ok: false, message: `set the faces of ${which} from a face selection` };
    const missing = missingFaces(l.faces, which);
    if (missing) return { ok: false, message: missing };
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
    const { E, nu, yield: y, density } = s.custom;
    // A cleared number input reads as "", which compares as 0, so check the type first.
    if (!isNum(E) || !(E > 0)) return { ok: false, message: "the custom material needs a modulus E above 0" };
    if (!isNum(nu) || !(nu >= 0 && nu < 0.5)) return { ok: false, message: "Poisson's ratio must be from 0 to below 0.5" };
    if (!isNum(y) || !(y > 0)) return { ok: false, message: "the custom material needs a yield strength above 0" };
    const hasDensity = isNum(density) && density > 0;
    if (s.gravity.on && !hasDensity) return { ok: false, message: "gravity needs the material's density in g/cm3" };
    material = { E, nu, yield: y, ...(hasDensity ? { density } : {}), name: CUSTOM_MATERIAL };
  } else {
    if (!STRESS_MATERIALS.some((m) => m.name === s.material)) return { ok: false, message: `unknown material ${s.material}` };
    material = s.material;
  }
  const options: StressOptions = { supports, loads, material };
  if (s.gravity.on) options.gravity = gravityVector(s.gravity.direction);
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

// --- the result -------------------------------------------------------------------

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

/** `supports` are the kinds of the supports sent, in order, which is the order
 *  the engine's per-support reactions come back in. */
export function formatStressResult(r: StressReply, unit: Unit, supports: readonly StressSupportType[] = []): StressResultView {
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
  if (r.weight) rows.push({ k: "Weight", v: fmtForce(r.weight) });
  rows.push({ k: "Applied", v: fmtForce(r.applied) });
  rows.push({ k: "Reaction", v: fmtForce(r.reaction) });
  // One support's reaction is the total above, so per support only with several.
  const reactions = r.reactions ?? [];
  if (reactions.length > 1) {
    for (const [i, f] of reactions.entries()) {
      const kind = supports[i];
      const label = kind ? SUPPORT_KINDS.find((x) => x.value === kind)?.label.toLowerCase() : undefined;
      rows.push({ k: `Support ${i + 1}${label ? `, ${label}` : ""}`, v: fmtForce(f) });
    }
  }
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

// --- the colour map -------------------------------------------------------------

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

// --- the force arrow -------------------------------------------------------------
// The arrow's length on screen grows with the cube root of the force, so twice
// as long is eight times the force at any size: a hand that doubles an arrow
// gets a bigger load, not a thousandfold one. Pixels, not mm, because the arrow
// is a constant size on screen like every other handle, and a drag is
// measured in what the hand moved.

/** Length goes with the force to the power 1 / ARROW_EXPONENT. */
export const ARROW_EXPONENT = 3;
/** How long a 1 N arrow is drawn, px. */
export const ARROW_UNIT_PX = 20;
export const ARROW_MIN_PX = 16;
export const ARROW_MAX_PX = 240;
/** The largest force a drag sets, N; past it the field takes a typed value. */
export const FORCE_DRAG_MAX = 1e6;
/** How close, in degrees on screen, a drag has to come to an axis or to "into
 *  the face" to snap onto it. */
export const SNAP_DEGREES = 10;

/** Round to `digits` significant figures, the precision a drag can honestly claim. */
export function roundSig(v: number, digits = 2): number {
  if (!Number.isFinite(v) || v === 0) return Number.isFinite(v) ? 0 : v;
  return Number(v.toPrecision(digits)) + 0;
}

function clampPx(px: number): number {
  return Math.min(ARROW_MAX_PX, Math.max(ARROW_MIN_PX, px));
}

/** How long to draw a force's arrow, in screen pixels. */
export function forceToArrowPx(force: number): number {
  const f = Math.abs(force);
  if (!(f > 0) || !Number.isFinite(f)) return ARROW_MIN_PX;
  return clampPx(ARROW_UNIT_PX * Math.cbrt(f));
}

/** The force an arrow this long is drawn for, N, unrounded. */
function pxToForce(px: number): number {
  return Math.pow(clampPx(px) / ARROW_UNIT_PX, ARROW_EXPONENT);
}

/** The force an arrow this long stands for, N, to two significant figures. */
export function arrowPxToForce(px: number): number {
  return roundSig(pxToForce(px), 2);
}

/** Where a drag of an arrow started: the load's force, the arrow's drawn
 *  length, and how far behind the tip the press landed. A drag is measured
 *  from there, so pressing anywhere on the tip and letting go changes nothing,
 *  and an arrow drawn at its longest for a force past the scale still grows
 *  and shrinks from what the load is. */
export interface ForceDragStart {
  force: number;
  px: number;
  offsetPx: number;
}

/** The start of a drag for an arrow of `force`, pressed `pressPx` along it
 *  from its root (null when the press could not be measured). */
export function forceDragStart(force: number, pressPx: number | null): ForceDragStart {
  const f = Math.abs(Number(force));
  const px = forceToArrowPx(f);
  const offsetPx = pressPx !== null && Number.isFinite(pressPx) ? px - pressPx : 0;
  return { force: f > 0 && Number.isFinite(f) ? f : pxToForce(px), px, offsetPx };
}

/** The force for a drag whose tip, with the press offset added back, is
 *  `px` from the root: the start's force scaled as the arrow's length is. */
export function dragForce(start: ForceDragStart, px: number): number {
  const ratio = Math.max(ARROW_MIN_PX, px) / start.px;
  return roundSig(Math.min(FORCE_DRAG_MAX, start.force * Math.pow(ratio, ARROW_EXPONENT)), 2);
}

/** A direction the drag may snap to, by its name in the panel. */
export interface SnapCandidate {
  key: ForceDirection;
  dir: Vec3;
}

/** Where a drag of the arrow's tip lands. `v` is the tip's offset from the
 *  arrow's root in world units, in the plane facing the camera; `view` is the
 *  camera's unit forward direction. A candidate whose screen image lies within
 *  `degrees` of the drag takes it over, and the length is then measured along
 *  that candidate, so a drag along an arrow that leans into the screen changes
 *  its size and nothing else. A candidate pointing at the camera has no screen
 *  direction to aim at and is passed over. Null for a drag back onto the root. */
export function snapDrag(
  v: Vec3,
  view: Vec3,
  candidates: readonly SnapCandidate[],
  degrees = SNAP_DEGREES,
): { key: ForceDirection; dir: Vec3; length: number } | null {
  const vl = Math.hypot(v[0], v[1], v[2]);
  if (!(vl > 1e-12)) return null;
  const cosMax = Math.cos((degrees * Math.PI) / 180);
  let best: { key: ForceDirection; dir: Vec3; length: number; cos: number } | null = null;
  for (const c of candidates) {
    const along = dot(c.dir, view);
    const cp: Vec3 = [c.dir[0] - view[0] * along, c.dir[1] - view[1] * along, c.dir[2] - view[2] * along];
    const cl = Math.hypot(cp[0], cp[1], cp[2]);
    if (cl < 0.3) continue;
    const cos = dot(v, cp) / (vl * cl);
    if (cos < cosMax || (best && cos <= best.cos)) continue;
    best = { key: c.key, dir: c.dir, length: dot(v, cp) / (cl * cl), cos };
  }
  if (best) return { key: best.key, dir: best.dir, length: best.length };
  return { key: "custom", dir: [v[0] / vl, v[1] / vl, v[2] / vl], length: vl };
}

/** What a drag of a force arrow writes into its load: the direction by name
 *  (a custom one rounded to three decimals, which is all a hand can aim) and
 *  the force from the arrow's length on screen against where the drag began.
 *  The force is always positive: the direction carries the sign. */
export function forceDragPatch(
  snapped: { key: ForceDirection; dir: Vec3; length: number },
  worldPerPx: number,
  start: ForceDragStart,
): { direction: ForceDirection; custom: Vec3 | null; force: number } {
  const px = worldPerPx > 0 ? snapped.length / worldPerPx + start.offsetPx : start.px;
  const custom: Vec3 | null = snapped.key === "custom"
    ? [round3(snapped.dir[0]), round3(snapped.dir[1]), round3(snapped.dir[2])]
    : null;
  return { direction: snapped.key, custom, force: dragForce(start, px) };
}

/** The live label beside a dragged arrow. */
export function forceDragLabel(patch: { direction: ForceDirection; force: number }): string {
  const named = patch.direction === "custom" ? "" : `, ${FORCE_DIRECTIONS.find((d) => d.value === patch.direction)?.label.toLowerCase()}`;
  return `${patch.force} N${named}`;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000 + 0;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// --- where the glyphs stand --------------------------------------------------------

export type Tri = [Vec3, Vec3, Vec3];

function triArea(t: Tri): number {
  const u: Vec3 = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
  const w: Vec3 = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
  return 0.5 * Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
}

function triCentre(t: Tri): Vec3 {
  return [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3, (t[0][2] + t[1][2] + t[2][2]) / 3];
}

/** The area-weighted centre of a set of triangles, where a load's arrow stands.
 *  Null with no area. */
export function areaCentre(tris: readonly Tri[]): Vec3 | null {
  let a = 0;
  const c: Vec3 = [0, 0, 0];
  for (const t of tris) {
    const w = triArea(t);
    const m = triCentre(t);
    c[0] += m[0] * w;
    c[1] += m[1] * w;
    c[2] += m[2] * w;
    a += w;
  }
  return a > 0 ? [c[0] / a, c[1] / a, c[2] / a] : null;
}

/** Up to `max` spots spread over a pressure's faces, each with the direction
 *  into the face there (`normals` are the triangles' outward normals). Every
 *  k-th triangle by area order would bunch them on the big ones, so they are
 *  taken in the faces' own order, which runs across the surface. */
export function pressureSites(tris: readonly Tri[], normals: readonly Vec3[], max = 16): { at: Vec3; dir: Vec3 }[] {
  const out: { at: Vec3; dir: Vec3 }[] = [];
  if (!tris.length || max <= 0) return out;
  const step = Math.max(1, Math.ceil(tris.length / max));
  for (let i = Math.floor(step / 2); i < tris.length && out.length < max; i += step) {
    const n = normals[i];
    if (!n || triArea(tris[i]!) <= 0) continue;
    out.push({ at: triCentre(tris[i]!), dir: [-n[0] + 0, -n[1] + 0, -n[2] + 0] });
  }
  return out;
}

/** The axis a pinned support turns about, as a segment through its face and a
 *  little past both ends, from the face's own tessellation. Null when the face
 *  is not a cylinder (the engine refuses those, and says so). */
export function pinAxisSegment(points: readonly Vec3[], normals: readonly Vec3[]): { from: Vec3; to: Vec3 } | null {
  const cyl = cylinderFromFace([...points], [...normals]);
  if (!cyl) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    const t = (p[0] - cyl.point[0]) * cyl.axis[0] + (p[1] - cyl.point[1]) * cyl.axis[1] + (p[2] - cyl.point[2]) * cyl.axis[2];
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  if (!(hi >= lo)) return null;
  const margin = Math.max(0.25 * (hi - lo), cyl.radius);
  const at = (t: number): Vec3 => [cyl.point[0] + cyl.axis[0] * t, cyl.point[1] + cyl.axis[1] * t, cyl.point[2] + cyl.axis[2] * t];
  return { from: at(lo - margin), to: at(hi + margin) };
}

// --- the deformed shape -----------------------------------------------------------

/** The scale that draws the largest deflection at `share` of the body's size
 *  (its bounding box diagonal), to two significant figures. 1, true scale, when
 *  nothing moved or there is nothing to measure. */
export function autoDeformScale(positions: ArrayLike<number>, displacement: ArrayLike<number>, share = 0.05): number {
  const n = Math.min(positions.length, displacement.length);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let maxD = 0;
  for (let i = 0; i + 2 < n; i += 3) {
    for (let k = 0; k < 3; k++) {
      const p = positions[i + k]!;
      if (p < lo[k]!) lo[k] = p;
      if (p > hi[k]!) hi[k] = p;
    }
    const d = Math.hypot(displacement[i]!, displacement[i + 1]!, displacement[i + 2]!);
    if (d > maxD) maxD = d;
  }
  const size = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
  if (!(maxD > 0) || !(size > 0) || !Number.isFinite(size)) return 1;
  return roundSig((share * size) / maxD, 2);
}

/** The Deformation slider's top: four times the automatic scale, and never
 *  below true scale, so the 1x button always lands on the slider. */
export function deformSliderMax(auto: number): number {
  return Math.max(4 * auto, 1);
}

/** The factor as the slider's label reads it. */
export function deformLabel(scale: number): string {
  return `${scale === 0 ? 0 : roundSig(scale, 2)}x`;
}

/** Positions moved by `scale` times their displacement, into `out` when given. */
export function displacedPositions(
  base: ArrayLike<number>,
  displacement: ArrayLike<number>,
  scale: number,
  out: Float32Array = new Float32Array(base.length),
): Float32Array {
  for (let i = 0; i < base.length; i++) out[i] = base[i]! + (displacement[i] ?? 0) * scale;
  return out;
}

/** The Animate toggle's swing: 0 to `scale` and back, eased at both ends. */
export function swingScale(timeMs: number, scale: number, periodMs = 1600): number {
  return (scale * (1 - Math.cos((2 * Math.PI * timeMs) / periodMs))) / 2;
}

// --- the probe ---------------------------------------------------------------------

/** Barycentric weights of `p` in triangle abc, the point projected onto the
 *  triangle's plane and pulled back inside it, so a hit a hair off the edge
 *  never extrapolates the field. Equal thirds for a degenerate triangle. */
export function barycentric(a: Vec3, b: Vec3, c: Vec3, p: Vec3): Vec3 {
  const v0: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v1: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const v2: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const d00 = dot(v0, v0);
  const d01 = dot(v0, v1);
  const d11 = dot(v1, v1);
  const d20 = dot(v2, v0);
  const d21 = dot(v2, v1);
  const den = d00 * d11 - d01 * d01;
  if (!(Math.abs(den) > 1e-18)) return [1 / 3, 1 / 3, 1 / 3];
  let v = (d11 * d20 - d01 * d21) / den;
  let w = (d00 * d21 - d01 * d20) / den;
  let u = 1 - v - w;
  u = Math.max(0, u);
  v = Math.max(0, v);
  w = Math.max(0, w);
  const s = u + v + w;
  return [u / s, v / s, w / s];
}

/** Von Mises (MPa) and the deflection (mm, its size, and its vector) at a
 *  point of surface triangle `tri` with barycentric `weights`, interpolated
 *  from the triangle's corners. Deflection is null when the reply carried no
 *  displacement. Null for a triangle the surface does not have. */
export function probeValues(
  surface: { indices: ArrayLike<number>; vonMises: ArrayLike<number>; displacement?: ArrayLike<number> },
  tri: number,
  weights: Vec3,
): { vonMises: number; deflection: number | null; vector: Vec3 | null } | null {
  if (!(tri >= 0) || tri * 3 + 2 >= surface.indices.length) return null;
  const ids = [surface.indices[tri * 3]!, surface.indices[tri * 3 + 1]!, surface.indices[tri * 3 + 2]!];
  let vm = 0;
  for (let k = 0; k < 3; k++) vm += weights[k]! * (surface.vonMises[ids[k]!] ?? 0);
  const d = surface.displacement;
  if (!d || !d.length) return { vonMises: vm, deflection: null, vector: null };
  const at = (k: number, j: number) => weights[k]! * (d[ids[k]! * 3 + j] ?? 0);
  const vec: Vec3 = [0, 1, 2].map((j) => at(0, j) + at(1, j) + at(2, j)) as Vec3;
  return { vonMises: vm, deflection: Math.hypot(vec[0], vec[1], vec[2]), vector: vec };
}

/** A probe's readout: stress in MPa, deflection in the display unit. */
export function probeLabel(p: { vonMises: number; deflection: number | null }, unit: Unit): string {
  const vm = `${displayRound(p.vonMises)} MPa`;
  return p.deflection === null ? vm : `${vm}, ${displayRound(toDisplay(p.deflection))} ${unit}`;
}

/** An engine refusal in the panel's words. The engine names a support or a
 *  load for MCP callers too, as "support 1 (supports[0].faces[1])"; the panel
 *  calls the same row "Support 1", so the request path is dropped. */
export function panelMessage(message: string): string {
  const named = message.replace(
    /\b(support|load) (\d+) \((?:supports|loads)\[\d+\][^)]*\)/g,
    (_, kind: string, n: string) => `${kind === "support" ? "Support" : "Load"} ${n}`,
  );
  return named.charAt(0).toUpperCase() + named.slice(1);
}
