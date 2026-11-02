// The Geometry list's rows as plain numbers. Words are made per page from `facts`, so 10,000 faces cost one page of
// describePick.

import type { RebuildResult, TopologyFace, TopologyReply, Vec3 } from "../types";
import { bandIndex } from "../viewport/faceBands";
import { facingOf, type EdgeFacts, type FaceFacts, type FacingWord } from "./describePick";
import { circleDiameter, polylineLength, type Pt3 } from "./selectionMeasure";

export type GeometryRowType = "flat" | "cylinder" | "curved" | "straight" | "round";

export interface GeometryRow {
  /** `f:<bodyId>:<local>` or `e:<bodyId>:<slot>`. A global face id is worked out only when acting on it, so a build
   *  that renumbers later bodies moves nothing. */
  key: string;
  kind: "face" | "edge";
  bodyId: string;
  /** The face's place in its body, its run's lowest for a run, or the edge's wire slot. */
  index: number;
  facts: FaceFacts | EdgeFacts;
  /** The one length the size filter compares, mm, 0 when nothing says. */
  size: number;
  facing: FacingWord | null;
  type: GeometryRowType;
  /** Every face of a run, ascending. Absent on a face that is alone. */
  members?: readonly number[];
}

export interface GeometryFilters {
  type: GeometryRowType | null;
  facing: FacingWord | null;
  /** mm */
  minSize: number | null;
}
export const NO_FILTERS: GeometryFilters = { type: null, facing: null, minSize: null };

type Body = NonNullable<RebuildResult["bodies"]>[number];
export type BodyMeta = Pick<Body, "id" | "name" | "faceCount" | "faceOwners" | "faceBands">;
/** A wire edge as the viewport holds it. */
export type WireEdge = { readonly slot: number; readonly points: readonly Pt3[] };

const NO_RUNS: ReadonlyMap<number, readonly number[]> = new Map();

// Through bandIndex, so a run a click would refuse is no run here either.
function runsOf(meta: BodyMeta): ReadonlyMap<number, readonly number[]> {
  if (!meta.faceBands?.length) return NO_RUNS;
  return bandIndex([{ faceStart: 0, faceCount: meta.faceCount, faceBands: meta.faceBands }]);
}

export const edgeKeyOf = (bodyId: string, slot: number) => `e:${bodyId}:${slot}`;

/** The key of the row that holds this face, its run's row for a piece of a run. */
export function faceKeyOf(meta: BodyMeta, local: number): string {
  return `f:${meta.id}:${runsOf(meta).get(local)?.[0] ?? local}`;
}

function faceSize(f: TopologyFace): number {
  if (f.surface === "plane" && f.size) return f.size[0];
  if ((f.surface === "cylinder" || f.surface === "sphere" || f.surface === "torus") && f.radius !== undefined) {
    return f.radius * 2;
  }
  return Math.sqrt(f.area ?? 0);
}

function faceType(surface: TopologyFace["surface"]): GeometryRowType {
  return surface === "plane" ? "flat" : surface === "cylinder" ? "cylinder" : "curved";
}

function faceFacts(f: TopologyFace, meta: BodyMeta, ownerName: (id: string) => string | null): FaceFacts {
  const facts: FaceFacts = { kind: "face", number: f.i + 1, surface: f.surface, body: meta.name };
  if (f.area !== undefined) facts.area = f.area;
  if (f.size) facts.size = f.size;
  if (f.normal) facts.normal = f.normal;
  if (f.axis) facts.axis = f.axis;
  if (f.radius !== undefined) facts.radius = f.radius;
  if (f.wraps !== undefined) facts.full = f.wraps;
  if (f.concave !== undefined) facts.concave = f.concave;
  if (f.length !== undefined) facts.length = f.length;
  if (f.centroid) facts.centroid = f.centroid;
  if (meta.faceOwners) {
    const owner = meta.faceOwners[f.i];
    facts.owner = owner ? ownerName(owner) : null;
  }
  return facts;
}

function massCentre(pieces: readonly TopologyFace[]): Vec3 | undefined {
  let area = 0;
  const sum: Vec3 = [0, 0, 0];
  for (const p of pieces) {
    if (!p.centroid || !p.area) return undefined;
    area += p.area;
    for (const k of [0, 1, 2] as const) sum[k] += p.centroid[k] * p.area;
  }
  return area > 0 ? [sum[0] / area, sum[1] / area, sum[2] / area] : undefined;
}

// A run's pieces overlap along an axis and lie side by side on a flat, so one piece's size or length says nothing of
// the whole. Its area adds up, its type and owner are its first piece's.
function mergedPiece(run: readonly number[], byIndex: ReadonlyMap<number, TopologyFace>): TopologyFace {
  const pieces = run.flatMap((i) => byIndex.get(i) ?? []);
  const { size: _size, length: _length, centroid: _centroid, ...lead } = pieces[0]!;
  const merged: TopologyFace = lead;
  const area = pieces.reduce((s, p) => s + (p.area ?? 0), 0);
  if (area > 0) merged.area = area;
  const centroid = massCentre(pieces);
  if (centroid) merged.centroid = centroid;
  return merged;
}

export function faceRows(
  reply: TopologyReply,
  meta: BodyMeta,
  ownerName: (id: string) => string | null,
): GeometryRow[] {
  const runs = runsOf(meta);
  const byIndex = new Map(runs.size ? reply.faces.map((f) => [f.i, f]) : []);
  const taken = new Set<readonly number[]>();
  const rows: GeometryRow[] = [];
  for (const source of reply.faces) {
    if (source.i >= meta.faceCount) continue;
    const run = runs.get(source.i);
    if (run) {
      if (taken.has(run)) continue;
      taken.add(run);
    }
    const f = run ? mergedPiece(run, byIndex) : source;
    const index = run ? run[0]! : source.i;
    const facts = faceFacts({ ...f, i: index }, meta, ownerName);
    if (run) facts.pieces = run.length;
    const row: GeometryRow = {
      key: `f:${meta.id}:${index}`,
      kind: "face",
      bodyId: meta.id,
      index,
      facts,
      size: faceSize(f),
      facing: f.surface === "plane" && f.normal ? (facingOf(f.normal)?.word ?? null) : null,
      type: faceType(f.surface),
    };
    if (run) row.members = run;
    rows.push(row);
  }
  return rows;
}

const distance = (a: Pt3, b: Pt3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Wire points are exact on a line, so this only has to clear float noise and stay under the bow of a large shallow arc.
const LINE_TOL_MM = 1e-4;
// A spline passing near a circle should stay a curve, and a wire vertex lies on its curve.
const ARC_TOL = 0.005;

function isStraight(points: readonly Pt3[]): boolean {
  const a = points[0]!;
  const b = points[points.length - 1]!;
  const chord = distance(a, b);
  if (chord === 0) return points.every((p) => distance(p, a) <= LINE_TOL_MM);
  const u = [(b[0] - a[0]) / chord, (b[1] - a[1]) / chord, (b[2] - a[2]) / chord] as const;
  return points.every((p) => {
    const d = [p[0] - a[0], p[1] - a[1], p[2] - a[2]] as const;
    const along = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
    return Math.hypot(d[0] - along * u[0], d[1] - along * u[1], d[2] - along * u[2]) <= LINE_TOL_MM;
  });
}

// The circle through the first, middle and last points, every other point has to lie on it too.
function arcRadius(points: readonly Pt3[]): number | null {
  if (points.length < 3) return null;
  const a = points[0]!;
  const b = points[points.length >> 1]!;
  const c = points[points.length - 1]!;
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
  const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]] as const;
  const nn = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
  if (nn === 0) return null;
  const abb = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const acc = ac[0] * ac[0] + ac[1] * ac[1] + ac[2] * ac[2];
  // The centre relative to a: (|ab|^2 (ac x n) + |ac|^2 (n x ab)) / 2|n|^2.
  const cx = (abb * (ac[1] * n[2] - ac[2] * n[1]) + acc * (n[1] * ab[2] - n[2] * ab[1])) / (2 * nn);
  const cy = (abb * (ac[2] * n[0] - ac[0] * n[2]) + acc * (n[2] * ab[0] - n[0] * ab[2])) / (2 * nn);
  const cz = (abb * (ac[0] * n[1] - ac[1] * n[0]) + acc * (n[0] * ab[1] - n[1] * ab[0])) / (2 * nn);
  const radius = Math.hypot(cx, cy, cz);
  const centre: Pt3 = [a[0] + cx, a[1] + cy, a[2] + cz];
  return points.every((p) => Math.abs(distance(p, centre) - radius) <= radius * ARC_TOL) ? radius : null;
}

function edgeCurve(points: readonly Pt3[]): { curve: EdgeFacts["curve"]; radius?: number } {
  if (points.length < 2 || isStraight(points)) return { curve: "line" };
  const diameter = circleDiameter(points);
  if (diameter !== null) return { curve: "circle", radius: diameter / 2 };
  const closed = distance(points[0]!, points[points.length - 1]!) <= polylineLength(points) * 1e-3;
  const radius = closed ? null : arcRadius(points);
  return radius !== null ? { curve: "arc", radius } : { curve: "curve" };
}

const EDGE_TYPE: Record<EdgeFacts["curve"], GeometryRowType> = {
  line: "straight",
  circle: "round",
  arc: "round",
  curve: "curved",
};

/** `edgeFaces` is one per wire edge. If its length is not `wireCount` the op and the viewport walked different wires,
 *  so only the facts it gives are dropped and the rows stay. */
export function edgeRows(
  refs: readonly WireEdge[],
  wireCount: number,
  edgeFaces: readonly (readonly number[])[] | undefined,
  meta: BodyMeta,
  ownerName: (id: string) => string | null,
): GeometryRow[] {
  const joins = edgeFaces?.length === wireCount ? edgeFaces : null;
  const runs = runsOf(meta);
  return refs.map((ref) => {
    const { curve, radius } = edgeCurve(ref.points);
    const length = polylineLength(ref.points);
    const facts: EdgeFacts = { kind: "edge", number: ref.slot + 1, curve, length, body: meta.name };
    if (radius !== undefined) facts.radius = radius;
    const joined = joins?.[ref.slot]?.filter((f) => f >= 0 && f < meta.faceCount);
    if (joined) {
      facts.faces = [...new Set(joined.map((f) => (runs.get(f)?.[0] ?? f) + 1))];
      const owner = meta.faceOwners && joined.length ? meta.faceOwners[joined[0]!] : null;
      facts.owner = owner ? ownerName(owner) : null;
    }
    return {
      key: edgeKeyOf(meta.id, ref.slot),
      kind: "edge",
      bodyId: meta.id,
      index: ref.slot,
      facts,
      size: length,
      facing: null,
      type: EDGE_TYPE[curve],
    };
  });
}

// A kernel length can fall a hair under the value it shows, and an inch limit is never exact in mm.
const SIZE_NOISE_MM = 1e-6;

export function filterRows(rows: readonly GeometryRow[], f: GeometryFilters): readonly GeometryRow[] {
  const limit = f.minSize !== null && f.minSize > 0 ? f.minSize - SIZE_NOISE_MM : null;
  if (!f.type && !f.facing && limit === null) return rows;
  return rows.filter(
    (r) =>
      (!f.type || r.type === f.type) && (!f.facing || r.facing === f.facing) && (limit === null || r.size >= limit),
  );
}
