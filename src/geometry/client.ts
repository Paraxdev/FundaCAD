// Client of the geometry engine over ./transport.ts: one request and reply per message, matched by `id`.
// Calls made before the transport opens are queued and flushed on open.

import type {
  CadDocument,
  EdgeFingerprint,
  ExportFormat,
  F32Wire,
  MeshExportOptions,
  Feature,
  PlaneDef,
  ImportFormat,
  ImportReply,
  PlaneSpec,
  ProjectedCurve,
  ProjectedSource,
  RebuildReply,
  RebuildResult,
  Selector,
  SketchEntity,
  U32Wire,
  Vec3,
} from "../types";
import { RebuildAssembly, manifestFromBodies } from "./assembly";
import { pipe, pipeFault } from "../diagnostics/pipelineLog";
import { BUILD_PHASE } from "./buildPhase";
import { EngineTransport, type GeometryTransport } from "./transport";
import { blake2b128Hex } from "../document/blake2b";

const BLOB_PUT_CHUNK = 4 * 1024 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
import type { WireBody, WireBodyFull, WireEdgeList, WireManifestEntry, WireRebuildResult } from "./assembly";

// The engine's reply envelope (server.py _ok/_err); `result`'s type is per op, given as call<T>()'s parameter.
interface WireError {
  message: string;
  feature_id?: string;
}
type RawReply<T> =
  | { id: string; ok: true; result: T }
  // `cancelled` marks a failure the user caused with Cancel: still ok:false, but callers can skip the error banner.
  | { id: string; ok: false; cancelled?: boolean; error: WireError };

type Pending = (msg: RawReply<unknown>) => void;
type StatusListener = (connected: boolean) => void;

/** One tessellated glyph face: an outer contour + zero or more hole contours (the
 *  counters in o/a/e), each a closed 2D polyline in final sketch coordinates. */
export type TextFace = { outer: [number, number][]; holes: [number, number][][] };

/** Per-source outcome of projectGeometry, one curve per resolved edge. `fp` is the engine's fingerprint for a
 *  body edge, which the caller wraps in a by:"match" selector, absent for sketch curves; ok:false is a refusal. */
export interface ProjectionResult {
  source_index: number;
  ok: boolean;
  curves: { fp?: EdgeFingerprint; curve: ProjectedCurve }[];
  error?: string;
}

// `positions`/`indices` coarsely triangulate the overlap solid for a display overlay only, absent if that failed.
export interface ClashPair {
  a: string;
  b: string;
  aName: string;
  bName: string;
  volume: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  positions?: number[];
  indices?: number[];
}

// A clearance near miss: closer than the threshold, not overlapping, with the two nearest points for a marker.
export interface ClearancePair {
  a: string;
  b: string;
  aName: string;
  bName: string;
  distance: number;
  pointA: [number, number, number];
  pointB: [number, number, number];
}

export interface InterferenceReply {
  ok: boolean;
  pairs?: ClashPair[];
  clearances?: ClearancePair[];
  truncated?: boolean;
  message?: string;
  unchecked?: UncheckedBody[];
}

/** A body an interference check could not judge, with why in words that
 *  follow its name: no pair with it was tested. */
export interface UncheckedBody {
  id: string;
  name: string;
  reason: string;
}

/** Where a generated shape goes: its local origin to `origin`, its +Z along `zAxis`. */
export interface ShapePlacement {
  origin: [number, number, number];
  zAxis: [number, number, number];
}

/** A solid from a shape generator, measured off the B-rep. `mesh` answers output "mesh",
 *  flat arrays with one normal per position; `geom` answers "store", a blob store hash. */
export interface GeneratedShape {
  solid: boolean;
  valid: boolean;
  faces: number;
  volume: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  geom?: string;
  mesh?: { positions: number[]; indices: number[]; normals: number[] };
}

export type GeneratedShapeReply = { ok: true; shape: GeneratedShape } | { ok: false; message: string };

/** The `patternAxis` op: the line a circular pattern's `axisRef` names. */
export type PatternAxisReply =
  { axis: { origin: [number, number, number]; dir: [number, number, number] } } | { reason: string };

/** The `faceAxis` op: `dir` points out of the material, `hole` marks the round
 *  end of a bore on the bore's own axis, `sameAsNormal` a flat face square to
 *  the axis, which moves the same either way. */
export type FaceAxisReply = (
  | { axis: { origin: [number, number, number]; dir: [number, number, number] }; hole: boolean; sameAsNormal?: boolean }
  | { reason: string }
) & { resize?: FaceResize };

/** The `faceAnchor` op: a picked point in the terms a `textOnFace` stores. */
export type FaceAnchorReply =
  | {
      body: string;
      surface: "plane" | "cylinder" | "cone" | "sphere" | "other";
      /** fractions of the face's (u, v) range */
      at: [number, number];
      normal: Vec3;
      fp?: Record<string, unknown>;
    }
  | { reason: string };

/** How a cylinder, cone, sphere or torus face resizes (docs/PROTOCOL.md, faceAxis). */
export interface FaceResize {
  kind: "cylinder" | "cone" | "sphere" | "torus";
  /** radius, tube radius, or 0 for a cone */
  size: number;
  full: boolean;
  concave: boolean;
  axis?: { origin: Vec3; dir: Vec3 };
  centre?: Vec3;
  /** the size where a neighbour would first be left behind */
  contact: number | null;
  tangent: {
    faces: number;
    lostWhen: "shrink" | "grow" | null;
    run: Vec3[];
    closed: boolean;
    followable: boolean;
  };
}

/** A material preset the engine knows by name, or one typed in (MPa, and
 *  g/cm3 for the density gravity needs). */
export type StressMaterial = string | { E: number; nu: number; yield: number; density?: number; name?: string };

/** One support: `fixed` holds its faces every way, `pinned` holds cylindrical
 *  faces radially and along their axis but lets them turn about it, `slider`
 *  holds them along their normal only. */
export interface StressSupport {
  type: "fixed" | "pinned" | "slider";
  faces?: Selector[];
  /** A fixed support only. */
  spots?: StressSpotArea[];
}

/** The body's surface within `radius` mm of the point `at`, for a support or a
 *  load on a place with no face of its own. */
export interface StressSpotArea {
  at: Vec3;
  radius: number;
}

/** What a load pushes on: faces, spots or both. */
export interface StressLoadArea {
  faces?: Selector[];
  spots?: StressSpotArea[];
}

/** `stress` options (docs/PROTOCOL.md). Selectors carry their body. Units mm, N and MPa; a force is the total
 *  over its faces, a pressure pushes into them. `fixed` is the older spelling of a fixed support, and one of it
 *  or `supports` is required. Gravity is in m/s2, `true` meaning 9.81 down Z. */
export interface StressOptions {
  fixed?: Selector[];
  supports?: StressSupport[];
  loads: (StressLoadArea & ({ force: Vec3 } | { pressure: number }))[];
  gravity?: boolean | Vec3;
  material: StressMaterial;
  size?: number;
  maxElements?: number;
}

/** A linear static analysis of one body, display only. `surface` is the analysis mesh boundary with a value per
 *  vertex, `displacement` three numbers per vertex, `weight` the gravity force (null without gravity), and
 *  `reactions` one force per support, `fixed` first; older engines omit the last two. */
export interface StressReply {
  body: string;
  name: string;
  material: { name: string; E: number; nu: number; yield: number; density?: number | null };
  mesh: { nodes: number; elements: number; size: number; minDihedral: number };
  /** `face` is null for a peak inside the body, away from every face. */
  maxVonMises: { value: number; at: Vec3; face?: number | null };
  maxDisplacement: { value: number; at: Vec3; vector: Vec3 };
  /** Null when nothing is stressed, so nothing yields. */
  safetyFactor: number | null;
  applied: Vec3;
  reaction: Vec3;
  weight?: Vec3 | null;
  reactions?: Vec3[];
  warnings?: string[];
  surface?: { positions: number[]; indices: number[]; faceIds?: number[]; vonMises: number[]; displacement?: number[] };
  errors?: { feature_id?: string; message: string }[];
}

export type StressResult = { ok: true; result: StressReply } | { ok: false; message: string; cancelled?: boolean };

export type PrintabilityCheck = "overhang" | "wall" | "gap" | "bridge" | "open";
export type PrintabilityUp = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";

/** `printability` options (docs/PROTOCOL.md). Lengths in mm, overhang in degrees past vertical. `up` and
 *  `layFlat` are exclusive, and without either it prints +Z up. Leaving `checks` out runs every check. */
export interface PrintabilityOptions {
  bodies?: string[];
  nozzle?: number;
  layer?: number;
  overhang?: number;
  minGap?: number;
  maxBridge?: number;
  checks?: PrintabilityCheck[];
  up?: PrintabilityUp;
  /** True to lay each body on its largest flat face, or a face index per body id. */
  layFlat?: true | Record<string, number>;
}

export type PrintabilityKind = "overhang" | "bridge" | "wall" | "floor" | "gap" | "fused" | "meshHole" | "flatTriangle";

/** One finding. `face` is the body's own face index (inspect's `i`), which the viewport offsets by faceStart.
 *  `other` is the facing face of a wall, floor, gap or fused pair, on another body for `fused`. */
export interface PrintabilityFinding {
  kind: PrintabilityKind;
  body: string;
  face: number;
  other: { body: string; face: number } | null;
  /** Degrees past vertical for an overhang (90 a flat ceiling), the open mesh
   *  edges for a meshHole, the triangles without area for a flatTriangle,
   *  otherwise mm: a span, a thickness or a gap. */
  value: number;
  /** What a wall, floor, gap, fused pair or bridge was held to, mm; 0 otherwise. */
  limit: number;
  area: number;
  /** An overhang's lowest point above the bed, mm. */
  low: number;
  at: Vec3;
  extent: number;
  note: string;
}

/** How the part was checked and what turned up, ordered per body and kind.
 *  `bodies` and `findings` are empty when nothing built, and `errors` says why. */
export interface PrintabilityReply {
  header: string;
  report: string;
  settings: {
    nozzle: number;
    layer: number;
    overhang: number;
    minGap: number;
    maxBridge: number;
    up: string | null;
    layFlat: boolean;
  };
  bodies: {
    id: string;
    name: string;
    up: Vec3;
    bed: number;
    bedFace: number | null;
    openEdges: number;
    solids: number;
    insideOut: boolean;
    fault?: string | null;
  }[];
  findings: PrintabilityFinding[];
  errors?: { feature_id?: string; message: string }[];
}

export type PrintabilityResult =
  { ok: true; result: PrintabilityReply } | { ok: false; message: string; cancelled?: boolean };

// The surface the rest of the app depends on: `Geometry` implements it over either engine's transport, tests stub it.
export interface GeometryBackend {
  /** `onId` receives the request id, again if a resync sends it a second time. */
  rebuild(doc: CadDocument, tolerance?: number, onId?: (id: string) => void): Promise<RebuildReply>;
  /** Per-glyph 2D outlines for a sketch text entity; the engine owns fonts, so previews match the extruded solid. */
  tessellateText(entity: object, pathEntity?: object): Promise<TextFace[]>;
  /** Project body edges, face boundaries or sketch curves onto a sketch plane. `doc` is the timeline prefix for
   *  that sketch. Pick-time sources use by:"nearest", refresh-time ones the stored by:"match" fingerprint, and a
   *  silhouette carries only the body id. Strict per source; a transport failure returns []. */
  projectGeometry(doc: CadDocument, plane: PlaneSpec, sources: ProjectedSource[]): Promise<ProjectionResult[]>;
  listFonts(): Promise<string[]>;
  /** One-way v4 to v5: move a document's inline base64 BREP into the blob store, returning each feature's hash.
   *  Best effort, the document keeps its inline copy, so a failure costs nothing. */
  migrateGeometry(items: { id: string; brep: string }[]): Promise<{ id: string; geom: string }[]>;
  export(
    doc: CadDocument,
    format: ExportFormat,
    path: string,
    // palette/bodyColors are read only by formats that carry colour (GLB).
    opts?: {
      body?: string;
      bodies?: string[];
      separate?: boolean;
      palette?: { name: string; color: string; material?: string }[];
      bodyColors?: Record<string, number>;
      mesh?: MeshExportOptions;
      /** DXF and SVG draw one sketch, or one flat face in `plane`. */
      sketch?: string;
      face?: unknown;
      plane?: PlaneDef;
      tolerance?: number;
    },
    // Hands back the request id so a Cancel targets this export, not whatever ran most recently
    // (the document stays editable while an export runs).
    onStarted?: (id: string) => void,
  ): Promise<{
    ok: boolean;
    path?: string;
    paths?: string[];
    message?: string;
    // The user stopped it, so the caller stays silent rather than reporting it as an error.
    cancelled?: boolean;
    // Features that failed during the export rebuild; their bodies are absent from the written files.
    warnings?: { message: string; feature_id?: string }[];
  }>;
  // Read an external file into an embeddable BREP for an `import` feature; the engine reads the path itself.
  // `onStarted` gets the request id so a Cancel targets this op.
  importGeometry(
    path: string,
    format: ImportFormat,
    onStarted?: (id: string) => void,
    unit?: string,
  ): Promise<ImportReply>;
  /** The same import from the file's bytes, base64, for a caller with no path
   *  (a file dropped on a browser tab). Optional, a test backend may lack it. */
  importBytes?(
    name: string,
    format: ImportFormat,
    data: string,
    onStarted?: (id: string) => void,
    unit?: string,
  ): Promise<ImportReply>;
  /** A solid from a shape generator a plugin registered with the engine (docs/PLUGINS.md). "mesh" previews;
   *  "store" writes the blob store, and an `import` carrying the returned `geom` rebuilds without the plugin. */
  generateShape?(
    generator: string,
    params: object,
    opts?: { output?: "mesh" | "store"; placement?: ShapePlacement },
  ): Promise<GeneratedShapeReply>;
  // Pairwise clash check. `clearance` (mm) adds near misses in `clearances`, `truncated` marks a candidate pair
  // cap on a dense assembly, and `unchecked` lists bodies that are not closed solids, whose pairs are in neither list.
  interference(doc: CadDocument, clearance?: number): Promise<InterferenceReply>;
  /** The axis a press/pull with `direction: "axis"` would move this face along, or why it has none.
   *  Null when the engine could not be asked. */
  faceAxis?(doc: CadDocument, face: Selector, body: string | null): Promise<FaceAxisReply | null>;
  /** Where `point` sits on `face`, as a fingerprint and (u, v) fractions. */
  faceAnchor?(doc: CadDocument, face: Selector, body: string | null, point: Vec3): Promise<FaceAnchorReply | null>;
  /** Linear static stress in one body (id or name). `onStarted` hands back the request id for `cancel(id)`. */
  stress?(doc: CadDocument, body: string, opts: StressOptions, onStarted?: (id: string) => void): Promise<StressResult>;
  /** What would go wrong printing the bodies layer by layer: overhangs, thin walls, gaps, bridges and open
   *  shells. `onStarted` as for `stress`. */
  printability?(
    doc: CadDocument,
    opts: PrintabilityOptions,
    onStarted?: (id: string) => void,
  ): Promise<PrintabilityResult>;
  patternAxis?(doc: CadDocument, ref: Selector): Promise<PatternAxisReply | null>;
  /** World polylines the built model cuts a sketch's areas along on one plane, the ones every consuming feature
   *  cuts with. Null when the engine holds no build of `doc` or could not be asked. */
  profileCuts?(doc: CadDocument, origin: Vec3, normal: Vec3, reach?: Vec3[]): Promise<Vec3[][] | null>;
  /** Export through a format a plugin registered with the engine. `options` reach the plugin's exporter
   *  untouched and `info` is whatever it reports back. */
  exportWith?(
    doc: CadDocument,
    path: string,
    exporter: string,
    options: Record<string, unknown>,
    onStarted?: (id: string) => void,
  ): Promise<{
    ok: boolean;
    path?: string;
    info?: Record<string, unknown>;
    message?: string;
    cancelled?: boolean;
    warnings?: { message: string; feature_id?: string }[];
  }>;
  // Call once before any op. Earlier ops queue in the outbox until it opens, so ordering is not critical.
  init(): Promise<void>;
  onStatus(fn: StatusListener): () => void;
  /** Build progress about once a second: the feature running (-1 outside the feature phase), while meshing the
   *  `meshed`/`meshTotal` bodies really being meshed (else -1), and the engine's `phase`. */
  onProgress?(fn: (feature: number, meshed: number, meshTotal: number, phase: number) => void): () => void;
  /** Installments of a chunked rebuild reply for progressive display; the in-process backend never streams. */
  onRebuildChunk?(fn: (c: RebuildChunk) => void): () => void;
  /** MCAD-style "Compute All": rebuild bypassing every cache layer. Optional. */
  computeAll?(doc: CadDocument, tolerance?: number): Promise<RebuildReply>;
  /** Stop an op in flight. Pass the id the busy state owns, not the most recent one.
   *  Resolves to whether anything stopped. */
  cancel?(target?: string, opts?: { soft?: boolean }): Promise<boolean>;
  /** A soft cancel stops a job at its next checkpoint and never restarts the
   *  engine to do it. Without it a superseded rebuild is left to finish. */
  readonly softCancel?: boolean;
  /** Stage progress for a long op (import), `pct` null while a stage has no fraction. */
  onOpProgress?(fn: OpProgressListener): () => void;
  /** Our request waits behind another client's job on the same engine: `behind` says whose, null once ours starts. */
  onQueue?(fn: (id: string, behind: EngineWait | null) => void): () => void;
  /** One live-session op (live_session.py): publish what this window has open, collect what an assistant asked
   *  for. One untyped passthrough on purpose, since it is not geometry. Null when unsupported or failed, so
   *  "no session" and "no backend" share one path. */
  session?(op: string, payload?: object): Promise<Record<string, unknown> | null>;
  /** Put bytes in the engine's content addressed blob store, resolving to the
   *  hash a document names them by. Rejects with the engine's message. */
  blobPut?(bytes: Uint8Array): Promise<string>;
  /** The bytes stored under `hash`, null when the store has none. */
  blobGet?(hash: string): Promise<Uint8Array | null>;
  readonly connected: boolean;
  /** Requests not answered yet, where the backend counts them. */
  readonly inFlight?: number;
}

/** Edge polylines packed into binary buffers (server.py _pack_edges): flattened point triples plus a per-edge
 *  point count. Exists only between reading a binary frame and expanding it. */
interface WireEdgesPacked {
  $pts: F32Wire;
  $counts: U32Wire;
  body?: string;
  /** indices of the edges whose faces meet tangentially */
  smooth?: number[];
}

/** Re-split packed edges (`counts` points per edge) into per-edge triples. Exported for its own test, since the
 *  engine side test only proves the encoder. */
export function expandPackedEdges(
  pts: Float32Array,
  counts: Uint32Array,
  body: string | undefined,
  smooth?: readonly number[],
): WireEdgeList {
  const list: WireEdgeList = [];
  let o = 0;
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i]!;
    const points: [number, number, number][] = new Array(n) as [number, number, number][];
    for (let k = 0; k < n; k++, o += 3) points[k] = [pts[o]!, pts[o + 1]!, pts[o + 2]!];
    list.push(body !== undefined ? { points, body } : { points });
  }
  for (const i of smooth ?? []) {
    const e = list[i];
    if (e) e.smooth = true;
  }
  return list;
}

/** A chunked reply's framing. Non-final frames carry `status: "chunk"` and no `ok`, so a peer that does not
 *  understand them treats them as informational. */
interface WireStreamEnvelope {
  sid: string;
  seq: number;
  final: boolean;
}

/** A decoded binary frame: the JSON envelope with every {"$buf": i} already
 *  swapped for a TypedArray view over the frame's own ArrayBuffer. */
interface BinaryHeader {
  id: string;
  ok?: boolean;
  status?: string;
  stream?: WireStreamEnvelope;
  result: WireRebuildResult & { $buffers?: { dtype: string; len: number }[] };
}

type RebuildBodyMeta = NonNullable<RebuildResult["bodies"]>[number];

/** One installment of a chunked rebuild reply, for renderers only. `result` is in progress: full-size arrays
 *  where undelivered bodies are still zeros, so never retain it or read it as document truth (store.build.result
 *  keeps the previous document until the build completes). Pass `triRange` to partitionMesh so the scan skips
 *  zeroed triangles, which would read as faceId 0. */
export interface RebuildChunk {
  phase: "begin" | "bodies";
  result: RebuildResult;
  /** metadata for EVERY body of the reply, in final order, known from frame 0 */
  manifest: RebuildBodyMeta[];
  /** just the bodies this installment filled */
  bodies: RebuildBodyMeta[];
  edgesByBody: Map<string, RebuildResult["edges"]>;
  triRange: { triStart: number; triEnd: number };
  /** Final for the whole reply from frame 0, so the camera settles once before any geometry arrives. */
  bbox: RebuildResult["bbox"];
  done: number;
  total: number;
}

// Longest gap between two frames of a chunked reply. Chunks go back to back, so a gap is an engine bug,
// and this makes it one failed rebuild instead of a wedged UI.
const STREAM_IDLE_MS = 30_000;

/** Decode one binary frame: [u32 LE header_len][JSON header][pad to 4][bufs...]. Mesh arrays become zero-copy
 *  views over `buf`. Buffer indices are frame-local, so each chunk decodes alone. Exported for its own test. */
export function decodeBinaryFrame(buf: ArrayBuffer): BinaryHeader {
  const dv = new DataView(buf);
  const headerLen = dv.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen))) as BinaryHeader;
  let offset = 4 + headerLen + ((4 - (headerLen % 4)) % 4);
  const views: (Float32Array | Uint32Array)[] = [];
  for (const meta of header.result.$buffers ?? []) {
    views.push(meta.dtype === "f32" ? new Float32Array(buf, offset, meta.len) : new Uint32Array(buf, offset, meta.len));
    offset += meta.len * 4;
  }
  const resolveBuf = (v: unknown) => views[(v as { $buf: number }).$buf]!;
  for (const b of header.result.bodies ?? []) {
    if (b.unchanged) continue;
    const fb = b as WireBodyFull;
    fb.positions = resolveBuf(fb.positions) as Float32Array;
    if (fb.normals !== undefined) fb.normals = resolveBuf(fb.normals) as Float32Array;
    fb.indices = resolveBuf(fb.indices) as Uint32Array;
    fb.faceIds = resolveBuf(fb.faceIds) as Uint32Array;
    // Edges arrive packed (server.py's _pack_edges), expand them back to the
    // plain list every consumer expects, here at the one point the raw frame is
    // interpreted. Rebuilding the triples is still cheaper than the JSON text it
    // replaces: on a large assembly that was 97.1 MiB to parse, and the frame it
    // saves is what keeps the reply under the cap.
    const rawEdges = (fb as { edges?: WireEdgeList | WireEdgesPacked }).edges;
    if (rawEdges !== undefined && !Array.isArray(rawEdges)) {
      fb.edges = expandPackedEdges(
        resolveBuf(rawEdges.$pts) as Float32Array,
        resolveBuf(rawEdges.$counts) as Uint32Array,
        rawEdges.body,
        rawEdges.smooth,
      );
    }
  }
  delete header.result.$buffers;
  return header;
}

// Delta wire protocol's request payload (see rebuild()'s comment below) vs a
// full-document send.
interface RebuildDeltaPayload {
  baseRevision: number;
  revision: number;
  ops: {
    length: number;
    set: [number, Feature][];
    parameters?: CadDocument["parameters"];
    bodyVisibility?: CadDocument["bodyVisibility"] | null;
    bodyIds?: CadDocument["bodyIds"] | null;
  };
}
interface RebuildFullPayload {
  document: CadDocument;
  revision: number;
}
type RebuildPayload = RebuildDeltaPayload | RebuildFullPayload;

/** Largest message the engine accepts, mirroring `MAX_FRAME` in crates/fundacad-protocol; keep them in step.
 *  Anything larger gets a 1009 close, not an error reply, so the client must catch it before sending. */
export const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;

/** The user-facing message for an over-cap payload, or null. Exported to test without a 128 MiB string. `len` is
 *  in UTF-16 units, slightly under-counting non-ASCII, since measuring UTF-8 would copy 100+ MiB per call. */
export function tooLargeToSend(len: number): string | null {
  if (len <= MAX_MESSAGE_BYTES) return null;
  const mib = (n: number) => `${Math.round(n / (1024 * 1024))} MiB`;
  return (
    `This model is too large for the geometry engine: ${mib(len)}, ` +
    `and the limit is ${mib(MAX_MESSAGE_BYTES)}. ` +
    `Remove or simplify the imported body, then try again.`
  );
}

/** One `importing` frame: the request it is for, its stage fraction 0 to 100 or
 *  null while the stage has none, and the stage name. */
export type OpProgressListener = (id: string, pct: number | null, stage: string) => void;

/** Another client's job one of ours is waiting behind, as the engine names it. */
export interface EngineWait {
  op: string;
  who: "app" | "assistant" | "session";
  name?: string;
}

function engineWait(v: unknown): EngineWait | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  const who = b.who === "app" || b.who === "assistant" ? b.who : "session";
  return {
    op: typeof b.op === "string" ? b.op : "",
    who,
    ...(typeof b.name === "string" && b.name ? { name: b.name } : {}),
  };
}

export class Geometry implements GeometryBackend {
  private readonly transport: GeometryTransport;
  private pending = new Map<string, Pending>();
  /** Requests sent and not yet answered, tool previews included. */
  get inFlight(): number {
    return this.pending.size;
  }
  // The heavy op most recently sent, for cancel(). Targeting by id keeps a late Cancel from killing the next op.
  private lastHeavyId: string | null = null;
  private outbox: string[] = [];
  private statusListeners = new Set<StatusListener>();
  private opProgressListeners = new Set<OpProgressListener>();
  private progressListeners = new Set<(feature: number, meshed: number, meshTotal: number, phase: number) => void>();
  private queueListeners = new Set<(id: string, behind: EngineWait | null) => void>();
  // Last full payload per body: the engine answers unchanged bodies with an etag stub instead of the multi-MB mesh,
  // and assemble() rebuilds the merged result from this cache.
  private bodyMesh = new Map<string, WireBodyFull>();
  /** Chunked replies in flight by id (server.py _stream_binary_reply). Invariant: each has a live `pending` entry
   *  and every teardown clears both, or a broken stream wedges rebuildNow()'s `rebuilding` flag forever. */
  private streams = new Map<
    string,
    {
      sid: string;
      nextSeq: number;
      manifest: WireManifestEntry[];
      assembly: RebuildAssembly;
      ids: string[];
      timer: number;
    }
  >();
  private chunkListeners = new Set<(c: RebuildChunk) => void>();
  /** The last assembled result and its reply signature, for assemble()'s no-op fast path. */
  private lastAssembled: RebuildResult | null = null;
  private lastAssembledSig: string | null = null;
  // Delta protocol: the engine worker holds the last document, so only features changed by reference are sent
  // (effectiveDoc() reuses unchanged objects). Any doubt (respawn, missed reply, many changes) sends it whole.
  private lastSent: { features: Feature[]; parameters: string; bodyVisibility: string; bodyIds: string } | null = null;
  private revision = 0;

  constructor(transport: GeometryTransport = new EngineTransport()) {
    this.transport = transport;
    // Does not connect: init() lets the transport pick IPC or the WebSocket before its first open.
  }

  async init(): Promise<void> {
    await this.transport.start({
      opened: () => this.onOpened(),
      message: (data) => this.onMessage(data),
      closed: (tooBig) => this.onClosed(tooBig),
    });
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    fn(this.connected);
    return () => this.statusListeners.delete(fn);
  }

  onOpProgress(fn: OpProgressListener): () => void {
    this.opProgressListeners.add(fn);
    return () => this.opProgressListeners.delete(fn);
  }

  /** Chunked rebuild installments, so the viewport draws bodies as they arrive. Only the viewport bridge in main.ts
   *  subscribes; anything reading document truth uses store.onBuild. */
  onRebuildChunk(fn: (c: RebuildChunk) => void): () => void {
    this.chunkListeners.add(fn);
    return () => this.chunkListeners.delete(fn);
  }

  onProgress(fn: (feature: number, meshed: number, meshTotal: number, phase: number) => void): () => void {
    this.progressListeners.add(fn);
    return () => this.progressListeners.delete(fn);
  }

  onQueue(fn: (id: string, behind: EngineWait | null) => void): () => void {
    this.queueListeners.add(fn);
    return () => this.queueListeners.delete(fn);
  }

  get connected(): boolean {
    return this.transport.open;
  }

  private emitStatus() {
    for (const fn of this.statusListeners) fn(this.connected);
  }

  private onOpened() {
    this.emitStatus();
    for (const raw of this.outbox) this.transport.send(raw);
    this.outbox = [];
  }

  private onMessage(data: string | ArrayBuffer) {
    if (typeof data !== "string") {
      this.handleBinaryReply(data);
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      console.error("[geometry] bad JSON from the engine:", err, "payload:", data.slice(0, 200));
      return;
    }
    if (msg && typeof msg.status === "string") {
      // Every interim status frame is informational and must never resolve the pending call, or the caller reports
      // failure while the engine keeps working. Frames for requests we are not waiting on are ignored.
      if (typeof msg.id !== "string" || !this.pending.has(msg.id)) return;
      if (msg.status === "queued") {
        const behind = engineWait(msg.behind);
        for (const fn of this.queueListeners) fn(msg.id, behind);
      } else if (msg.status === "started") {
        for (const fn of this.queueListeners) fn(msg.id, null);
      } else if (msg.status === "building") {
        const f = typeof msg.feature === "number" ? msg.feature : -1;
        const m = typeof msg.meshed === "number" ? msg.meshed : -1;
        const mt = typeof msg.meshTotal === "number" ? msg.meshTotal : -1;
        const phase = typeof msg.phase === "number" ? msg.phase : f >= 0 ? BUILD_PHASE.feature : BUILD_PHASE.preparing;
        for (const fn of this.progressListeners) fn(f, m, mt, phase);
      } else if (msg.status === "importing") {
        const pct = typeof msg.pct === "number" && msg.pct >= 0 ? Math.min(msg.pct, 100) : null;
        const label = typeof msg.label === "string" ? msg.label : "";
        for (const fn of this.opProgressListeners) fn(msg.id, pct, label);
      }
      return;
    }
    const resolve = this.pending.get(msg.id);
    if (resolve) {
      this.pending.delete(msg.id);
      // A terminal text reply for a streaming id is how the engine aborts mid-send (cancel, or a body over the cap).
      this.dropStream(msg.id);
      resolve(msg);
    }
  }

  private onClosed(tooBig: boolean) {
    this.emitStatus();
    // A refused size means call()'s pre-flight guard and the engine limit have drifted. Saying so avoids blaming
    // the connection, which misled GH #4's reporter.
    const message = tooBig
      ? "That model is too large for the geometry engine to accept. " +
        "Remove or simplify the imported body, then try again."
      : "geometry engine connection lost";
    // Settle every in-flight call with an engine-shaped error. Otherwise a call made before the drop hangs, rebuildNow()
    // never clears `rebuilding`, and the reconnect rebuild in main.ts's onStatus() silently no-ops forever.
    for (const [id, resolve] of this.pending) {
      resolve({ id, ok: false, error: { message } });
    }
    this.pending.clear();
    // Every pending call is settled, so clear all streams and their watchdogs to keep the invariant exact.
    for (const s of this.streams.values()) clearTimeout(s.timer);
    this.streams.clear();
  }

  /** Decode one binary frame (server.py _encode_binary_reply / _frame_bytes). Each big mesh array in the header is
   *  replaced by {"$buf": i}, and buffers become zero-copy views over this frame's ArrayBuffer. */
  private handleBinaryReply(buf: ArrayBuffer) {
    let header: BinaryHeader | null = null;
    try {
      header = decodeBinaryFrame(buf);
      if (header.stream) {
        this.routeStreamFrame(header);
        return;
      }
      const resolve = this.pending.get(header.id);
      if (resolve) {
        this.pending.delete(header.id);
        // a single-frame reply supersedes any stream for the same id
        this.dropStream(header.id);
        resolve(header as RawReply<unknown>);
      }
    } catch (err) {
      // An unreadable frame is as fatal as bad JSON. Settle the caller if the id is known, or rebuildNow()'s
      // `rebuilding` flag never clears (see the onclose comment).
      console.error("[geometry] bad binary frame from the engine:", err);
      const id = header?.id;
      if (id !== undefined) this.abortStream(id, "the geometry engine sent an unreadable reply");
    }
  }

  /** Accumulate one frame of a chunked reply and resolve the caller on the last (server.py _stream_binary_reply).
   *  Every exit that drops a stream also settles its pending call; that pairing is the whole leak surface. */
  private routeStreamFrame(header: BinaryHeader) {
    const st = header.stream!;
    const id = header.id;
    if (st.seq === 0) {
      // A head frame replaces any half-received stream for its id. Rebuilds are serialized so this cannot happen,
      // but a reset beats a silent body splice.
      const prev = this.streams.get(id);
      if (prev) clearTimeout(prev.timer);
      const result = header.result as WireRebuildResult & { manifest?: WireManifestEntry[] };
      const manifest = result.manifest ?? [];
      delete result.manifest;
      // Plan the whole reply from the manifest now, so each body draws as soon as its chunk lands, and an unbacked
      // stub forces a resync before any allocation or partial display.
      const begun = RebuildAssembly.begin(result, manifest, this.bodyMesh, this.lastAssembled, this.lastAssembledSig);
      if (begun.kind === "resync") {
        this.settleStream(id, { id, ok: true, result: { resync: true } } as RawReply<unknown>);
        return;
      }
      if (begun.kind === "noop") {
        this.settleStream(id, {
          id,
          ok: true,
          result: { protocol: 2, assembled: begun.result },
        } as RawReply<unknown>);
        return;
      }
      this.streams.set(id, {
        sid: st.sid,
        nextSeq: 1,
        manifest,
        assembly: begun.assembly,
        ids: [],
        timer: 0,
      });
      this.emitChunk({
        phase: "begin",
        result: begun.assembly.result,
        manifest: begun.assembly.result.bodies ?? [],
        bodies: [],
        edgesByBody: new Map(),
        triRange: { triStart: 0, triEnd: 0 },
        bbox: begun.assembly.result.bbox,
        done: 0,
        total: manifest.length,
      });
    } else {
      const s = this.streams.get(id);
      if (!s) return; // a late chunk of a stream we already abandoned
      if (st.sid !== s.sid) {
        this.abortStream(id, "the geometry engine restarted its reply mid-send");
        return;
      }
      if (st.seq !== s.nextSeq) {
        this.abortStream(id, "the geometry engine's reply arrived out of order");
        return;
      }
      s.nextSeq++;
      const arrived: string[] = [];
      for (const b of header.result.bodies ?? []) {
        if (b.unchanged) {
          arrived.push(b.id);
          continue;
        }
        this.bodyMesh.set(b.id, b);
        if (!s.assembly.writeBody(b)) {
          // Writing a payload that disagrees with the manifest would corrupt the next body's triangles believably.
          pipeFault(
            `body ${b.id} did not match its manifest entry, stream aborted ` +
              `(declared verts3=${b.positions?.length ?? "?"} idx=${b.indices?.length ?? "?"} ` +
              `tris=${b.faceIds?.length ?? "?"})`,
          );
          this.abortStream(id, "the geometry engine sent a body that did not match its manifest");
          return;
        }
        arrived.push(b.id);
      }
      s.ids.push(...arrived);
      if (arrived.length) {
        const edgesByBody = new Map<string, RebuildResult["edges"]>();
        const metas: RebuildBodyMeta[] = [];
        for (const bid of arrived) {
          const m = s.assembly.metaOf(bid);
          if (m) metas.push(m);
          edgesByBody.set(bid, s.assembly.edgesOf(bid));
        }
        this.emitChunk({
          phase: "bodies",
          result: s.assembly.result,
          manifest: s.assembly.result.bodies ?? [],
          bodies: metas,
          edgesByBody,
          triRange: s.assembly.triRange(arrived),
          bbox: s.assembly.result.bbox,
          done: s.ids.length,
          total: s.manifest.length,
        });
      }
    }
    const s = this.streams.get(id)!;
    clearTimeout(s.timer);
    if (!st.final) {
      // Chunks go back to back, so this fires only on an engine bug, which would otherwise never settle the call.
      s.timer = setTimeout(
        () => this.abortStream(id, "the geometry engine stopped part-way through its reply"),
        STREAM_IDLE_MS,
      );
      return;
    }
    this.streams.delete(id);
    // Every manifest body must have arrived: finishAssembly prunes bodyMesh to this reply's ids, so a short stream
    // would evict a body from the cache and corrupt the next rebuild's `known` map too.
    const out = this.finishAssembly(
      s.assembly,
      s.manifest.map((m) => m.id),
    );
    if (out === null) {
      this.abortStream(id, "the geometry engine's reply was incomplete");
      return;
    }
    this.settleStream(id, {
      id,
      ok: true,
      result: { protocol: 2, assembled: out },
    } as RawReply<unknown>);
  }

  private settleStream(id: string, reply: RawReply<unknown>) {
    this.dropStream(id);
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(reply);
  }

  private emitChunk(c: RebuildChunk) {
    for (const fn of this.chunkListeners) {
      try {
        fn(c);
      } catch (err) {
        console.error("[geometry] chunk listener threw:", err);
      }
    }
  }

  /** Drop a stream without settling its call, safe only when a terminal single-frame reply settles it. */
  private dropStream(id: string) {
    const s = this.streams.get(id);
    if (!s) return;
    clearTimeout(s.timer);
    this.streams.delete(id);
  }

  /** The one teardown for a stream that cannot finish: drop it and settle its call with an engine-shaped error. */
  private abortStream(id: string, message: string) {
    this.dropStream(id);
    const resolve = this.pending.get(id);
    if (resolve) {
      this.pending.delete(id);
      resolve({ id, ok: false, error: { message } } as RawReply<unknown>);
    }
  }

  /** See GeometryBackend.session. Answered on the engine's read path, so it never queues behind a rebuild
   *  and the host keeps publishing during its own build. */
  async session(op: string, payload: object = {}): Promise<Record<string, unknown> | null> {
    const msg = await this.call<Record<string, unknown>>(op, payload);
    return msg.ok ? msg.result : null;
  }

  private call<T>(op: string, extra: object, onId?: (id: string) => void): Promise<RawReply<T>> {
    const id = crypto.randomUUID();
    const raw = JSON.stringify({ id, op, ...extra });
    return new Promise((resolve) => {
      // Refuse an over-cap message: the engine answers it with a 1009 close, and since the body stays in the document
      // every rebuild re-sent it and killed the session again (GH #4, "cannot open files larger than 245 MB").
      const tooLarge = tooLargeToSend(raw.length);
      if (tooLarge) {
        resolve({ id, ok: false, error: { message: tooLarge } } as RawReply<T>);
        return;
      }
      // Set only once the call goes out, or Cancel would target a request the engine never saw. Ops nobody would stop
      // are excluded, above all the timed session polls, or Cancel would stop a poll while the build ran on.
      if (op !== "cancel" && op !== "ping" && !op.startsWith("session_")) this.lastHeavyId = id;
      onId?.(id);
      // The one type-erasing cast: the pending map holds resolvers for every T.
      this.pending.set(id, resolve as Pending);
      if (this.connected) {
        this.transport.send(raw);
      } else {
        this.outbox.push(raw);
      }
    });
  }

  /** Every rebuild and computeAll goes through here so the wire opt-in flags are set once; the resync paths, the
   *  largest replies, are the ones that must never fall back to a single frame. */
  private rebuildCall(op: "rebuild" | "computeAll", extra: object, onId?: (id: string) => void) {
    return this.call<WireRebuildResult>(op, { ...extra, binary: true, chunked: true }, onId);
  }

  get softCancel(): boolean {
    return this.transport.softCancel === true;
  }

  async rebuild(doc: CadDocument, tolerance = 0.1, onId?: (id: string) => void): Promise<RebuildReply> {
    const known: Record<string, string> = {};
    for (const [id, p] of this.bodyMesh) known[id] = p.etag;

    const pJson = JSON.stringify(doc.parameters ?? null);
    const vJson = JSON.stringify(doc.bodyVisibility ?? null);
    const iJson = JSON.stringify(doc.bodyIds ?? null);
    let payload: RebuildPayload | null = null;
    if (this.lastSent) {
      const set: [number, Feature][] = [];
      for (let i = 0; i < doc.features.length; i++) {
        const f = doc.features[i];
        if (f !== undefined && this.lastSent.features[i] !== f) set.push([i, f]);
      }
      // Delta only when small; a reordered or rewritten timeline ships fewer bytes as a full document.
      if (set.length <= Math.max(8, doc.features.length / 2)) {
        const ops: RebuildDeltaPayload["ops"] = { length: doc.features.length, set };
        if (pJson !== this.lastSent.parameters) ops.parameters = doc.parameters;
        // null, not undefined: an absent key would leave the engine's copy as it was
        if (vJson !== this.lastSent.bodyVisibility) ops.bodyVisibility = doc.bodyVisibility ?? null;
        if (iJson !== this.lastSent.bodyIds) ops.bodyIds = doc.bodyIds ?? null;
        payload = { baseRevision: this.revision, revision: this.revision + 1, ops };
      }
    }
    if (!payload) payload = { document: doc, revision: this.revision + 1 };

    let msg = await this.rebuildCall("rebuild", { ...payload, tolerance, known }, onId);
    if (msg.ok && msg.result?.resync) {
      // worker respawned or lost sync, one full resend recovers everything
      pipe(
        `RESYNC asked by the engine, resending the whole document ` +
          `(${doc.features.length} features, ${Object.keys(known).length} known etags)`,
      );
      this.lastSent = null;
      this.bodyMesh.clear();
      payload = { document: doc, revision: this.revision + 1 };
      msg = await this.rebuildCall("rebuild", { ...payload, tolerance }, onId);
    }
    if (msg.ok && !msg.result?.resync) {
      this.revision = payload.revision;
      this.lastSent = { features: doc.features.slice(), parameters: pJson, bodyVisibility: vJson, bodyIds: iJson };
    }
    if (msg.ok && msg.result?.protocol === 2) {
      let assembled = this.assemble(msg.result);
      if (assembled === null) {
        // We claimed an etag the cache no longer backs (say a worker respawn race), so resync in full.
        pipe("RESYNC: a stub named an etag this client no longer holds, " + "re-requesting every body in full");
        this.bodyMesh.clear();
        // the assemble cache is keyed on payloads that just went away
        this.lastAssembled = null;
        this.lastAssembledSig = null;
        msg = await this.rebuildCall("rebuild", { document: doc, revision: ++this.revision, tolerance }, onId);
        if (msg.ok && msg.result?.protocol === 2) assembled = this.assemble(msg.result);
      }
      if (msg.ok && assembled !== null) return { ok: true, result: assembled };
    }
    if (msg.ok) {
      const legacy = this.legacyResult(msg.result);
      if (legacy) return { ok: true, result: legacy };
      return { ok: false, error: { message: "geometry engine returned no mesh" } };
    }
    return msg.cancelled ? { ok: false, error: msg.error, cancelled: true } : { ok: false, error: msg.error };
  }

  /** MCAD-style "Compute All": bypass and rebuild every cache layer (RAM,
   *  mesh, disk checkpoints) server-side, and drop our own mesh cache. */
  async computeAll(doc: CadDocument, tolerance = 0.1): Promise<RebuildReply> {
    this.bodyMesh.clear();
    this.lastSent = null;
    const msg = await this.rebuildCall("computeAll", { document: doc, revision: ++this.revision, tolerance });
    if (msg.ok && msg.result?.protocol === 2) {
      const assembled = this.assemble(msg.result);
      if (assembled !== null) return { ok: true, result: assembled };
    }
    if (msg.ok) {
      const legacy = this.legacyResult(msg.result);
      if (legacy) return { ok: true, result: legacy };
      return { ok: false, error: { message: "geometry engine returned no mesh" } };
    }
    return { ok: false, error: msg.error };
  }

  /** Merge protocol v2 per-body payloads into a RebuildResult, null if a stub names a body we do not hold. A thin
   *  wrapper over RebuildAssembly, so the single-frame and chunked paths run the same tested code. */
  private assemble(r: WireRebuildResult): RebuildResult | null {
    // A chunked reply was assembled as its frames arrived (routeStreamFrame), cache prune and no-op baseline included.
    if (r.assembled) return r.assembled;
    const bodies: WireBody[] = r.bodies ?? [];
    const begun = RebuildAssembly.begin(
      r,
      manifestFromBodies(bodies),
      this.bodyMesh,
      this.lastAssembled,
      this.lastAssembledSig,
    );
    if (begun.kind === "resync") return null;
    if (begun.kind === "noop") return begun.result;
    for (const nb of bodies) {
      if (nb.unchanged) continue;
      this.bodyMesh.set(nb.id, nb);
      if (!begun.assembly.writeBody(nb)) {
        pipeFault(
          `body ${nb.id} did not match its manifest entry in a single-frame ` +
            "reply, re-requesting the whole document",
        );
        return null;
      }
    }
    return this.finishAssembly(
      begun.assembly,
      bodies.map((b) => b.id),
    );
  }

  /** Common tail of both assembly paths: prune the body cache to this reply's ids and make the result the no-op
   *  baseline. Null on an incomplete assembly (see RebuildAssembly.complete). */
  private finishAssembly(assembly: RebuildAssembly, live: string[]): RebuildResult | null {
    const out = assembly.complete();
    if (out === null) return null;
    const keep = new Set(live);
    for (const id of this.bodyMesh.keys()) if (!keep.has(id)) this.bodyMesh.delete(id);
    this.lastAssembledSig = assembly.sig;
    this.lastAssembled = out;
    return out;
  }

  /** The legacy single-mesh result from a protocol v1 reply, or null without a direct mesh, so the caller takes
   *  its error path instead of fabricating an empty result. */
  private legacyResult(r: WireRebuildResult): RebuildResult | null {
    if (!r.mesh || !r.edges) return null;
    const out: RebuildResult = {
      mesh: r.mesh,
      edges: r.edges,
      // The wire sends bbox null before anything has built; RebuildResult types it as always present.
      bbox: r.bbox as RebuildResult["bbox"],
    };
    if (r.diagnostics) out.diagnostics = r.diagnostics;
    if (r.featureError) out.featureError = r.featureError;
    if (r.featureErrors) out.featureErrors = r.featureErrors;
    if (r.projectionUpdates) out.projectionUpdates = r.projectionUpdates;
    if (r.datumPlanes) out.datumPlanes = r.datumPlanes;
    if (r.sketchPlanes) out.sketchPlanes = r.sketchPlanes;
    if (r.datumMarks) out.datumMarks = r.datumMarks;
    if (r.trackedFaces) out.trackedFaces = r.trackedFaces;
    if (r.bodyIds) out.bodyIds = r.bodyIds;
    if (r.skippedFeatures) out.skippedFeatures = r.skippedFeatures;
    return out;
  }

  async export(
    doc: CadDocument,
    format: ExportFormat,
    path: string,
    opts: {
      body?: string;
      bodies?: string[];
      separate?: boolean;
      palette?: { name: string; color: string; material?: string }[];
      bodyColors?: Record<string, number>;
      mesh?: MeshExportOptions;
      /** DXF and SVG draw one sketch, or one flat face in `plane`. */
      sketch?: string;
      face?: unknown;
      plane?: PlaneDef;
      tolerance?: number;
    } = {},
    onStarted?: (id: string) => void,
  ): Promise<{
    ok: boolean;
    path?: string;
    paths?: string[];
    message?: string;
    cancelled?: boolean;
    warnings?: { message: string; feature_id?: string }[];
  }> {
    const msg = await this.call<{
      path?: string;
      paths?: string[];
      warnings?: { message: string; feature_id?: string }[];
    }>(
      "export",
      {
        document: doc,
        format,
        path,
        body: opts.body,
        bodies: opts.bodies,
        separate: opts.separate,
        // GLB writes one material per body from these; other formats ignore them.
        palette: opts.palette,
        bodyColors: opts.bodyColors,
        mesh: opts.mesh,
        sketch: opts.sketch,
        face: opts.face,
        plane: opts.plane,
        tolerance: opts.tolerance,
      },
      onStarted,
    );
    if (msg.ok) {
      const r = msg.result;
      return {
        ok: true,
        ...(r.path !== undefined ? { path: r.path } : {}),
        ...(r.paths !== undefined ? { paths: r.paths } : {}),
        ...(r.warnings !== undefined ? { warnings: r.warnings } : {}),
      };
    }
    if (msg.cancelled) return { ok: false, cancelled: true, message: "export cancelled" };
    return { ok: false, message: msg.error?.message };
  }

  async exportWith(
    doc: CadDocument,
    path: string,
    exporter: string,
    options: Record<string, unknown>,
    onStarted?: (id: string) => void,
  ): Promise<{
    ok: boolean;
    path?: string;
    info?: Record<string, unknown>;
    message?: string;
    cancelled?: boolean;
    warnings?: { message: string; feature_id?: string }[];
  }> {
    const msg = await this.call<{
      path?: string;
      info?: Record<string, unknown>;
      warnings?: { message: string; feature_id?: string }[];
    }>("exportWith", { document: doc, path, exporter, options }, onStarted);
    if (msg.ok) {
      const r = msg.result;
      return {
        ok: true,
        ...(r.path !== undefined ? { path: r.path } : {}),
        ...(r.info !== undefined ? { info: r.info } : {}),
        ...(r.warnings !== undefined ? { warnings: r.warnings } : {}),
      };
    }
    if (msg.cancelled) return { ok: false, cancelled: true, message: "export cancelled" };
    return { ok: false, message: msg.error?.message };
  }

  importGeometry(
    path: string,
    format: ImportFormat,
    onStarted?: (id: string) => void,
    unit?: string,
  ): Promise<ImportReply> {
    return this.importRequest({ path, format, ...(unit ? { unit } : {}) }, onStarted);
  }

  importBytes(
    name: string,
    format: ImportFormat,
    data: string,
    onStarted?: (id: string) => void,
    unit?: string,
  ): Promise<ImportReply> {
    return this.importRequest({ name, format, data, ...(unit ? { unit } : {}) }, onStarted);
  }

  private async importRequest(req: object, onStarted?: (id: string) => void): Promise<ImportReply> {
    const msg = await this.call<{
      geom?: string;
      name: string;
      solid?: boolean;
      faces?: number;
      color?: string;
      nodes?: { name: string; parent: number | null; color?: string }[];
      parts?: { node: number; faces: number }[];
      notes?: string[];
      unit?: string;
      sketches?: { name: string; entities: SketchEntity[]; fillRule?: "evenodd" }[];
    }>("import", req, onStarted);
    if (msg.ok) {
      const r = msg.result;
      return {
        ok: true,
        name: r.name,
        ...(r.geom !== undefined ? { geom: r.geom } : {}),
        ...(r.solid !== undefined ? { solid: r.solid } : {}),
        ...(r.faces !== undefined ? { faces: r.faces } : {}),
        ...(r.color !== undefined ? { color: r.color } : {}),
        ...(r.nodes !== undefined ? { nodes: r.nodes } : {}),
        ...(r.parts !== undefined ? { parts: r.parts } : {}),
        ...(r.notes !== undefined ? { notes: r.notes } : {}),
        ...(r.unit !== undefined ? { unit: r.unit } : {}),
        ...(r.sketches !== undefined ? { sketches: r.sketches } : {}),
      };
    }
    if (!msg.ok && msg.cancelled) return { ok: false, cancelled: true, message: "import cancelled" };
    return { ok: false, message: msg.error?.message ?? "import failed" };
  }

  /** Stop the geometry op in flight. Answered on the engine's read path so it is heard during a long job; the
   *  cancelled op settles separately with `cancelled: true`. A pool job's worker is killed and respawned. */
  async cancel(target?: string, opts?: { soft?: boolean }): Promise<boolean> {
    // Prefer an explicit target: a rebuild during a long import overwrites lastHeavyId, and the engine would then
    // refuse to cancel the import. lastHeavyId is a fallback for callers that never learned an id.
    const id = target ?? this.lastHeavyId;
    if (!id) return false;
    const soft = opts?.soft && this.softCancel ? { soft: true } : {};
    const msg = await this.call<{ cancelled: boolean }>("cancel", { target: id, ...soft });
    return msg.ok ? msg.result.cancelled : false;
  }

  async generateShape(
    generator: string,
    params: object,
    opts: { output?: "mesh" | "store"; placement?: ShapePlacement } = {},
  ): Promise<GeneratedShapeReply> {
    const msg = await this.call<GeneratedShape>("generateShape", {
      generator,
      params,
      output: opts.output ?? "mesh",
      ...(opts.placement ? { placement: opts.placement } : {}),
    });
    if (msg.ok) return { ok: true, shape: msg.result };
    return { ok: false, message: msg.error?.message ?? "the shape could not be generated" };
  }

  async interference(doc: CadDocument, clearance?: number): Promise<InterferenceReply> {
    const msg = await this.call<Omit<InterferenceReply, "ok">>("interference", {
      document: doc,
      ...(clearance ? { clearance } : {}),
    });
    if (msg.ok) {
      const r = msg.result;
      return {
        ok: true,
        ...(r.pairs !== undefined ? { pairs: r.pairs } : {}),
        ...(r.clearances !== undefined ? { clearances: r.clearances } : {}),
        ...(r.truncated ? { truncated: true, message: r.message } : {}),
        ...(r.unchecked?.length ? { unchecked: r.unchecked } : {}),
      };
    }
    return { ok: false, message: msg.error?.message };
  }

  async stress(
    doc: CadDocument,
    body: string,
    opts: StressOptions,
    onStarted?: (id: string) => void,
  ): Promise<StressResult> {
    const msg = await this.call<StressReply>("stress", { document: doc, body, ...opts }, onStarted);
    if (msg.ok) return { ok: true, result: msg.result };
    if (msg.cancelled) return { ok: false, cancelled: true, message: "stress analysis cancelled" };
    return { ok: false, message: msg.error?.message ?? "stress analysis failed" };
  }

  async printability(
    doc: CadDocument,
    opts: PrintabilityOptions,
    onStarted?: (id: string) => void,
  ): Promise<PrintabilityResult> {
    const msg = await this.call<PrintabilityReply>("printability", { document: doc, ...opts }, onStarted);
    if (msg.ok) return { ok: true, result: msg.result };
    if (msg.cancelled) return { ok: false, cancelled: true, message: "printability check cancelled" };
    return { ok: false, message: msg.error?.message ?? "printability check failed" };
  }

  async blobPut(bytes: Uint8Array): Promise<string> {
    const hash = blake2b128Hex(bytes);
    const total = bytes.length;
    let offset = 0;
    do {
      const piece = bytes.subarray(offset, offset + BLOB_PUT_CHUNK);
      const msg = await this.call<{ stored: boolean; received?: number }>("blobWrite", {
        hash,
        offset,
        total,
        data: bytesToBase64(piece),
      });
      if (!msg.ok) throw new Error(msg.error?.message ?? "the engine refused the bytes");
      if (msg.result.stored) return hash;
      offset += piece.length;
    } while (offset < total);
    throw new Error("the engine did not store the bytes");
  }

  async blobGet(hash: string): Promise<Uint8Array | null> {
    const parts: Uint8Array[] = [];
    let offset = 0;
    let size = 0;
    do {
      const msg = await this.call<{ missing?: boolean; size: number; data: string }>("blobRead", { hash, offset });
      if (!msg.ok || msg.result.missing) return null;
      const piece = base64ToBytes(msg.result.data);
      if (!piece.length && offset < msg.result.size) return null;
      parts.push(piece);
      size = msg.result.size;
      offset += piece.length;
    } while (offset < size);
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  async faceAxis(doc: CadDocument, face: Selector, body: string | null): Promise<FaceAxisReply | null> {
    const msg = await this.call<FaceAxisReply>("faceAxis", { document: doc, face, ...(body ? { body } : {}) });
    return msg.ok ? msg.result : null;
  }

  async faceAnchor(
    doc: CadDocument,
    face: Selector,
    body: string | null,
    point: Vec3,
  ): Promise<FaceAnchorReply | null> {
    const msg = await this.call<FaceAnchorReply>("faceAnchor", {
      document: doc,
      face,
      point,
      ...(body ? { body } : {}),
    });
    return msg.ok ? msg.result : null;
  }

  async profileCuts(doc: CadDocument, origin: Vec3, normal: Vec3, reach?: Vec3[]): Promise<Vec3[][] | null> {
    const msg = await this.call<{ cuts: Vec3[][] | null }>("profileCuts", {
      document: doc,
      origin,
      normal,
      ...(reach ? { reach } : {}),
    });
    return msg.ok ? (msg.result.cuts ?? null) : null;
  }

  async patternAxis(doc: CadDocument, ref: Selector): Promise<PatternAxisReply | null> {
    const msg = await this.call<PatternAxisReply>("patternAxis", { document: doc, ref });
    return msg.ok ? msg.result : null;
  }

  async tessellateText(entity: object, pathEntity?: object): Promise<TextFace[]> {
    const msg = await this.call<{ faces: TextFace[] }>("tessellateText", {
      entity,
      ...(pathEntity ? { pathEntity } : {}),
    });
    return msg.ok ? (msg.result.faces ?? []) : [];
  }

  async projectGeometry(doc: CadDocument, plane: PlaneSpec, sources: ProjectedSource[]): Promise<ProjectionResult[]> {
    const msg = await this.call<{ results: ProjectionResult[] }>("projectGeometry", {
      document: doc,
      plane,
      sources,
    });
    return msg.ok ? (msg.result.results ?? []) : [];
  }

  async listFonts(): Promise<string[]> {
    const msg = await this.call<{ families: string[] }>("listFonts", {});
    return msg.ok ? (msg.result.families ?? []) : [];
  }

  async migrateGeometry(items: { id: string; brep: string }[]): Promise<{ id: string; geom: string }[]> {
    if (!items.length) return [];
    const msg = await this.call<{
      items: { id: string; geom: string }[];
      failed?: { id: string; message: string }[];
    }>("migrateGeometry", { items });
    if (!msg.ok) return []; // keep the inline copy; nothing is lost
    for (const f of msg.result.failed ?? []) {
      console.warn(`could not migrate geometry for ${f.id}: ${f.message}`);
    }
    return msg.result.items ?? [];
  }
}
