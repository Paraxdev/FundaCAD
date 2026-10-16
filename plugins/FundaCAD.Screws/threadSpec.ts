// Standard threads for the core `thread` feature: which size a round face is,
// and the groove or ridge profile each family cuts. The engine only sweeps a
// profile; every standard number lives here, beside the fastener tables.

import THREADS from "./catalogue/threads.json";

export type ThreadSystem = "iso" | "unc" | "unf" | "tr" | "acme";
export type FaceIs = "nominal" | "tap";
export type Hand = "right" | "left";

export interface ThreadChoice {
  system: ThreadSystem;
  size: string;
  designation: string;
  /** Nominal major diameter, mm. */
  d: number;
  /** Axial pitch, mm. */
  pitch: number;
  fine: boolean;
  /** The bore a tap of this size goes into, mm. */
  tap: number;
}

const IN = 25.4;
const H60 = Math.sqrt(3) / 2;
const TAN30 = Math.tan(Math.PI / 6);
const TAN15 = Math.tan(Math.PI / 12);
const TAN_ACME = Math.tan((14.5 * Math.PI) / 180);
/** ASME B1.5 general purpose depth allowance, 0.010 in. */
const ACME_ALLOWANCE = 0.254;

interface MetricRow { d: number; coarse: number; fine?: number[] }
interface InchRow { d: number; unc?: number; unf?: number }
interface TrRow { d: number; pitch: number; other?: number[] }
interface AcmeRow { d: number; tpi: number }

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The basic minor diameter D1 of a 60 degree internal thread. */
function minor60(d: number, p: number): number {
  return d - 2 * (5 / 8) * H60 * p;
}

/** ISO 2904 crest clearance for a trapezoidal pitch. */
export function trapezoidalAc(p: number): number {
  const rows = THREADS.trapezoidal.ac as [number, number][];
  return (rows.find(([upTo]) => p <= upTo + 1e-9) ?? rows[rows.length - 1]!)[1];
}

export function threadChoices(): ThreadChoice[] {
  const out: ThreadChoice[] = [];
  const holes = THREADS.holes as Record<string, { tap: number }>;
  for (const [size, row] of Object.entries(THREADS.metric.sizes as Record<string, MetricRow>)) {
    out.push({ system: "iso", size, designation: size, d: row.d, pitch: row.coarse, fine: false, tap: holes[size]?.tap ?? r3(row.d - row.coarse) });
    for (const p of row.fine ?? []) {
      out.push({ system: "iso", size, designation: `${size}x${p}`, d: row.d, pitch: p, fine: true, tap: r3(row.d - p) });
    }
  }
  for (const [size, row] of Object.entries(THREADS.inch.sizes as Record<string, InchRow>)) {
    const d = row.d * IN;
    for (const [system, tpi] of [["unc", row.unc], ["unf", row.unf]] as const) {
      if (!tpi) continue;
      const p = IN / tpi;
      out.push({ system, size, designation: `${size}-${tpi} ${system.toUpperCase()}`, d, pitch: p, fine: system === "unf", tap: r3(minor60(d, p)) });
    }
  }
  for (const [size, row] of Object.entries(THREADS.trapezoidal.sizes as Record<string, TrRow>)) {
    for (const p of [row.pitch, ...(row.other ?? [])]) {
      out.push({ system: "tr", size, designation: `${size}x${p}`, d: row.d, pitch: p, fine: p !== row.pitch, tap: row.d - p });
    }
  }
  for (const [size, row] of Object.entries(THREADS.acme.sizes as Record<string, AcmeRow>)) {
    const d = row.d * IN;
    const p = IN / row.tpi;
    out.push({ system: "acme", size, designation: `${size}-${row.tpi} ACME`, d, pitch: p, fine: false, tap: d - p });
  }
  return out;
}

export interface NearestThread {
  choice: ThreadChoice;
  faceIs: FaceIs;
  /** Face diameter minus the diameter it was matched to, mm: negative is under. */
  offBy: number;
}

/** The standard thread a round face most likely is. A shaft is matched by its
 *  major diameter; a bore by its tap drill or, failing that, its nominal size,
 *  so an M6 tap bore of 5.0 reads as M6 and not as M5. Coarse is preferred
 *  over fine, and ISO over UNC/UNF, when two sizes are equally near. */
export function nearestThread(
  faceDiameter: number,
  external: boolean,
  systems: readonly ThreadSystem[] = ["iso", "unc", "unf"],
): NearestThread | null {
  let best: NearestThread | null = null;
  let bestScore = Infinity;
  const order: ThreadSystem[] = ["iso", "unc", "unf", "tr", "acme"];
  for (const choice of threadChoices()) {
    if (!systems.includes(choice.system)) continue;
    const refs: [FaceIs, number][] = external ? [["nominal", choice.d]] : [["tap", choice.tap], ["nominal", choice.d]];
    for (const [faceIs, dia] of refs) {
      const offBy = faceDiameter - dia;
      // Ties go to tap over nominal, coarse over fine, then system order.
      const score = Math.abs(offBy) + (faceIs === "nominal" && !external ? 1e-6 : 0)
        + (choice.fine ? 2e-6 : 0) + order.indexOf(choice.system) * 1e-7;
      if (score < bestScore) {
        bestScore = score;
        best = { choice, faceIs, offBy: r3(offBy) };
      }
    }
  }
  return best;
}

export function formatOffBy(n: NearestThread): string {
  const how = n.faceIs === "tap" ? "tap drill" : "nominal";
  if (Math.abs(n.offBy) < 0.0005) return `${n.choice.designation}, on ${how}`;
  return `${n.choice.designation}, ${Math.abs(n.offBy).toFixed(2)} mm ${n.offBy < 0 ? "under" : "over"} ${how}`;
}

interface Groove { h: number; w0: number; tan: number }

/** The thread's groove, depth `h` into the material from the face with width
 *  `w0` at the face, for a face at the major (shaft) or at the minor (tap bore). */
function groove(system: ThreadSystem, p: number, external: boolean): Groove {
  switch (system) {
    case "tr": {
      const h = 0.5 * p + trapezoidalAc(p);
      return { h, w0: 0.634 * p, tan: TAN15 };
    }
    case "acme":
      return { h: 0.5 * p + ACME_ALLOWANCE, w0: p - 0.3707 * p, tan: TAN_ACME };
    default:
      // External root at 17H/24 with the P/8 crest; internal 5H/8 from D1 with the P/4 crest.
      return external ? { h: (17 / 24) * H60 * p, w0: 0.875 * p, tan: TAN30 } : { h: (5 / 8) * H60 * p, w0: 0.75 * p, tan: TAN30 };
  }
}

/** How far a profile runs out of the material so its flanks cross the face,
 *  short enough that it stays narrower than the pitch. */
function breakout(g: Groove, p: number): number {
  const room = (0.96 * p - g.w0) / (2 * g.tan);
  return Math.max(0, Math.min(0.15 * g.h, room));
}

/** The `[into, along]` outline the engine sweeps. A shaft or a tap bore gets
 *  the groove, cut; a bore drawn at nominal gets the internal tooth, joined. */
export function threadProfile(system: ThreadSystem, p: number, external: boolean, faceIs: FaceIs): { profile: [number, number][]; operation: "cut" | "join" } {
  if (!external && faceIs === "nominal") {
    // The tooth is the space between two grooves: wide where the groove floor
    // is narrow (at the major) and narrow where the groove opens (at the minor).
    const g = groove(system, p, false);
    const base = p - (g.w0 - 2 * g.h * g.tan);
    const tip = p - g.w0;
    const b = Math.max(0, Math.min(0.15 * g.h, (0.98 * p - base) / (2 * g.tan)));
    const out = base / 2 + b * g.tan;
    return { profile: [[b, -out], [-g.h, -tip / 2], [-g.h, tip / 2], [b, out]].map(rnd) as [number, number][], operation: "join" };
  }
  const g = groove(system, p, external);
  const b = breakout(g, p);
  const out = g.w0 / 2 + b * g.tan;
  const floor = g.w0 / 2 - g.h * g.tan;
  return { profile: [[-b, -out], [g.h, -floor], [g.h, floor], [-b, out]].map(rnd) as [number, number][], operation: "cut" };
}

const rnd = (pt: number[]) => pt.map((v) => Math.round(v * 1e5) / 1e5);

export interface ThreadOptions {
  id: string;
  face: Record<string, unknown>;
  axis?: [number, number, number] | undefined;
  choice: ThreadChoice;
  faceIs: FaceIs;
  external: boolean;
  starts?: number;
  hand?: Hand;
  /** Radial print clearance, mm; 0 or absent for none. */
  clearance?: number;
  length?: number | undefined;
  offset?: number | undefined;
}

/** The PRINT fit's default radial clearance, mm. */
export const PRINT_CLEARANCE = 0.2;

/** A core `thread` feature for a standard thread, with the choice kept in
 *  `spec` so the panel can open on it again. */
export function threadFeature(o: ThreadOptions): Record<string, unknown> {
  const { profile, operation } = threadProfile(o.choice.system, o.choice.pitch, o.external, o.faceIs);
  const f: Record<string, unknown> = {
    id: o.id, type: "thread", face: o.face, profile, pitch: o.choice.pitch,
    starts: o.starts ?? 1, hand: o.hand ?? "right", operation,
    spec: { system: o.choice.system, size: o.choice.size, designation: o.choice.designation, faceIs: o.faceIs, external: o.external },
  };
  if (o.axis) f.axis = o.axis;
  if (o.clearance) f.clearance = o.clearance;
  if (o.length != null) f.length = o.length;
  if (o.offset) f.offset = o.offset;
  return f;
}
