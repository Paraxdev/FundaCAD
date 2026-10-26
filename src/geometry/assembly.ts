// Assembles a rebuild reply's per-body payloads into one flat RebuildResult. A chunked reply's head frame
// lists every body, so all offsets are planned before any payload arrives and chunks may land in any order.

import type { EngineTiming } from "../diagnostics/editTiming";
import type { FaceColorRuns, F32Wire, RebuildResult, U32Wire } from "../types";

// Protocol v2 wire shapes (server.py _rebuild_job / _body_payload). `unchanged` marks a stub for a cached etag.
export interface WireBodyFull {
  id: string;
  name: string;
  etag: string;
  unchanged?: false;
  /** "<importFeatureId>/<nodeIndex>" for a body from an imported assembly tree. */
  nodeRef?: string;
  /** Packed per-face colours from the imported file. In the envelope, not the etag-cached payload,
   *  because they can change while the geometry does not. */
  faceColors?: FaceColorRuns;
  /** The colour the imported file gave this body's solid. In the envelope, like faceColors. */
  partColor?: string;
  /** A read-only reference scan: one surfaceless face, never in a boolean. */
  scan?: true;
  positions: F32Wire;
  indices: U32Wire;
  faceIds: U32Wire;
  // Sent at shipping quality and for bodies a plugin mesh pass displaced, absent on a large document's coarse tier.
  normals?: F32Wire;
  faceOwners?: (string | null)[];
  /** Runs of LOCAL face indices that are pieces of one surface (face_bands.py).
   *  Absent on the ordinary body, which has no run. */
  faceBands?: number[][];
  /** Per-face palette slot; the capability that owns the palette resolves the colour.
   *  The key is a contract with crates/fundacad-geom/src/mesh/mod.rs, guarded by tests/geometry/wireKeys.test.ts. */
  faceColorSlots?: (number | null)[];
  edges?: WireEdgeList;
  faceCount?: number;
  /** Why the body is not a closed solid facing outward, worded to follow its
   *  name. Absent for a sound body. */
  fault?: string;
}

export interface WireBodyStub {
  id: string;
  name: string;
  etag: string;
  nodeRef?: string;
  faceColors?: FaceColorRuns;
  partColor?: string;
  scan?: true;
  unchanged: true;
}
export type WireBody = WireBodyFull | WireBodyStub;

/** Edge polylines as every consumer sees them; decodeBinaryFrame expands the packed binary form first. */
export type WireEdgeList = { points: [number, number, number][]; body?: string; smooth?: boolean; reach?: number }[];

// The engine's raw rebuild result: a resync request, a protocol v2 per-body result, or the legacy single mesh.
// One flat all-optional shape so the `?.resync` / `?.protocol` checks need no narrowing.
export interface WireRebuildResult {
  resync?: true;
  protocol?: 2;
  timing?: EngineTiming;
  bodies?: WireBody[];
  bbox?: { min: number[]; max: number[] } | null;
  diagnostics?: RebuildResult["diagnostics"];
  featureError?: RebuildResult["featureError"];
  featureErrors?: RebuildResult["featureErrors"];
  // projectionUpdates to trackedFaces ride the header, not per-body payloads: stubs would drop them, datums have no body.
  projectionUpdates?: RebuildResult["projectionUpdates"];
  datumPlanes?: RebuildResult["datumPlanes"];
  sketchPlanes?: RebuildResult["sketchPlanes"];
  datumMarks?: RebuildResult["datumMarks"];
  trackedFaces?: RebuildResult["trackedFaces"];
  bodyIds?: RebuildResult["bodyIds"];
  skippedFeatures?: RebuildResult["skippedFeatures"];
  // legacy direct-mesh shape (only when `protocol` is absent)
  mesh?: RebuildResult["mesh"];
  edges?: RebuildResult["edges"];
  /** Set only by the chunked path, which assembles as frames arrive, so assemble() does not redo it. */
  assembled?: RebuildResult;
}

/** One row of a chunked reply's manifest (server.py _manifest_entry), every body in final order.
 *  Stubs carry no sizes by design: their arrays live in this client's cache, which begin() checks anyway. */
export interface WireManifestEntry {
  id: string;
  name: string;
  etag: string;
  nodeRef?: string;
  faceColors?: FaceColorRuns;
  partColor?: string;
  scan?: true;
  unchanged?: true;
  faceCount?: number;
  nVerts3?: number;
  nIdx?: number;
  nTris?: number;
  nEdges?: number;
  hasNormals?: true;
}

type RebuildBody = NonNullable<RebuildResult["bodies"]>[number];

/** Where one body's data goes in the flat arrays, planned from the manifest so bodies may arrive in any order. */
interface BodyPlan {
  id: string;
  vOff: number; // into positions/normals
  nVerts3: number;
  iOff: number; // into indices
  nIdx: number;
  tOff: number; // into faceIds
  nTris: number;
  faceBase: number; // this body's global faceId offset (== meta.faceStart)
  faceCount: number;
  edgeBase: number;
  nEdges: number;
}

/** Manifest entries from a non-chunked reply, so the single frame and chunked paths share code. */
export function manifestFromBodies(bodies: WireBody[]): WireManifestEntry[] {
  return bodies.map((b) => {
    const e: WireManifestEntry = { id: b.id, name: b.name, etag: b.etag };
    if (b.nodeRef !== undefined) e.nodeRef = b.nodeRef;
    if (b.faceColors !== undefined) e.faceColors = b.faceColors;
    if (b.partColor !== undefined) e.partColor = b.partColor;
    if (b.scan) e.scan = true;
    if (b.unchanged) {
      e.unchanged = true;
      return e;
    }
    e.faceCount = b.faceCount ?? 0;
    e.nVerts3 = b.positions.length;
    e.nIdx = b.indices.length;
    e.nTris = b.faceIds.length;
    e.nEdges = b.edges?.length ?? 0;
    if (b.normals !== undefined) e.hasNormals = true;
    return e;
  });
}

export type BeginOutcome =
  /** A stub named an etag no longer cached. Decided before any allocation, so a resync costs one round trip. */
  | { kind: "resync" }
  /** Nothing changed: the previous result, BY REFERENCE. */
  | { kind: "noop"; result: RebuildResult }
  | { kind: "stream"; assembly: RebuildAssembly };

export class RebuildAssembly {
  /** Allocated at full size up front. Regions of bodies that have not arrived are still zeros,
   *  so readers before complete() must stick to written bodies. */
  readonly result: RebuildResult;
  readonly plan: BodyPlan[];
  readonly sig: string | null;
  // Typed arrays behind result.mesh, held separately so writes use .set() without casts
  // (RebuildResult also allows plain arrays).
  private readonly positions: Float32Array;
  private readonly normals: Float32Array | undefined;
  private readonly indices: Uint32Array;
  private readonly faceIds: Uint32Array;
  private readonly index = new Map<string, number>();
  private readonly written: boolean[];
  private left: number;

  private constructor(
    result: RebuildResult,
    arrays: { positions: Float32Array; normals?: Float32Array; indices: Uint32Array; faceIds: Uint32Array },
    plan: BodyPlan[],
    sig: string | null,
  ) {
    this.result = result;
    this.positions = arrays.positions;
    this.normals = arrays.normals;
    this.indices = arrays.indices;
    this.faceIds = arrays.faceIds;
    this.plan = plan;
    this.sig = sig;
    plan.forEach((p, i) => this.index.set(p.id, i));
    this.written = new Array(plan.length).fill(false);
    this.left = plan.length;
  }

  static begin(
    head: WireRebuildResult,
    manifest: WireManifestEntry[],
    cache: Map<string, WireBodyFull>,
    lastAssembled: RebuildResult | null,
    lastSig: string | null,
  ): BeginOutcome {
    // Resolve every entry first: an uncached stub etag means resync, found before allocation or partial display.
    const sizes: WireManifestEntry[] = [];
    for (const m of manifest) {
      if (!m.unchanged) {
        sizes.push(m);
        continue;
      }
      const cached = cache.get(m.id);
      if (!cached || cached.etag !== m.etag) return { kind: "resync" };
      sizes.push({
        ...m,
        faceCount: cached.faceCount ?? 0,
        nVerts3: cached.positions.length,
        nIdx: cached.indices.length,
        nTris: cached.faceIds.length,
        nEdges: cached.edges?.length ?? 0,
        ...(cached.normals !== undefined ? { hasNormals: true as const } : {}),
      });
    }

    // No-op fast path: all stubs with a matching signature means identical arrays. Rebuilding them cost ~98 MiB
    // and 0.171 s per rebuild. The previous object is returned by reference because setModel's fast path keys on
    // identity; the signature includes non-geometry extras since they can change while geometry does not.
    const sig =
      manifest.length === 0
        ? null
        : JSON.stringify([
            sizes.map((m) => [m.id, m.etag, m.name, m.nodeRef, m.faceCount, m.faceColors, m.partColor, m.scan]),
            head.bbox,
            head.diagnostics,
            head.featureError,
            head.featureErrors,
            head.projectionUpdates,
            // Datums and face-anchored sketches belong to no body, so they can move with every etag unchanged.
            head.datumPlanes,
            head.sketchPlanes,
            head.datumMarks,
            head.trackedFaces,
            head.bodyIds,
            head.skippedFeatures,
          ]);
    if (sig !== null && sig === lastSig && lastAssembled !== null && manifest.every((m) => m.unchanged)) {
      return { kind: "noop", result: lastAssembled };
    }

    // One cumulative walk plans every offset, keeping faceStart and faceId rebasing identical to the single-shot path.
    const plan: BodyPlan[] = [];
    let vOff = 0,
      iOff = 0,
      tOff = 0,
      faceBase = 0,
      edgeBase = 0;
    for (const m of sizes) {
      const nVerts3 = m.nVerts3 ?? 0,
        nIdx = m.nIdx ?? 0,
        nTris = m.nTris ?? 0;
      const faceCount = m.faceCount ?? 0,
        nEdges = m.nEdges ?? 0;
      plan.push({ id: m.id, vOff, nVerts3, iOff, nIdx, tOff, nTris, faceBase, faceCount, edgeBase, nEdges });
      vOff += nVerts3;
      iOff += nIdx;
      tOff += nTris;
      faceBase += faceCount;
      edgeBase += nEdges;
    }

    // A body without normals keeps a zeroed slice, and render.ts falls back to computeVertexNormals for it.
    const anyNormals = sizes.some((m) => m.hasNormals);
    const arrays = {
      positions: new Float32Array(vOff),
      indices: new Uint32Array(iOff),
      faceIds: new Uint32Array(tOff),
      ...(anyNormals ? { normals: new Float32Array(vOff) } : {}),
    };
    const mesh: RebuildResult["mesh"] = { ...arrays };
    const meta: RebuildBody[] = sizes.map((m, i) => ({
      // Identity from the envelope, geometry from the payload: a stub's cached mesh keeps the id, name and
      // nodeRef from its last geometry change.
      id: m.id,
      name: m.name,
      faceStart: plan[i]!.faceBase,
      faceCount: m.faceCount ?? 0,
      ...(m.etag !== undefined ? { etag: m.etag } : {}),
      ...(m.nodeRef !== undefined ? { nodeRef: m.nodeRef } : {}),
      ...(m.faceColors !== undefined ? { faceColors: m.faceColors } : {}),
      ...(m.partColor !== undefined ? { partColor: m.partColor } : {}),
      ...(m.scan ? { scan: true as const } : {}),
    }));
    const out: RebuildResult = {
      mesh,
      edges: new Array(edgeBase),
      // The wire sends bbox null before anything has built; RebuildResult types it as always present.
      bbox: head.bbox as RebuildResult["bbox"],
      bodies: meta,
    };
    if (head.diagnostics) out.diagnostics = head.diagnostics;
    if (head.featureError) out.featureError = head.featureError;
    if (head.featureErrors) out.featureErrors = head.featureErrors;
    if (head.projectionUpdates) out.projectionUpdates = head.projectionUpdates;
    if (head.datumPlanes) out.datumPlanes = head.datumPlanes;
    if (head.sketchPlanes) out.sketchPlanes = head.sketchPlanes;
    if (head.datumMarks) out.datumMarks = head.datumMarks;
    if (head.trackedFaces) out.trackedFaces = head.trackedFaces;
    if (head.bodyIds) out.bodyIds = head.bodyIds;
    if (head.skippedFeatures) out.skippedFeatures = head.skippedFeatures;

    const asm = new RebuildAssembly(out, arrays, plan, sig);
    // Stubs are backed by the cache and fill now; full payloads wait for their chunk.
    for (const m of manifest) {
      if (m.unchanged) asm.writeBody(cache.get(m.id)!);
    }
    return { kind: "stream", assembly: asm };
  }

  /** Copy one body's payload into its planned slice, false if it disagrees with the manifest. Load-bearing:
   *  an over-long payload would overwrite the next body believably, so false must fail the whole rebuild. */
  writeBody(p: WireBodyFull): boolean {
    const i = this.index.get(p.id);
    if (i === undefined) return false;
    const q = this.plan[i]!;
    if (
      p.positions.length !== q.nVerts3 ||
      p.indices.length !== q.nIdx ||
      p.faceIds.length !== q.nTris ||
      (p.edges?.length ?? 0) !== q.nEdges
    )
      return false;

    const { edges, bodies } = this.result;
    this.positions.set(p.positions as ArrayLike<number>, q.vOff);
    if (this.normals && p.normals !== undefined) {
      this.normals.set(p.normals as ArrayLike<number>, q.vOff);
    }
    // `indices` has 3 entries per triangle, `faceIds` has one. Mixing them up scatters later bodies' faceIds past
    // the triangle range and renders every body after the first as bare edges.
    const vbase = q.vOff / 3;
    const pi = p.indices,
      pf = p.faceIds;
    for (let k = 0; k < pi.length; k++) this.indices[q.iOff + k] = (pi[k] as number) + vbase;
    for (let k = 0; k < pf.length; k++) this.faceIds[q.tOff + k] = (pf[k] as number) + q.faceBase;
    const pe = p.edges ?? [];
    for (let k = 0; k < pe.length; k++) {
      const e = pe[k]!;
      edges[q.edgeBase + k] = {
        id: `e${q.edgeBase + k}`,
        points: e.points,
        ...(e.body !== undefined ? { body: e.body } : {}),
        ...(e.smooth ? { smooth: true } : {}),
        ...(e.reach !== undefined ? { reach: e.reach } : {}),
      };
    }
    // geometry-side metadata only reachable from the payload
    const m = bodies![i]!;
    if (p.faceOwners !== undefined) m.faceOwners = p.faceOwners;
    if (p.faceBands !== undefined) m.faceBands = p.faceBands;
    if (p.faceColorSlots !== undefined) m.faceColorSlots = p.faceColorSlots;
    if (p.fault !== undefined) m.fault = p.fault;

    if (!this.written[i]) {
      this.written[i] = true;
      this.left--;
    }
    return true;
  }

  has(id: string): boolean {
    const i = this.index.get(id);
    return i !== undefined && this.written[i]!;
  }

  /** Half-open triangle range (not face ids) of the given bodies. Readers of in-progress arrays must stay
   *  inside written ranges, since unwritten zeros are valid faceIds. */
  triRange(ids: string[]): { triStart: number; triEnd: number } {
    let triStart = Infinity;
    let triEnd = 0;
    for (const id of ids) {
      const i = this.index.get(id);
      if (i === undefined) continue;
      const q = this.plan[i]!;
      triStart = Math.min(triStart, q.tOff);
      triEnd = Math.max(triEnd, q.tOff + q.nTris);
    }
    return { triStart: Number.isFinite(triStart) ? triStart : 0, triEnd };
  }

  edgesOf(id: string): RebuildResult["edges"] {
    const i = this.index.get(id);
    if (i === undefined) return [];
    const q = this.plan[i]!;
    return this.result.edges.slice(q.edgeBase, q.edgeBase + q.nEdges);
  }

  metaOf(id: string): RebuildBody | undefined {
    const i = this.index.get(id);
    return i === undefined ? undefined : this.result.bodies![i];
  }

  get remaining(): number {
    return this.left;
  }

  /** Null while any body is missing: zeroed slices would render as plausible degenerate geometry, not an error. */
  complete(): RebuildResult | null {
    return this.left === 0 ? this.result : null;
  }
}
