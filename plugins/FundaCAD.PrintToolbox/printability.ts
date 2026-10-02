// The pure half of the Printability panel: the settings and their defaults,
// turning them into the engine's `printability` op's options, turning its reply
// into plain-English rows grouped by body, and the face tints for each kind of
// finding that the viewport and the panel's legend share. Nothing here touches
// the viewport or the store, so all of it is testable in node.

import { displayRound } from "fundacad";
import type {
  PrintabilityCheck, PrintabilityFinding, PrintabilityKind, PrintabilityOptions, PrintabilityReply, PrintabilityUp,
} from "fundacad";

export interface PrintabilitySetup {
  /** mm whatever the display unit: these are nozzle-sized numbers, and the
   *  engine's report quotes them in mm. */
  nozzle: number;
  layer: number;
  /** Degrees past vertical a face may lean before it needs support. */
  overhang: number;
  minGap: number;
  maxBridge: number;
  up: PrintabilityUp;
  /** Lay each body on its largest flat face instead of turning it by `up`. */
  layFlat: boolean;
  checks: Record<PrintabilityCheck, boolean>;
}

export const UP_CHOICES: readonly { value: PrintabilityUp; label: string }[] = [
  { value: "+Z", label: "+Z, as modelled" },
  { value: "-Z", label: "-Z" },
  { value: "+X", label: "+X" },
  { value: "-X", label: "-X" },
  { value: "+Y", label: "+Y" },
  { value: "-Y", label: "-Y" },
];

export const CHECKS: readonly { value: PrintabilityCheck; label: string }[] = [
  { value: "overhang", label: "Overhangs" },
  { value: "wall", label: "Thin walls" },
  { value: "gap", label: "Gaps" },
  { value: "bridge", label: "Bridges" },
  { value: "open", label: "Open shells" },
];

export function newPrintabilitySetup(): PrintabilitySetup {
  return {
    nozzle: 0.4,
    layer: 0.2,
    overhang: 45,
    minGap: 0.2,
    maxBridge: 10,
    up: "+Z",
    layFlat: false,
    checks: { overhang: true, wall: true, gap: true, bridge: true, open: true },
  };
}

/** One tint per kind, in the view and beside the legend. Clear of the app's
 *  hover amber and selection orange, which mark the finding a row puts forward. */
export const KIND_COLORS: Record<PrintabilityKind, number> = {
  overhang: 0xff5c8a,
  bridge: 0xb48cff,
  wall: 0x3fa9f5,
  floor: 0x3fd0c9,
  gap: 0x8bd450,
  fused: 0xe23b3b,
  meshHole: 0xf0e442,
};

/** A tint as a CSS colour, for the legend's swatches. */
export function cssHex(c: number): string {
  return `#${c.toString(16).padStart(6, "0")}`;
}

export const KIND_LABELS: Record<PrintabilityKind, string> = {
  overhang: "Overhang",
  bridge: "Bridge",
  wall: "Thin wall",
  floor: "Thin floor",
  gap: "Gap",
  fused: "Fused",
  meshHole: "Mesh hole",
};

export type PrintabilityRequest = { ok: true; options: PrintabilityOptions } | { ok: false; message: string };

/** The panel's settings as the op's options for `bodies`, or the first thing
 *  in the way, phrased for the status line. Every setting is sent, so what the
 *  engine checks against is what the panel shows. */
/** `bodies` empty checks every body. */
export function buildPrintabilityRequest(s: PrintabilitySetup, bodies: string[]): PrintabilityRequest {
  // A cleared number input reads as "", which compares as 0, so check the type first.
  if (!isNum(s.nozzle) || !(s.nozzle > 0)) return { ok: false, message: "the nozzle width must be above 0" };
  if (!isNum(s.layer) || !(s.layer > 0)) return { ok: false, message: "the layer height must be above 0" };
  if (!isNum(s.overhang) || !(s.overhang > 0 && s.overhang < 90)) {
    return { ok: false, message: "the overhang angle must be between 0 and 90 degrees" };
  }
  if (!isNum(s.minGap) || !(s.minGap > 0)) return { ok: false, message: "the smallest gap must be above 0" };
  if (!isNum(s.maxBridge) || !(s.maxBridge > 0)) return { ok: false, message: "the longest bridge must be above 0" };
  const checks = CHECKS.map((c) => c.value).filter((c) => s.checks[c]);
  if (!checks.length) return { ok: false, message: "tick at least one check" };
  const options: PrintabilityOptions = {
    nozzle: s.nozzle,
    layer: s.layer,
    overhang: s.overhang,
    minGap: s.minGap,
    maxBridge: s.maxBridge,
  };
  if (bodies.length) options.bodies = [...bodies];
  // Left out when all are on, so the engine runs all it has.
  if (checks.length < CHECKS.length) options.checks = checks;
  if (s.layFlat) options.layFlat = true;
  else options.up = s.up;
  return { ok: true, options };
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** One finding's row: its words and where it sits in the reply's findings. */
export interface FindingRow {
  index: number;
  kind: PrintabilityKind;
  text: string;
}

export interface BodyGroup {
  body: string;
  name: string;
  /** Problems with the body as a whole, an open shell or several pieces. */
  notes: string[];
  rows: FindingRow[];
}

/** The reply as the panel shows it. `findings` stays the engine's own, which
 *  the rows index into, for the faces and where to look. */
export interface PrintabilityView {
  header: string;
  groups: BodyGroup[];
  findings: PrintabilityFinding[];
  /** The kinds found, in legend order. */
  kinds: PrintabilityKind[];
  errors: string[];
}

// In mm like the settings they are held to; see PrintabilitySetup.
function mm(v: number): string {
  return `${displayRound(v)} mm`;
}

function area(v: number): string {
  return `${v >= 10 ? Math.round(v) : displayRound(v)} mm²`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A finding in a few plain words. `nameOf` names the other body of a fused pair. */
export function findingText(f: PrintabilityFinding, nameOf: (id: string) => string): string {
  let text: string;
  switch (f.kind) {
    case "overhang":
      text = `Overhang, ${area(f.area)} leaning ${Math.round(f.value)}°`;
      break;
    case "bridge":
      text = `Bridge ${mm(f.value)} span (over ${displayRound(f.limit)})`;
      break;
    case "wall":
      text = `Thin wall ${mm(f.value)} (under ${displayRound(f.limit)})`;
      break;
    case "floor":
      text = `Thin floor ${mm(f.value)} (under ${displayRound(f.limit)})`;
      break;
    case "gap":
      text = `Gap ${mm(f.value)} will fuse`;
      break;
    case "fused": {
      const other = f.other ? nameOf(f.other.body) : "another body";
      // Under a thousandth is touching, as far as the nozzle can tell.
      text = f.value >= 0.001 ? `${mm(f.value)} from ${other}, prints fused` : `Touches ${other}, prints fused`;
      break;
    }
    case "meshHole":
      text = `Mesh has ${plural(Math.round(f.value), "open edge", "open edges")}`;
      break;
    default:
      text = String(f.kind);
  }
  return f.note ? `${text}, ${f.note}` : text;
}

/** The kinds in the legend's order, which is also the order of KIND_COLORS. */
export const KIND_ORDER = Object.keys(KIND_COLORS) as PrintabilityKind[];

/** The reply grouped by body, in the reply's body order, each finding a row.
 *  A finding on a body the reply does not list still gets a group. */
export function formatPrintabilityResult(r: PrintabilityReply): PrintabilityView {
  const names = new Map(r.bodies.map((b) => [b.id, b.name || b.id]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const groups = new Map<string, BodyGroup>();
  const groupOf = (id: string): BodyGroup => {
    let g = groups.get(id);
    if (!g) {
      g = { body: id, name: nameOf(id), notes: [], rows: [] };
      groups.set(id, g);
    }
    return g;
  };
  for (const b of r.bodies) {
    const g = groupOf(b.id);
    if (b.openEdges > 0) g.notes.push(`Open shell, ${plural(b.openEdges, "open edge", "open edges")}`);
    if (b.solids > 1) g.notes.push(`${b.solids} separate pieces`);
    if (b.insideOut) g.notes.push("Inside out, may print hollow or not at all");
  }
  const kinds = new Set<PrintabilityKind>();
  r.findings.forEach((f, index) => {
    groupOf(f.body).rows.push({ index, kind: f.kind, text: findingText(f, nameOf) });
    kinds.add(f.kind);
  });
  const errors = (r.errors ?? []).map((e) => (e.feature_id ? `${e.feature_id}: ${e.message}` : e.message));
  return {
    header: r.header,
    groups: [...groups.values()],
    findings: r.findings,
    kinds: KIND_ORDER.filter((k) => kinds.has(k)),
    errors,
  };
}

/** How many things the check found, body-level problems included. */
export function problemCount(v: PrintabilityView): number {
  return v.groups.reduce((n, g) => n + g.notes.length + g.rows.length, 0);
}

/** The tints for a result, in display face ids: each finding's face in its
 *  kind's colour, and the one finding put forward (its face and the face
 *  across from it) in `emphasisColor` instead. `faceOf` turns a body's own
 *  face index into the viewport's id, or null for a face that cannot be
 *  drawn, on a hidden body or past the body's faces. */
export function findingMarks(
  findings: readonly PrintabilityFinding[],
  emphasis: number | null,
  emphasisColor: number,
  faceOf: (body: string, face: number) => number | null,
): { faceIds: number[]; color: number }[] {
  const forward = new Set<number>();
  const f = emphasis === null ? undefined : findings[emphasis];
  if (f) {
    const ends: [string, number][] = [[f.body, f.face]];
    if (f.other) ends.push([f.other.body, f.other.face]);
    for (const [body, face] of ends) {
      const id = faceOf(body, face);
      if (id !== null) forward.add(id);
    }
  }
  const byKind = new Map<PrintabilityKind, Set<number>>();
  // Both sides of a wall, a gap or a fused pair, as the row names both.
  for (const x of findings) {
    const ends: [string, number][] = [[x.body, x.face]];
    if (x.other) ends.push([x.other.body, x.other.face]);
    for (const [body, face] of ends) {
      const id = faceOf(body, face);
      if (id === null || forward.has(id)) continue;
      const set = byKind.get(x.kind) ?? new Set<number>();
      set.add(id);
      byKind.set(x.kind, set);
    }
  }
  const marks = KIND_ORDER.filter((k) => byKind.has(k)).map((k) => ({ faceIds: [...byKind.get(k)!], color: KIND_COLORS[k] }));
  if (forward.size) marks.push({ faceIds: [...forward], color: emphasisColor });
  return marks;
}

/** Where to look for a finding: its point, and a view about twice its size
 *  across, never under 5 mm so a pinhole still shows what is around it. */
export function findingView(f: PrintabilityFinding): { at: [number, number, number]; size: number } {
  const e = Number.isFinite(f.extent) ? f.extent : 0;
  return { at: [f.at[0], f.at[1], f.at[2]], size: Math.max(5, 2 * e) };
}
