// Document state: the CadDocument, undo and redo, load and save, and the rebuild
// pipeline that re-runs the tree after every mutation.

import {
  commit as commitVersion,
  createBranch as createVersionBranch,
  diffAgainstWorking,
  emptyRepo,
  headOf,
  normalizeRepo,
  snapshotOf,
  switchBranch as switchVersionBranch,
  type Snapshot,
  type Version,
  type VersionDiff,
  type VersionRepo,
} from "./versions";
import type { CadDocument, Feature, ImportColorSource, ParamControl, ParamExtras, ParamTarget, PlaneSpec, ProjectedSource, ProjectionUpdate, RebuildReply, RebuildResult, ResolveDiag, Selector, ViewCubeSide, ViewOverride } from "../types";
import { asFeature } from "../types";
import { applyProjectionUpdate } from "../types";
import type { FaceAxisReply, GeometryBackend, ProjectionResult } from "../geometry/client";
import { FORMAT_VERSION, migrateDocument } from "./migrate";
import {
  ancestryOf, descendantsOf, type ElementDef, freshElementName, reparented,
  withElementRemoved,
} from "./elements";
import {
  type BodyFinish, FINISH, finishOf, freshMaterialName, type MaterialDef,
  normalizeMaterial, slugId, STARTER_LIBRARY, uniqueId,
} from "./materials";
import { faceKey, parseFaceKey } from "./faceMaterials";
import { forgetStaleJoins, joinSignatures } from "./bodyIds";
import * as params from "../params/engine";
import { extrasEmpty, trialConfiguration } from "../params/extras";
import type { FieldKind } from "./numFields";
import { writeTarget } from "./numFields";

/** An expression typed on a sketch dimension while the sketch was OPEN, the
 *  dim isn't in the document until the sketch commits, so the binding travels
 *  with the commit (addFeature/replaceFeature) and lands in the same mutate. */
export interface SketchBinding {
  target: ParamTarget;
  expr: string;
  kind: FieldKind;
  /** Fusion's on-the-fly `name=expr`: bind under this chosen name instead of dN. */
  name?: string;
}

export interface RebuildState {
  building: boolean;
  result: RebuildResult | null;
  errorFeatureId: string | null;
  errorMessage: string | null;
  // while building: the feature index the engine is currently executing
  // (-1 = tessellating), streamed ~1/s during long rebuilds; null otherwise
  progress: number | null;
  /** During the meshing (payload) phase: bodies meshed so far and the total.
   *  Both null outside it. The feature index is -1 for that whole phase, so
   *  without these the chip has nothing to show a fraction from. */
  meshed: number | null;
  meshTotal: number | null;
  /** Progress through a chunked reply, null outside one. `result` stays the previous
   *  model meanwhile, so nothing but the viewport ever sees a partial body list. */
  streamed: number | null;
  streamTotal: number | null;
  /** The preview features this settled build was sent with, null when it had none.
   *  A reply can land after the tool has moved on, so this is what it answered. */
  previewBuilt?: Feature[] | null;
  /** Set when a held preview (setPreview's `hold`) was refused: `result` is then
   *  still the last model that built, and this carries what the refusal said. */
  heldRefusal?: PreviewRefusal | null;
}

export interface PreviewRefusal {
  featureId: string;
  message: string;
  code: string | null;
  diagnostics: ResolveDiag[];
}

/** One installment of a chunked reply, for the viewport only. Everything else uses onBuild. */
export interface BuildChunk {
  epoch: number;
  phase: "begin" | "bodies";
  /** the IN-PROGRESS result: only the bodies delivered so far hold real data */
  result: RebuildResult;
  manifest: NonNullable<RebuildResult["bodies"]>;
  bodies: NonNullable<RebuildResult["bodies"]>;
  edgesByBody: Map<string, RebuildResult["edges"]>;
  triRange: { triStart: number; triEnd: number };
  bbox: RebuildResult["bbox"];
  done: number;
  total: number;
}

/** A long cancellable operation, kept apart from RebuildState so nothing keyed on
 *  `building` misreads it. `id` is the engine request id a cancel targets. */
export interface BusyState {
  active: boolean;
  label: string;
  id: string | null;
  /** 0-100 phase progress, or null when the backend reports none. Coarse by
   *  necessity: OCCT gives no sub-operation progress, so this advances a few
   *  times and creeps on elapsed time in between. */
  pct: number | null;
}

type DocListener = (doc: CadDocument) => void;
type BuildListener = (state: RebuildState) => void;
type BusyListener = (state: BusyState) => void;
type MetaListener = () => void;

// Safe for `"hiddenBodies" in f` checks: no mutator writes an explicit undefined.
const clone = (d: CadDocument): CadDocument => structuredClone(d);

const isIdMap = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

export const EMPTY_DOCUMENT: CadDocument = { parameters: {}, features: [], bodyIds: {} };

/** What a build of `doc` depends on. Body ids are left out: they are what a
 *  build hands back, recorded into the document after it. */
function buildKey(doc: CadDocument): string {
  const { bodyIds: _ids, ...rest } = doc;
  return JSON.stringify(rest);
}

/** What a sketch may reference: features up to the rollback marker, unsuppressed, and
 *  strictly before the sketch being edited. */
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

/** A persisted display-only id to value map, stored under one CadDocument field. */
class Overlay<T> {
  private map = new Map<string, T>();
  constructor(private readonly jsonKey: string) {}
  get(id: string): T | undefined {
    return this.map.get(id);
  }
  set(id: string, value: T) {
    this.map.set(id, value);
  }
  delete(id: string) {
    this.map.delete(id);
  }
  clear() {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
  entries(): IterableIterator<[string, T]> {
    return this.map.entries();
  }
  /** append this overlay's toJSON branch onto `out`, iff non-empty. */
  writeJSON(out: Record<string, unknown>) {
    if (this.map.size) out[this.jsonKey] = Object.fromEntries(this.map);
  }
  /** rebuild the map from a parsed document's `[jsonKey]` field. */
  loadFrom(parsed: Record<string, unknown>, mapValue?: (v: unknown) => T) {
    const src = (parsed[this.jsonKey] as Record<string, unknown> | undefined) ?? {};
    this.map = new Map(Object.entries(src).map(([k, v]) => [k, mapValue ? mapValue(v) : (v as T)]));
  }
}

/** A history step's name is for people, except on an import, where it names the
 *  bodies. Kept out of the build so renaming a step does not invalidate the
 *  geometry cache for it and everything after it. */
export function withoutDisplayName(f: Feature): Feature {
  if (f.type === "import" || !("name" in f)) return f;
  const { name: _name, ...rest } = f as Feature & { name?: string };
  return rest as Feature;
}

export class DocumentStore {
  private doc: CadDocument;
  private undoStack: CadDocument[] = [];
  private redoStack: CadDocument[] = [];
  private docListeners = new Set<DocListener>();
  private buildListeners = new Set<BuildListener>();
  private busyListeners = new Set<BusyListener>();
  private metaListeners = new Set<MetaListener>();
  private path: string | null = null; // current file path (null = unsaved)
  private isDirty = false; // unsaved changes since last save/open/new
  private rollback: number | null = null; // # of active features (null = all); timeline marker
  private suppressed = new Set<string>(); // feature ids skipped on rebuild (suppress)
  private sketchVis = new Overlay<boolean>("sketchVisibility"); // explicit per-sketch show/hide overrides
  private bodyVis = new Overlay<boolean>("bodyVisibility"); // explicit per-body show/hide overrides (id → visible)
  private planeVis = new Overlay<boolean>("planeVisibility"); // explicit per-construction-plane show/hide overrides
  private bodyNames = new Overlay<string>("bodyNames"); // explicit per-body display-name overrides (id → name)
  private palette: { name: string; color: string; material?: string }[] = DEFAULT_PALETTE.map((s) => ({ ...s }));
  private bodyColors = new Overlay<number>("bodyColors"); // per-body palette-slot assignment (id → slot index)
  private bodyElement = new Overlay<string>("bodyElement"); // per-body element assignment (id → element id)
  private bodyMaterial = new Overlay<string>("bodyMaterial"); // per-body material assignment (id → material id)
  /** per-FACE material assignment (`bodyId#localFaceIndex` → material id). See
   *  document/faceMaterials.ts for what that key promises and what it does not. */
  private faceMaterial = new Overlay<string>("faceMaterials");
  /** import feature id → "faces" for an import whose parts wear their face
   *  colours over their body colours (document/faceColors.ts). Absent is "bodies". */
  private importColors = new Overlay<ImportColorSource>("importColorSource");
  /** Left out of the saved file while it is the untouched starter set. */
  private materials: MaterialDef[] = STARTER_LIBRARY.map((m) => ({ ...m }));
  /** The user's folders over the bodies (document/elements.ts). */
  private elements: ElementDef[] = [];
  /** Saved versions of this document. Null until the first one. */
  private repo: VersionRepo | null = null;
  // static descriptor list driving toJSON/load below, in the exact on-disk key
  // order (palette piggybacks on bodyColors' condition, so isn't listed here).
  private readonly overlays: { overlay: Overlay<any>; mapValue?: (v: unknown) => any }[] = [
    { overlay: this.sketchVis },
    { overlay: this.bodyVis },
    { overlay: this.planeVis },
    { overlay: this.bodyNames },
    { overlay: this.bodyColors, mapValue: (v) => Number(v) },
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
  /** Bumped on every rebuild start. Chunk installments carry it so a late one
   *  from an abandoned reply can be recognised and dropped. */
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
    meshed: null,
    meshTotal: null,
  };

  private busy: BusyState = { active: false, label: "", id: null, pct: null };

  /** The last build of the document without a preview, and what it was built
   *  from. Leaving a tool, or undoing a commit the kernel refused, lands back on
   *  exactly this document, so it is shown again at once instead of rebuilt. */
  private committedShown: { key: string; state: RebuildState } | null = null;
  /** The rebuild on the wire, and the id a supersede cancels. */
  private inflight: { gen: number; id: string | null; cancelled: boolean } | null = null;
  private sendGen = 0;
  /** Replies to rebuilds sent at or before this are stale and never published. */
  private staleThrough = 0;
  /** A commit the kernel had not answered for yet, see verifyCommit. */
  private provisional: { id: string; what: string; key: string } | null = null;
  /** Set when a preview is dropped or a refused commit undone, the only times
   *  the committed model may be shown again without asking the engine. */
  private restoreArmed = false;

  /** surfaced when the store hits something worth telling the user without
   *  failing (newer-version file on load, a dropped sketch binding, a param
   *  commit that failed mid-cascade). Wired to a toast in main.ts. */
  onWarning?: (msg: string) => void;

  constructor(
    private geometry: GeometryBackend,
    initial: CadDocument,
  ) {
    this.doc = clone(initial);
    migrateDocument(this.doc); // the seed doc skips load(); normalize it the same way
    // long-rebuild progress frames -> live "building 57/103" in the timeline
    geometry.onProgress?.((feature, meshed, meshTotal) => {
      if (!this.build.building) return;
      // -1/-1 means "not meshing"; keep those out of the state as null so the
      // chip can distinguish "no denominator" from "0 of N done".
      this.build = {
        ...this.build,
        progress: feature,
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
    // coarse phase progress for a long non-rebuild op (import) -> the busy chip
    geometry.onOpProgress?.((pct, label) => {
      if (!this.busy.active) return;
      this.busy = { ...this.busy, pct, ...(label ? { label } : {}) };
      this.emitBusy();
    });
  }

  // --- access ---
  get document(): CadDocument {
    return this.doc;
  }
  get buildState(): RebuildState {
    return this.build;
  }

  onDocChange(fn: DocListener): () => void {
    this.docListeners.add(fn);
    fn(this.doc);
    return () => this.docListeners.delete(fn);
  }
  get busyState(): BusyState {
    return this.busy;
  }

  onBusy(fn: BusyListener): () => void {
    this.busyListeners.add(fn);
    fn(this.busy);
    return () => this.busyListeners.delete(fn);
  }

  /** Run a cancellable backend op with busy state. `onStarted` hands back the request
   *  id, since a rebuild started meanwhile would otherwise be "most recent". */
  async runBusy<T>(label: string, fn: (onStarted: (id: string) => void) => Promise<T>): Promise<T> {
    this.busy = { active: true, label, id: null, pct: null };
    this.emitBusy();
    try {
      return await fn((id) => {
        this.busy = { ...this.busy, id };
        this.emitBusy();
      });
    } finally {
      this.busy = { active: false, label: "", id: null, pct: null };
      this.emitBusy();
    }
  }

  /** Stop the busy op, if any. Resolves to whether anything was stopped, false
   *  covers both "nothing running" and "the engine had already finished". */
  async cancelBusy(): Promise<boolean> {
    if (!this.busy.active) return false;
    // A rebuild never learns its id; undefined falls back to the client's lastHeavyId.
    return (await this.geometry.cancel?.(this.busy.id ?? undefined)) ?? false;
  }

  onBuild(fn: BuildListener): () => void {
    this.buildListeners.add(fn);
    fn(this.build);
    return () => this.buildListeners.delete(fn);
  }
  /** Chunked reply installments, for the viewport only. Unlike onBuild, nothing is replayed. */
  onBuildChunk(fn: (c: BuildChunk) => void): () => void {
    this.chunkListeners.add(fn);
    return () => this.chunkListeners.delete(fn);
  }
  /** A chunked reply that will never finish (dropped connection, cancel, a
   *  malformed frame). The viewport must tear down whatever it has drawn. */
  onBuildAbort(fn: (epoch: number) => void): () => void {
    this.abortListeners.add(fn);
    return () => this.abortListeners.delete(fn);
  }
  /** Notified when the feature under edit changes live, see liveFeature. */
  onEditPreview(fn: () => void): () => void {
    this.editPreviewListeners.add(fn);
    return () => this.editPreviewListeners.delete(fn);
  }
  private editPreviewListeners = new Set<() => void>();
  private emitEditPreview() {
    for (const fn of this.editPreviewListeners) fn();
  }

  /** `id` as the model on screen shows it: the tool's live version while one
   *  edits it, so a panel beside the tool never contradicts it. */
  liveFeature(id: string): Feature | null {
    if (this.editPreview?.id === id && this.editPreview.feature) return this.editPreview.feature;
    return this.doc.features.find((f) => f.id === id) ?? null;
  }

  /** notified when the file path or dirty flag changes (for the titlebar). */
  onMeta(fn: MetaListener): () => void {
    this.metaListeners.add(fn);
    fn();
    return () => this.metaListeners.delete(fn);
  }

  // --- file identity ---
  get filePath(): string | null {
    return this.path;
  }
  get dirty(): boolean {
    return this.isDirty;
  }
  /** display name: the file's basename, or "Untitled". */
  get fileName(): string {
    if (!this.path) return "Untitled";
    return this.path.split(/[\\/]/).pop() || this.path;
  }
  /** mark the document as saved/opened at `path` (clears the dirty flag). */
  markSaved(path: string) {
    this.path = path;
    this.isDirty = false;
    this.emitMeta();
  }
  /** On New or Open, drop the old model and cancel its build: a failed rebuild keeps
   *  the last result, and a build in flight would hold up the new document's. */
  private discardModelForReplacement() {
    this.build = {
      ...this.build,
      building: false,
      result: null,
      errorFeatureId: null,
      errorMessage: null,
      streamed: null,
      streamTotal: null,
      progress: null,
      meshed: null,
      meshTotal: null,
      previewBuilt: null,
      heldRefusal: null,
    };
    this.emitBuild();
    this.committedShown = null;
    this.provisional = null;
    this.restoreArmed = false;
    // No-op when nothing is running. Cancel kills the pool worker, which is the
    // only way to interrupt an OCCT call already under way.
    void this.cancelBusy();
  }

  newDocument() {
    this.undoStack = [];
    this.redoStack = [];
    this.doc = clone(EMPTY_DOCUMENT);
    this.rollback = null;
    this.rearmProjectionValve(); // valve state must never cross documents
    this.suppressed.clear();
    for (const { overlay } of this.overlays) overlay.clear();
    this.palette = DEFAULT_PALETTE.map((s) => ({ ...s }));
    this.elements = [];
    this.materials = STARTER_LIBRARY.map((m) => ({ ...m }));
    this.repo = null;
    this.path = null;
    this.isDirty = false;
    this.discardModelForReplacement();
    this.emitDoc();
    this.emitMeta();
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
    if (this.isDirty) return;
    this.isDirty = true;
    this.emitMeta();
  }

  // --- mutation (records undo, triggers rebuild) ---
  // Undo entries are FULL document clones (imports embed multi-MB BREPs), so an
  // uncapped stack grows without bound over a long session, cap it.
  private static readonly UNDO_CAP = 50;

  private pushUndo() {
    this.undoStack.push(clone(this.doc));
    if (this.undoStack.length > DocumentStore.UNDO_CAP) this.undoStack.shift();
  }

  mutate(fn: (doc: CadDocument) => void, immediate = false) {
    this.pushUndo();
    this.redoStack = [];
    // a user edit is the "edit the model to retry" the valve toast promises
    this.rearmProjectionValve();
    this.applyDerived(fn, immediate);
  }

  // --- parameters (engine-backed; see src/params/engine.ts) ---

  /** name → why its value is stale (cycle, unknown ref, non-finite, missing
   *  target) from the last recompute. Empty on a healthy document. */
  paramIssues: Record<string, string> = {};

  private applyRecompute(r: params.RecomputeResult) {
    this.paramIssues = r.issues;
  }

  /** Injected (main.ts): headless planegcs re-solve of one sketch feature,
   *  kept out of the store so the document layer doesn't depend on the WASM
   *  solver (and tests don't need it). */
  headlessSolve?: (sketch: Extract<Feature, { type: "sketch" }>, parameters: CadDocument["parameters"]) => Promise<{ entities: Extract<Feature, { type: "sketch" }>["entities"] } | null>;
  /** Injected: the sketch feature id currently OPEN in the sketch editor (it
   *  re-solves itself live and must not be overwritten headlessly). */
  openSketchId?: () => string | null;
  /** No sketch set on purpose: an open sketch's pending bindings are not in the draft. */
  onParamsApplied?: () => void;
  /** A closed sketch could not satisfy its dims after a param edit (conflict);
   *  its coordinates were left unchanged. */
  onParamSolveIssue?: (sketchId: string) => void;
  /** Injected (main.ts): deliver projection refresh entries for the OPEN sketch
   *  to the live session (SketchMode.syncProjectedCurves), the doc copy of an
   *  open sketch is never written headlessly. */
  onProjectionsApplied?: (updates: ProjectionUpdate[]) => void;

  /** Parameter commits run in series: recompute a draft, re-solve affected sketches,
   *  land it all as one undo step and one rebuild. */
  private paramChain: Promise<void> = Promise.resolve();
  private queueParamCommit(fn: (d: CadDocument) => void) {
    this.paramChain = this.paramChain
      .then(() => this.commitWithCascade(fn))
      .catch((e) => {
        console.error("param commit failed:", e);
        this.onWarning?.("Parameter change failed to apply, see the console for details.");
      });
  }
  private async commitWithCascade(fn: (d: CadDocument) => void): Promise<void> {
    const draft = clone(this.doc);
    fn(draft);
    const r = params.recompute(draft);
    const open = this.openSketchId?.() ?? null;
    for (const sid of r.affectedSketches) {
      if (sid === open) continue;
      const f = draft.features.find((x): x is Extract<Feature, { type: "sketch" }> => x.type === "sketch" && x.id === sid);
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
      d.features = draft.features;
    });
    this.onParamsApplied?.();
  }

  // --- associative projection refresh ---
  // projectionUpdates land as a derived commit with no undo entry, so an upstream
  // edit settles in exactly two rebuilds.

  /** consecutive doc-changing refreshes we applied (incremented in
   *  commitProjectionRefresh, open-sketch-only deliveries don't count, their
   *  doc copy lags until finish() so the engine re-emits them every rebuild). */
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
        this.onWarning?.("Projected geometry keeps changing on every rebuild, paused automatic refresh (edit the model or Compute All to retry).");
      }
      return;
    }
    this.queueProjectionRefresh(updates);
  }

  /** Chained on paramChain so refreshes and param commits serialize (both
   *  headless-solve sketches and land a whole-feature replacement). */
  private queueProjectionRefresh(updates: ProjectionUpdate[]) {
    this.paramChain = this.paramChain
      .then(() => this.commitProjectionRefresh(updates))
      .catch((e) => {
        console.error("projection refresh failed:", e);
        this.onWarning?.("Projected geometry failed to refresh, see the console for details.");
      });
  }

  private async commitProjectionRefresh(updates: ProjectionUpdate[]) {
    // Re-validate against the LIVE doc: the rebuild that produced these ran on
    // an older snapshot, so a sketch/entity may have been deleted since, drop
    // dangling entries rather than resurrecting them.
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

    // stale transitions warn once per sketch (the engine only emits stale:true
    // on the not-stale -> stale transition, so every entry here is news)
    for (const sid of new Set(valid.filter((u) => u.stale).map((u) => u.sketch))) {
      const f = sketchOf.get(sid)!;
      this.onWarning?.(`Projected geometry in ${f.name ?? sid} lost its source, keeping last shape`);
    }

    const open = this.openSketchId?.() ?? null;
    const openUpdates = valid.filter((u) => u.sketch === open);
    const closedUpdates = valid.filter((u) => u.sketch !== open);
    // the OPEN sketch's doc copy is never written, the live session owns it
    // and persists the patched entities itself on finish()
    if (openUpdates.length) this.onProjectionsApplied?.(openUpdates);
    if (!closedUpdates.length) return;

    const bySketch = new Map<string, ProjectionUpdate[]>();
    for (const u of closedUpdates) {
      let list = bySketch.get(u.sketch);
      if (!list) bySketch.set(u.sketch, (list = []));
      list.push(u);
    }
    // Build every replacement feature BEFORE the single applyDerived, the
    // headless solve is async, and curves + solved coordinates must land
    // together (constrained user geometry follows the moved projections).
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
        // REPLACE the feature object, the delta wire protocol diffs features
        // by reference, so an in-place patch would never ship to the engine.
        if (i >= 0) d.features[i] = nf;
      }
    });
  }

  /** Headless re-solve shared by the param cascade and projection refresh. Null when
   *  there is nothing to solve or the solve failed (onParamSolveIssue). */
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

  /** The commit tail: apply `fn`, recompute parameters, then dirty, emit and rebuild.
   *  Derived commits call this directly to stay out of undo. */
  private applyDerived(fn: (doc: CadDocument) => void, immediate = true) {
    const joins = joinSignatures(this.doc);
    fn(this.doc);
    forgetStaleJoins(joins, this.doc);
    if (this.doc.paramDefs) this.applyRecompute(params.recompute(this.doc));
    this.markDirty();
    this.emitDoc();
    this.scheduleRebuild(immediate);
  }

  setParam(name: string, value: number) {
    void this.setParamExpr(name, String(value));
  }

  /** Set (or create) a parameter from an expression. Returns an error message
   *  to surface at the input, or null, the commit itself lands async via the
   *  cascade queue (validation is synchronous against the current document). */
  setParamExpr(name: string, expr: string, unit?: "mm" | "deg" | "count"): string | null {
    const v = params.validateExpr(this.doc, name, expr);
    if (!v.ok) return v.error;
    this.queueParamCommit((d) => params.commitParamExpr(d, name, expr, unit));
    return null;
  }

  /** Create a NEW user parameter (validates the name too). */
  addParam(name: string, expr: string, unit?: "mm" | "deg" | "count"): string | null {
    const bad = params.validateName(params.defsOf(this.doc), name);
    if (bad) return bad;
    return this.setParamExpr(name, expr, unit);
  }

  /** Classify raw dim expression input (incl. `name=expr`) for a (possibly
   *  not-yet-committed) binding without mutating anything, the sketch dim
   *  editor's pre-check. */
  classifyTargetExpr(boundName: string | null, pendingName: string | null, raw: string, kind: FieldKind): params.ExprInput {
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

  /** Set or clear how a parameter is edited, grouped and shown. A null clears
   *  that key; an absent key is left as it is. */
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

  /** Edit groups, configurations and checks as one undo step. Deleting a group
   *  also ungroups its parameters, so no parameter names a group that is gone. */
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

  /** Write every value of a configuration into its parameter, as one undo step
   *  with the usual cascade. Refused, changing nothing, when any value does not
   *  fit the document as it is now. */
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

  /** Commit an expression (canonical units, `name=expr` names the parameter) into a
   *  field. Plain numbers go through setTargetValue. Returns an error or null. */
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

  /** Commit a plain CANONICAL number into a field. A bound field keeps its
   *  model param (the expression becomes the literal, Fusion behavior); an
   *  unbound field is written directly, no param is created. */
  setTargetValue(target: ParamTarget, canonical: number, kind: FieldKind): void {
    if (params.boundParam(this.doc, target)) {
      void this.setTargetExpr(target, String(canonical), kind);
    } else {
      this.mutate((d) => void writeTarget(d, target, canonical));
    }
  }

  /** The expression driving `target`, when a model param is bound to it. */
  boundExpr(target: ParamTarget): { name: string; expr: string; value: number } | null {
    const name = params.boundParam(this.doc, target);
    if (!name) return null;
    const def = params.defsOf(this.doc)[name]!;
    return { name, expr: def.expr, value: def.value };
  }

  /** True when `target` is driven by a non-literal expression (fx: fields,
   *  drag tools must not overwrite them). */
  isParamBound(target: ParamTarget): boolean {
    return params.isBound(this.doc, target);
  }

  /** Applied in the same mutate as the sketch commit; an invalid binding is dropped with a warning. */
  private applyBindings(d: CadDocument, bindings?: SketchBinding[]) {
    for (const b of bindings ?? []) {
      // re-validate against the final doc, the dim/entity now exists in it
      const bound = params.boundParam(d, b.target);
      const nameBad = b.name && b.name !== bound ? params.validateName(params.defsOf(d), b.name) : null;
      const v = params.validateExpr(d, bound, b.expr, b.kind);
      if (!v.ok || nameBad) {
        this.onWarning?.(`Dimension expression "${b.name ? `${b.name}=` : ""}${b.expr}" was dropped: ${nameBad ?? (v.ok ? "" : v.error)}`);
        continue;
      }
      if (b.name) params.commitNamedFieldExpr(d, b.target, b.name, b.expr, b.kind);
      else params.commitFieldExpr(d, b.target, b.expr, b.kind);
    }
  }

  addFeature(feature: Feature, atIndex?: number, bindings?: SketchBinding[]) {
    // new features land at the rollback marker (mainstream MCAD), which then advances past it
    const at = atIndex ?? this.rollbackIndex;
    if (this.rollback !== null && at <= this.rollback) this.rollback += 1;
    this.mutate((d) => {
      d.features.splice(at, 0, feature);
      this.applyBindings(d, bindings);
    }, true);
  }

  /** An edit to existing features plus any new ones, as ONE undo step. */
  editAndAdd(edit: (doc: CadDocument) => void, features: Feature[] = []) {
    const at = this.rollbackIndex;
    if (features.length && this.rollback !== null && at <= this.rollback) this.rollback += features.length;
    this.mutate((d) => {
      edit(d);
      if (features.length) d.features.splice(at, 0, ...features);
    }, true);
  }

  /** Several features as one undo step at the rollback marker (a thread is two). */
  addFeatures(features: Feature[], bindings?: SketchBinding[]) {
    if (!features.length) return;
    const at = this.rollbackIndex;
    if (this.rollback !== null && at <= this.rollback) this.rollback += features.length;
    this.mutate((d) => {
      d.features.splice(at, 0, ...features);
      this.applyBindings(d, bindings);
    }, true);
  }

  /** A bound numeric field is re-asserted by the recompute; use setTargetValue/setTargetExpr. */
  updateFeature(id: string, patch: Partial<Feature>) {
    this.mutate((d) => {
      const i = d.features.findIndex((f) => f.id === id);
      if (i >= 0) d.features[i] = { ...d.features[i], ...patch } as Feature;
    });
  }

  /** Take a field off a feature entirely. A model parameter bound to it stops
   *  resolving and the recompute in mutate() collects it. */
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

  /** Give a history step a name of its own. Blank goes back to the default. */
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

  replaceFeature(id: string, feature: Feature, bindings?: SketchBinding[]) {
    this.mutate((d) => {
      const i = d.features.findIndex((f) => f.id === id);
      if (i >= 0) d.features[i] = feature;
      this.applyBindings(d, bindings);
    }, true);
  }

  /** next unused feature id (f1, f2, ...) */
  nextId(): string {
    const ids = new Set(this.doc.features.map((f) => f.id));
    let n = ids.size + 1;
    while (ids.has(`f${n}`)) n++;
    return `f${n}`;
  }

  removeFeature(id: string) {
    const idx = this.doc.features.findIndex((f) => f.id === id);
    if (this.rollback !== null && idx >= 0 && idx < this.rollback) this.rollback -= 1;
    this.suppressed.delete(id);
    this.mutate((d) => {
      d.features = d.features.filter((f) => f.id !== id);
    }, true);
  }

  // --- timeline: rollback marker, suppress, reorder ---
  /** number of features built (features[0..rollbackIndex-1] are active). */
  get rollbackIndex(): number {
    return this.rollback ?? this.doc.features.length;
  }
  isSuppressed(id: string): boolean {
    return this.suppressed.has(id);
  }
  /** roll the model back/forward to build only the first `i` features. */
  setRollback(i: number) {
    const n = this.doc.features.length;
    this.rollback = i >= n ? null : Math.max(0, i);
    this.emitDoc();
    this.scheduleRebuild(true);
  }
  /** skip/unskip a feature on rebuild without deleting it. */
  toggleSuppress(id: string) {
    if (this.suppressed.has(id)) this.suppressed.delete(id);
    else this.suppressed.add(id);
    this.markDirty();
    this.emitDoc();
    this.scheduleRebuild(true);
  }

  // --- live preview ---
  /** Append un-committed features to the build, no undo, not dirty. Null clears.
   *  `hold`: if the kernel refuses a previewed feature, keep the last model that
   *  built on screen instead of the model without it (see heldRefusal). */
  setPreview(feature: Feature | Feature[] | null, opts?: { hold?: boolean }) {
    const had = this.preview !== null;
    this.preview = feature === null ? null : Array.isArray(feature) ? feature : [feature];
    this.previewHold = feature !== null && !!opts?.hold;
    if (feature === null && had) this.leavePreview();
    else this.scheduleRebuild(true);
  }

  /** Rebuild after a preview is dropped, a microtask later: a commit drops its
   *  preview and adds the feature in one go, and only a drop that nothing
   *  follows may show the committed model again (restoreCommitted). */
  private leavePreview() {
    this.restoreArmed = true;
    queueMicrotask(() => {
      if (this.restoreArmed) this.scheduleRebuild(true);
    });
  }
  private previewHold = false;
  /** true while an un-committed live-preview feature is appended to rebuilds
   *  (its transient failures must not toast). */
  get hasPreview(): boolean {
    return this.preview !== null || this.editPreview !== null;
  }

  // --- edit preview ---
  /** While editing a feature, builds stop just before it plus the live edit: the
   *  committed mesh has already consumed e.g. a fillet's edges. `inPlace` keeps
   *  everything after it instead, for a feature that consumes nothing and whose
   *  point is what follows it (a datum plane under a sketch). */
  private editPreview: { id: string; feature: Feature | null; inPlace?: boolean } | null = null;
  /** Omit `feature` to see the model before it (extrude picks profiles there); pass it
   *  to open on the model as it looks, without a flash. */
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
  /** The edit rebuilds in place, so nothing after it is rolled away. */
  get editPreviewInPlace(): boolean {
    return !!this.editPreview?.inPlace;
  }

  /** The kernel's refusal of the previewed feature only, and null mid-build so a drag does not strobe. */
  get previewError(): string | null {
    if (this.build.building) return null;
    const failed = this.build.errorFeatureId;
    if (failed === null) return null;
    // Any of the previewed features. A thread's sketch and its revolve are one
    // gesture to the user, so a refusal of either belongs on the same boxes.
    const own = this.editPreview
      ? [this.editPreview.id]
      : (this.preview ?? []).map((f) => f.id);
    return own.includes(failed) ? this.build.errorMessage : null;
  }
  /** reorder: move feature `id` to position `toIndex` in the timeline. */
  moveFeature(id: string, toIndex: number) {
    this.mutate((d) => {
      const from = d.features.findIndex((f) => f.id === id);
      if (from < 0) return;
      const [f] = d.features.splice(from, 1);
      if (!f) return;
      d.features.splice(Math.max(0, Math.min(d.features.length, toIndex)), 0, f);
    }, true);
  }

  // --- undo / redo ---
  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(clone(this.doc));
    this.doc = prev;
    this.rearmProjectionValve();
    this.markDirty();
    this.emitDoc();
    this.scheduleRebuild(true);
  }
  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.pushUndo();
    this.doc = next;
    this.rearmProjectionValve();
    this.markDirty();
    this.emitDoc();
    this.scheduleRebuild(true);
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  // --- ViewCube side redefinitions (don't affect geometry, so no rebuild) ---
  /** the current per-side overrides (live object on the document; treat as read-only). */
  get viewOverrides(): Partial<Record<ViewCubeSide, ViewOverride>> {
    return this.doc.viewOverrides ?? {};
  }
  /** redefine a cube side from a model face (null clears it). Records undo, marks
   *  dirty + emits doc-change so the titlebar and listeners update. No rebuild:
   *  overrides don't affect geometry (effectiveDoc ignores them). */
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

  // --- sketch visibility overrides (explicit show/hide; no geometry effect) ---
  /** explicit show/hide override for a sketch, or undefined if the user hasn't set one. */
  sketchVisibilityOverride(id: string): boolean | undefined {
    return this.sketchVis.get(id);
  }
  /** set an explicit show/hide override for a sketch (persisted with the document). */
  setSketchVisibility(id: string, visible: boolean) {
    this.sketchVis.set(id, visible);
    this.markDirty();
  }

  // --- body visibility overrides (explicit show/hide; no geometry effect, just a
  // re-render that filters the hidden body's faces out of the mesh, MCAD-style) ---
  /** explicit show/hide override for a body, or undefined if unset. */
  bodyVisibilityOverride(id: string): boolean | undefined {
    return this.bodyVis.get(id);
  }
  /** true unless the user has hidden this body (bodies default to visible). */
  isBodyVisible(id: string): boolean {
    return this.bodyVis.get(id) ?? true;
  }
  /** show/hide a body; re-emits the build so the viewport re-renders (no rebuild). */
  setBodyVisibility(id: string, visible: boolean) {
    this.setBodiesVisibility(new Map([[id, visible]]));
  }

  /** Show or hide several bodies with one emit. */
  setBodiesVisibility(vis: Map<string, boolean>) {
    let changed = false;
    for (const [id, visible] of vis) {
      if ((this.bodyVis.get(id) ?? true) === visible) continue;
      this.bodyVis.set(id, visible);
      changed = true;
    }
    if (!changed) return;
    this.markDirty();
    this.emitBuild();
    // Display only, unless a legacy extrude without hiddenBodies still reads the live map.
    const legacy = this.doc.features.some(
      (f) => f.type === "extrude" && !("hiddenBodies" in f),
    );
    if (legacy) this.scheduleRebuild(true);
  }

  /** Body ids currently hidden by the user, captured into new boolean
   *  features so later eye toggles can't rewrite what a cut touched. */
  hiddenBodyIds(): string[] {
    return [...this.bodyVis.entries()].filter(([, v]) => v === false).map(([k]) => k);
  }

  // --- construction-plane visibility (the caller re-syncs the quads) ---
  /** true unless the user has hidden this construction plane (planes default to visible). */
  isPlaneVisible(id: string): boolean {
    return this.planeVis.get(id) ?? true;
  }
  /** show/hide a construction plane (persisted with the document). */
  setPlaneVisibility(id: string, visible: boolean) {
    this.planeVis.set(id, visible);
    this.markDirty();
  }

  // --- body name overrides (display-only; no geometry effect) -----------------
  /** display-name override for a body, or undefined (→ use the rebuilt name). */
  bodyName(id: string): string | undefined {
    return this.bodyNames.get(id);
  }
  /** rename a body (display-only override; blank clears it). Re-emits the build so
   *  the tree updates without a geometry rebuild, names don't affect geometry. */
  setBodyName(id: string, name: string) {
    const n = name.trim();
    if (n) this.bodyNames.set(id, n);
    else this.bodyNames.delete(id);
    this.markDirty();
    this.emitBuild();
  }
  // --- elements: the user's own folders over the bodies ---------------------
  // Display only and off the undo stack, like every overlay: undo is the timeline.

  /** the document's elements, in list order. */
  get bodyElements(): readonly ElementDef[] {
    return this.elements;
  }

  /** Which element holds this body, or undefined for an orphan. */
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

  /** Make an element and return its id. `parent` of null is the top level; one
   *  naming an element that is not there is treated as the top level rather than
   *  refused, so a stale menu can't fail silently into nothing at all. */
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

  /** Rename an element. Blank is ignored: a folder with no name is a row the
   *  user cannot aim at again. */
  renameElement(id: string, name: string) {
    const n = name.trim();
    if (!n) return;
    this.elements = this.elements.map((e) => (e.id === id ? { ...e, name: n } : e));
    this.markDirty();
    this.emitBuild();
  }

  /** Move an element under another (null = top level). A move that would bury a
   *  folder inside itself is dropped, see elements.wouldCycle. */
  setElementParent(id: string, parent: string | null) {
    const cur = this.elements.find((e) => e.id === id);
    if (!cur || (cur.parent ?? null) === parent) return;
    const next = reparented(this.elements, id, parent);
    // `reparented` hands back the same entry objects for everything it did not
    // touch, and refuses an illegal move by returning them all, so identity is
    // the whole test for "did anything happen".
    if (next.every((e, i) => e === this.elements[i])) return;
    this.elements = next;
    this.markDirty();
    this.emitBuild();
  }

  /** Delete an element, LIFTING its bodies and sub-elements into its own parent.
   *  No body is ever removed from the document by this, see
   *  elements.withElementRemoved. */
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

  /** Every element id from `id` up to its root, nearest first. What the Browser
   *  opens so a row it is about to rename is on screen. */
  elementAncestry(id: string): string[] {
    return ancestryOf(this.elements, id);
  }

  /** `id` and every element under it. */
  elementSubtree(id: string): Set<string> {
    return descendantsOf(this.elements, id);
  }

  /** Move bodies into an element (null = top level) with one emit. */
  setBodiesElement(bodyIds: Iterable<string>, element: string | null) {
    const target =
      element !== null && this.elements.some((e) => e.id === element) ? element : null;
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

  // --- materials (document/materials.ts), display only, off the undo stack ----

  /** the document's material library, in list order. */
  get materialLibrary(): readonly MaterialDef[] {
    return this.materials;
  }

  /** The material assigned to a body, or undefined. Resolved, not the raw id:
   *  an assignment naming a material that has since been deleted is the same
   *  thing as no assignment, and every caller would otherwise have to say so. */
  bodyMaterialOf(id: string): MaterialDef | undefined {
    const held = this.bodyMaterial.get(id);
    return held ? this.materials.find((m) => m.id === held) : undefined;
  }

  /** the raw assignment, for a menu that has to grey out the current row. */
  bodyMaterialId(id: string): string | undefined {
    return this.bodyMaterial.get(id);
  }

  /** Under contributed paint: a filament slot is a deliberate print choice. */
  materialPaint(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [body, id] of this.bodyMaterial.entries()) {
      const m = this.materials.find((x) => x.id === id);
      if (m) out[body] = m.color;
    }
    return out;
  }

  /** Only bodies whose finish differs from the default. */
  materialFinishes(): Record<string, BodyFinish> {
    const out: Record<string, BodyFinish> = {};
    for (const [body, id] of this.bodyMaterial.entries()) {
      const m = this.materials.find((x) => x.id === id);
      if (!m) continue;
      const f = finishOf(m);
      if (
        f.metalness === FINISH.metalness && f.roughness === FINISH.roughness
        && f.opacity === FINISH.opacity && f.emissive === FINISH.emissive
      ) {
        continue;
      }
      out[body] = f;
    }
    return out;
  }

  // --- materials on one face (document/faceMaterials.ts) ----------------------

  /** The raw per-face assignment, for a menu that has to show what is there. */
  faceMaterialId(bodyId: string, localFace: number): string | undefined {
    return this.faceMaterial.get(faceKey(bodyId, localFace));
  }

  /** Every per-face assignment, as the pure resolver wants them. */
  faceMaterialEntries(): [string, string][] {
    return [...this.faceMaterial.entries()];
  }

  /** How many faces of this body carry a material of their own. What a browser
   *  row and a body menu ask to decide whether "Clear face materials" is worth
   *  offering at all. */
  faceMaterialCount(bodyId: string): number {
    let n = 0;
    for (const [k] of this.faceMaterial.entries()) {
      const p = parseFaceKey(k);
      if (p && p.body === bodyId) n++;
    }
    return n;
  }

  /** Assign a material to faces (null clears them). Batched and emitting once,
   *  for the reason setBodiesMaterial is: a drop can land on a run of faces. */
  setFacesMaterial(faces: Iterable<{ body: string; face: number }>, material: string | null) {
    const target = material !== null && this.materials.some((m) => m.id === material) ? material : null;
    let changed = false;
    for (const { body, face } of faces) {
      const key = faceKey(body, face);
      if ((this.faceMaterial.get(key) ?? null) === target) continue;
      if (target === null) this.faceMaterial.delete(key);
      else this.faceMaterial.set(key, target);
      changed = true;
    }
    if (!changed) return;
    this.markDirty();
    this.emitBuild();
  }

  /** Drop every per-face assignment on these bodies, so a part that has been
   *  fiddled with can be put back to one material in one gesture. */
  clearFaceMaterials(bodyIds: Iterable<string>) {
    const want = new Set(bodyIds);
    let changed = false;
    for (const [k] of [...this.faceMaterial.entries()]) {
      const p = parseFaceKey(k);
      if (!p || !want.has(p.body)) continue;
      this.faceMaterial.delete(k);
      changed = true;
    }
    if (!changed) return;
    this.markDirty();
    this.emitBuild();
  }

  /** Add a material and return its id. */
  addMaterial(m?: Partial<MaterialDef>): string {
    const taken = new Set(this.materials.map((x) => x.id));
    const name = (m?.name ?? "").trim() || freshMaterialName(this.materials);
    const next: MaterialDef =
      normalizeMaterial({ ...m, name, color: m?.color ?? "#9aa7b4" }) ??
      { id: slugId(name), name, color: "#9aa7b4" };
    next.id = uniqueId(m?.id && !taken.has(m.id) ? m.id : slugId(name), taken);
    this.materials = [...this.materials, next];
    this.markDirty();
    this.emitBuild();
    return next.id;
  }

  /** Change a material in place. Every body wearing it repaints, which is the
   *  whole point of a library: the colour is edited once, not per body. */
  updateMaterial(id: string, patch: Partial<Omit<MaterialDef, "id">>) {
    let changed = false;
    this.materials = this.materials.map((m) => {
      if (m.id !== id) return m;
      const merged = normalizeMaterial({ ...m, ...patch });
      if (!merged) return m; // a patch that removed the colour is not applied
      merged.id = m.id;
      changed = true;
      return merged;
    });
    if (!changed) return;
    this.markDirty();
    this.emitBuild();
  }

  /** Delete a material. Bodies wearing it become unassigned and go back to the
   *  default grey; nothing about them is otherwise touched. */
  removeMaterial(id: string) {
    this.removeMaterials([id]);
  }

  /** Delete several materials as one change, so the model repaints once. */
  removeMaterials(ids: Iterable<string>) {
    const gone = new Set(ids);
    if (!this.materials.some((m) => gone.has(m.id))) return;
    this.materials = this.materials.filter((m) => !gone.has(m.id));
    this.dropMaterialUses(gone);
    this.markDirty();
    this.emitBuild();
  }

  /** Take materials off every body and face wearing them, keeping them in the
   *  library. */
  unassignMaterials(ids: Iterable<string>) {
    if (!this.dropMaterialUses(new Set(ids))) return;
    this.markDirty();
    this.emitBuild();
  }

  private dropMaterialUses(ids: ReadonlySet<string>): boolean {
    let changed = false;
    for (const [body, held] of [...this.bodyMaterial.entries()]) {
      if (ids.has(held)) { this.bodyMaterial.delete(body); changed = true; }
    }
    for (const [key, held] of [...this.faceMaterial.entries()]) {
      if (ids.has(held)) { this.faceMaterial.delete(key); changed = true; }
    }
    return changed;
  }

  /** Merge a library by id; replacing would unassign bodies wearing missing materials. */
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

  /** Assign a material to bodies (null clears it). Batched and emitting once,
   *  for the same reason setBodiesElement is: this is applied to a selection. */
  setBodiesMaterial(bodyIds: Iterable<string>, material: string | null) {
    const target = material !== null && this.materials.some((m) => m.id === material) ? material : null;
    let changed = false;
    for (const id of bodyIds) {
      if ((this.bodyMaterial.get(id) ?? null) === target) continue;
      if (target === null) this.bodyMaterial.delete(id);
      else this.bodyMaterial.set(id, target);
      changed = true;
    }
    if (!changed) return;
    this.markDirty();
    this.emitBuild();
  }

  /** Whether an import's parts wear their body colours or their face colours
   *  where the file gave both. Display-only and off the undo stack, like the
   *  material assignments it steers. */
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

  /** Is the library still exactly the one every new document starts with? What
   *  decides whether it is written to the file at all. */
  private materialsAreDefault(): boolean {
    return JSON.stringify(this.materials) === JSON.stringify(STARTER_LIBRARY);
  }

  /** delete a body by appending a removeBody feature at the END of the timeline
   *  (so it operates on the final body list). Undoable like any feature. */
  removeBody(bodyId: string) {
    const feat: Feature = { id: this.nextId(), type: "removeBody", bodies: [bodyId] };
    this.addFeature(feat, this.doc.features.length);
  }

  /** Append a duplicate feature, offset in X so the copy is not hidden inside the original. */
  duplicateBody(bodyId: string) {
    const feat: Feature = {
      id: this.nextId(), type: "duplicate",
      dx: 20, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0, bodies: [bodyId],
    };
    this.addFeature(feat, this.doc.features.length);
  }

  // --- color palette + per-body color (multi-color; display + export metadata) -
  /** the project's filament palette. */
  get colorPalette(): { name: string; color: string; material?: string }[] {
    return this.palette;
  }
  /** true when the palette is still the untouched default, lets a sync from
   *  elsewhere skip its "overwrite?" confirmation when there's nothing to lose. */
  paletteIsDefault(): boolean {
    return (
      this.palette.length === DEFAULT_PALETTE.length &&
      this.palette.every((s, i) => {
        const d = DEFAULT_PALETTE[i];
        return d !== undefined && s.name === d.name && s.color === d.color && !s.material;
      })
    );
  }
  /** edit a palette slot's name and/or hex color; re-emits for a live repaint. */
  setPaletteSlot(i: number, patch: { name?: string; color?: string; material?: string }) {
    if (i < 0 || i >= this.palette.length) return;
    const cur = this.palette[i];
    if (!cur) return;
    this.palette[i] = { ...cur, ...patch };
    this.markDirty();
    this.emitBuild();
  }
  /** Replace slots (name/color/material) by index, in ONE emit. Empty entries
   *  (undefined) leave that slot untouched. */
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
  /** the palette slot assigned to a body, or undefined (→ default shade). */
  bodyColorSlot(id: string): number | undefined {
    return this.bodyColors.get(id);
  }
  /** assign a body to a palette slot (null clears it); display-only re-emit. */
  setBodyColorSlot(id: string, slot: number | null) {
    if (slot == null) this.bodyColors.delete(id);
    else this.bodyColors.set(id, slot);
    this.markDirty();
    this.emitBuild();
  }
  /** body id → palette-slot index, as a plain object. For the colored-3MF export
   *  call, which must thread these side-maps explicitly (they never travel inside
   *  `document`). */
  bodyColorsMap(): Record<string, number> {
    return Object.fromEntries(this.bodyColors.entries());
  }
  /** body id → display-name override, as a plain object. Threaded through the
   *  export call so exported objects carry the sidebar names. */
  bodyNamesMap(): Record<string, string> {
    return Object.fromEntries(this.bodyNames.entries());
  }

  // --- serialization ---
  /** Everything toJSON() writes, as an object, so autosave stringifies once. */
  toObject(withVersions = true): CadDocument {
    // Persist the geometry doc PLUS the non-geometry project state that lives in
    // the store (suppress set, rollback marker, sketch visibility) so reopening
    // restores the full session. Empty state is omitted to keep files clean.
    const out: CadDocument = { ...this.doc, version: FORMAT_VERSION };
    if (this.suppressed.size) out.suppressed = [...this.suppressed];
    if (this.rollback !== null) out.rollback = this.rollback;
    for (const { overlay } of this.overlays) overlay.writeJSON(out as unknown as Record<string, unknown>);
    // Omitted when there are none, so a document that was never organised is
    // byte-identical to one saved before elements existed.
    if (this.elements.length) out.elements = this.elements.map((e) => ({ ...e }));
    // Same bargain the palette strikes below: written whenever it carries
    // information, which is a library that has been changed OR any body wearing
    // one of its rows, and omitted while it is still the untouched starter set.
    if (this.bodyMaterial.size || this.faceMaterial.size || !this.materialsAreDefault()) {
      out.materials = this.materials.map((m) => ({ ...m }));
    }
    // Persist the palette whenever it carries information: body assignments
    // reference it, and a synced/customized palette is project state in its own
    // right (the "design in loaded colors" premise) even with zero assignments.
    if (this.bodyColors.size || !this.paletteIsDefault()) out.palette = this.palette;
    if (withVersions && this.repo) out.versions = this.repo;
    return out;
  }

  // --- versions (document/versions.ts) ---

  get versionRepo(): Readonly<VersionRepo> | null {
    return this.repo;
  }

  /** The document as a version records it. */
  workingSnapshot(): Snapshot {
    return JSON.parse(JSON.stringify(this.toObject(false))) as Snapshot;
  }

  /** Save the document as it is now as a version on the current branch. Null
   *  when nothing changed since that branch's newest version. */
  saveVersion(message: string): Version | null {
    const repo = this.repo ?? emptyRepo();
    const v = commitVersion(repo, this.workingSnapshot(), message, Date.now());
    if (!v) return null;
    this.repo = repo;
    this.markDirty();
    this.emitMeta();
    return v;
  }

  /** What changed since the current branch's newest version, or null with no versions. */
  changesSinceVersion(): VersionDiff | null {
    const head = this.repo ? headOf(this.repo) : undefined;
    return head && this.repo ? diffAgainstWorking(this.repo, head.id, this.workingSnapshot()) : null;
  }

  /** Put a version's document back in front of the user. Undoable like any
   *  other replacement of the document, and the versions are untouched. */
  restoreVersion(id: string) {
    const repo = this.repo;
    if (!repo) return;
    const snapshot = snapshotOf(repo, id);
    this.load(JSON.stringify(snapshot));
    this.repo = repo;
    this.emitMeta();
  }

  /** Start a branch at a version and move onto it. */
  branchFromVersion(id: string, name: string): string {
    if (!this.repo) throw new Error("save a version first");
    const clean = createVersionBranch(this.repo, name, id);
    this.switchVersionBranch(clean);
    return clean;
  }

  /** Move onto a branch, bringing back its newest version. */
  switchVersionBranch(name: string) {
    if (!this.repo) return;
    const head = switchVersionBranch(this.repo, name);
    this.restoreVersion(head.id);
  }
  toJSON(): string {
    return JSON.stringify(this.toObject(), null, 2);
  }
  load(json: string) {
    let parsed: CadDocument;
    try {
      parsed = JSON.parse(json) as CadDocument;
    } catch (e) {
      throw new Error(`could not read document: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const w of migrateDocument(parsed)) this.onWarning?.(w);
    this.pushUndo();
    this.redoStack = [];
    this.rearmProjectionValve(); // valve state must never cross documents
    // split persisted project state back out of the document; keep `this.doc`
    // pure geometry (+ viewOverrides) so undo/rebuild stay unaffected by it.
    this.suppressed = new Set(parsed.suppressed ?? []);
    this.rollback = parsed.rollback ?? null;
    for (const { overlay, mapValue } of this.overlays) overlay.loadFrom(parsed as unknown as Record<string, unknown>, mapValue);
    this.palette = parsed.palette?.length ? parsed.palette.map((s) => ({ ...s })) : DEFAULT_PALETTE.map((s) => ({ ...s }));
    // Elements without an id and materials without a colour are dropped here, not at every reader.
    this.repo = normalizeRepo(parsed.versions);
    this.materials = parsed.materials?.length
      ? parsed.materials
          .map((m, i) => normalizeMaterial(m, i))
          .filter((m): m is MaterialDef => m !== null)
      : STARTER_LIBRARY.map((m) => ({ ...m }));
    this.elements = (parsed.elements ?? [])
      .filter((e) => e && typeof e.id === "string" && e.id)
      .map((e) => ({
        id: e.id,
        name: typeof e.name === "string" && e.name.trim() ? e.name : e.id,
        ...(typeof e.parent === "string" && e.parent ? { parent: e.parent } : {}),
      }));
    this.doc = {
      parameters: parsed.parameters ?? {},
      ...(parsed.paramDefs ? { paramDefs: parsed.paramDefs } : {}),
      ...(parsed.paramExtras ? { paramExtras: parsed.paramExtras } : {}),
      features: parsed.features ?? [],
      ...(parsed.viewOverrides ? { viewOverrides: parsed.viewOverrides } : {}),
      ...(isIdMap(parsed.bodyIds) ? { bodyIds: parsed.bodyIds } : {}),
    };
    // An extrude without hiddenBodies reads the live eye states, so hiding a body
    // rewrote geometry. Stamp "nothing hidden", which every saved file was built with.
    for (const f of this.doc.features) {
      if (f.type === "extrude" && !("hiddenBodies" in f)) {
        (f as { hiddenBodies?: string[] }).hiddenBodies = [];
      }
    }
    this.markDirty(); // openDocument clears this via markSaved() once the path is known
    this.discardModelForReplacement();
    this.emitDoc();
    this.scheduleRebuild(true);
  }
  loadDocument(doc: CadDocument) {
    this.load(JSON.stringify(doc));
  }

  // --- rebuild pipeline ---
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

  /** the document actually sent to build: features up to the rollback marker,
   *  minus suppressed ones. The full document is what we save/serialize. */
  private effectiveDoc(): CadDocument {
    let features = prefixFeatures(this.doc.features, this.rollbackIndex, this.suppressed);
    if (this.editPreview) {
      // roll to the edited feature's position (never past the rollback marker),
      // then append the live edited version if the tool has produced one.
      const idx = features.findIndex((f) => f.id === this.editPreview!.id);
      const live = this.editPreview.feature;
      if (this.editPreview.inPlace && idx >= 0) {
        if (live) features = features.map((f, i) => (i === idx ? live : f));
      } else {
        if (idx >= 0) features = features.slice(0, idx);
        if (live) features.push(live);
      }
    }
    if (this.preview) features.push(...this.preview);
    features = features.map(withoutDisplayName);
    // Body visibility travels with the rebuild so the engine can keep hidden
    // bodies out of extrude booleans (a hidden body is protected from edits).
    const bodyVisibility = this.bodyVis.size ? Object.fromEntries(this.bodyVis.entries()) : undefined;
    return {
      parameters: this.doc.parameters, features,
      ...(bodyVisibility ? { bodyVisibility } : {}),
      ...(this.doc.bodyIds ? { bodyIds: this.doc.bodyIds } : {}),
    };
  }

  /** Project sources against the prefix document (prefixFeatures). [] on transport failure. */
  projectGeometry(plane: PlaneSpec, sources: ProjectedSource[], editingId: string | null): Promise<ProjectionResult[]> {
    const doc: CadDocument = {
      parameters: this.doc.parameters,
      features: prefixFeatures(this.doc.features, this.rollbackIndex, this.suppressed, editingId),
      ...(this.doc.bodyIds ? { bodyIds: this.doc.bodyIds } : {}),
    };
    return this.geometry.projectGeometry(doc, plane, sources);
  }

  /** The axis a press/pull along the axis would move `face` along, asked of the
   *  document as it is built on screen. Null when the backend cannot answer. */
  async faceAxis(face: Selector, body: string | null): Promise<FaceAxisReply | null> {
    return (await this.geometry.faceAxis?.(this.effectiveDoc(), face, body)) ?? null;
  }

  /** Publish "a rebuild round-trip has started": keep whatever is on screen,
   *  clear every progress field so a stale fraction can't linger under the new
   *  build's label. */
  private emitBuildStarted() {
    // A new rebuild invalidates any stream still in flight for the old one.
    this.buildEpoch++;
    this.build = {
      ...this.build, building: true,
      progress: null, meshed: null, meshTotal: null, streamed: null, streamTotal: null,
    };
    this.emitBuild();
  }

  /** Drop a partial model when a build settles without its stream completing. */
  private emitBuildAbort() {
    for (const fn of this.abortListeners) fn(this.buildEpoch);
  }

  /** Remember the ids a build handed out. Not an edit, so no undo step and no
   *  unsaved star: a document built again without them gets the same ids. */
  private keepBodyIds(sent: CadDocument, reply: RebuildReply) {
    if (reply.ok && reply.result.bodyIds && this.doc === sent) this.doc.bodyIds = reply.result.bodyIds;
  }

  /** What was about to be sent as preview, and whether a refusal of it is held. */
  private previewSnapshot(): { features: Feature[] | null; hold: boolean } {
    if (!this.preview && !this.editPreview) return { features: null, hold: false };
    const features = [
      ...(this.editPreview?.feature ? [this.editPreview.feature] : []),
      ...(this.preview ?? []),
    ];
    return { features, hold: this.previewHold };
  }

  /** The refusal of one of `sent`'s features in this reply, when the preview asked to be held. */
  private heldRefusalOf(reply: RebuildReply, sent: { features: Feature[] | null; hold: boolean }): PreviewRefusal | null {
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
      code: ("code" in err && typeof err.code === "string") ? err.code : null,
      diagnostics: reply.ok ? (reply.result.diagnostics ?? []).filter((d) => d.feature_id === err.feature_id) : [],
    };
  }

  /** A partial build carries its failure inside the result; an outright failure keeps the last mesh. */
  private settledBuild(reply: RebuildReply, sent: { features: Feature[] | null; hold: boolean }): RebuildState {
    const done = {
      building: false, progress: null, meshed: null, meshTotal: null,
      streamed: null, streamTotal: null, previewBuilt: sent.features,
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
    return {
      ...done,
      result: reply.result,
      errorFeatureId: fe?.feature_id ?? null,
      errorMessage: fe?.message ?? null,
      heldRefusal: null,
    };
  }

  /** The drain currently running, so a caller that arrives mid-rebuild can
   *  await the same finish rather than a promise of its own. Null when idle. */
  private rebuildDrain: Promise<void> | null = null;

  /** Rebuild, resolving once the latest document's result is published, including
   *  when another rebuild was already running (callers need the new body ids). */
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
      // runBusy gives a long rebuild its Cancel button.
      await this.runBusy("Rebuilding", async () => {
        try {
          do {
            this.rebuildQueued = false;
            this.emitBuildStarted();
            const sent = this.doc;
            const previewing = !!(this.preview || this.editPreview);
            const sentPreview = this.previewSnapshot();
            const effective = this.effectiveDoc();
            const key = previewing ? null : buildKey(effective);
            const flight = { gen: ++this.sendGen, id: null as string | null, cancelled: false };
            this.inflight = flight;
            const reply = await this.geometry.rebuild(effective, undefined, (id) => { flight.id = id; });
            this.inflight = null;
            if (flight.gen <= this.staleThrough) continue;
            // Superseded and stopped, so there is nothing to show: the newer
            // request queued behind it is what the user is waiting for.
            if (!reply.ok && reply.cancelled && this.rebuildQueued) continue;
            if (key !== null && this.refusedProvisional(reply, key)) continue;
            if (!previewing) this.keepBodyIds(sent, reply);
            const settled = this.settledBuild(reply, sentPreview);
            // A stream that was in flight but never completed has left a PARTIAL
            // model on screen. Tell the viewport to drop it before this result,
            // which on a failure is the PREVIOUS document, renders over the top.
            if (this.build.streamed !== null && (!reply.ok || settled.heldRefusal)) this.emitBuildAbort();
            this.build = settled;
            if (key !== null && reply.ok) this.committedShown = { key, state: settled };
            this.emitBuild();
            // After publishing; a failed rebuild says nothing about projections.
            if (reply.ok) this.maybeQueueProjectionRefresh(reply.result.projectionUpdates);
          } while (this.rebuildQueued);
        } finally {
          // Here, not in the outer finally: runBusy's teardown awaits, and a refresh
          // queued in that window would be dropped.
          this.rebuilding = false;
          this.inflight = null;
        }
      });
    })();
    this.rebuildDrain = drain;
    try {
      await drain;
    } finally {
      this.rebuilding = false; // belt and braces if runBusy throws before the callback
      this.rebuildDrain = null;
    }
  }

  /** Stop the rebuild on the wire, whose document nobody wants any more. Only
   *  where the engine can stop it without a restart: killing the worker to save
   *  a draft preview would throw away every cached feature before it. */
  private supersede() {
    const f = this.inflight;
    if (!f || f.cancelled || !f.id || !this.geometry.softCancel) return;
    f.cancelled = true;
    void this.geometry.cancel?.(f.id, { soft: true });
  }

  /** Show the committed model again when the document to build is the one it
   *  was built from, the state a cancelled tool returns to. */
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

  /** Commit `featureId` without waiting for the kernel's verdict on it, so the
   *  tool that made it can close at once. If the rebuild of this exact document
   *  then refuses the feature, the commit is undone and `what` is named in the
   *  warning: a refused value is never left in the history. */
  verifyCommit(featureId: string, what: string) {
    this.provisional = { id: featureId, what, key: buildKey(this.effectiveDoc()) };
  }

  /** True when `reply` refused the provisional commit and it was undone. */
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
    this.undo();
    return true;
  }

  /** Rebuild past every cache layer, for a suspected stale result. */
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
      // Compute All is the explicit retry gesture the valve toast promises:
      // re-arm the valve and route the (freshly recomputed) projection updates
      // through the normal refresh path instead of dropping them.
      if (reply.ok) {
        this.rearmProjectionValve();
        this.maybeQueueProjectionRefresh(reply.result.projectionUpdates);
      }
    } finally {
      this.rebuilding = false;
    }
  }
}
