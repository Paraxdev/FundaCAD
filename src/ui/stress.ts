// The Stress panel's pure half: material presets, setup to `stress` op options and saved study, reply to display
// rows, the colour map, and the arithmetic behind the force arrow, deformation and probe. Testable in node.

import { t, type MessageKey } from "../i18n";
import type { AxisDirection, Selector, StressSpot, StressStudy, StressSupportType, Vec3 } from "../types";
import type { StressMaterial, StressOptions, StressRefine, StressReply, StressSpotArea } from "../geometry/client";
import type { PanelRow } from "../stores/panels";
import { STUDY_DEFAULTS } from "../document/stressStudy";
import { cylinderFromFace } from "../features/planeMath";
import { listJoin, spellNumber, spellRounded } from "./measure";
import { toDisplay, type Unit } from "./units";
import { peakPlaceOf, type VerdictInput } from "./stressVerdict";
import { vonMisesAt } from "./stressLocate";

/** E and yield in MPa, density in g/cm3. Mirrors the engine's presets: a preset goes over the wire by name, so these
 *  numbers are only what the panel shows. */
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

/** The dropdown's last entry, E, nu, yield and density typed by the user. Saved as is, only its label is translated. */
export const CUSTOM_MATERIAL = "Custom";

export function materialOptions(): { value: string; label: string }[] {
  return [
    ...STRESS_MATERIALS.map((m) => ({ value: m.name, label: m.name })),
    { value: CUSTOM_MATERIAL, label: t("stress.material.custom") },
  ];
}

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

// Getters, so a label read in a render follows a change of language.
function option<V extends string>(value: V, key: MessageKey): { value: V; readonly label: string } {
  return {
    value,
    get label() {
      return t(key);
    },
  };
}

function supportKind(value: StressSupportType, label: MessageKey, hint: MessageKey) {
  return {
    value,
    get label() {
      return t(label);
    },
    get hint() {
      return t(hint);
    },
  };
}

export const SUPPORT_KINDS: readonly { value: StressSupportType; readonly label: string; readonly hint: string }[] = [
  supportKind("fixed", "stress.support.fixed", "stress.support.fixedHint"),
  supportKind("pinned", "stress.support.pinned", "stress.support.pinnedHint"),
  supportKind("slider", "stress.support.slider", "stress.support.sliderHint"),
];

// The results step is not translated yet, so its reaction rows keep these words.
const SUPPORT_WORDS: Record<StressSupportType, string> = { fixed: "fixed", pinned: "pinned", slider: "slider" };

export function cssHex(c: number): string {
  return `#${c.toString(16).padStart(6, "0")}`;
}

export type ForceDirection = StressStudy["loads"][number]["direction"];

export const GRAVITY_DIRECTIONS: readonly AxisDirection[] = ["-Z", "+Z", "+X", "-X", "+Y", "-Y"];

// Z is up and the front view looks along +Y.
const AXIS_KEYS: Record<AxisDirection, MessageKey> = {
  "-Z": "stress.dir.down",
  "+Z": "stress.dir.up",
  "+X": "stress.dir.right",
  "-X": "stress.dir.left",
  "+Y": "stress.dir.back",
  "-Y": "stress.dir.front",
};

export const AXIS_LABELS: Readonly<Record<AxisDirection, string>> = Object.defineProperties(
  {} as Record<AxisDirection, string>,
  Object.fromEntries(GRAVITY_DIRECTIONS.map((d) => [d, { get: () => t(AXIS_KEYS[d]), enumerable: true }])),
);

export const FORCE_DIRECTIONS: readonly { value: ForceDirection; readonly label: string }[] = [
  option("into", "stress.dir.into"),
  ...GRAVITY_DIRECTIONS.map((d) => option(d, AXIS_KEYS[d])),
  option("custom", "stress.dir.custom"),
];

export const AXES: Record<AxisDirection, Vec3> = {
  "-Z": [0, 0, -1],
  "+Z": [0, 0, 1],
  "+X": [1, 0, 0],
  "-X": [-1, 0, 0],
  "+Y": [0, 1, 0],
  "-Y": [0, -1, 0],
};

/** Standard gravity, m/s2, what the gravity checkbox applies. */
export const GRAVITY = 9.81;

/** Body-stamped selectors for the engine, display face ids for marking, and the summed area-weighted outward normal
 *  for "into the face". A selector the view cannot place (hand or MCP written) is kept with no face id. */
export interface StressFaceSet {
  selectors: Selector[];
  faceIds: number[];
  normalSum: Vec3;
  area: number;
  /** Selectors naming a face the current model lacks. Kept, and saved, for a model that has them again; until then a
   *  Run is refused. Absent means none. */
  missing?: number;
  /** Selectors the view cannot place but the engine resolves (a moved fingerprint, a face named by its normal). Absent
   *  means every selector without a face id that is not missing. */
  unshown?: number;
}

/** The selectors of a set the engine gets but the view does not show. */
export function unshownFaces(set: StressFaceSet): number {
  return set.unshown ?? Math.max(0, set.selectors.length - set.faceIds.length - (set.missing ?? 0));
}

/** How a row's places read in the panel: its faces as the engine gets them,
 *  what the view cannot show of them, and its spots. "none" only with neither. */
export function faceCountLabel(set: StressFaceSet, spots: readonly StressSpot[] = []): string {
  const k = spots.length;
  if (!k) return facesLabel(set);
  const placed = t("stress.spots.count", { k });
  return set.selectors.length ? t("stress.places.both", { faces: facesLabel(set), spots: placed }) : placed;
}

function facesLabel(set: StressFaceSet): string {
  const n = set.selectors.length;
  if (!n) return t("stress.faces.none");
  const missing = set.missing ?? 0;
  if (missing)
    return missing === n ? t("stress.faces.missingAll", { n }) : t("stress.faces.missingSome", { n, missing });
  const unshown = unshownFaces(set);
  if (unshown > 0)
    return unshown === n ? t("stress.faces.unshownAll", { n }) : t("stress.faces.unshownSome", { n, unshown });
  return t("stress.faces.count", { n });
}

/** The status line after a row took the faces picked in the view, `index` counted from 1. */
export function pickedFacesStatus(row: StressSupportType | "load", index: number, faces: number): string {
  return t("stress.status.picked", { row, i: index, n: faces });
}

export function emptyFaceSet(): StressFaceSet {
  return { selectors: [], faceIds: [], normalSum: [0, 0, 0], area: 0 };
}

export interface StressSupportSetup {
  id: number;
  type: StressSupportType;
  faces: StressFaceSet;
  /** Places it holds besides its faces, absent for none. */
  spots?: StressSpot[];
}

export interface StressLoadSetup {
  id: number;
  faces: StressFaceSet;
  /** Places it pushes on besides its faces, absent for none. */
  spots?: StressSpot[];
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
  /** The Mesh detail of More options: "off" is Coarse. */
  refine: StressRefine;
}

export const MESH_DETAIL_CHOICES: readonly { value: StressRefine; readonly label: string }[] = [
  option("off", "stress.mesh.coarse"),
  option("standard", "stress.mesh.standard"),
  option("fine", "stress.mesh.fine"),
];

/** The element limit sent with Fine; the engine's default is about half. */
export const FINE_MAX_ELEMENTS = 60_000;

/** The one button of a finer answer. The time is rough, so steps of 5 seconds, then whole minutes. */
export function finerLabel(seconds: number): string {
  if (seconds < 90) return t("stress.finer.seconds", { s: Math.max(10, Math.round(seconds / 5) * 5) });
  return t("stress.finer.minutes", { m: Math.max(1, Math.round(seconds / 60)) });
}

/** One row of the setup, by its id. */
export type StressTarget = { support: number } | { load: number };

export function sameTarget(a: StressTarget | null, b: StressTarget | null): boolean {
  if (!a || !b) return a === b;
  return "support" in a ? "support" in b && a.support === b.support : "load" in b && a.load === b.load;
}

export function newSupport(id: number, type: StressSupportType = "fixed"): StressSupportSetup {
  return { id, type, faces: emptyFaceSet() };
}

export function newLoad(id: number): StressLoadSetup {
  return {
    id,
    faces: emptyFaceSet(),
    kind: "force",
    force: STUDY_DEFAULTS.force,
    direction: "into",
    custom: [...STUDY_DEFAULTS.custom],
    pressure: STUDY_DEFAULTS.pressure,
  };
}

export function newSetup(body: string | null): StressSetup {
  return {
    body,
    supports: [newSupport(1)],
    loads: [newLoad(1)],
    gravity: { on: false, direction: "-Z" },
    material: STUDY_DEFAULTS.material,
    custom: {
      E: STUDY_DEFAULTS.E,
      nu: STUDY_DEFAULTS.nu,
      yield: STUDY_DEFAULTS.yield,
      density: STUDY_DEFAULTS.density,
    },
    refine: "standard",
  };
}

export function nextId(rows: readonly { id: number }[]): number {
  return rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** A deep copy of plain JSON data. Not structuredClone: the panel's setup is a
 *  Vue proxy, which it refuses to clone. */
function copy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Selectors and numbers only. A just-cleared field keeps the value `prev` saved, and a Run refuses the blank field
 *  by name meanwhile; only a row `prev` has not seen falls back to its shown default. */
export function studyFromSetup(s: StressSetup, prev?: Readonly<StressStudy> | null): StressStudy {
  const d = STUDY_DEFAULTS;
  const pc = prev?.custom;
  return {
    body: s.body,
    supports: s.supports.map((x) => ({
      id: x.id,
      type: x.type,
      faces: copy(x.faces.selectors),
      ...savedSpots(x.spots),
    })),
    loads: s.loads.map((l) => {
      const was = prev?.loads.find((p) => p.id === l.id);
      const wc = was?.custom ?? d.custom;
      return {
        id: l.id,
        kind: l.kind,
        faces: copy(l.faces.selectors),
        ...savedSpots(l.spots),
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
    // A size from an older study stays in the file unused, so reading it back is no edit.
    size: prev?.size ?? null,
    ...(s.refine === "fine" || s.refine === "off" ? { refine: s.refine } : {}),
  };
}

/** The key only when there are spots; a just-cleared radius is left out, so no saved spot lacks a size. */
function savedSpots(spots: readonly StressSpot[] | undefined): { spots?: StressSpot[] } {
  const kept = (spots ?? []).filter((s) => isNum(s.radius) && s.radius > 0);
  return kept.length ? { spots: copy(kept) } : {};
}

/** A setup from a saved study. `faces` turns stored selectors into a face set on
 *  the build on screen; the face ids and normals are never stored. */
export function setupFromStudy(study: StressStudy, faces: (selectors: Selector[]) => StressFaceSet): StressSetup {
  return {
    body: study.body,
    supports: study.supports.map((x) => ({
      id: x.id,
      type: x.type,
      faces: faces(copy(x.faces)),
      ...(x.spots?.length ? { spots: copy(x.spots) } : {}),
    })),
    loads: study.loads.map((l) => ({
      id: l.id,
      kind: l.kind,
      faces: faces(copy(l.faces)),
      ...(l.spots?.length ? { spots: copy(l.spots) } : {}),
      force: l.force,
      direction: l.direction,
      custom: [...l.custom],
      pressure: l.pressure,
    })),
    gravity: { ...study.gravity },
    material: study.material,
    custom: { ...study.custom },
    refine: study.refine ?? "standard",
  };
}

/** Minus the mean outward normal of the faces and spots, a spot counting as a disc of its radius. Null when they point
 *  too many ways (a whole cylinder, opposite faces). */
export function intoDirection(faces: StressFaceSet, spots: readonly StressSpot[] = []): Vec3 | null {
  let [x, y, z] = faces.normalSum;
  let area = faces.area;
  for (const s of spots) {
    if (!s.normal) continue;
    const a = Math.PI * s.radius * s.radius;
    x += s.normal[0] * a;
    y += s.normal[1] * a;
    z += s.normal[2] * a;
    area += a;
  }
  const len = Math.hypot(x, y, z);
  if (!(area > 0) || len < 0.5 * area) return null;
  // + 0 turns the -0 of a zero component into 0.
  return [-x / len + 0, -y / len + 0, -z / len + 0];
}

/** One load's unit direction, or why it has none. */
export function forceDirection(load: StressLoadSetup): Vec3 | string {
  if (load.direction === "into") {
    // "Into the face" is read off the faces drawn in the view, so with any unplaced the direction would be a guess.
    const unplaced = unshownFaces(load.faces) + (load.faces.missing ?? 0);
    if (unplaced > 0) {
      return (
        `${unplaced === 1 ? "one of its faces is" : `${unplaced} of its faces are`} not shown in the view, so ` +
        '"into the face" cannot be worked out; set the faces again, or pick an axis or a custom vector'
      );
    }
    if (load.spots?.some((s) => !s.normal)) {
      return 'one of its spots has no direction of its own, so "into the face" cannot be worked out; place the spot again, or pick an axis or a custom vector';
    }
    const d = intoDirection(load.faces, load.spots);
    return (
      d ??
      'its faces point different ways, so "into the face" has no single direction; pick an axis, a custom vector or a pressure'
    );
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
  return (
    !l.faces.selectors.length &&
    !l.spots?.length &&
    l.kind === "force" &&
    l.force === d.force &&
    l.direction === "into" &&
    l.pressure === d.pressure &&
    l.custom.every((v, i) => v === d.custom[i])
  );
}

/** Why a face set cannot be sent as it is: faces the current model lacks. */
function missingFaces(set: StressFaceSet, which: string): string | null {
  const k = set.missing ?? 0;
  if (!k) return null;
  return `${k === 1 ? "a face" : `${k} faces`} of ${which} ${k === 1 ? "is" : "are"} not found on the current model, set the faces again`;
}

/** What a row holds or pushes on, as the engine takes it: its faces when it
 *  has any, its spots when it has any, or why it cannot be sent. */
function areaOf(
  faces: StressFaceSet,
  spots: readonly StressSpot[] | undefined,
  which: string,
): { faces?: Selector[]; spots?: StressSpotArea[] } | string {
  const placed = spots ?? [];
  if (!faces.selectors.length && !placed.length) {
    return `${which} has no faces yet, place it on the body or use selected faces`;
  }
  const missing = missingFaces(faces, which);
  if (missing) return missing;
  if (placed.some((s) => !isNum(s.radius) || !(s.radius > 0))) return `a spot of ${which} needs a radius above 0`;
  return {
    ...(faces.selectors.length ? { faces: faces.selectors } : {}),
    ...(placed.length ? { spots: placed.map((s) => ({ at: [...s.at] as Vec3, radius: s.radius })) } : {}),
  };
}

/** A twentieth of the bounding box diagonal, mm, to two figures, so a spot is in proportion to the part. */
export function defaultSpotRadius(diagonal: number): number {
  if (!Number.isFinite(diagonal) || !(diagonal > 0)) return STUDY_DEFAULTS.radius;
  return Math.max(0.5, roundSig(diagonal / 20, 2));
}

/** The panel's setup as the `stress` op's options, or the first thing in the
 *  way, phrased for the status line. */
export function buildStressRequest(s: StressSetup): StressRequest {
  if (!s.body) return { ok: false, message: "pick the body to analyse" };
  if (!s.supports.length) return { ok: false, message: "add a support" };
  const supports: NonNullable<StressOptions["supports"]> = [];
  for (const [i, x] of s.supports.entries()) {
    const which = s.supports.length > 1 ? `support ${i + 1}` : "the support";
    const area = areaOf(x.faces, x.spots, which);
    if (typeof area === "string") return { ok: false, message: area };
    if (area.spots && x.type !== "fixed") {
      return {
        ok: false,
        message: `${which} is ${x.type} but has a spot, and a spot holds every way, so make it fixed or remove the spot`,
      };
    }
    supports.push({ type: x.type, ...area });
  }
  // Its own weight is a load, so a body under gravity alone is a study, and
  // the blank row a fresh panel starts with is no load at all then.
  const rows = s.gravity.on ? s.loads.filter((l) => !untouchedLoad(l)) : s.loads;
  if (!rows.length && !s.gravity.on) return { ok: false, message: "add a load, or turn on Own weight" };
  const loads: StressOptions["loads"] = [];
  for (const l of rows) {
    const i = s.loads.indexOf(l);
    const which = s.loads.length > 1 ? `load ${i + 1}` : "the load";
    const area = areaOf(l.faces, l.spots, which);
    if (typeof area === "string") return { ok: false, message: area };
    if (l.kind === "pressure") {
      if (!Number.isFinite(l.pressure) || l.pressure === 0) return { ok: false, message: `${which} needs a pressure` };
      loads.push({ ...area, pressure: l.pressure });
      continue;
    }
    if (!Number.isFinite(l.force) || l.force === 0) return { ok: false, message: `${which} needs a force` };
    const v = forceVector(l);
    if (typeof v === "string") return { ok: false, message: `${which}: ${v}` };
    loads.push({ ...area, force: v.map(roundForce) as Vec3 });
  }
  let material: StressMaterial;
  if (s.material === CUSTOM_MATERIAL) {
    const { E, nu, yield: y, density } = s.custom;
    // A cleared number input reads as "", which compares as 0, so check the type first.
    if (!isNum(E) || !(E > 0)) return { ok: false, message: "the custom material needs a modulus E above 0" };
    if (!isNum(nu) || !(nu >= 0 && nu < 0.5))
      return { ok: false, message: "Poisson's ratio must be from 0 to below 0.5" };
    if (!isNum(y) || !(y > 0)) return { ok: false, message: "the custom material needs a yield strength above 0" };
    const hasDensity = isNum(density) && density > 0;
    if (s.gravity.on && !hasDensity) return { ok: false, message: "own weight needs the material's density in g/cm3" };
    material = { E, nu, yield: y, ...(hasDensity ? { density } : {}), name: CUSTOM_MATERIAL };
  } else {
    if (!STRESS_MATERIALS.some((m) => m.name === s.material))
      return { ok: false, message: `unknown material ${s.material}` };
    material = s.material;
  }
  const options: StressOptions = { supports, loads, material };
  if (s.gravity.on) options.gravity = gravityVector(s.gravity.direction);
  if (s.refine === "fine") {
    options.refine = "fine";
    options.maxElements = FINE_MAX_ELEMENTS;
  } else if (s.refine === "off") options.refine = "off";
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
  /** The rows that say whether it holds and how far it bends; `details` holds the rest. */
  rows: PanelRow[];
  details: PanelRow[];
  warnings: string[];
  /** The colour bar's ends, MPa. */
  legend: { min: number; max: number };
  /** Below 1, or no yield at all, the part is expected to yield. */
  yields: boolean;
  /** What the verdict is worded from, as the view shows it: marked or not. */
  verdict: VerdictInput;
  /** Where the peak stress is, for the weakest spot's pin. */
  peakAt: Vec3 | null;
  /** The largest deflection, mm. */
  maxDeflection: number | null;
  /** Where the highest values are, one row each to look at. */
  peaks: StressPeak[];
}

/** A place worth looking at: `at` and `size` are mm, the words use the display unit. */
export interface StressPeak {
  label: string;
  where: string;
  spoken: string;
  at: Vec3;
  /** How much of the model to frame around `at`, mm. */
  size: number;
}

const PEAK_SIZE_FALLBACK = 20;
const PEAK_SIZE_MIN = 5;

function fmtPoint(p: Vec3, unit: Unit): string {
  const [x, y, z] = p.map((v) => spellRounded(toDisplay(v)));
  return `${listJoin([`x ${x}`, `y ${y}`, `z ${z}`])} ${unit}`;
}

// A third of the drawn surface's diagonal, to the hundredth and at least 5 mm, so the point sits in a view of the part.
function peakSize(positions: ArrayLike<number> | undefined): number {
  if (!positions || positions.length < 3) return PEAK_SIZE_FALLBACK;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const a = i % 3;
    const v = positions[i]!;
    if (v < lo[a]!) lo[a] = v;
    if (v > hi[a]!) hi[a] = v;
  }
  const diag = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
  const size = Math.round((diag / 3) * 100) / 100;
  return size > 0 ? Math.max(size, PEAK_SIZE_MIN) : PEAK_SIZE_FALLBACK;
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
export function formatStressResult(
  r: StressReply,
  unit: Unit,
  supports: readonly StressSupportType[] = [],
  refine: StressRefine = "standard",
): StressResultView {
  const sf = r.safetyFactor;
  const rows: PanelRow[] = [
    { k: "Safety factor", v: sf !== null && Number.isFinite(sf) ? `${spellRounded(sf)}` : "none, no stress" },
    { k: "Peak stress", v: `${spellRounded(r.maxVonMises.value)} MPa` },
    { k: "Max deflection", v: `${spellRounded(toDisplay(r.maxDisplacement.value))} ${unit}` },
  ];
  const details: PanelRow[] = [];
  details.push({ k: "Material", v: r.material.name });
  details.push({ k: "Yield", v: `${spellRounded(r.material.yield)} MPa` });
  if (r.weight) details.push({ k: "Weight", v: fmtForce(r.weight) });
  details.push({ k: "Applied", v: fmtForce(r.applied) });
  details.push({ k: "Reaction", v: fmtForce(r.reaction) });
  // One support's reaction is the total above, so per support only with several.
  const reactions = r.reactions ?? [];
  if (reactions.length > 1) {
    for (const [i, f] of reactions.entries()) {
      const kind = supports[i];
      const label = kind ? SUPPORT_WORDS[kind] : undefined;
      details.push({ k: `Support ${i + 1}${label ? `, ${label}` : ""}`, v: fmtForce(f) });
    }
  }
  details.push({ k: "Mesh", v: meshRow(r.mesh) });
  const refinement = refinementRow(r.mesh);
  if (refinement) details.push({ k: "Mesh detail", v: refinement });
  // Fine starts on a finer mesh, so on some parts its peak reads lower than Standard's (Wall bracket 14.0 against
  // 15.2 MPa, a deep round groove 5% lower) and on others higher.
  if (refine === "fine") details.push({ k: "Note", v: FINE_NOTE });
  const warnings = [...(r.warnings ?? [])];
  for (const e of r.errors ?? []) warnings.push(e.feature_id ? `${e.feature_id}: ${e.message}` : e.message);
  const values = r.surface?.vonMises ?? [];
  const legend = values.length ? valueRange(values) : { min: 0, max: r.maxVonMises.value };
  const size = peakSize(r.surface?.positions);
  // No face number: the engine's one counts the faces of a copy of the body, which nothing else in the app shows.
  const peak = (label: string, value: string, at: Vec3): StressPeak => {
    const where = fmtPoint(at, unit);
    return { label, where, spoken: `${label}, ${value}, at ${where}`, at, size };
  };
  return {
    rows,
    details,
    warnings,
    legend,
    peaks: [
      peak("Peak stress", `${spellRounded(r.maxVonMises.value)} MPa`, r.maxVonMises.at),
      peak("Max deflection", `${spellRounded(toDisplay(r.maxDisplacement.value))} ${unit}`, r.maxDisplacement.at),
    ],
    yields: sf !== null && sf < 1,
    verdict: { safetyFactor: sf, peakPlace: peakPlaceOf(r.warnings ?? []) },
    peakAt: r.maxVonMises.at,
    maxDeflection: r.maxDisplacement.value,
  };
}

function meshRow(m: StressReply["mesh"]): string {
  const row = `${m.elements} elements, ${spellRounded(m.size)} mm`;
  const passes = m.passes?.length ?? 1;
  if (passes < 2 || m.finest === undefined || !(m.finest < m.size)) return row;
  return `${row}, ${spellRounded(m.finest)} mm at the peak, ${passes} passes`;
}

const FINE_NOTE =
  "Fine starts on a finer mesh than Standard and can read a lower peak, check the safety factor with Standard too";

const REFINE_STOPS: Record<string, string> = {
  settled: "a finer mesh would barely move the peak",
  elements: "stopped at the element limit",
  time: "stopped to stay within about a minute",
  memory: "stopped as a finer mesh needs more memory",
  unrefinable: "nothing left to refine",
};

function refinementRow(m: StressReply["mesh"]): string | null {
  if (m.stop === undefined) return null;
  const passes = m.passes ?? [];
  const why = REFINE_STOPS[m.stop];
  if (passes.length < 2) {
    if (m.stop === "off") return "Coarse";
    if (m.stop === "settled") return `Not needed, ${why}`;
    return why ? why[0]!.toUpperCase() + why.slice(1) : null;
  }
  const n = passes.length - 1;
  const moved = `${n === 1 ? "Refined once" : `Refined ${n} times`}, the peak went from ${spellRounded(passes[0]!.maxVonMises)} to ${spellRounded(passes[n]!.maxVonMises)} MPa`;
  return why ? `${moved}, then ${why}` : moved;
}

/** The legend's end labels, MPa. A minimum under a thousandth of the peak is no colour of its own, so it reads 0. */
export function legendEnds(legend: { min: number; max: number }): [string, string] {
  const min = Math.abs(legend.min) < Math.abs(legend.max) / 1000 ? 0 : legend.min;
  return [spellRounded(min), spellRounded(legend.max)];
}

/** Labels for the colour bar at each quarter of the range, MPa, the ends as legendEnds reads them. */
export function legendTicks(legend: { min: number; max: number }): { pct: number; label: string }[] {
  const [low, high] = legendEnds(legend);
  return [0, 25, 50, 75, 100].map((pct) => ({
    pct,
    label:
      pct === 0 ? low : pct === 100 ? high : spellRounded(legend.min + ((legend.max - legend.min) * pct) / 100),
  }));
}

/** The setup a result ran with, in one line: what holds it, what pushes, its own weight and the material. */
export function setupSummary(s: StressSetup): string {
  const n = (k: number, what: string) => `${k} ${what}${k === 1 ? "" : "s"}`;
  const parts = [n(s.supports.length, "support"), n(s.loads.length, "load")];
  if (s.gravity.on) parts.push(`own weight ${s.gravity.direction}`);
  parts.push(s.material);
  return parts.join(", ");
}

function fmtForce(f: Vec3): string {
  return `${listJoin(f.map((v) => spellRounded(v)))} N`;
}

export type StressRamp = "perceptual" | "rainbow" | "greyscale";

export const STRESS_RAMPS: readonly { value: StressRamp; label: string }[] = [
  { value: "perceptual", label: "Perceptual" },
  { value: "rainbow", label: "Rainbow" },
  { value: "greyscale", label: "Greyscale" },
];

const hex = (h: string): Vec3 => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as Vec3;

// Perceptual is viridis. Rainbow falls in lightness and merges green with orange for colour blind viewers, it stays as a choice.
const RAMPS: Record<StressRamp, readonly Vec3[]> = {
  perceptual: ["#440154", "#472d7b", "#3b528b", "#2c728e", "#21918c", "#28ae80", "#5ec962", "#addc30", "#fde725"].map(
    hex,
  ),
  rainbow: ["#0000ff", "#00ffff", "#00ff00", "#ffff00", "#ff0000"].map(hex),
  greyscale: ["#262626", "#f2f2f2"].map(hex),
};

/** sRGB 0..1 for a value 0..1 along the ramp (clamped; NaN reads as 0). */
export function rampColor(ramp: StressRamp, t: number): Vec3 {
  const stops = RAMPS[ramp];
  const c = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  const x = c * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Eight bands put every second edge on the legend's 25, 50 and 75 percent marks. */
export const STRESS_BANDS = 8;

/** The centre of the band t falls in; 0 bands leaves t alone. */
export function bandT(t: number, bands: number): number {
  if (bands <= 0) return t;
  const c = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  return (Math.min(bands - 1, Math.floor(c * bands)) + 0.5) / bands;
}

/** One sRGB triple per value, mapped over [min, max]. A flat field (max = min) is all the low colour. */
export function stressColors(
  values: ArrayLike<number>,
  min: number,
  max: number,
  ramp: StressRamp = "perceptual",
  bands = 0,
): Float32Array {
  const out = new Float32Array(values.length * 3);
  const span = max - min;
  for (let i = 0; i < values.length; i++) {
    const t = span > 0 ? ((values[i] ?? min) - min) / span : 0;
    const [r, g, b] = rampColor(ramp, bandT(t, bands));
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return out;
}

const css = (c: Vec3) => `rgb(${c.map((v) => Math.round(v * 255)).join(", ")})`;

/** The legend's CSS gradient, left (low) to right (high), from the same colours. Banded, each band is a hard stop pair. */
export function legendGradient(ramp: StressRamp = "perceptual", bands = 0): string {
  const parts: string[] = [];
  if (bands > 0) {
    for (let i = 0; i < bands; i++) {
      const colour = css(rampColor(ramp, bandT((i + 0.5) / bands, bands)));
      parts.push(`${colour} ${(i / bands) * 100}%`, `${colour} ${((i + 1) / bands) * 100}%`);
    }
  } else {
    const stops = RAMPS[ramp];
    stops.forEach((s, i) => parts.push(`${css(s)} ${(i / (stops.length - 1)) * 100}%`));
  }
  return `linear-gradient(to right, ${parts.join(", ")})`;
}

// Arrow length grows with the cube root of the force, so doubling an arrow is eight times the force. In screen pixels,
// since the arrow is a constant size handle and a drag measures what the hand moved.

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

/** A drag is measured from where it started, so pressing the tip and letting go changes nothing, and an arrow capped
 *  at its longest still grows and shrinks from the real force. */
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

/** `v` is the tip offset from the root in world units, in the camera-facing plane. A candidate within `degrees` on
 *  screen takes over and the length is measured along it; one facing the camera is skipped. Null back on the root. */
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

/** A custom direction is rounded to three decimals, all a hand can aim. The force is always positive, the direction
 *  carries the sign. */
export function forceDragPatch(
  snapped: { key: ForceDirection; dir: Vec3; length: number },
  worldPerPx: number,
  start: ForceDragStart,
): { direction: ForceDirection; custom: Vec3 | null; force: number } {
  const px = worldPerPx > 0 ? snapped.length / worldPerPx + start.offsetPx : start.px;
  const custom: Vec3 | null =
    snapped.key === "custom" ? [round3(snapped.dir[0]), round3(snapped.dir[1]), round3(snapped.dir[2])] : null;
  return { direction: snapped.key, custom, force: dragForce(start, px) };
}

// A select option is a plain word, so the label's message names each direction by one.
const DRAG_WORDS: Record<ForceDirection, string> = {
  into: "into",
  custom: "custom",
  "-Z": "down",
  "+Z": "up",
  "+X": "right",
  "-X": "left",
  "+Y": "back",
  "-Y": "front",
};

/** The live label beside a dragged arrow. */
export function forceDragLabel(patch: { direction: ForceDirection; force: number }): string {
  return t("stress.drag.label", { force: patch.force, direction: DRAG_WORDS[patch.direction] });
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000 + 0;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

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

/** Up to `max` spots over a pressure's faces, with the direction into the face there. Taken in the faces' own order,
 *  since area order would bunch them on the big triangles. */
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

/** The pin axis as a segment through the face and a little past both ends. Null when the face is not a cylinder,
 *  which the engine refuses. */
export function pinAxisSegment(points: readonly Vec3[], normals: readonly Vec3[]): { from: Vec3; to: Vec3 } | null {
  const cyl = cylinderFromFace([...points], [...normals]);
  if (!cyl) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    const t =
      (p[0] - cyl.point[0]) * cyl.axis[0] + (p[1] - cyl.point[1]) * cyl.axis[1] + (p[2] - cyl.point[2]) * cyl.axis[2];
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  if (!(hi >= lo)) return null;
  const margin = Math.max(0.25 * (hi - lo), cyl.radius);
  const at = (t: number): Vec3 => [
    cyl.point[0] + cyl.axis[0] * t,
    cyl.point[1] + cyl.axis[1] * t,
    cyl.point[2] + cyl.axis[2] * t,
  ];
  return { from: at(lo - margin), to: at(hi + margin) };
}

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
  return `${spellNumber(scale === 0 ? 0 : roundSig(scale, 2))}x`;
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

export const SWING_PERIOD_MS = 1600;

/** The deformation's swing: 0 to `scale` and back, eased at both ends, at `scale` half way through a period. */
export function swingScale(timeMs: number, scale: number, periodMs = SWING_PERIOD_MS): number {
  return (scale * (1 - Math.cos((2 * Math.PI * timeMs) / periodMs))) / 2;
}

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

/** Von Mises (MPa) and deflection (mm, its size and vector) interpolated at `weights` in surface triangle `tri`.
 *  Deflection is null without displacement data; null for a triangle the surface lacks. */
export function probeValues(
  surface: {
    indices: ArrayLike<number>;
    vonMises: ArrayLike<number>;
    displacement?: ArrayLike<number> | undefined;
    stress?: ArrayLike<number> | undefined;
  },
  tri: number,
  weights: Vec3,
): { vonMises: number; deflection: number | null; vector: Vec3 | null } | null {
  if (!(tri >= 0) || tri * 3 + 2 >= surface.indices.length) return null;
  const ids = [surface.indices[tri * 3]!, surface.indices[tri * 3 + 1]!, surface.indices[tri * 3 + 2]!];
  const vm = vonMisesAt(surface, tri, weights);
  const d = surface.displacement;
  if (!d || !d.length) return { vonMises: vm, deflection: null, vector: null };
  const at = (k: number, j: number) => weights[k]! * (d[ids[k]! * 3 + j] ?? 0);
  const vec: Vec3 = [0, 1, 2].map((j) => at(0, j) + at(1, j) + at(2, j)) as Vec3;
  return { vonMises: vm, deflection: Math.hypot(vec[0], vec[1], vec[2]), vector: vec };
}

/** A probe's readout: stress in MPa, deflection in the display unit. */
export function probeLabel(p: { vonMises: number; deflection: number | null }, unit: Unit): string {
  const vm = `${spellRounded(p.vonMises)} MPa`;
  return p.deflection === null ? vm : listJoin([vm, `${spellRounded(toDisplay(p.deflection))} ${unit}`]);
}

/** An engine refusal in the panel's words. The engine names a support or a
 *  load for MCP callers too, as "support 1 (supports[0].faces[1])"; the panel
 *  calls the same row "Support 1", so the request path is dropped. */
export function panelMessage(message: string): string {
  const named = message
    .replace(
      /\b(support|load) (\d+) \((?:supports|loads)\[\d+\][^)]*\)/g,
      (_, kind: string, n: string) => `${kind === "support" ? "Support" : "Load"} ${n}`,
    )
    .replace(/\b(?:supports|loads)\[\d+\]\.spots\[(\d+)\] of /g, (_, i: string) => `spot ${Number(i) + 1} of `);
  return named.charAt(0).toUpperCase() + named.slice(1);
}
