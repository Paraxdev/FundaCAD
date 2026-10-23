// Document state: the CadDocument, undo and redo, load and save, and the rebuild
// pipeline that re-runs the tree after every mutation.

import {
  commit as commitVersion,
  createBranch as createVersionBranch,
  diffAgainstWorking,
  emptyRepo,
  headOf,
  normalizeRepo,
  restOf,
  snapshotOf,
  switchBranch as switchVersionBranch,
  type Snapshot,
  type Version,
  type VersionDiff,
  type VersionRepo,
} from "./versions";
import type {
  CadDocument,
  Feature,
  ImportColorSource,
  ParamControl,
  ParamExtras,
  ParamTarget,
  PlaneSpec,
  ProjectedSource,
  ProjectionUpdate,
  RebuildReply,
  RebuildResult,
  ResolveDiag,
  SectionView,
  Selector,
  StressStudy,
  Vec3,
  ViewCubeSide,
  ViewOverride,
} from "../types";
import { asFeature } from "../types";
import { applyProjectionUpdate } from "../types";
import type {
  EngineWait,
  FaceAnchorReply,
  FaceAxisReply,
  GeometryBackend,
  PatternAxisReply,
  ProjectionResult,
} from "../geometry/client";
import { FORMAT_VERSION, migrateDocument } from "./migrate";
import {
  ancestryOf,
  descendantsOf,
  type ElementDef,
  freshElementName,
  reparented,
  withElementRemoved,
} from "./elements";
import {
  type BodyFinish,
  finishOf,
  freshMaterialName,
  isDefaultFinish,
  type MaterialDef,
  asHex,
  normalizeMaterial,
  slugId,
  STARTER_LIBRARY,
  uniqueId,
} from "./materials";
import { faceKey } from "./faceMaterials";
import {
  bodyPrints,
  type FaceRef,
  type FaceResolution,
  type FaceTrack,
  loadFaceRefs,
  resolveFaceRefs,
  savedFaceRefs,
} from "./faceRefs";
import { documentShapeProblem, UnreadableDocumentError } from "./documentShape";
import { forgetStaleJoins, joinSignatures } from "./bodyIds";
import { canonicalMirrorPlanes } from "./mirrorPlane";
import { normalizeStressStudy } from "./stressStudy";
import { contentHash } from "./contentHash";
import { normalizeDocEnvironment, sameDocEnvironment, type DocEnvironment } from "./docEnvironment";
import { readSectionView, sameSectionView, sectionViewExtras } from "./sectionView";
import { readsBodyVisibility } from "./readsVisibility";
import * as params from "../params/engine";
import { extrasEmpty, trialConfiguration } from "../params/extras";
import type { FieldKind } from "./numFields";
import { writeTarget } from "./numFields";
import { markReceived, markSent } from "../diagnostics/rebuildTiming";
import { logEditTiming } from "../diagnostics/editTiming";
import { featureMeta } from "../ui/featureMeta";
import { afterPaint, APPLY_LABEL_AFTER_MS, BUILD_PHASE } from "../geometry/buildPhase";

/** A section of a `.fundab` this version does not read (docs/FUNDA-FORMAT.md). */
export interface CarriedSection {
  kind: number;
  name: string;
  hash: string;
}

// A dimension expression typed while the sketch is open travels with the commit, since the dim is not in the document.
export interface SketchBinding {
  target: ParamTarget;
  expr: string;
  kind: FieldKind;
  // Fusion style `name=expr`: bind under this name instead of dN.
  name?: string;
}

export interface RebuildState {
  building: boolean;
  result: RebuildResult | null;
  errorFeatureId: string | null;
  errorMessage: string | null;
  // Feature index the engine is executing (-1 outside the feature phase), streamed about 1/s during long rebuilds.
  progress: number | null;
  // A `BUILD_PHASE`, null until the first report.
  phase: number | null;
  // Bodies meshed and to mesh during the meshing phase, hits excluded.
  meshed: number | null;
  meshTotal: number | null;
  // `result` stays the previous model during a chunked reply, so only the viewport sees a partial body list.
  streamed: number | null;
  streamTotal: number | null;
  // A reply can land after the tool has moved on, so this is what it answered.
  previewBuilt?: Feature[] | null;
  // A held preview was refused: `result` is still the last model that built.
  heldRefusal?: PreviewRefusal | null;
  // Cancel was pressed: `result` is the model before this build.
  cancelled?: boolean;
}

export interface PreviewRefusal {
  featureId: string;
  message: string;
  code: string | null;
  diagnostics: ResolveDiag[];
}

// For the viewport only, everything else uses onBuild.
export interface BuildChunk {
  epoch: number;
  phase: "begin" | "bodies";
  // Only the bodies delivered so far hold real data.
  result: RebuildResult;
  manifest: NonNullable<RebuildResult["bodies"]>;
  bodies: NonNullable<RebuildResult["bodies"]>;
  edgesByBody: Map<string, RebuildResult["edges"]>;
  triRange: { triStart: number; triEnd: number };
  bbox: RebuildResult["bbox"];
  done: number;
  total: number;
}

// Kept apart from RebuildState so nothing keyed on `building` misreads it. `id` is the engine request a cancel targets.
export interface BusyState {
  active: boolean;
  label: string;
  id: string | null;
  pct: number | null;
  // "Transferring shapes"; null before the op says.
  stage: string | null;
  // This document's own rebuild rather than an import or export.
  rebuild: boolean;
  // Another client's job on the same engine this op is queued behind.
  waiting: EngineWait | null;
}

type DocListener = (doc: CadDocument) => void;
type BuildListener = (state: RebuildState) => void;
const IDLE_BUSY: BusyState = {
  active: false,
  label: "",
  id: null,
  pct: null,
  stage: null,
  rebuild: false,
  waiting: null,
};

type BusyListener = (state: BusyState) => void;
type MetaListener = () => void;

// Per top level key: the JSON to put back and the fingerprint the step left. A key changed since keeps its value,
// so a kept id map may name a missing id.
type StateSwap = Map<string, { put: string | undefined; expect: string }>;
const fingerprint = (json: string | undefined) => contentHash(json ?? "");
const TIMELINE_KEYS: ReadonlySet<string> = new Set(["suppressed", "rollback"]);

// Snapshots and display-only overlay changes share one chronological stack, so Ctrl+Z undoes whichever came last.
type UndoEntry =
  | { kind: "doc"; doc: CadDocument; state?: StateSwap }
  | { kind: "overlay"; undo: () => void; redo: () => void }
  | { kind: "group"; entries: UndoEntry[] };

// Safe for `"hiddenBodies" in f` checks: no mutator writes an explicit undefined.
const clone = (d: CadDocument): CadDocument => structuredClone(d);

// Anything else in a file is from a newer version and is carried. `geometry` is the JSON file's embedded blob map,
// which the Rust reader takes out and the writer puts back.
export const KNOWN_DOC_KEYS: ReadonlySet<string> = new Set([
  "version",
  "parameters",
  "paramDefs",
  "paramExtras",
  "features",
  "viewOverrides",
  "bodyIds",
  "suppressed",
  "rollback",
  "sketchVisibility",
  "bodyVisibility",
  "planeVisibility",
  "bodyNames",
  "bodyColors",
  "bodyElement",
  "bodyMaterial",
  "faceMaterials",
  "facePrints",
  "importColorSource",
  "elements",
  "materials",
  "palette",
  "stress",
  "environment",
  "versions",
  "geometry",
  "referenceImages",
  "sectionView",
]);
const ELEMENT_KEYS: ReadonlySet<string> = new Set(["id", "name", "parent"]);
const GEOMETRY_KEYS = ["parameters", "paramDefs", "paramExtras", "features", "viewOverrides", "bodyIds"] as const;

function stateSwap(before: Map<string, string>, after: Map<string, string>): StateSwap {
  const swap: StateSwap = new Map();
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const put = before.get(k);
    const left = after.get(k);
    if (put !== left) swap.set(k, { put, expect: fingerprint(left) });
  }
  return swap;
}

function sharesAFeature(a: readonly Feature[], b: readonly Feature[]): boolean {
  const ids = new Set(a.map((f) => f.id));
  return b.some((f) => ids.has(f.id));
}

// Deep copied, as normalizeMaterial keeps a material's unknown fields.
export function carriedKeys(raw: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (known.has(k) || k === "__proto__" || v === undefined) continue;
    out[k] = structuredClone(v);
  }
  return out;
}

// The first of a repeated id wins.
function readReferenceImages(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const id = (e as { id?: unknown }).id;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    out.push(structuredClone(e as Record<string, unknown>));
  }
  return out;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isBool = (v: unknown) => typeof v === "boolean";
const isText = (v: unknown) => typeof v === "string" && v.trim() !== "";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

const isVec3 = (v: unknown) =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

const VIEW_SIDES: ReadonlySet<string> = new Set(["front", "back", "left", "right", "top", "bottom"]);

function readViewOverrides(raw: unknown): Pick<CadDocument, "viewOverrides"> {
  if (!isPlainObject(raw)) return {};
  const kept = Object.entries(raw).filter(
    ([side, o]) => VIEW_SIDES.has(side) && isPlainObject(o) && isVec3(o["normal"]) && isVec3(o["up"]),
  );
  return kept.length ? { viewOverrides: Object.fromEntries(kept) } : {};
}

const isIdMap = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

export const EMPTY_DOCUMENT: CadDocument = { parameters: {}, features: [], bodyIds: {} };

// Body ids are left out: a build hands them back.
function buildKey(doc: CadDocument): string {
  const { bodyIds: _ids, ...rest } = doc;
  return JSON.stringify(rest);
}

// Features up to the rollback marker, unsuppressed, strictly before the sketch being edited.
export function prefixFeatures(
  features: Feature[],
  rollbackIndex: number,
  suppressed: ReadonlySet<string>,
  beforeId: string | null = null,
): Feature[] {
  let out = features.slice(0, rollbackIndex);
  if (beforeId !== null) {
    const i = out.findIndex((f) => f.id === beforeId);
    if (i >= 0) out = out.slice(0, i);
  }
  return out.filter((f) => !suppressed.has(f.id));
}

// Default filament palette. Editable; bodies/faces reference a slot index.
const DEFAULT_PALETTE: { name: string; color: string }[] = [
  { name: "White", color: "#e8e8e8" },
  { name: "Black", color: "#202020" },
  { name: "Red", color: "#d23b30" },
  { name: "Blue", color: "#3050c8" },
];

// A slot keeps its place when unreadable, since bodies point at slots by index.
function readPalette(raw: unknown): { name: string; color: string; material?: string }[] {
  if (!Array.isArray(raw) || !raw.length) return DEFAULT_PALETTE.map((s) => ({ ...s }));
  return raw.map((slot, i) => {
    const s = isPlainObject(slot) ? slot : {};
    const base = DEFAULT_PALETTE[i] ?? { name: `Colour ${i + 1}`, color: "#9a9a9a" };
    const { material: _m, ...rest } = s;
    return {
      ...rest,
      name: isText(s["name"]) ? (s["name"] as string) : base.name,
      color: asHex(s["color"]) ?? base.color,
      ...(typeof s["material"] === "string" ? { material: s["material"] } : {}),
    };
  });
}

/** A persisted display-only id to value map, stored under one CadDocument field. */
class Overlay<T> {
  private map = new Map<string, T>();
  rev = 0;
  constructor(
    readonly jsonKey: string,
    private readonly accepts: (v: unknown) => boolean = () => true,
  ) {}
  get(id: string): T | undefined {
    return this.map.get(id);
  }
  set(id: string, value: T) {
    this.map.set(id, value);
    this.rev++;
  }
  delete(id: string) {
    this.map.delete(id);
    this.rev++;
  }
  clear() {
    this.map.clear();
    this.rev++;
  }
  get size(): number {
    return this.map.size;
  }
  entries(): IterableIterator<[string, T]> {
    return this.map.entries();
  }
  writeJSON(out: Record<string, unknown>) {
    if (this.map.size) out[this.jsonKey] = Object.fromEntries(this.map);
  }
  loadFrom(parsed: Record<string, unknown>) {
    const src = parsed[this.jsonKey];
    const entries = isPlainObject(src) ? Object.entries(src).filter(([, v]) => this.accepts(v)) : [];
    this.map = new Map(entries as [string, T][]);
    this.rev++;
  }
}

let faceRefSeq = 0;
const newFaceRefId = () => `fr${++faceRefSeq}`;

// Face materials by opaque id, so an undo step never holds a face number a rebuild has moved (document/faceRefs.ts).
// Saved as `faceMaterials` and `facePrints` at the faces they are on in the build on screen.
class FaceRefOverlay extends Overlay<FaceRef> {
  private track: FaceTrack | null = null;
  private prior: FaceTrack | null = null;
  private memo: { result: RebuildResult; rev: number; on: FaceResolution; owners: Map<string, string> } | null = null;
  constructor(private readonly built: () => RebuildResult | null) {
    super("faceMaterials");
  }
  resolution(): FaceResolution | null {
    return this.resolved()?.on ?? null;
  }
  /** The track the build before the one on screen left: where each ref was on it. */
  before(): FaceTrack | null {
    return this.resolved() ? this.prior : this.track;
  }
  /** `bodyId#face` to the ref on it, the stored face without a build. */
  owners(): Map<string, string> {
    const r = this.resolved();
    if (r) return r.owners;
    const out = new Map<string, string>();
    for (const [id, ref] of this.entries()) out.set(faceKey(ref.body, ref.face), id);
    return out;
  }
  private resolved() {
    const result = this.built();
    if (!result?.bodies) return null;
    if (this.memo?.result === result && this.memo.rev === this.rev) return this.memo;
    if (this.memo?.result !== result) {
      // A ref written since the last look at the build before this one joins its track first.
      if (this.memo && this.memo.rev !== this.rev)
        this.track = resolveFaceRefs(this.entries(), this.memo.result, this.track).track;
      this.prior = this.track;
    }
    const on = resolveFaceRefs(this.entries(), result, this.track);
    this.track = on.track;
    const owners = new Map<string, string>();
    for (const [id, ref] of this.entries())
      for (const f of on.faces.get(id) ?? []) owners.set(faceKey(ref.body, f), id);
    this.memo = { result, rev: this.rev, on, owners };
    return this.memo;
  }
  /** Refs found on a face earlier in this session that the build on screen has no face for. */
  hidden(): string[] {
    const on = this.resolution();
    if (!on) return [];
    return [...on.faces].filter(([id, faces]) => !faces.length && on.track.seen.has(id)).map(([id]) => id);
  }
  override writeJSON(out: Record<string, unknown>) {
    if (!this.size) return;
    const { materials, prints } = savedFaceRefs(this.entries(), this.resolution(), this.built());
    out["faceMaterials"] = materials;
    if (Object.keys(prints).length) out["facePrints"] = prints;
  }
  stored(): [string, FaceRef][] {
    return [...this.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }
  // At the face and print the build on screen last found it on, so a ref undo puts back finds its face.
  located(): [string, FaceRef][] {
    const seen = this.resolution()?.track.seen;
    return this.stored().map(([id, ref]) => {
      const s = seen?.get(id);
      return [id, s ? { ...ref, face: s.face, at: s.at } : ref];
    });
  }
  restore(refs: readonly [string, FaceRef][]) {
    this.clear();
    for (const [id, ref] of refs) this.set(id, ref);
  }
  override loadFrom(parsed: Record<string, unknown>) {
    this.clear();
    for (const ref of loadFaceRefs(parsed["faceMaterials"], parsed["facePrints"])) this.set(newFaceRefId(), ref);
  }
  override clear() {
    super.clear();
    this.track = null;
    this.prior = null;
    this.memo = null;
  }
}

// A step's name is for people and is kept out of the build, so renaming does not invalidate the geometry cache for it
// and everything after. An import is the exception: there the name names the bodies.
export function withoutDisplayName(f: Feature): Feature {
  if (f.type === "import" || !("name" in f)) return f;
  // Same object back for the same feature: the rebuild wire resends any feature whose object changed.
  let out = unnamed.get(f);
  if (!out) {
    const { name: _name, ...rest } = f as Feature & { name?: string };
    out = rest as Feature;
    unnamed.set(f, out);
  }
  return out;
}
const unnamed = new WeakMap<Feature, Feature>();

// An older app recorded the section cut in versions, but a cut is a view, not part of the model.
function versionSnapshot(repo: VersionRepo, id: string): Snapshot {
  const { sectionView: _, ...doc } = snapshotOf(repo, id) as Snapshot & { sectionView?: unknown };
  return doc;
}

/** Without the cut, which an older app recorded in a version. */
function restText({ features: _, sectionView: _cut, ...rest }: Partial<Snapshot>): string {
  return JSON.stringify(rest);
}

export class DocumentStore {
  private doc: CadDocument;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private docListeners = new Set<DocListener>();
  private rewindListeners = new Set<() => void>();
  private openListeners = new Set<() => void>();
  private buildListeners = new Set<BuildListener>();
  private busyListeners = new Set<BusyListener>();
  private metaListeners = new Set<MetaListener>();
  private path: string | null = null; // current file path (null = unsaved)
  private pathlessName: string | null = null;
  private isDirty = false; // unsaved changes since last save/open/new
  private edits = 0;
  private keepClean = 0;
  private rollback: number | null = null; // # of active features (null = all); timeline marker
  private suppressed = new Set<string>(); // feature ids skipped on rebuild (suppress)
  private sketchVis = new Overlay<boolean>("sketchVisibility", isBool); // explicit per-sketch show/hide overrides
  private bodyVis = new Overlay<boolean>("bodyVisibility", isBool); // explicit per-body show/hide overrides (id → visible)
  // True only while the hidden set is exactly an isolate, so the indicator ignores a manual hide. Session only.
  private isolate = false;
  private planeVis = new Overlay<boolean>("planeVisibility", isBool); // explicit per-construction-plane show/hide overrides
  private bodyNames = new Overlay<string>("bodyNames", isText); // explicit per-body display-name overrides (id → name)
  private palette: { name: string; color: string; material?: string }[] = DEFAULT_PALETTE.map((s) => ({ ...s }));
  private bodyColors = new Overlay<number>("bodyColors", isCount); // per-body palette-slot assignment (id → slot index)
  private bodyElement = new Overlay<string>("bodyElement", isText); // per-body element assignment (id → element id)
  private bodyMaterial = new Overlay<string>("bodyMaterial", isText); // per-body material assignment (id → material id)
  private faceMaterial = new FaceRefOverlay(() => this.build.result);
  // Import feature id to "faces" when its parts wear face colours over body colours. Absent is "bodies".
  private importColors = new Overlay<ImportColorSource>("importColorSource", isText);
  /** Left out of the saved file while it is the untouched starter set. */
  private materials: MaterialDef[] = STARTER_LIBRARY.map((m) => ({ ...m }));
  private elements: ElementDef[] = [];
  private repo: VersionRepo | null = null;
  private stress: StressStudy | null = null;
  /** Off `doc` like the study, so an embedded panorama is never cloned onto the undo stack. */
  private environment: DocEnvironment | null = null;
  // Unknown top level keys of the opened file, written back as they came, off the undo stack and the rebuild.
  private unknownKeys: Record<string, unknown> = {};
  // Reference images (plugins/FundaCAD.ReferenceImages), kept whole. Off `doc`: a picture neither rebuilds nor undoes.
  private refImages: Record<string, unknown>[] = [];
  private refImageListeners = new Set<(list: readonly Record<string, unknown>[]) => void>();
  private refCoalesce: { key: string; top: unknown; after: { v: Record<string, unknown>[] } } | null = null;
  // A newer study or repo shape this version cannot read, written back while the document has none of its own.
  private unreadSections: { stress?: unknown; environment?: unknown; versions?: unknown; sectionView?: unknown } = {};
  /** The section cut that is on. Off `doc` and off the undo stack: undo never moves it and it builds nothing. */
  private cut: SectionView | null = null;
  private cutListeners = new Set<(v: Readonly<SectionView> | null) => void>();
  /** The `version` the open document was stamped with, 1 when it had none. */
  openedVersion = FORMAT_VERSION;
  // Sections of the opened `.fundab` this version does not read, written back on a `.fundab` save.
  carriedSections: CarriedSection[] = [];
  // In on-disk key order. palette piggybacks on bodyColors' condition, so is not listed.
  private readonly overlays: { overlay: Overlay<any> }[] = [
    { overlay: this.sketchVis },
    { overlay: this.bodyVis },
    { overlay: this.planeVis },
    { overlay: this.bodyNames },
    { overlay: this.bodyColors },
    { overlay: this.bodyElement },
    { overlay: this.bodyMaterial },
    { overlay: this.faceMaterial },
    { overlay: this.importColors },
  ];
  /** Un-committed features shown live, never in undo. A list: a thread is a sketch plus a revolve. */
  private preview: Feature[] | null = null;
  private rebuildTimer: number | null = null;
  private rebuilding = false; // a rebuild round-trip is in flight
  private rebuildQueued = false; // a newer rebuild was requested while one was in flight
  // Chunk installments carry it so a late one from an abandoned reply is dropped.
  private buildEpoch = 0;
  private chunkListeners = new Set<(c: BuildChunk) => void>();
  private abortListeners = new Set<(epoch: number) => void>();
  private build: RebuildState = {
    building: false,
    result: null,
    errorFeatureId: null,
    errorMessage: null,
    streamed: null,
    streamTotal: null,
    progress: null,
    phase: null,
    meshed: null,
    meshTotal: null,
  };

  private busy: BusyState = IDLE_BUSY;
  /** Every runBusy op still running, newest last; the chip shows the newest. */
  private busyOps: { state: BusyState; abort: AbortController | null }[] = [];
  private historyHeld = 0;
  // Reads begun since the last open: an open drops the ones before it, so only these can land in this document.
  private readsHere = 0;
  private opens = 0;

  // The last preview-free build and its key: leaving a tool or undoing a refused commit shows it again without a rebuild.
  private committedShown: { key: string; state: RebuildState } | null = null;
  /** The rebuild on the wire, and the id a supersede cancels. */
  private inflight: { gen: number; id: string | null; cancelled: boolean; byUser?: boolean } | null = null;
  private sendGen = 0;
  /** Replies to rebuilds sent at or before this are stale and never published. */
  private staleThrough = 0;
  /** A commit the kernel had not answered for yet, see verifyCommit. */
  private provisional: { id: string; what: string; key: string } | null = null;
  /** Set when a preview is dropped or a refused commit undone, the only times
   *  the committed model may be shown again without asking the engine. */
  private restoreArmed = false;

  // Non-fatal news for the user (a newer file, a dropped sketch binding, a failed param cascade); a toast in main.ts.
  onWarning?: (msg: string) => void;

  constructor(
    private geometry: GeometryBackend,
    initial: CadDocument,
  ) {
    this.doc = clone(initial);
    migrateDocument(this.doc); // the seed doc skips load(); normalize it the same way
    geometry.onProgress?.((feature, meshed, meshTotal, phase) => {
      if (!this.build.building) return;
      // -1/-1 means not meshing; null lets the chip tell "no denominator" from "0 of N".
      this.build = {
        ...this.build,
        progress: feature,
        phase,
        meshed: meshed >= 0 ? meshed : null,
        meshTotal: meshTotal > 0 ? meshTotal : null,
      };
      this.emitBuild();
    });
    // installments of a chunked reply -> the viewport, and ONLY the viewport
    geometry.onRebuildChunk?.((c) => {
      if (!this.build.building) return;
      this.build = { ...this.build, streamed: c.done, streamTotal: c.total };
      this.emitBuild();
      const chunk: BuildChunk = { ...c, epoch: this.buildEpoch };
      for (const fn of this.chunkListeners) fn(chunk);
    });
    geometry.onOpProgress?.((id, pct, stage) => {
      if (!this.busy.active || (this.busy.id !== null && this.busy.id !== id)) return;
      this.setBusy({ ...this.busy, pct, stage: stage || null });
    });
    // Only the busy op's own request: any other id is not what this document waits on.
    geometry.onQueue?.((id, behind) => {
      if (!this.busy.active || this.busy.id !== id) return;
      this.setBusy({ ...this.busy, waiting: behind });
    });
  }

  get document(): CadDocument {
    return this.doc;
  }
  get backend(): GeometryBackend {
    return this.geometry;
  }
  get buildState(): RebuildState {
    return this.build;
  }

  onDocChange(fn: DocListener): () => void {
    this.docListeners.add(fn);
    fn(this.doc);
    return () => this.docListeners.delete(fn);
  }
  // Undo, redo, a load or a new document: anything half picked against the old one is stale.
  onRewind(fn: () => void): () => void {
    this.rewindListeners.add(fn);
    return () => this.rewindListeners.delete(fn);
  }
  private emitRewind() {
    for (const fn of this.rewindListeners) fn();
  }
  /** Another document took this one's place: an open or a new document, never
   *  an undo or a replacement of the same document. */
  onOpen(fn: () => void): () => void {
    this.openListeners.add(fn);
    return () => this.openListeners.delete(fn);
  }
  private emitOpen() {
    this.opens++;
    this.readsHere = 0;
    for (const fn of this.openListeners) fn();
  }
  get busyState(): BusyState {
    return this.busy;
  }
  /** Only an import's read holds history, so this is true while one is still read into this document. */
  get importRunning(): boolean {
    return this.readsHere > 0;
  }

  /** An edit is waiting out the rebuild debounce. */
  get rebuildPending(): boolean {
    return this.rebuildTimer != null;
  }

  onBusy(fn: BusyListener): () => void {
    this.busyListeners.add(fn);
    fn(this.busy);
    return () => this.busyListeners.delete(fn);
  }

  // `onStarted` hands back the request id, else a rebuild started meanwhile would be "most recent". An op that never
  // reaches the engine passes `abort`. `holdHistory` blocks undo/redo, since an import's late step would drop a redo.
  async runBusy<T>(
    label: string,
    fn: (onStarted: (id: string) => void) => Promise<T>,
    opts: { rebuild?: boolean; abort?: AbortController; holdHistory?: boolean } = {},
  ): Promise<T> {
    const op = {
      state: { ...IDLE_BUSY, active: true, label, rebuild: opts.rebuild === true },
      abort: opts.abort ?? null,
    };
    const openedAt = this.opens;
    if (opts.holdHistory) {
      this.historyHeld++;
      this.readsHere++;
    }
    this.busyOps.push(op);
    this.setBusy(op.state);
    try {
      return await fn((id) => {
        op.state = { ...op.state, id, waiting: null };
        if (this.busyOps.at(-1) === op) this.setBusy(op.state);
      });
    } finally {
      if (opts.holdHistory) {
        this.historyHeld--;
        if (openedAt === this.opens) this.readsHere--;
      }
      this.busyOps.splice(this.busyOps.indexOf(op), 1);
      this.busy = this.busyOps.at(-1)?.state ?? IDLE_BUSY;
      this.emitBusy();
    }
  }
  private get busyAbort(): AbortController | null {
    return this.busyOps.at(-1)?.abort ?? null;
  }

  private setBusy(next: BusyState) {
    this.busy = next;
    const top = this.busyOps.at(-1);
    if (top) top.state = next;
    this.emitBusy();
  }

  // False covers both "nothing running" and "the engine had already finished".
  async cancelBusy(): Promise<boolean> {
    if (!this.busy.active) return false;
    if (this.busy.rebuild && this.inflight) this.inflight.byUser = true;
    if (this.busyAbort) {
      this.busyAbort.abort();
      return true;
    }
    // No id yet means the request has not gone out; undefined falls back to the client's lastHeavyId.
    return (await this.geometry.cancel?.(this.busy.id ?? undefined)) ?? false;
  }

  onBuild(fn: BuildListener): () => void {
    this.buildListeners.add(fn);
    fn(this.build);
    return () => this.buildListeners.delete(fn);
  }
  // For the viewport only. Unlike onBuild, nothing is replayed.
  onBuildChunk(fn: (c: BuildChunk) => void): () => void {
    this.chunkListeners.add(fn);
    return () => this.chunkListeners.delete(fn);
  }
  // A chunked reply that will never finish (dropped connection, cancel, bad frame): tear down what was drawn.
  onBuildAbort(fn: (epoch: number) => void): () => void {
    this.abortListeners.add(fn);
    return () => this.abortListeners.delete(fn);
  }
  onEditPreview(fn: () => void): () => void {
    this.editPreviewListeners.add(fn);
    return () => this.editPreviewListeners.delete(fn);
  }
  private editPreviewListeners = new Set<() => void>();
  private emitEditPreview() {
    for (const fn of this.editPreviewListeners) fn();
  }

  // The tool's live version while one edits it, so a panel beside the tool never contradicts it.
  liveFeature(id: string): Feature | null {
    if (this.editPreview?.id === id && this.editPreview.feature) return this.editPreview.feature;
    return this.doc.features.find((f) => f.id === id) ?? null;
  }

  // For the titlebar.
  onMeta(fn: MetaListener): () => void {
    this.metaListeners.add(fn);
    fn();
    return () => this.metaListeners.delete(fn);
  }

  get filePath(): string | null {
    return this.path;
  }
  get dirty(): boolean {
    return this.isDirty;
  }
  get fileName(): string {
    if (!this.path) return this.pathlessName ?? "Untitled";
    return this.path.split(/[\\/]/).pop() || this.path;
  }
  markSaved(path: string) {
    this.path = path;
    this.pathlessName = null;
    this.isDirty = false;
    this.emitMeta();
  }
  // Bytes the desktop app could not place on disk: Save asks where, instead of writing beside the app's working dir.
  markOpenedWithoutPath(name: string) {
    this.path = null;
    this.pathlessName = name;
    this.isDirty = false;
    this.emitMeta();
  }
  // Gives up a name taken without a path, so the document is Untitled again, unsaved work and all.
  dropPathlessName() {
    if (this.path || this.pathlessName === null) return;
    this.pathlessName = null;
    this.emitMeta();
  }
  // A failed rebuild keeps the last result, and a build in flight would hold up the new document's.
  private discardModelForReplacement() {
    // A reply or chunk for the old document can still arrive before the cancel lands.
    this.staleThrough = this.sendGen;
    this.buildEpoch++;
    if (this.build.streamed !== null) this.emitBuildAbort();
    this.build = {
      ...this.build,
      building: false,
      result: null,
      errorFeatureId: null,
      errorMessage: null,
      streamed: null,
      streamTotal: null,
      progress: null,
      phase: null,
      meshed: null,
      meshTotal: null,
      previewBuilt: null,
      heldRefusal: null,
      cancelled: false,
    };
    this.emitBuild();
    this.committedShown = null;
    this.provisional = null;
    this.restoreArmed = false;
    // Cancel kills the pool worker, the only way to interrupt an OCCT call already under way.
    void this.cancelBusy();
  }

  // Not for a replace load, where an armed tool stays and keeps previewing.
  private dropToolPreview() {
    this.preview = null;
    this.previewHold = false;
    if (this.editPreview) {
      this.editPreview = null;
      this.emitEditPreview();
    }
  }

  newDocument() {
    this.emitOpen();
    this.emitRewind();
    this.undoStack = [];
    this.redoStack = [];
    this.doc = clone(EMPTY_DOCUMENT);
    this.rollback = null;
    this.rearmProjectionValve(); // valve state must never cross documents
    this.suppressed.clear();
    for (const { overlay } of this.overlays) overlay.clear();
    this.isolate = false;
    this.palette = DEFAULT_PALETTE.map((s) => ({ ...s }));
    this.elements = [];
    this.materials = STARTER_LIBRARY.map((m) => ({ ...m }));
    this.repo = null;
    this.stress = null;
    this.environment = null;
    this.cut = null;
    this.unknownKeys = {};
    this.setRefImagesQuiet([]);
    this.unreadSections = {};
    this.openedVersion = FORMAT_VERSION;
    this.carriedSections = [];
    this.path = null;
    this.pathlessName = null;
    this.isDirty = false;
    this.dropToolPreview();
    this.discardModelForReplacement();
    this.emitDoc();
    this.emitMeta();
    this.emitSectionView();
    this.scheduleRebuild(true);
  }

  private emitDoc() {
    for (const fn of this.docListeners) fn(this.doc);
  }
  private emitBuild() {
    for (const fn of this.buildListeners) fn(this.build);
  }
  private emitBusy() {
    for (const fn of this.busyListeners) fn(this.busy);
  }
  private emitMeta() {
    for (const fn of this.metaListeners) fn();
  }
  private markDirty() {
    this.edits++;
    if (this.isDirty || this.keepClean) return;
    this.isDirty = true;
    this.emitMeta();
  }

  // Counts every change, saved or not, so a caller can tell nothing else changed between two of its own steps.
  get editCount(): number {
    return this.edits;
  }
  // For the writes that open a document: a clean one stays clean through them, a dirty one stays dirty.
  keepingClean<T>(fn: () => T): T {
    this.keepClean++;
    try {
      return fn();
    } finally {
      this.keepClean--;
    }
  }
  // Back to what the last save or open left, as when a cancelled import was the only change.
  markClean() {
    if (!this.isDirty) return;
    this.isDirty = false;
    this.emitMeta();
  }

  // A doc undo entry is a full clone (imports embed multi-MB BREPs), so the stack is capped; overlay entries share it.
  private static readonly UNDO_CAP = 50;

  private collecting: UndoEntry[] | null = null;

  private pushUndo(): UndoEntry & { kind: "doc" } {
    const entry = { kind: "doc" as const, doc: clone(this.doc) };
    if (this.collecting) this.collecting.push(entry);
    else if (this.undoStack.push(entry) > DocumentStore.UNDO_CAP) this.undoStack.shift();
    return entry;
  }

  private pushOverlayUndo(entry: { undo: () => void; redo: () => void }) {
    if (this.collecting) return void this.collecting.push({ kind: "overlay", ...entry });
    this.undoStack.push({ kind: "overlay", ...entry });
    if (this.undoStack.length > DocumentStore.UNDO_CAP) this.undoStack.shift();
    this.redoStack = [];
  }

  // setBodiesVisibility has its own, since a visible id is always set, never deleted. False when nothing changed, so
  // the caller can skip its own emit and dirty.
  private writeOverlayBatch<T>(overlay: Overlay<T>, ids: Iterable<string>, value: T | null): boolean {
    return this.writeOverlayMap(overlay, new Map([...ids].map((id) => [id, value])));
  }

  private writeOverlayMap<T>(overlay: Overlay<T>, writes: ReadonlyMap<string, T | null>): boolean {
    const prior = new Map<string, T | undefined>();
    for (const [id, value] of writes) {
      const was = overlay.get(id);
      if ((was ?? null) === value) continue;
      prior.set(id, was);
      if (value === null) overlay.delete(id);
      else overlay.set(id, value);
    }
    if (!prior.size) return false;
    this.markDirty();
    this.emitBuild();
    this.pushOverlayUndo({
      undo: () => {
        for (const [id, was] of prior) {
          if (was === undefined) overlay.delete(id);
          else overlay.set(id, was);
        }
        this.markDirty();
        this.emitBuild();
      },
      redo: () => {
        for (const [id] of prior) {
          const value = writes.get(id)!;
          if (value === null) overlay.delete(id);
          else overlay.set(id, value);
        }
        this.markDirty();
        this.emitBuild();
      },
    });
    return true;
  }

  mutate(fn: (doc: CadDocument) => void, immediate = false) {
    this.step(fn, immediate);
  }
  /** `move` shifts the rollback marker or the suppress set with the edit, inside its undo step. */
  private step(fn: (doc: CadDocument) => void, immediate: boolean, move?: () => void) {
    const before = move && this.timelineSections();
    move?.();
    const entry = this.pushUndo();
    if (before) {
      const swap = stateSwap(before, this.timelineSections());
      if (swap.size) entry.state = swap;
    }
    this.redoStack = [];
    // A user edit is the "edit the model to retry" the valve toast promises.
    this.rearmProjectionValve();
    this.applyDerived(fn, immediate);
  }

  // name -> why its value is stale (cycle, unknown ref, non-finite, missing target) from the last recompute.
  paramIssues: Record<string, string> = {};

  private applyRecompute(r: params.RecomputeResult) {
    this.paramIssues = r.issues;
  }

  // Injected by main.ts, so the document layer and its tests do not depend on the WASM solver.
  headlessSolve?: (
    sketch: Extract<Feature, { type: "sketch" }>,
    parameters: CadDocument["parameters"],
    anchor?: { x: number; y: number },
  ) => Promise<{ entities: Extract<Feature, { type: "sketch" }>["entities"] } | null>;
  // The sketch open in the editor re-solves itself live and must not be overwritten headlessly.
  openSketchId?: () => string | null;
  /** No sketch set on purpose: an open sketch's pending bindings are not in the draft. */
  onParamsApplied?: () => void;
  // A closed sketch could not satisfy its dims after a param edit; its coordinates were left unchanged.
  onParamSolveIssue?: (sketchId: string) => void;
  // Projection refreshes for the open sketch go to the live session (SketchMode.syncProjectedCurves), never the doc copy.
  onProjectionsApplied?: (updates: ProjectionUpdate[]) => void;

  // In series: recompute a draft, re-solve affected sketches, land it as one undo step and one rebuild.
  private paramChain: Promise<void> = Promise.resolve();
  private paramPending = 0;
  private queueParamCommit(fn: (d: CadDocument) => void) {
    this.paramPending++;
    this.paramChain = this.paramChain
      // Only the last of a burst rebuilds at once, the rest keep the debounce, so
      // a plugin setting ten parameters does not start and supersede nine builds.
      .then(() => this.commitWithCascade(fn, --this.paramPending === 0))
      .catch((e) => {
        console.error("param commit failed:", e);
        this.onWarning?.("Parameter change failed to apply, see the console for details.");
      });
  }
  private async commitWithCascade(fn: (d: CadDocument) => void, immediate: boolean): Promise<void> {
    const draft = clone(this.doc);
    fn(draft);
    const r = params.recompute(draft);
    const open = this.openSketchId?.() ?? null;
    for (const sid of r.affectedSketches) {
      if (sid === open) continue;
      const f = draft.features.find(
        (x): x is Extract<Feature, { type: "sketch" }> => x.type === "sketch" && x.id === sid,
      );
      if (!f) continue;
      const solved = await this.solveConstrainedSketch(f, draft.parameters);
      if (solved) f.entities = solved;
    }
    this.mutate((d) => {
      d.parameters = draft.parameters;
      if (draft.paramDefs) d.paramDefs = draft.paramDefs;
      else delete d.paramDefs;
      if (draft.paramExtras) d.paramExtras = draft.paramExtras;
      else delete d.paramExtras;
      // The draft is a clone, and the rebuild wire resends every changed object, so keep the untouched features.
      d.features = draft.features.map((f, i) => {
        const was = d.features[i];
        return was && was.id === f.id && JSON.stringify(was) === JSON.stringify(f) ? was : f;
      });
    }, immediate);
    this.onParamsApplied?.();
  }

  // Projection updates land as a derived commit with no undo entry, so an upstream edit settles in two rebuilds.

  // Open sketch deliveries do not count: their doc copy lags until finish(), so the engine re-emits them every rebuild.
  private projStreak = 0;
  private projValveOpen = true;

  /** Every user gesture earns a fresh refresh budget; a tripped valve cannot recover otherwise. */
  private rearmProjectionValve() {
    this.projStreak = 0;
    this.projValveOpen = true;
  }

  /** Never from a preview build, which also must not touch the streak. The valve stops
   *  a source flapping past the 1e-4 tolerance after 5 refreshes in a row. */
  private maybeQueueProjectionRefresh(updates: ProjectionUpdate[] | undefined) {
    if (this.hasPreview) return;
    if (!updates?.length) {
      this.rearmProjectionValve();
      return;
    }
    if (this.projStreak >= 5) {
      if (this.projValveOpen) {
        this.projValveOpen = false;
        this.onWarning?.(
          "Projected geometry keeps changing on every rebuild, paused automatic refresh (edit the model or Compute All to retry).",
        );
      }
      return;
    }
    this.queueProjectionRefresh(updates);
  }

  // Serialised with param commits: both headless-solve sketches and replace whole features.
  private queueProjectionRefresh(updates: ProjectionUpdate[]) {
    this.paramChain = this.paramChain
      .then(() => this.commitProjectionRefresh(updates))
      .catch((e) => {
        console.error("projection refresh failed:", e);
        this.onWarning?.("Projected geometry failed to refresh, see the console for details.");
      });
  }

  private async commitProjectionRefresh(updates: ProjectionUpdate[]) {
    // The rebuild ran on an older snapshot, so drop entries for sketches or entities deleted since.
    const sketchOf = new Map<string, Extract<Feature, { type: "sketch" }>>();
    for (const f of this.doc.features) {
      const sk = asFeature(f, "sketch");
      if (sk) sketchOf.set(sk.id, sk);
    }
    const valid = updates.filter((u) => {
      const f = sketchOf.get(u.sketch);
      return !!f && f.entities.some((e) => e.type === "projected" && e.id === u.entity);
    });
    if (!valid.length) return;

    // The engine emits stale:true only on the transition, so every entry here is news.
    for (const sid of new Set(valid.filter((u) => u.stale).map((u) => u.sketch))) {
      const f = sketchOf.get(sid)!;
      this.onWarning?.(`Projected geometry in ${f.name ?? sid} lost its source, keeping last shape`);
    }

    const open = this.openSketchId?.() ?? null;
    const openUpdates = valid.filter((u) => u.sketch === open);
    const closedUpdates = valid.filter((u) => u.sketch !== open);
    // The live session owns the open sketch's doc copy and persists the patched entities on finish().
    if (openUpdates.length) this.onProjectionsApplied?.(openUpdates);
    if (!closedUpdates.length) return;

    const bySketch = new Map<string, ProjectionUpdate[]>();
    for (const u of closedUpdates) {
      let list = bySketch.get(u.sketch);
      if (!list) bySketch.set(u.sketch, (list = []));
      list.push(u);
    }
    // Built before the single applyDerived: the solve is async, and curves and solved coordinates must land together.
    const replacements = new Map<string, Extract<Feature, { type: "sketch" }>>();
    for (const [sid, list] of bySketch) {
      const f = sketchOf.get(sid)!;
      const byEntity = new Map(list.map((u) => [u.entity, u]));
      const entities = f.entities.map((e) => {
        if (e.type !== "projected" || e.id === undefined) return e;
        const u = byEntity.get(e.id);
        return u ? applyProjectionUpdate(e, u) : e;
      });
      let nf: Extract<Feature, { type: "sketch" }> = { ...f, entities };
      const solved = await this.solveConstrainedSketch(nf, this.doc.parameters);
      if (solved) nf = { ...nf, entities: solved };
      replacements.set(sid, nf);
    }
    // A sketch edited during the solves would be resurrected; its own rebuild re-emits the diff.
    for (const sid of [...replacements.keys()]) {
      if (this.doc.features.find((x) => x.id === sid) !== sketchOf.get(sid)) replacements.delete(sid);
    }
    if (!replacements.size) return;
    this.projStreak++; // only doc-changing refreshes count toward the valve
    this.applyDerived((d) => {
      for (const [sid, nf] of replacements) {
        const i = d.features.findIndex((x) => x.id === sid);
        // Replaced, not patched: the delta wire protocol diffs features by reference.
        if (i >= 0) d.features[i] = nf;
      }
    });
  }

  // Shared by the param cascade and projection refresh. Null when nothing to solve or it failed (onParamSolveIssue).
  private async solveConstrainedSketch(
    f: Extract<Feature, { type: "sketch" }>,
    parameters: CadDocument["parameters"],
  ): Promise<Extract<Feature, { type: "sketch" }>["entities"] | null> {
    if (!(f.constraints ?? []).length || !this.headlessSolve) return null;
    const solved = await this.headlessSolve(f, parameters);
    if (!solved) {
      this.onParamSolveIssue?.(f.id);
      return null;
    }
    return solved.entities;
  }

  // Derived commits call this directly to stay out of undo.
  private applyDerived(fn: (doc: CadDocument) => void, immediate = true) {
    const joins = joinSignatures(this.doc);
    fn(this.doc);
    forgetStaleJoins(joins, this.doc);
    canonicalMirrorPlanes(this.doc);
    if (this.doc.paramDefs) this.applyRecompute(params.recompute(this.doc));
    this.markDirty();
    this.emitDoc();
    this.scheduleRebuild(immediate);
  }

  setParam(name: string, value: number) {
    void this.setParamExpr(name, String(value));
  }

  // Returns an error for the input, or null; validation is synchronous but the commit lands later via the cascade.
  setParamExpr(name: string, expr: string, unit?: "mm" | "deg" | "count"): string | null {
    const v = params.validateExpr(this.doc, name, expr);
    if (!v.ok) return v.error;
    this.queueParamCommit((d) => params.commitParamExpr(d, name, expr, unit));
    return null;
  }

  // Also validates the name.
  addParam(name: string, expr: string, unit?: "mm" | "deg" | "count"): string | null {
    const bad = params.validateName(params.defsOf(this.doc), name);
    if (bad) return bad;
    return this.setParamExpr(name, expr, unit);
  }

  // The sketch dim editor's pre-check, for a binding that may not be committed yet. Handles `name=expr`.
  classifyTargetExpr(
    boundName: string | null,
    pendingName: string | null,
    raw: string,
    kind: FieldKind,
  ): params.ExprInput {
    return params.classifyExprInput(this.doc, raw, kind, boundName, pendingName);
  }

  renameParam(from: string, to: string): string | null {
    const defs = params.defsOf(this.doc);
    if (!(from in defs)) return `no parameter "${from}"`;
    const bad = params.validateName(defs, to);
    if (bad) return bad;
    this.mutate((d) => void params.commitRenameParam(d, from, to));
    return null;
  }

  deleteParam(name: string): string | null {
    const blocked = params.deleteBlockers(this.doc, name);
    if (blocked) return blocked;
    this.mutate((d) => void params.commitDeleteParam(d, name));
    return null;
  }

  // A null clears that key; an absent key is left as it is.
  setParamMeta(name: string, patch: { control?: ParamControl | null; group?: string | null; hidden?: boolean }) {
    if (!params.defsOf(this.doc)[name]) return;
    this.mutate((d) => {
      const def = params.defsOf(d)[name];
      if (!def) return;
      if (patch.control === null) delete def.control;
      else if (patch.control) def.control = patch.control;
      if (patch.group === null) delete def.group;
      else if (patch.group !== undefined) def.group = patch.group;
      if (patch.hidden === false) delete def.hidden;
      else if (patch.hidden) def.hidden = true;
    });
  }

  // One undo step. Deleting a group also ungroups its parameters, so none names a group that is gone.
  updateParamExtras(fn: (x: ParamExtras) => void) {
    this.mutate((d) => {
      const x: ParamExtras = structuredClone(d.paramExtras ?? {});
      fn(x);
      const groups = new Set((x.groups ?? []).map((g) => g.id));
      for (const def of Object.values(params.defsOf(d))) {
        if (def.group !== undefined && !groups.has(def.group)) delete def.group;
      }
      if (extrasEmpty(x)) delete d.paramExtras;
      else d.paramExtras = x;
    });
  }

  // One undo step; refused, changing nothing, when any value does not fit the document as it is now.
  applyConfiguration(id: string): string | null {
    const cfg = this.doc.paramExtras?.configurations?.find((c) => c.id === id);
    if (!cfg) return `no configuration "${id}"`;
    const trial = trialConfiguration(this.doc, cfg);
    if (!trial.ok) return trial.error;
    this.queueParamCommit((d) => {
      for (const [name, expr] of Object.entries(cfg.values)) params.commitParamExpr(d, name, expr);
      d.paramExtras = { ...(d.paramExtras ?? {}), activeConfiguration: id };
    });
    return null;
  }

  setParamComment(name: string, comment: string) {
    const def = params.defsOf(this.doc)[name];
    if (!def) return;
    this.mutate((d) => {
      const target = params.defsOf(d)[name];
      if (!target) return;
      if (comment) target.comment = comment;
      else delete target.comment;
    });
  }

  // Canonical units; `name=expr` names the parameter. Plain numbers go through setTargetValue.
  setTargetExpr(target: ParamTarget, raw: string, kind: FieldKind): string | null {
    const bound = params.boundParam(this.doc, target);
    const c = params.classifyExprInput(this.doc, raw, kind, bound);
    if (!c.ok) return c.error;
    this.queueParamCommit((d) => {
      if (c.name) params.commitNamedFieldExpr(d, target, c.name, c.expr, kind);
      else params.commitFieldExpr(d, target, c.expr, kind);
    });
    return null;
  }

  // A bound field keeps its model param with the literal as its expression (Fusion behaviour); an unbound field is
  // written directly and no param is created.
  setTargetValue(target: ParamTarget, canonical: number, kind: FieldKind): void {
    if (params.boundParam(this.doc, target)) {
      void this.setTargetExpr(target, String(canonical), kind);
    } else {
      this.mutate((d) => void writeTarget(d, target, canonical));
    }
  }

  boundExpr(target: ParamTarget): { name: string; expr: string; value: number } | null {
    const name = params.boundParam(this.doc, target);
    if (!name) return null;
    const def = params.defsOf(this.doc)[name]!;
    return { name, expr: def.expr, value: def.value };
  }

  // Drag tools must not overwrite a field driven by a non-literal expression.
  isParamBound(target: ParamTarget): boolean {
    return params.isBound(this.doc, target);
  }

  // A drag tool that gets a name back may edit that parameter directly (see params/engine.ts).
  bareParamRef(target: ParamTarget): string | null {
    return params.bareParamRef(this.doc, target);
  }

  /** Applied in the same mutate as the sketch commit; an invalid binding is dropped with a warning. */
  private applyBindings(d: CadDocument, bindings?: SketchBinding[]) {
    for (const b of bindings ?? []) {
      // Re-validated against the final doc, where the dim or entity now exists.
      const bound = params.boundParam(d, b.target);
      const nameBad = b.name && b.name !== bound ? params.validateName(params.defsOf(d), b.name) : null;
      const v = params.validateExpr(d, bound, b.expr, b.kind);
      if (!v.ok || nameBad) {
        this.onWarning?.(
          `Dimension expression "${b.name ? `${b.name}=` : ""}${b.expr}" was dropped: ${nameBad ?? (v.ok ? "" : v.error)}`,
        );
        continue;
      }
      if (b.name) params.commitNamedFieldExpr(d, b.target, b.name, b.expr, b.kind);
      else params.commitFieldExpr(d, b.target, b.expr, b.kind);
    }
  }

  addFeature(feature: Feature, atIndex?: number, bindings?: SketchBinding[]) {
    // New features land at the rollback marker (mainstream MCAD), which then advances past them.
    const at = atIndex ?? this.rollbackIndex;
    this.step(
      (d) => {
        d.features.splice(at, 0, feature);
        this.applyBindings(d, bindings);
      },
      true,
      () => {
        if (this.rollback !== null && at <= this.rollback) this.rollback += 1;
      },
    );
  }

  // One undo step.
  editAndAdd(edit: (doc: CadDocument) => void, features: Feature[] = []) {
    const at = this.rollbackIndex;
    this.step(
      (d) => {
        edit(d);
        if (features.length) d.features.splice(at, 0, ...features);
      },
      true,
      () => {
        if (features.length && this.rollback !== null && at <= this.rollback) this.rollback += features.length;
      },
    );
  }

  // One undo step at the rollback marker (a thread is two features).
  addFeatures(features: Feature[], bindings?: SketchBinding[]) {
    if (!features.length) return;
    const at = this.rollbackIndex;
    this.step(
      (d) => {
        d.features.splice(at, 0, ...features);
        this.applyBindings(d, bindings);
      },
      true,
      () => {
        if (this.rollback !== null && at <= this.rollback) this.rollback += features.length;
      },
    );
  }

  /** A bound numeric field is re-asserted by the recompute; use setTargetValue/setTargetExpr. */
  updateFeature(id: string, patch: Partial<Feature>) {
    this.mutate((d) => {
      const i = d.features.findIndex((f) => f.id === id);
      if (i >= 0) d.features[i] = { ...d.features[i], ...patch } as Feature;
    });
  }

  // No undo step of its own, so undoing the edit that asked for the measurement undoes both.
  deriveFeature(id: string, patch: Partial<Feature>) {
    this.applyDerived((d) => {
      const i = d.features.findIndex((f) => f.id === id);
      if (i >= 0) d.features[i] = { ...d.features[i], ...patch } as Feature;
    });
  }

  // A model parameter bound to it stops resolving and the recompute in mutate() collects it.
  removeFeatureField(id: string, field: string) {
    const f = this.doc.features.find((x) => x.id === id) as Record<string, unknown> | undefined;
    if (!f || f[field] === undefined) return;
    this.mutate((d) => {
      const i = d.features.findIndex((x) => x.id === id);
      if (i < 0) return;
      const { [field]: _gone, ...rest } = d.features[i] as unknown as Record<string, unknown>;
      d.features[i] = rest as unknown as Feature;
    });
  }

  // Blank goes back to the default.
  renameFeature(id: string, name: string) {
    const current = this.doc.features.find((f) => f.id === id) as (Feature & { name?: string }) | undefined;
    if (!current) return;
    const next = name.trim();
    if ((current.name ?? "") === next) return;
    this.mutate((d) => {
      const i = d.features.findIndex((f) => f.id === id);
      if (i < 0) return;
      const { name: _old, ...rest } = d.features[i] as Feature & { name?: string };
      d.features[i] = (next ? { ...rest, name: next } : rest) as Feature;
    });
  }

  // One undo step; with a parameter it goes through the cascade so both land in one mutate. Ends an open preview
  // without its own rebuild. On an invalid parameter value it returns the error and writes nothing.
  commitFeatureEdit(id: string, feature: Feature | null, param: { name: string; value: number } | null): string | null {
    const put = (d: CadDocument) => {
      if (!feature) return;
      const i = d.features.findIndex((f) => f.id === id);
      if (i >= 0) d.features[i] = feature;
    };
    if (!param) {
      this.endEditPreview(false);
      if (feature) this.mutate(put, true);
      return null;
    }
    const expr = String(param.value);
    const v = params.validateExpr(this.doc, param.name, expr);
    if (!v.ok) return v.error;
    this.endEditPreview(false);
    this.queueParamCommit((d) => {
      put(d);
      params.commitParamExpr(d, param.name, expr);
    });
    return null;
  }

  replaceFeature(id: string, feature: Feature, bindings?: SketchBinding[]) {
    this.mutate((d) => {
      const i = d.features.findIndex((f) => f.id === id);
      if (i >= 0) d.features[i] = feature;
      this.applyBindings(d, bindings);
    }, true);
  }

  // f1, f2, ...
  nextId(): string {
    const ids = new Set(this.doc.features.map((f) => f.id));
    let n = ids.size + 1;
    while (ids.has(`f${n}`)) n++;
    return `f${n}`;
  }

  removeFeature(id: string) {
    const idx = this.doc.features.findIndex((f) => f.id === id);
    this.step(
      (d) => {
        d.features = d.features.filter((f) => f.id !== id);
      },
      true,
      () => {
        if (this.rollback !== null && idx >= 0 && idx < this.rollback) this.rollback -= 1;
        this.suppressed.delete(id);
      },
    );
  }

  // features[0..rollbackIndex-1] are built.
  get rollbackIndex(): number {
    return this.rollback ?? this.doc.features.length;
  }
  isSuppressed(id: string): boolean {
    return this.suppressed.has(id);
  }
  setRollback(i: number) {
    const n = this.doc.features.length;
    this.rollback = i >= n ? null : Math.max(0, i);
    this.emitDoc();
    this.scheduleRebuild(true);
  }
  toggleSuppress(id: string) {
    const was = this.suppressed.has(id);
    const set = (on: boolean) => {
      if (on) this.suppressed.add(id);
      else this.suppressed.delete(id);
      this.markDirty();
      this.emitDoc();
      this.scheduleRebuild(true);
    };
    set(!was);
    this.pushOverlayUndo({ undo: () => set(was), redo: () => set(!was) });
  }

  // No undo, not dirty. `hold` keeps the last model that built on screen if the kernel refuses (see heldRefusal).
  setPreview(feature: Feature | Feature[] | null, opts?: { hold?: boolean }) {
    const had = this.preview !== null;
    this.preview = feature === null ? null : Array.isArray(feature) ? feature : [feature];
    this.previewHold = feature !== null && !!opts?.hold;
    if (feature === null && had) this.leavePreview();
    else this.scheduleRebuild(true);
  }

  // A microtask later: a commit drops its preview and adds the feature in one go, and only a drop nothing follows may
  // show the committed model again (restoreCommitted).
  private leavePreview() {
    this.restoreArmed = true;
    queueMicrotask(() => {
      if (this.restoreArmed) this.scheduleRebuild(true);
    });
  }
  private previewHold = false;
  // A preview's transient failures must not toast.
  get hasPreview(): boolean {
    return this.preview !== null || this.editPreview !== null;
  }

  // Builds stop just before the edited feature: the committed mesh has already consumed, say, a fillet's edges.
  // `inPlace` keeps what follows instead, for a feature that consumes nothing (a datum plane under a sketch).
  private editPreview: { id: string; feature: Feature | null; inPlace?: boolean } | null = null;
  // Omit `feature` to see the model before it (extrude picks profiles there); pass it to open without a flash.
  beginEditPreview(id: string, feature: Feature | null = null, opts?: { inPlace?: boolean }) {
    this.editPreview = { id, feature, ...(opts?.inPlace ? { inPlace: true } : {}) };
    this.previewHold = false;
    this.emitEditPreview();
    this.scheduleRebuild(true);
  }
  setEditPreview(feature: Feature | null, opts?: { hold?: boolean }) {
    if (!this.editPreview) return;
    this.editPreview = { ...this.editPreview, feature };
    this.previewHold = feature !== null && !!opts?.hold;
    this.emitEditPreview();
    this.scheduleRebuild(true);
  }
  endEditPreview(rebuild = true) {
    if (!this.editPreview) return;
    this.editPreview = null;
    this.previewHold = false;
    this.emitEditPreview();
    if (rebuild) this.leavePreview();
  }
  get editPreviewId(): string | null {
    return this.editPreview?.id ?? null;
  }
  get editPreviewInPlace(): boolean {
    return !!this.editPreview?.inPlace;
  }

  // Null mid-build so a drag does not strobe.
  get previewError(): string | null {
    if (this.build.building) return null;
    const failed = this.build.errorFeatureId;
    if (failed === null) return null;
    // A thread's sketch and revolve are one gesture, so a refusal of either belongs on the same boxes.
    const own = this.editPreview ? [this.editPreview.id] : (this.preview ?? []).map((f) => f.id);
    if (own.includes(failed)) return this.build.errorMessage;
    return this.editPreview?.inPlace ? this.downstreamRefusal(this.editPreview.id) : null;
  }

  // An in-place edit keeps the features after it, so breaking one is the edit's refusal too; featureError holds only
  // the most downstream failure.
  private downstreamRefusal(editedId: string): string | null {
    if (this.build.heldRefusal) return null;
    const errs = this.build.result?.featureErrors ?? [];
    const own = errs.find((e) => e.feature_id === editedId);
    if (own) return own.message;
    const features = this.doc.features;
    const at = features.findIndex((f) => f.id === editedId);
    if (at < 0) return null;
    let first: { index: number; message: string } | null = null;
    for (const e of errs) {
      if (!e.feature_id || this.committedFailures.has(e.feature_id)) continue;
      const index = features.findIndex((f) => f.id === e.feature_id);
      if (index > at && (!first || index < first.index)) first = { index, message: e.message };
    }
    if (!first) return null;
    const f = features[first.index]!;
    const name = (f as { name?: string }).name?.trim() || featureMeta(f).label;
    return `${name} fails with this value: ${first.message}`;
  }
  // Failed by the last preview-free build, so an in-place edit is not blamed for them.
  private committedFailures = new Set<string>();
  moveFeature(id: string, toIndex: number) {
    this.mutate((d) => {
      const from = d.features.findIndex((f) => f.id === id);
      if (from < 0) return;
      const [f] = d.features.splice(from, 1);
      if (!f) return;
      d.features.splice(Math.max(0, Math.min(d.features.length, toIndex)), 0, f);
    }, true);
  }

  undo() {
    if (!this.historyHeld) this.undoStep();
  }
  // An import's history hold does not stop this.
  private undoStep() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.emitRewind();
    this.redoStack.push(this.applyUndoEntry(prev, "undo"));
  }
  redo() {
    if (this.historyHeld) return;
    const next = this.redoStack.pop();
    if (!next) return;
    this.emitRewind();
    this.undoStack.push(this.applyUndoEntry(next, "redo"));
    if (this.undoStack.length > DocumentStore.UNDO_CAP) this.undoStack.shift();
  }
  private applyUndoEntry(e: UndoEntry, way: "undo" | "redo"): UndoEntry {
    if (e.kind === "overlay") {
      e[way]();
      return e;
    }
    if (e.kind === "group") {
      const order = way === "undo" ? [...e.entries].reverse() : e.entries;
      const back = order.map((x) => this.applyUndoEntry(x, way));
      return { kind: "group", entries: way === "undo" ? back.reverse() : back };
    }
    const was: UndoEntry = { kind: "doc", doc: clone(this.doc) };
    this.doc = e.doc;
    if (e.state) was.state = this.swapState(e.state);
    this.rearmProjectionValve();
    this.markDirty();
    this.emitDoc();
    this.scheduleRebuild(true);
    return was;
  }
  // When the top step is a document change and `onto` holds for the document before it, they join it. With
  // `only: true` nothing runs unless they can.
  undoAsOne(fn: () => void, onto?: (before: CadDocument) => boolean, opts: { only?: boolean } = {}): boolean {
    const top = this.undoStack.at(-1);
    const join = top?.kind === "doc" && !!onto?.(top.doc);
    if (opts.only && !join) return false;
    const taken: UndoEntry[] = [];
    this.collecting = taken;
    try {
      fn();
    } finally {
      this.collecting = null;
    }
    if (!taken.length) return join;
    if (join) {
      this.undoStack[this.undoStack.length - 1] = { kind: "group", entries: [top!, ...taken] };
      return true;
    }
    this.undoStack.push(taken.length > 1 ? { kind: "group", entries: taken } : taken[0]!);
    if (this.undoStack.length > DocumentStore.UNDO_CAP) this.undoStack.shift();
    this.redoStack = [];
    return false;
  }
  get canUndo() {
    return !this.historyHeld && this.undoStack.length > 0;
  }
  get canRedo() {
    return !this.historyHeld && this.redoStack.length > 0;
  }

  // Live object on the document; treat as read-only. Overrides do not affect geometry, so no rebuild.
  get viewOverrides(): Partial<Record<ViewCubeSide, ViewOverride>> {
    return this.doc.viewOverrides ?? {};
  }
  // Records undo and emits doc-change; effectiveDoc ignores overrides, so no rebuild.
  setViewOverride(side: ViewCubeSide, override: ViewOverride | null) {
    this.pushUndo();
    this.redoStack = [];
    if (override) {
      (this.doc.viewOverrides ??= {})[side] = override;
    } else if (this.doc.viewOverrides) {
      delete this.doc.viewOverrides[side];
      if (Object.keys(this.doc.viewOverrides).length === 0) delete this.doc.viewOverrides;
    }
    this.markDirty();
    this.emitDoc();
  }

  sketchVisibilityOverride(id: string): boolean | undefined {
    return this.sketchVis.get(id);
  }
  setSketchVisibility(id: string, visible: boolean) {
    const was = this.sketchVis.get(id);
    this.sketchVis.set(id, visible);
    this.markDirty();
    if (was === visible) return;
    this.pushOverlayUndo({
      undo: () => {
        if (was === undefined) this.sketchVis.delete(id);
        else this.sketchVis.set(id, was);
        this.markDirty();
      },
      redo: () => {
        this.sketchVis.set(id, visible);
        this.markDirty();
      },
    });
  }

  // Body visibility filters the hidden faces out of the mesh on re-render, no geometry rebuild.
  bodyVisibilityOverride(id: string): boolean | undefined {
    return this.bodyVis.get(id);
  }
  isBodyVisible(id: string): boolean {
    return this.bodyVis.get(id) ?? true;
  }
  setBodyVisibility(id: string, visible: boolean) {
    this.setBodiesVisibility(new Map([[id, visible]]));
  }

  setBodiesVisibility(vis: Map<string, boolean>) {
    // An isolate is exactly the current hidden set, so even a no-op call must clear a stale isolate=true first.
    // isolateBodies() re-asserts it right after this returns.
    const wasIsolate = this.isolate;
    let isolateAfter = false;
    this.isolate = false;
    const prior = new Map<string, boolean | undefined>();
    for (const [id, visible] of vis) {
      const was = this.bodyVis.get(id);
      if ((was ?? true) === visible) continue;
      prior.set(id, was);
      this.bodyVis.set(id, visible);
    }
    if (!prior.size) {
      this.emitBuild(); // isolate may just have flipped even though no id's visibility did
      return;
    }
    // Display only, unless some feature acts on whatever is shown when it builds.
    const shown = () => {
      this.markDirty();
      this.emitBuild();
      if (this.doc.features.some(readsBodyVisibility)) this.scheduleRebuild(true);
    };
    shown();
    this.pushOverlayUndo({
      undo: () => {
        isolateAfter = this.isolate;
        this.isolate = wasIsolate;
        for (const [id, was] of prior) {
          if (was === undefined) this.bodyVis.delete(id);
          else this.bodyVis.set(id, was);
        }
        shown();
      },
      redo: () => {
        this.isolate = isolateAfter;
        for (const [id] of prior) this.bodyVis.set(id, vis.get(id)!);
        shown();
      },
    });
  }

  // Captured into new boolean features so later eye toggles cannot rewrite what a cut touched.
  hiddenBodyIds(): string[] {
    return [...this.bodyVis.entries()].filter(([, v]) => v === false).map(([k]) => k);
  }

  // Marked as an isolate so isolateActive reflects it; a plain hide never sets it.
  isolateBodies(keepIds: Iterable<string>) {
    const keep = new Set(keepIds);
    const all = this.build.result?.bodies ?? [];
    this.setBodiesVisibility(new Map(all.map((b) => [b.id, keep.has(b.id)])));
    this.isolate = true;
    this.emitBuild();
  }

  get isolateActive(): boolean {
    return this.isolate;
  }

  // The caller re-syncs the plane quads.
  isPlaneVisible(id: string): boolean {
    return this.planeVis.get(id) ?? true;
  }
  setPlaneVisibility(id: string, visible: boolean) {
    const was = this.planeVis.get(id);
    this.planeVis.set(id, visible);
    this.markDirty();
    if (was === visible) return;
    this.pushOverlayUndo({
      undo: () => {
        if (was === undefined) this.planeVis.delete(id);
        else this.planeVis.set(id, was);
        this.markDirty();
      },
      redo: () => {
        this.planeVis.set(id, visible);
        this.markDirty();
      },
    });
  }

  // Undefined means use the rebuilt name.
  bodyName(id: string): string | undefined {
    return this.bodyNames.get(id);
  }
  // Display only, blank clears it. Re-emits the build so the tree updates without a geometry rebuild.
  setBodyName(id: string, name: string) {
    this.writeOverlayBatch(this.bodyNames, [id], name.trim() || null);
  }
  // Palette slot, material, folder, visibility, name override and the per face materials of the faces each piece took
  // (`faces` runs over the source's face list). One undo step, so a body later reusing a piece's id finds no stale look.
  inheritBodyLook(
    from: string,
    pieces: { id: string; name?: string | undefined; faces?: { from: number; count: number } | undefined }[],
  ) {
    const was = new Map<Overlay<any>, Map<string, unknown>>();
    const write = (overlay: Overlay<any>, key: string, value: unknown) => {
      let seen = was.get(overlay);
      if (!seen) was.set(overlay, (seen = new Map()));
      if (!seen.has(key)) seen.set(key, overlay.get(key));
      if (value === undefined) overlay.delete(key);
      else overlay.set(key, value);
    };
    // The engine's runs number the source's faces as they were before the Separate.
    const before = this.faceMaterial.before();
    const prints = before?.bodies.get(from)?.prints;
    const faces = new Map<number, FaceRef>();
    for (const [id, ref] of [...this.faceMaterial.entries()]) {
      if (ref.body !== from) continue;
      const was = before?.refs.get(id);
      const on = !before ? [ref.face] : was?.ref === ref ? was.faces : [];
      if (!on.length) continue;
      for (const f of on) faces.set(f, ref);
      if (pieces.some((p) => p.faces)) write(this.faceMaterial, id, undefined);
    }
    for (const piece of pieces) {
      if (piece.id !== from) {
        write(this.bodyColors, piece.id, this.bodyColors.get(from));
        write(this.bodyMaterial, piece.id, this.bodyMaterial.get(from));
        write(this.bodyElement, piece.id, this.bodyElement.get(from));
        write(this.bodyVis, piece.id, this.bodyVis.get(from));
        const named = piece.name && this.bodyNames.get(from) !== undefined;
        if (named) write(this.bodyNames, piece.id, piece.name);
      }
      const { faces: run } = piece;
      if (!run) continue;
      for (let i = 0; i < run.count; i++) {
        const ref = faces.get(run.from + i);
        if (!ref) continue;
        const at = prints?.[run.from + i] ?? ref.at;
        write(this.faceMaterial, newFaceRefId(), {
          body: piece.id,
          face: i,
          material: ref.material,
          ...(at ? { at: { ...at, faces: run.count } } : {}),
        });
      }
    }
    const changed = [...was].flatMap(([overlay, keys]) =>
      [...keys]
        .filter(([key, prior]) => overlay.get(key) !== prior)
        .map(([key, prior]) => ({ overlay, key, prior, value: overlay.get(key) })),
    );
    if (!changed.length) return;
    const apply = (pick: (c: (typeof changed)[number]) => unknown) => {
      for (const c of changed) {
        const value = pick(c);
        if (value === undefined) c.overlay.delete(c.key);
        else c.overlay.set(c.key, value);
      }
      this.markDirty();
      this.emitBuild();
    };
    this.markDirty();
    this.emitBuild();
    this.pushOverlayUndo({ undo: () => apply((c) => c.prior), redo: () => apply((c) => c.value) });
  }
  // The stress study is saved but off the undo stack: the panel writes on every keystroke, which would bury model edits.

  get stressStudy(): Readonly<StressStudy> | null {
    return this.stress;
  }

  // Marks the document changed only when it did change; null drops it.
  setStressStudy(study: StressStudy | null) {
    const next = study ? structuredClone(study) : null;
    if (JSON.stringify(next) === JSON.stringify(this.stress)) return;
    this.stress = next;
    this.markDirty();
  }

  get documentEnvironment(): Readonly<DocEnvironment> | null {
    return this.environment;
  }

  // Off the undo stack. `quiet` carries it without making the document unsaved.
  setDocumentEnvironment(env: DocEnvironment | null, opts: { quiet?: boolean } = {}) {
    if (sameDocEnvironment(env, this.environment)) return;
    this.environment = env ? { ...env, settings: { ...env.settings } } : null;
    if (!opts.quiet) this.markDirty();
  }

  get sectionView(): Readonly<SectionView> | null {
    return this.cut;
  }

  // Off the undo stack. Fields this version does not read stay on the cut until it is turned off.
  setSectionView(view: SectionView | null) {
    const read = view ? readSectionView({ ...sectionViewExtras(this.cut), ...view }) : null;
    if (view && !read) return;
    if (sameSectionView(read, this.cut)) return;
    this.cut = read;
    if (read) delete this.unreadSections.sectionView;
    this.markDirty();
    this.emitSectionView();
  }

  // Called now, on every change, and at the end of every open and New.
  onSectionViewChange(fn: (v: Readonly<SectionView> | null) => void): () => void {
    this.cutListeners.add(fn);
    fn(this.cut);
    return () => {
      this.cutListeners.delete(fn);
    };
  }

  private emitSectionView() {
    for (const fn of [...this.cutListeners]) fn(this.cut);
  }

  // Elements are display only and off the undo stack.

  get bodyElements(): readonly ElementDef[] {
    return this.elements;
  }

  bodyElementOf(id: string): string | undefined {
    return this.bodyElement.get(id);
  }

  bodyElementMap(): ReadonlyMap<string, string> {
    return new Map(this.bodyElement.entries());
  }

  private nextElementId(): string {
    const ids = new Set(this.elements.map((e) => e.id));
    let n = ids.size + 1;
    while (ids.has(`e${n}`)) n++;
    return `e${n}`;
  }

  // A `parent` naming a missing element falls back to the top level, so a stale menu does not fail into nothing.
  addElement(name?: string, parent: string | null = null): string {
    const under = parent !== null && this.elements.some((e) => e.id === parent) ? parent : null;
    const id = this.nextElementId();
    const label = (name ?? "").trim() || freshElementName(this.elements, under);
    const next: ElementDef = { id, name: label };
    if (under !== null) next.parent = under;
    this.elements = [...this.elements, next];
    this.markDirty();
    this.emitBuild();
    return id;
  }

  // Blank is ignored: a folder with no name is a row the user cannot aim at again.
  renameElement(id: string, name: string) {
    const n = name.trim();
    if (!n) return;
    this.elements = this.elements.map((e) => (e.id === id ? { ...e, name: n } : e));
    this.markDirty();
    this.emitBuild();
  }

  // A move that would bury a folder inside itself is dropped (elements.wouldCycle).
  setElementParent(id: string, parent: string | null) {
    const cur = this.elements.find((e) => e.id === id);
    if (!cur || (cur.parent ?? null) === parent) return;
    const next = reparented(this.elements, id, parent);
    // `reparented` returns untouched entries by identity and refuses an illegal move by returning them all.
    if (next.every((e, i) => e === this.elements[i])) return;
    this.elements = next;
    this.markDirty();
    this.emitBuild();
  }

  // Lifts its bodies and sub-elements into its parent; no body is ever removed (elements.withElementRemoved).
  removeElement(id: string) {
    const { elements, movedTo } = withElementRemoved(this.elements, id);
    if (elements.length === this.elements.length) return;
    this.elements = elements;
    for (const [body, held] of [...this.bodyElement.entries()]) {
      if (held !== id) continue;
      if (movedTo === null) this.bodyElement.delete(body);
      else this.bodyElement.set(body, movedTo);
    }
    this.markDirty();
    this.emitBuild();
  }

  // Nearest first. The Browser opens these so a row about to be renamed is on screen.
  elementAncestry(id: string): string[] {
    return ancestryOf(this.elements, id);
  }

  elementSubtree(id: string): Set<string> {
    return descendantsOf(this.elements, id);
  }

  // One emit.
  setBodiesElement(bodyIds: Iterable<string>, element: string | null) {
    const target = element !== null && this.elements.some((e) => e.id === element) ? element : null;
    let changed = false;
    for (const id of bodyIds) {
      if ((this.bodyElement.get(id) ?? null) === target) continue;
      if (target === null) this.bodyElement.delete(id);
      else this.bodyElement.set(id, target);
      changed = true;
    }
    if (!changed) return;
    this.markDirty();
    this.emitBuild();
  }

  referenceImages(): readonly Record<string, unknown>[] {
    return this.refImages;
  }

  // Called now and on every change, an open, an undo.
  onReferenceImagesChange(fn: (list: readonly Record<string, unknown>[]) => void): () => void {
    this.refImageListeners.add(fn);
    fn(this.refImages);
    return () => this.refImageListeners.delete(fn);
  }

  // One undo step; consecutive calls with the same `coalesce` key share it, so a slider drag undoes in one go.
  setReferenceImages(next: readonly Record<string, unknown>[], opts: { coalesce?: string } = {}) {
    const after = readReferenceImages(next);
    if (JSON.stringify(after) === JSON.stringify(this.refImages)) return;
    const c = this.refCoalesce;
    if (opts.coalesce && c && c.key === opts.coalesce && this.undoStack[this.undoStack.length - 1] === c.top) {
      c.after.v = after;
      this.redoStack = [];
    } else {
      const before = this.refImages;
      const box = { v: after };
      this.pushOverlayUndo({
        undo: () => {
          this.refCoalesce = null;
          this.setRefImagesQuiet(before);
          this.markDirty();
        },
        redo: () => {
          this.refCoalesce = null;
          this.setRefImagesQuiet(box.v);
          this.markDirty();
        },
      });
      const top = this.undoStack[this.undoStack.length - 1];
      this.refCoalesce = opts.coalesce ? { key: opts.coalesce, top, after: box } : null;
    }
    this.setRefImagesQuiet(after);
    this.markDirty();
  }

  private setRefImagesQuiet(list: Record<string, unknown>[]) {
    if (!list.length && !this.refImages.length) return;
    this.refImages = list;
    for (const fn of this.refImageListeners) fn(list);
  }

  // The material library is off the undo stack; assigning to a body or face is on it, through writeOverlayBatch.

  get materialLibrary(): readonly MaterialDef[] {
    return this.materials;
  }

  // Resolved: an assignment naming a deleted material is the same as none.
  bodyMaterialOf(id: string): MaterialDef | undefined {
    const held = this.bodyMaterial.get(id);
    return held ? this.materials.find((m) => m.id === held) : undefined;
  }

  // The raw assignment, for a menu that greys out the current row.
  bodyMaterialId(id: string): string | undefined {
    return this.bodyMaterial.get(id);
  }

  // Under contributed paint: a filament slot is a deliberate print choice.
  materialPaint(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [body, id] of this.bodyMaterial.entries()) {
      const m = this.materials.find((x) => x.id === id);
      if (m) out[body] = m.color;
    }
    return out;
  }

  // Only bodies whose finish differs from the default.
  materialFinishes(): Record<string, BodyFinish> {
    const out: Record<string, BodyFinish> = {};
    for (const [body, id] of this.bodyMaterial.entries()) {
      const m = this.materials.find((x) => x.id === id);
      if (!m) continue;
      const f = finishOf(m);
      if (!isDefaultFinish(f)) out[body] = f;
    }
    return out;
  }

  faceMaterialId(bodyId: string, localFace: number): string | undefined {
    const id = this.faceMaterial.owners().get(faceKey(bodyId, localFace));
    return id === undefined ? undefined : this.faceMaterial.get(id)?.material;
  }

  // `bodyId#face` to material id for every face of the build on screen that wears one.
  faceMaterialEntries(): [string, string][] {
    return [...this.faceMaterial.owners()].map(([key, id]) => [key, this.faceMaterial.get(id)!.material]);
  }

  // Decides whether "Clear face materials" is worth offering.
  faceMaterialCount(bodyId: string): number {
    let n = 0;
    for (const [, ref] of this.faceMaterial.entries()) if (ref.body === bodyId) n++;
    return n;
  }

  // Kept to come back when the build on screen regains the face.
  hiddenFaceMaterials(): string[] {
    return this.faceMaterial.hidden();
  }

  // Batched with one emit, like setBodiesMaterial: a drop can land on a run of faces.
  setFacesMaterial(faces: Iterable<{ body: string; face: number }>, material: string | null) {
    const target = material !== null && this.materials.some((m) => m.id === material) ? material : null;
    const overlay = this.faceMaterial;
    const owners = new Map(overlay.owners());
    const on = overlay.resolution();
    const result = this.build.result;
    const fresh = (body: string, face: number, m: string): FaceRef => {
      const span = result?.bodies?.find((b) => b.id === body);
      const at = result && span ? bodyPrints(result, span)[face] : undefined;
      return at ? { body, face, material: m, at } : { body, face, material: m };
    };
    const writes = new Map<string, FaceRef | null>();
    const now = (id: string) => (writes.has(id) ? writes.get(id) : overlay.get(id));
    for (const { body, face } of faces) {
      const key = faceKey(body, face);
      let id = owners.get(key);
      let ref = id === undefined ? undefined : now(id);
      // A ref a split left on several faces becomes one ref per face first.
      const parts = id !== undefined && on ? (on.faces.get(id) ?? []) : [];
      if (id !== undefined && ref && parts.length > 1) {
        writes.set(id, null);
        for (const f of parts) {
          const part = newFaceRefId();
          writes.set(part, fresh(body, f, ref.material));
          owners.set(faceKey(body, f), part);
        }
        id = owners.get(key)!;
        ref = now(id)!;
      }
      if (id !== undefined && ref) {
        if (ref.material !== target) writes.set(id, target === null ? null : { ...ref, ...fresh(body, face, target) });
      } else if (target !== null) {
        const added = newFaceRefId();
        writes.set(added, fresh(body, face, target));
        owners.set(key, added);
      }
    }
    this.writeOverlayMap(overlay, writes);
  }

  clearFaceMaterials(bodyIds: Iterable<string>) {
    const want = new Set(bodyIds);
    const ids = [...this.faceMaterial.entries()].filter(([, ref]) => want.has(ref.body)).map(([id]) => id);
    this.writeOverlayBatch(this.faceMaterial, ids, null);
  }

  addMaterial(m?: Partial<MaterialDef>): string {
    const taken = new Set(this.materials.map((x) => x.id));
    const name = (m?.name ?? "").trim() || freshMaterialName(this.materials);
    const next: MaterialDef = normalizeMaterial({ ...m, name, color: m?.color ?? "#9aa7b4" }) ?? {
      id: slugId(name),
      name,
      color: "#9aa7b4",
    };
    next.id = uniqueId(m?.id && !taken.has(m.id) ? m.id : slugId(name), taken);
    this.materials = [...this.materials, next];
    this.markDirty();
    this.emitBuild();
    return next.id;
  }

  // A plain copy under a fresh id and name, one undo step. Null when it does not normalise to a material.
  addMaterialPreset(raw: unknown): string | null {
    const m = normalizeMaterial(raw);
    if (!m) return null;
    const taken = new Set(this.materials.map((x) => x.id));
    const base = m.name.trim() ? m.name : "Material";
    m.name = freshMaterialName(this.materials, base);
    m.id = uniqueId(slugId(m.name), taken);
    const entry = m;
    const emit = () => {
      this.markDirty();
      this.emitBuild();
    };
    this.materials = [...this.materials, entry];
    emit();
    this.pushOverlayUndo({
      undo: () => {
        this.materials = this.materials.filter((x) => x.id !== entry.id);
        this.dropMaterialUses(new Set([entry.id]));
        emit();
      },
      redo: () => {
        if (!this.materials.some((x) => x.id === entry.id)) this.materials = [...this.materials, entry];
        emit();
      },
    });
    return m.id;
  }

  // Every body wearing it repaints: the colour is edited once, not per body.
  updateMaterial(id: string, patch: Partial<Omit<MaterialDef, "id">>) {
    let changed = false;
    this.materials = this.materials.map((m) => {
      if (m.id !== id) return m;
      const merged = normalizeMaterial({ ...m, ...patch });
      if (!merged) return m;
      merged.id = m.id;
      changed = true;
      return merged;
    });
    if (!changed) return;
    this.markDirty();
    this.emitBuild();
  }

  // Bodies wearing it go back to the default grey; nothing else about them changes.
  removeMaterial(id: string) {
    this.removeMaterials([id]);
  }

  // One change, so the model repaints once.
  removeMaterials(ids: Iterable<string>) {
    const gone = new Set(ids);
    if (!this.materials.some((m) => gone.has(m.id))) return;
    this.materials = this.materials.filter((m) => !gone.has(m.id));
    this.dropMaterialUses(gone);
    this.markDirty();
    this.emitBuild();
  }

  // Keeps them in the library.
  unassignMaterials(ids: Iterable<string>) {
    if (!this.dropMaterialUses(new Set(ids))) return;
    this.markDirty();
    this.emitBuild();
  }

  private dropMaterialUses(ids: ReadonlySet<string>): boolean {
    let changed = false;
    for (const [body, held] of [...this.bodyMaterial.entries()]) {
      if (ids.has(held)) {
        this.bodyMaterial.delete(body);
        changed = true;
      }
    }
    for (const [id, ref] of [...this.faceMaterial.entries()]) {
      if (ids.has(ref.material)) {
        this.faceMaterial.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  // By id; replacing would unassign bodies wearing missing materials.
  importMaterials(incoming: readonly MaterialDef[]): { added: number; updated: number } {
    let added = 0;
    let updated = 0;
    const next = [...this.materials];
    for (const m of incoming) {
      const at = next.findIndex((x) => x.id === m.id);
      if (at >= 0) {
        next[at] = { ...m };
        updated++;
      } else {
        next.push({ ...m });
        added++;
      }
    }
    if (!added && !updated) return { added, updated };
    this.materials = next;
    this.markDirty();
    this.emitBuild();
    return { added, updated };
  }

  // Batched with one emit, like setBodiesElement: it is applied to a selection.
  setBodiesMaterial(bodyIds: Iterable<string>, material: string | null) {
    const target = material !== null && this.materials.some((m) => m.id === material) ? material : null;
    this.writeOverlayBatch(this.bodyMaterial, bodyIds, target);
  }

  // Where the file gave both. Display only and off the undo stack, unlike the material assignments it steers.
  importColorSource(featureId: string): ImportColorSource {
    return this.importColors.get(featureId) === "faces" ? "faces" : "bodies";
  }

  setImportColorSource(featureId: string, source: ImportColorSource) {
    if (this.importColorSource(featureId) === source) return;
    if (source === "faces") this.importColors.set(featureId, "faces");
    else this.importColors.delete(featureId);
    this.markDirty();
    this.emitBuild();
  }

  // Decides whether the library is written to the file at all.
  private materialsAreDefault(): boolean {
    return JSON.stringify(this.materials) === JSON.stringify(STARTER_LIBRARY);
  }

  // Appends a removeBody feature at the end of the timeline, so it acts on the final body list.
  removeBody(bodyId: string) {
    const feat: Feature = { id: this.nextId(), type: "removeBody", bodies: [bodyId] };
    this.addFeature(feat, this.doc.features.length);
  }

  // Offset in X so the copy is not hidden inside the original.
  duplicateBody(bodyId: string) {
    const feat: Feature = {
      id: this.nextId(),
      type: "duplicate",
      dx: 20,
      dy: 0,
      dz: 0,
      rx: 0,
      ry: 0,
      rz: 0,
      bodies: [bodyId],
    };
    this.addFeature(feat, this.doc.features.length);
  }

  // The filament palette and per-body slots are display and export metadata.
  get colorPalette(): { name: string; color: string; material?: string }[] {
    return this.palette;
  }
  // Lets a sync skip its "overwrite?" confirmation when there is nothing to lose.
  paletteIsDefault(): boolean {
    return (
      this.palette.length === DEFAULT_PALETTE.length &&
      this.palette.every((s, i) => {
        const d = DEFAULT_PALETTE[i];
        return d !== undefined && s.name === d.name && s.color === d.color && !s.material;
      })
    );
  }
  // Re-emits for a live repaint.
  setPaletteSlot(i: number, patch: { name?: string; color?: string; material?: string }) {
    if (i < 0 || i >= this.palette.length) return;
    const cur = this.palette[i];
    if (!cur) return;
    this.palette[i] = { ...cur, ...patch };
    this.markDirty();
    this.emitBuild();
  }
  // One emit. Undefined entries leave that slot untouched.
  replacePaletteSlots(slots: ({ name: string; color: string; material?: string } | undefined)[]) {
    let changed = false;
    slots.forEach((s, i) => {
      if (!s || i >= this.palette.length) return;
      this.palette[i] = { ...this.palette[i], ...s };
      changed = true;
    });
    if (!changed) return;
    this.markDirty();
    this.emitBuild();
  }
  // Undefined means the default shade.
  bodyColorSlot(id: string): number | undefined {
    return this.bodyColors.get(id);
  }
  setBodyColorSlot(id: string, slot: number | null) {
    this.writeOverlayBatch(this.bodyColors, [id], slot);
  }
  // For the colored-3MF export, which must thread these side maps explicitly: they never travel inside `document`.
  bodyColorsMap(): Record<string, number> {
    return Object.fromEntries(this.bodyColors.entries());
  }
  // Threaded through the export so exported objects carry the sidebar names.
  bodyNamesMap(): Record<string, string> {
    return Object.fromEntries(this.bodyNames.entries());
  }

  // Everything toJSON() writes, as an object, so autosave stringifies once.
  toObject(withVersions = true): CadDocument {
    // Store-held session state (suppress set, rollback, visibility) is saved too, empty state omitted. A known key
    // always wins over a carried one of the same name.
    const out: CadDocument = { ...structuredClone(this.unknownKeys), ...this.doc, version: FORMAT_VERSION };
    if (this.suppressed.size) out.suppressed = [...this.suppressed];
    if (this.rollback !== null) out.rollback = this.rollback;
    for (const { overlay } of this.overlays) overlay.writeJSON(out as unknown as Record<string, unknown>);
    // Omitted when empty, so a never-organised document is byte-identical to one saved before elements existed.
    if (this.elements.length) out.elements = this.elements.map((e) => ({ ...e }));
    // Written when changed or worn by any body, omitted while it is the untouched starter set.
    if (this.bodyMaterial.size || this.faceMaterial.size || !this.materialsAreDefault()) {
      out.materials = this.materials.map((m) => ({ ...m }));
    }
    if (this.refImages.length) out.referenceImages = structuredClone(this.refImages);
    // A synced or customised palette is project state even with zero assignments.
    if (this.bodyColors.size || !this.paletteIsDefault()) out.palette = this.palette;
    const unread = this.unreadSections;
    const raw = out as unknown as Record<string, unknown>;
    if (this.stress) out.stress = structuredClone(this.stress);
    else if (unread.stress !== undefined) raw["stress"] = structuredClone(unread.stress);
    if (this.environment) out.environment = { ...this.environment, settings: { ...this.environment.settings } };
    else if (unread.environment !== undefined) raw["environment"] = structuredClone(unread.environment);
    if (this.cut) out.sectionView = structuredClone(this.cut);
    else if (unread.sectionView !== undefined) raw["sectionView"] = structuredClone(unread.sectionView);
    if (withVersions && this.repo) out.versions = this.repo;
    else if (withVersions && unread.versions !== undefined) raw["versions"] = structuredClone(unread.versions);
    return out;
  }

  get versionRepo(): Readonly<VersionRepo> | null {
    return this.repo;
  }

  // A section cut is a view, not part of the model.
  workingSnapshot(): Snapshot {
    const { sectionView: _, ...doc } = this.toObject(false);
    return JSON.parse(JSON.stringify(doc)) as Snapshot;
  }

  // Versions this build cannot read, replaced by the first version saved here.
  hasUnreadVersions(): boolean {
    return this.unreadSections.versions != null && !this.repo;
  }

  // Null when nothing changed since the branch's newest version.
  saveVersion(message: string): Version | null {
    const repo = this.repo ?? emptyRepo();
    const v = commitVersion(repo, this.workingSnapshot(), message, Date.now());
    if (!v) return null;
    this.repo = repo;
    this.markDirty();
    this.emitMeta();
    return v;
  }

  // Null with no versions.
  changesSinceVersion(): VersionDiff | null {
    const repo = this.repo;
    const head = repo ? headOf(repo) : undefined;
    if (!repo || !head) return null;
    const working = this.workingSnapshot();
    const diff = diffAgainstWorking(repo, head.id, working);
    if (diff.settings && restText(restOf(repo, head)) === restText(working)) diff.settings = false;
    return diff;
  }

  // Undoable like any replacement of the document; the versions are untouched.
  restoreVersion(id: string) {
    const repo = this.repo;
    if (!repo) return;
    this.loadAs(JSON.stringify(versionSnapshot(repo, id)), "version");
    this.emitMeta();
  }

  branchFromVersion(id: string, name: string): string {
    if (!this.repo) throw new Error("save a version first");
    const clean = createVersionBranch(this.repo, name, id);
    this.switchVersionBranch(clean);
    return clean;
  }

  // Brings back its newest version.
  switchVersionBranch(name: string) {
    const repo = this.repo;
    if (!repo) return;
    const was = repo.current;
    const head = switchVersionBranch(repo, name);
    const onto = (branch: string) => {
      if (!repo.branches[branch]) return;
      repo.current = branch;
      this.emitMeta();
    };
    this.undoAsOne(() => {
      this.restoreVersion(head.id);
      this.pushOverlayUndo({ undo: () => onto(was), redo: () => onto(name) });
    });
  }
  toJSON(): string {
    return JSON.stringify(this.toObject(), null, 2);
  }
  // `replace` puts another state of the same document in place (a version, an assistant's or a plugin's edit), as one
  // undoable step that leaves the versions alone.
  load(json: string, opts: { replace?: boolean } = {}) {
    this.loadAs(json, opts.replace ? "edit" : "open");
  }
  // A version is always the open document, even one sharing no feature with what is on screen.
  private loadAs(json: string, as: "open" | "edit" | "version") {
    const replace = as !== "open";
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (e) {
      throw new UnreadableDocumentError(
        "its contents are garbled or cut short",
        `could not read document: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const problem = documentShapeProblem(raw);
    if (problem) throw new UnreadableDocumentError(problem.reason, problem.detail);
    const parsed = raw as CadDocument;
    for (const w of migrateDocument(parsed)) this.onWarning?.(w);
    if (!replace) this.emitOpen();
    this.emitRewind();
    const replaced = replace ? { entry: this.pushUndo(), before: this.stateSections(true) } : null;
    if (!replaced) this.undoStack = [];
    this.redoStack = [];
    this.rearmProjectionValve(); // valve state must never cross documents
    // The versions are the open file's history, which a replacing load's copy may lack or hold stale or foreign.
    if (!replace) {
      this.repo = normalizeRepo(parsed.versions);
      this.unreadSections = parsed.versions != null && !this.repo ? { versions: structuredClone(parsed.versions) } : {};
    }
    this.openedVersion = typeof parsed.version === "number" ? parsed.version : 1;
    // A replacing load sharing no feature is a different document, and must not inherit .fundab sections.
    const sameDoc = as === "version" || (as === "edit" && sharesAFeature(this.doc.features, parsed.features ?? []));
    if (!sameDoc) this.carriedSections = [];
    this.readProjectState(parsed);
    // The cut is the user's view: a replacing load keeps it, unless that is another document.
    if (!replace || !sameDoc) {
      delete this.unreadSections.sectionView;
      this.cut = replace ? null : readSectionView(parsed.sectionView);
      if (!replace && parsed.sectionView != null && !this.cut)
        this.unreadSections.sectionView = structuredClone(parsed.sectionView);
    }
    this.doc = {
      parameters: parsed.parameters ?? {},
      ...(parsed.paramDefs ? { paramDefs: parsed.paramDefs } : {}),
      ...(parsed.paramExtras ? { paramExtras: parsed.paramExtras } : {}),
      features: parsed.features ?? [],
      ...readViewOverrides(parsed.viewOverrides),
      ...(isIdMap(parsed.bodyIds) ? { bodyIds: parsed.bodyIds } : {}),
    };
    // An extrude without hiddenBodies reads the live eye states, so stamp "nothing hidden", as every saved file built.
    for (const f of this.doc.features) {
      if (f.type === "extrude" && !("hiddenBodies" in f)) {
        (f as { hiddenBodies?: string[] }).hiddenBodies = [];
      }
    }
    canonicalMirrorPlanes(this.doc);
    // Before the sections are read, or the old build would seed the new face materials' track.
    this.discardModelForReplacement();
    if (replaced) replaced.entry.state = stateSwap(replaced.before, this.stateSections());
    this.markDirty(); // openDocument clears this via markSaved() once the path is known
    if (!replace) this.dropToolPreview();
    this.emitDoc();
    this.emitSectionView();
    this.scheduleRebuild(true);
  }
  // Kept out of `this.doc` so undo and rebuild are unaffected. `only` reads just those top level keys.
  private readProjectState(parsed: CadDocument, only?: ReadonlySet<string>) {
    const reads = (key: string) => !only || only.has(key);
    const raw = parsed as unknown as Record<string, unknown>;
    if (reads("suppressed")) {
      this.suppressed = new Set(
        Array.isArray(parsed.suppressed) ? parsed.suppressed.filter((id) => typeof id === "string") : [],
      );
    }
    if (reads("rollback")) this.rollback = isCount(parsed.rollback) ? parsed.rollback : null;
    for (const { overlay } of this.overlays) if (reads(overlay.jsonKey)) overlay.loadFrom(raw);
    if (reads("bodyVisibility")) this.isolate = false; // the hidden set just came from the file, it is not an isolate
    if (reads("palette")) {
      this.palette = readPalette(parsed.palette);
    }
    if (reads("stress")) {
      this.stress = normalizeStressStudy(parsed.stress);
      delete this.unreadSections.stress;
      if (parsed.stress != null && !this.stress) this.unreadSections.stress = structuredClone(parsed.stress);
    }
    if (reads("environment")) {
      this.environment = normalizeDocEnvironment(parsed.environment);
      delete this.unreadSections.environment;
      if (parsed.environment != null && !this.environment)
        this.unreadSections.environment = structuredClone(parsed.environment);
    }
    const carried = carriedKeys(raw, KNOWN_DOC_KEYS);
    this.unknownKeys = only
      ? { ...Object.fromEntries(Object.entries(this.unknownKeys).filter(([k]) => !only.has(k))), ...carried }
      : carried;
    if (reads("referenceImages")) this.setRefImagesQuiet(readReferenceImages(parsed.referenceImages));
    // Elements without an id and materials without a colour are dropped here, not at every reader.
    if (reads("materials")) {
      const rows = Array.isArray(parsed.materials)
        ? parsed.materials.map((m, i) => normalizeMaterial(m, i)).filter((m): m is MaterialDef => m !== null)
        : [];
      this.materials = rows.length ? rows : STARTER_LIBRARY.map((m) => ({ ...m }));
    }
    if (reads("elements")) {
      this.elements = (parsed.elements ?? [])
        .filter((e) => e && typeof e.id === "string" && e.id)
        .map((e) => ({
          ...carriedKeys(e as unknown as Record<string, unknown>, ELEMENT_KEYS),
          id: e.id,
          name: typeof e.name === "string" && e.name.trim() ? e.name : e.id,
          ...(typeof e.parent === "string" && e.parent ? { parent: e.parent } : {}),
        }));
    }
  }
  // JSON per top level key, without the undo entry's geometry, face materials by id. Isolate is not saved, so it rides
  // with the hidden set it explains.
  private stateSections(located = false): Map<string, string> {
    const out = this.toObject(false) as unknown as Record<string, unknown>;
    for (const k of GEOMETRY_KEYS) delete out[k];
    // In id order, since undo of a cleared id sets it back at the end of its map.
    for (const {
      overlay: { jsonKey: k },
    } of this.overlays) {
      const map = out[k] as Record<string, unknown> | undefined;
      if (map) out[k] = Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    // Their undo steps go by id, and the faces they are on move with every rebuild.
    delete out["facePrints"];
    delete out["sectionView"];
    if (this.faceMaterial.size)
      out["faceMaterials"] = located ? this.faceMaterial.located() : this.faceMaterial.stored();
    out["bodyVisibility"] = [out["bodyVisibility"] ?? null, this.isolate];
    return new Map([
      ...Object.entries(out).map(([k, v]) => [k, JSON.stringify(v)] as const),
      ...this.timelineSections(),
    ]);
  }
  // Sorted, since toggling a step off and back moves it to the end.
  private timelineSections(): Map<string, string> {
    const out = new Map<string, string>();
    if (this.suppressed.size) out.set("suppressed", JSON.stringify([...this.suppressed].sort()));
    if (this.rollback !== null) out.set("rollback", JSON.stringify(this.rollback));
    return out;
  }
  // Puts back each key the user has not changed since, returning the swap that reverses it.
  private swapState(swap: StateSwap): StateSwap {
    const now = [...swap.keys()].every((k) => TIMELINE_KEYS.has(k)) ? this.timelineSections() : this.stateSections();
    const back: StateSwap = new Map();
    const put: Record<string, unknown> = {};
    for (const [k, { put: json, expect }] of swap) {
      const current = now.get(k);
      if (fingerprint(current) !== expect) continue;
      back.set(k, { put: current, expect: fingerprint(json) });
      if (json !== undefined) put[k] = JSON.parse(json);
    }
    const vis = put["bodyVisibility"] as [Record<string, boolean> | null, boolean] | undefined;
    if (vis) put["bodyVisibility"] = vis[0] ?? undefined;
    const only = new Set(back.keys());
    if (only.delete("faceMaterials")) this.faceMaterial.restore((put["faceMaterials"] ?? []) as [string, FaceRef][]);
    delete put["faceMaterials"];
    this.readProjectState(put as unknown as CadDocument, only);
    if (vis) this.isolate = vis[1];
    return back;
  }
  loadDocument(doc: CadDocument, opts: { replace?: boolean } = {}) {
    this.load(JSON.stringify(doc), opts);
  }

  private scheduleRebuild(immediate: boolean) {
    if (this.rebuildTimer != null) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    const run = () => {
      this.rebuildTimer = null;
      void this.rebuildNow();
    };
    if (immediate) run();
    else this.rebuildTimer = window.setTimeout(run, 120);
  }

  // For an analysis whose answer names that model's faces.
  builtDocument(): CadDocument {
    return this.effectiveDoc();
  }

  // Features up to the rollback marker, minus suppressed ones. The full document is what is saved.
  private effectiveDoc(opts?: { withoutPreview?: boolean }): CadDocument {
    let features = prefixFeatures(this.doc.features, this.rollbackIndex, this.suppressed);
    if (this.editPreview) {
      // Roll to the edited feature (never past the rollback marker), then append its live version if there is one.
      const idx = features.findIndex((f) => f.id === this.editPreview!.id);
      const live = this.editPreview.feature;
      if (this.editPreview.inPlace && idx >= 0) {
        if (live) features = features.map((f, i) => (i === idx ? live : f));
      } else {
        if (idx >= 0) features = features.slice(0, idx);
        if (live) features.push(live);
      }
    }
    if (this.preview && !opts?.withoutPreview) features.push(...this.preview);
    features = features.map(withoutDisplayName);
    // Travels with the rebuild: a join, cut or intersect that names no targets leaves hidden bodies alone.
    const bodyVisibility = this.bodyVis.size ? Object.fromEntries(this.bodyVis.entries()) : undefined;
    return {
      parameters: this.doc.parameters,
      features,
      ...(bodyVisibility ? { bodyVisibility } : {}),
      ...(this.doc.bodyIds ? { bodyIds: this.doc.bodyIds } : {}),
    };
  }

  // Against the prefix document (prefixFeatures). [] on transport failure.
  projectGeometry(plane: PlaneSpec, sources: ProjectedSource[], editingId: string | null): Promise<ProjectionResult[]> {
    const doc: CadDocument = {
      parameters: this.doc.parameters,
      features: prefixFeatures(this.doc.features, this.rollbackIndex, this.suppressed, editingId),
      ...(this.doc.bodyIds ? { bodyIds: this.doc.bodyIds } : {}),
    };
    return this.geometry.projectGeometry(doc, plane, sources);
  }

  // Asked of the document as built on screen. Null when the backend cannot answer.
  async faceAxis(face: Selector, body: string | null): Promise<FaceAxisReply | null> {
    return (await this.geometry.faceAxis?.(this.effectiveDoc(), face, body)) ?? null;
  }

  // In textOnFace terms, asked of the document as built without the tool's own preview. Null when the backend cannot
  // answer.
  async faceAnchor(face: Selector, body: string | null, point: Vec3): Promise<FaceAnchorReply | null> {
    return (await this.geometry.faceAnchor?.(this.effectiveDoc({ withoutPreview: true }), face, body, point)) ?? null;
  }

  // Only lines reaching the box of the `reach` points, on the model before any preview or live edit, which is what that
  // feature's own build sees. Null when the backend cannot answer.
  async profileCuts(origin: Vec3, normal: Vec3, reach?: Vec3[]): Promise<Vec3[][] | null> {
    let features = prefixFeatures(this.doc.features, this.rollbackIndex, this.suppressed);
    const edit = this.editPreview;
    if (edit && !edit.inPlace) {
      const idx = features.findIndex((f) => f.id === edit.id);
      if (idx >= 0) features = features.slice(0, idx);
    }
    const doc: CadDocument = {
      parameters: this.doc.parameters,
      features: features.map(withoutDisplayName),
      ...(this.bodyVis.size ? { bodyVisibility: Object.fromEntries(this.bodyVis.entries()) } : {}),
      ...(this.doc.bodyIds ? { bodyIds: this.doc.bodyIds } : {}),
    };
    return (await this.geometry.profileCuts?.(doc, origin, normal, reach)) ?? null;
  }

  async patternAxis(ref: Selector): Promise<PatternAxisReply | null> {
    return (await this.geometry.patternAxis?.(this.effectiveDoc(), ref)) ?? null;
  }

  // Keeps what is on screen but clears every progress field, so a stale fraction cannot linger under the new label.
  private emitBuildStarted() {
    this.buildEpoch++;
    this.build = {
      ...this.build,
      building: true,
      progress: null,
      phase: null,
      meshed: null,
      meshTotal: null,
      streamed: null,
      streamTotal: null,
    };
    this.emitBuild();
  }

  private emitBuildAbort() {
    for (const fn of this.abortListeners) fn(this.buildEpoch);
  }

  // Not an edit, so no undo step and no unsaved star: a document built again without them gets the same ids.
  private keepBodyIds(sent: CadDocument, reply: RebuildReply) {
    if (reply.ok && reply.result.bodyIds && this.doc === sent) this.doc.bodyIds = reply.result.bodyIds;
  }

  private previewSnapshot(): { features: Feature[] | null; hold: boolean } {
    if (!this.preview && !this.editPreview) return { features: null, hold: false };
    const features = [...(this.editPreview?.feature ? [this.editPreview.feature] : []), ...(this.preview ?? [])];
    return { features, hold: this.previewHold };
  }

  // Only when the preview asked to be held.
  private heldRefusalOf(
    reply: RebuildReply,
    sent: { features: Feature[] | null; hold: boolean },
  ): PreviewRefusal | null {
    if (!sent.hold || !sent.features?.length) return null;
    const ids = new Set(sent.features.map((f) => f.id));
    const errs = reply.ok
      ? (reply.result.featureErrors ?? (reply.result.featureError ? [reply.result.featureError] : []))
      : [reply.error];
    const err = errs.find((e) => e.feature_id && ids.has(e.feature_id));
    if (!err?.feature_id) return null;
    return {
      featureId: err.feature_id,
      message: err.message,
      code: "code" in err && typeof err.code === "string" ? err.code : null,
      diagnostics: reply.ok ? (reply.result.diagnostics ?? []).filter((d) => d.feature_id === err.feature_id) : [],
    };
  }

  // A partial build carries its failure inside the result; an outright failure keeps the last mesh.
  private settledBuild(reply: RebuildReply, sent: { features: Feature[] | null; hold: boolean }): RebuildState {
    const done = {
      building: false,
      progress: null,
      phase: null,
      meshed: null,
      meshTotal: null,
      streamed: null,
      streamTotal: null,
      previewBuilt: sent.features,
      cancelled: !reply.ok && !!reply.cancelled,
    };
    const held = this.heldRefusalOf(reply, sent);
    if (held) {
      return {
        ...done,
        result: this.build.result,
        errorFeatureId: held.featureId,
        errorMessage: held.message,
        heldRefusal: held,
      };
    }
    if (!reply.ok) {
      return {
        ...done,
        result: this.build.result,
        errorFeatureId: reply.error.feature_id ?? null,
        errorMessage: reply.error.message,
        heldRefusal: null,
      };
    }
    const fe = reply.result.featureError;
    if (sent.features === null) {
      this.committedFailures = new Set(
        (reply.result.featureErrors ?? []).flatMap((e) => (e.feature_id ? [e.feature_id] : [])),
      );
    }
    return {
      ...done,
      result: reply.result,
      errorFeatureId: fe?.feature_id ?? null,
      errorMessage: fe?.message ?? null,
      heldRefusal: null,
    };
  }

  // A caller arriving mid-rebuild awaits the same finish rather than a promise of its own.
  private rebuildDrain: Promise<void> | null = null;

  // Resolves once the latest document's result is published, even when another rebuild was running (callers need the
  // new body ids).
  async rebuildNow(): Promise<void> {
    if (this.restoreCommitted()) return;
    if (this.rebuilding) {
      this.rebuildQueued = true;
      this.supersede();
      await this.rebuildDrain;
      return;
    }
    this.rebuilding = true;
    const drain = (async () => {
      await this.runBusy(
        "Rebuilding",
        async (onStarted) => {
          try {
            do {
              this.rebuildQueued = false;
              this.emitBuildStarted();
              const startedAt = Date.now();
              const sent = this.doc;
              const previewing = !!(this.preview || this.editPreview);
              const sentPreview = this.previewSnapshot();
              const effective = this.effectiveDoc();
              const key = previewing ? null : buildKey(effective);
              const flight: NonNullable<typeof this.inflight> = { gen: ++this.sendGen, id: null, cancelled: false };
              this.inflight = flight;
              const sentAtMs = performance.now();
              markSent();
              const reply = await this.geometry.rebuild(effective, undefined, (id) => {
                flight.id = id;
                onStarted(id);
              });
              markReceived();
              this.inflight = null;
              if (flight.gen <= this.staleThrough) continue;
              // Superseded and stopped: the newer queued request is what the user waits for. A user Cancel stops the
              // queue too.
              if (!reply.ok && reply.cancelled && flight.byUser) this.rebuildQueued = false;
              if (!reply.ok && reply.cancelled && this.rebuildQueued) continue;
              if (key !== null && this.refusedProvisional(reply, key)) continue;
              if (reply.ok && Date.now() - startedAt >= APPLY_LABEL_AFTER_MS) {
                this.build = {
                  ...this.build,
                  progress: null,
                  meshed: null,
                  meshTotal: null,
                  phase: BUILD_PHASE.applying,
                };
                this.emitBuild();
                await afterPaint();
                if (flight.gen <= this.staleThrough) continue;
              }
              if (!previewing) this.keepBodyIds(sent, reply);
              const settled = this.settledBuild(reply, sentPreview);
              // An incomplete stream left a partial model on screen; drop it before this result (on failure the
              // previous document) renders over it.
              if (this.build.streamed !== null && (!reply.ok || settled.heldRefusal)) this.emitBuildAbort();
              this.build = settled;
              if (key !== null && reply.ok) this.committedShown = { key, state: settled };
              const appliedAtMs = performance.now();
              this.emitBuild();
              if (reply.ok && !previewing) {
                const cost = this.geometry.lastRebuildCost?.();
                logEditTiming({
                  totalMs: performance.now() - sentAtMs,
                  engine: cost?.engine ?? null,
                  replyBytes: cost?.replyBytes ?? 0,
                  applyMs: performance.now() - appliedAtMs,
                });
              }
              // After publishing; a failed rebuild says nothing about projections.
              if (reply.ok) this.maybeQueueProjectionRefresh(reply.result.projectionUpdates);
            } while (this.rebuildQueued);
          } finally {
            // Here, not in the outer finally: runBusy's teardown awaits, and a refresh queued in that window would be dropped.
            this.rebuilding = false;
            this.inflight = null;
          }
        },
        { rebuild: true },
      );
    })();
    this.rebuildDrain = drain;
    try {
      await drain;
    } finally {
      this.rebuilding = false; // belt and braces if runBusy throws before the callback
      this.rebuildDrain = null;
    }
  }

  // Covers a build in flight or one an edit is waiting to start. Unlike rebuildNow it never re-sends the same document.
  async whenBuilt(): Promise<void> {
    if (this.rebuildTimer != null) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
      await this.rebuildNow();
      return;
    }
    for (let d = this.rebuildDrain; d;) {
      await d;
      d = this.rebuildDrain === d ? null : this.rebuildDrain;
    }
  }

  // Works even while an import holds the history. The model built before that step comes back without a rebuild.
  undoIfTop(added: (before: CadDocument) => boolean): boolean {
    const top = this.undoStack.at(-1);
    if (top?.kind !== "doc" || !added(top.doc)) return false;
    this.restoreArmed = true;
    this.undoStep();
    return true;
  }

  // Only where the engine can stop it without a restart: killing the worker for a draft preview would throw away every
  // cached feature before it.
  private supersede() {
    const f = this.inflight;
    if (!f || f.cancelled || !f.id || !this.geometry.softCancel) return;
    f.cancelled = true;
    void this.geometry.cancel?.(f.id, { soft: true });
  }

  // When the document to build is the one it was built from, the state a cancelled tool returns to.
  private restoreCommitted(): boolean {
    if (!this.restoreArmed) return false;
    this.restoreArmed = false;
    const c = this.committedShown;
    if (!c || this.preview || this.editPreview) return false;
    if (buildKey(this.effectiveDoc()) !== c.key) return false;
    if (!this.build.building && this.build.result === c.state.result && !this.inflight) return true;
    this.staleThrough = this.sendGen;
    this.rebuildQueued = false;
    this.supersede();
    if (this.build.streamed !== null) this.emitBuildAbort();
    this.build = { ...c.state };
    this.emitBuild();
    return true;
  }

  // Lets the tool close at once. If the rebuild of this exact document refuses the feature, the commit is undone and
  // `what` is named in the warning: a refused value is never left in the history.
  verifyCommit(featureId: string, what: string) {
    this.provisional = { id: featureId, what, key: buildKey(this.effectiveDoc()) };
  }

  private refusedProvisional(reply: RebuildReply, key: string): boolean {
    const p = this.provisional;
    if (!p) return false;
    this.provisional = null;
    if (p.key !== key || (!reply.ok && reply.cancelled)) return false;
    const errs = reply.ok
      ? (reply.result.featureErrors ?? (reply.result.featureError ? [reply.result.featureError] : []))
      : [reply.error];
    const err = errs.find((e) => e.feature_id === p.id);
    if (!err) return false;
    this.onWarning?.(`${p.what} was refused, nothing changed: ${err.message}`);
    this.restoreArmed = true;
    this.undoStep();
    return true;
  }

  // Past every cache layer, for a suspected stale result.
  async computeAllNow() {
    const ca = this.geometry.computeAll?.bind(this.geometry);
    if (!ca) return this.scheduleRebuild(true);
    if (this.rebuilding) {
      this.rebuildQueued = true;
      return;
    }
    this.rebuilding = true;
    try {
      this.emitBuildStarted();
      const sent = this.doc;
      const previewing = !!(this.preview || this.editPreview);
      const sentPreview = this.previewSnapshot();
      const reply = await ca(this.effectiveDoc());
      if (!previewing) this.keepBodyIds(sent, reply);
      const settled = this.settledBuild(reply, sentPreview);
      if (this.build.streamed !== null && (!reply.ok || settled.heldRefusal)) this.emitBuildAbort();
      this.build = settled;
      this.emitBuild();
      // Compute All is the explicit retry the valve toast promises: re-arm it and route the recomputed projection
      // updates through the normal refresh path.
      if (reply.ok) {
        this.rearmProjectionValve();
        this.maybeQueueProjectionRefresh(reply.result.projectionUpdates);
      }
    } finally {
      this.rebuilding = false;
    }
  }
}
