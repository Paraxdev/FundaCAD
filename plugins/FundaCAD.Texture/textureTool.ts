// No drag gizmo: the tool rides the ambient viewport selection, diffed in a rAF tick because main.ts owns
// viewport.onSelectionChange. The preview is the real engine displacement, debounced like Fillet and Press/Pull.

import { contributedPalette, setPrompt } from "fundacad";
import type { DocumentStore, Feature, Num, Selector, Viewport } from "fundacad";
import * as panel from "./panel";
import {
  ANGLE_KINDS,
  PROJECTION_KINDS,
  SEED_KINDS,
  asTexture,
  type TextureMode,
  type TextureValues,
} from "./textureForm";

// Warm texture ticks are ~10-70ms engine-side (geometry-skeleton cache), so a
// short debounce keeps scrubbing responsive while still coalescing keystrokes.
const PREVIEW_DEBOUNCE_MS = 150;

const defaultValues = (): TextureValues => ({
  kind: "knurl",
  depth: 0.4,
  scale: 2,
  angle: 0,
  offset: 0,
  sharpness: 0.5,
  profile: "facet",
  boundaryInset: 0,
  grime: 0,
  smooth: 0,
  projection: "triplanar",
  seamBlend: 0.5,
  seamBand: 0.5,
  amplitude: 1,
  slopeMin: 0,
  slopeMax: 180,
  targetEdge: 0,
  triBudget: 0,
  direction: "out",
  seed: 1,
  invert: false,
});

const PICK_PROMPT = "Select faces (or switch to Whole Body) for the texture · Esc to cancel";

function sameSet<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(b);
  return a.every((x) => s.has(x));
}

export class TextureTool {
  active = false;
  private mode: TextureMode = "faces";
  private values: TextureValues = defaultValues();
  private previewId = "";
  private onDone: ((id: string | null) => void) | null = null;

  private editId: string | null = null;
  private savedFaceSelectors: Selector[] = [];
  private savedBodyId: string | null = null;
  private awaitingRollback = false;
  private unsubBuild: (() => void) | null = null;

  private lastFaceIds: number[] = [];
  private lastBodyIds: string[] = [];
  private raf = 0;
  private boundTick: () => void;
  private previewDebounce = 0;
  // While a rebuild is in flight the ambient selection is not an answer: a chunked reply briefly shows nothing selected,
  // and reading that as a deselect would end the gesture. streamMemo in viewport.ts restores it once the build lands.
  private building = false;
  // A build completed and the selection is still empty: the restore missed (a real drift), so the members are put back.
  private rebuildLanded = false;
  // Add pressed mid-rebuild is held and run when the build lands, not refused against a briefly empty selection.
  private pendingCommit = false;

  // Esc lives on the tool, active from the rollback before any panel exists until cleanup. Anything narrower leaves a
  // window where toolBusy() gates every Esc handler in main.ts and there is no way out.
  private escHandler = (e: KeyboardEvent) => {
    if (!this.active || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    this.cancel();
  };

  constructor(
    private viewport: Viewport,
    private store: DocumentStore,
  ) {
    this.boundTick = () => this.tick();
  }

  private listenForEscape() {
    document.addEventListener("keydown", this.escHandler, true);
  }

  start(onDone: (id: string | null) => void) {
    if (this.active) return;
    this.active = true;
    this.onDone = onDone;
    this.editId = null;
    this.previewId = this.store.nextId();
    this.values = defaultValues();
    // Keep the mode the user is already browsing in, e.g. Select: Bodies with something preselected.
    this.mode = this.viewport.selecting === "bodies" ? "body" : "faces";
    this.viewport.setSelectionMode(this.mode === "body" ? "bodies" : "faces");
    this.lastFaceIds = [];
    this.lastBodyIds = [];
    this.rebuildLanded = false;
    this.building = false;
    this.pendingCommit = false;
    this.unsubBuild = this.store.onBuild((s) => {
      this.building = s.building;
      if (s.building || !s.result) return;
      this.rebuildLanded = true;
      this.runHeldCommit();
    });
    this.openPanel(false);
    setPrompt(PICK_PROMPT);
    this.listenForEscape();
    this.raf = requestAnimationFrame(this.boundTick);
  }

  /** Rolls back to just before the feature, reselects its saved members (best effort), seeds the panel and commits in
   *  place as one undo step. False when a numeric field holds a parameter, the value rows edit that instead. */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = asTexture(this.store.document.features.find((x) => x.id === featureId));
    if (!f) return false;
    const numeric = [f.depth, f.scale, f.angle, f.offset, f.sharpness, f.boundaryInset, f.seed];
    if (numeric.some((v) => v !== undefined && typeof v !== "number")) return false; // parameter, the value rows' job
    const fields = ["depth", "scale", "angle", "offset", "sharpness", "boundaryInset", "seed"];
    if (fields.some((field) => this.store.isParamBound({ kind: "feature", feature: f.id, field }))) return false; // parameter-driven field, the value rows' job

    this.active = true;
    this.onDone = onDone;
    this.editId = featureId;
    this.previewId = featureId; // keep the SAME id through preview and commit
    this.mode = f.faces ? "faces" : "body";
    this.savedFaceSelectors = f.faces ? (Array.isArray(f.faces) ? f.faces : [f.faces]) : [];
    this.savedBodyId = f.body ?? null;
    this.values = {
      kind: f.kind,
      depth: (f.depth as number) ?? 0.4,
      scale: (f.scale as number) ?? 2,
      angle: (f.angle as number) ?? 0,
      offset: (f.offset as number) ?? 0,
      sharpness: (f.sharpness as number) ?? 0.5,
      profile: f.profile ?? "facet",
      boundaryInset: (f.boundaryInset as number) ?? 0,
      grime: (f.grime as number) ?? 0,
      smooth: (f.smooth as number) ?? 0,
      projection: f.projection ?? "triplanar",
      seamBlend: (f.seamBlend as number) ?? 0.5,
      seamBand: (f.seamBand as number) ?? 0.5,
      amplitude: (f.amplitude as number) ?? 1,
      slopeMin: (f.slopeMin as number) ?? 0,
      slopeMax: (f.slopeMax as number) ?? 180,
      targetEdge: (f.targetEdge as number) ?? 0,
      triBudget: (f.triBudget as number) ?? 0,
      direction: f.direction ?? "out",
      seed: (f.seed as number) ?? 1,
      invert: f.invert ?? false,
      ...(f.imagePath ? { imagePath: f.imagePath } : {}),
      ...(typeof f.colorSlot === "number" ? { colorSlot: f.colorSlot } : {}),
    };
    this.awaitingRollback = true;
    this.pendingCommit = false;
    this.lastFaceIds = [];
    this.lastBodyIds = [];
    this.viewport.setSelectionMode(this.mode === "body" ? "bodies" : "faces");
    setPrompt("Rolling back to edit… (later features are hidden while editing)");

    this.store.beginEditPreview(featureId);
    this.listenForEscape();
    this.unsubBuild = this.store.onBuild((s) => {
      this.building = s.building;
      if (s.building || !s.result) return;
      if (this.awaitingRollback) {
        this.awaitingRollback = false;
        this.seedSelectionFromSaved();
        this.openPanel(true);
        setPrompt(PICK_PROMPT);
        this.pushPreview();
        this.raf = requestAnimationFrame(this.boundTick);
      } else {
        this.rebuildLanded = true; // an edit-preview rebuild wipes the selection too
        this.runHeldCommit();
      }
    });
    return true;
  }

  /** Best effort: a face whose saved point no longer matches within tolerance is just not reselected, the same risk a
   *  moved fillet edge accepts. */
  private seedSelectionFromSaved() {
    if (this.mode === "body") {
      if (this.savedBodyId) this.viewport.setSelectedBodies([this.savedBodyId]);
    } else {
      const ids: number[] = [];
      // The saved point came from the displaced preview mesh, so on the rolled back model it floats up to depth+offset
      // off the surface.
      const off = Math.abs(this.values.depth) + Math.abs(this.values.offset);
      for (const sel of this.savedFaceSelectors) {
        if (!("point" in sel)) continue;
        const fid = this.viewport.faceIdNear(sel.point as [number, number, number], off);
        if (fid != null) ids.push(fid);
      }
      this.viewport.selectFaces(ids);
    }
  }

  private openPanel(editing: boolean) {
    panel.show(
      {
        editing,
        mode: this.mode,
        summary: this.currentSummary(),
        initial: this.values,
        // Whatever colours a plugin says this document has, usually none, and an empty palette already means no inlay.
        palette: contributedPalette(),
      },
      {
        onCommit: (v) => {
          this.values = v;
          this.commit();
        },
        onCancel: () => this.cancel(),
        onChange: (v) => {
          this.values = v;
          this.pushPreview();
        },
        onModeChange: (m) => this.setMode(m),
      },
    );
  }

  private setMode(m: TextureMode) {
    if (this.mode === m) return;
    this.mode = m;
    // switching clears the OTHER kind of selection (setSelectionMode's job), so
    // the member set for the new mode always starts empty, not a stale mix.
    this.viewport.setSelectionMode(m === "body" ? "bodies" : "faces");
    this.lastFaceIds = [];
    this.lastBodyIds = [];
    panel.mode.value = m;
    this.refreshSummary();
    this.pushPreview();
  }

  private tick() {
    if (!this.active) return;
    if (this.awaitingRollback) {
      this.raf = requestAnimationFrame(this.boundTick);
      return;
    }
    // Mid-rebuild the selection is unknown, not new, and diffing it would let the tool's own preview end the gesture.
    if (this.building) {
      this.raf = requestAnimationFrame(this.boundTick);
      return;
    }
    if (this.mode === "faces") {
      const cur = this.viewport.getSelectedFaceIds();
      // A rebuild wiped the selection but the members are still the tool's. Face ids are stable, displacement never
      // adds or removes B-rep faces.
      if (this.rebuildLanded) {
        this.rebuildLanded = false;
        if (!cur.length && this.lastFaceIds.length) {
          this.viewport.selectFaces(this.lastFaceIds);
          this.raf = requestAnimationFrame(this.boundTick);
          return;
        }
      }
      if (!sameSet(cur, this.lastFaceIds)) {
        this.lastFaceIds = cur;
        this.refreshSummary();
        this.pushPreview();
      }
    } else {
      const cur = this.viewport.getSelectedBodies();
      if (this.rebuildLanded) {
        this.rebuildLanded = false;
        if (!cur.length && this.lastBodyIds.length) {
          this.viewport.setSelectedBodies(this.lastBodyIds);
          this.raf = requestAnimationFrame(this.boundTick);
          return;
        }
      }
      if (!sameSet(cur, this.lastBodyIds)) {
        this.lastBodyIds = cur;
        this.refreshSummary();
        this.pushPreview();
      }
    }
    this.raf = requestAnimationFrame(this.boundTick);
  }

  private currentSummary(): string {
    if (this.mode === "body") {
      const ids = this.viewport.getSelectedBodies();
      const id = ids[0];
      if (!id) return "Whole body: nothing selected, click a body";
      const b = (this.store.buildState.result?.bodies ?? []).find((x) => x.id === id);
      const name = this.store.bodyName(id) ?? b?.name ?? id;
      return ids.length > 1 ? `Whole body: ${name} (using first of ${ids.length} selected)` : `Whole body: ${name}`;
    }
    const n = this.viewport.getSelectedFaceIds().length;
    return n ? `${n} face${n === 1 ? "" : "s"} selected` : "No faces selected, click one or more faces";
  }

  private refreshSummary() {
    panel.summary.value = this.currentSummary();
  }

  /** The real displaced mesh, ~half a second behind the slider. A GPU vertex shader preview cannot move vertices a flat
   *  face does not have and never reshades, so it showed almost nothing. An empty selection clears it. */
  private pushPreview() {
    if (this.hasTarget()) {
      this.schedulePreview();
      return;
    }
    if (this.previewDebounce) {
      clearTimeout(this.previewDebounce);
      this.previewDebounce = 0;
    }
    if (!this.editId) this.store.setPreview(null);
  }

  private hasTarget(): boolean {
    if (this.mode === "body") return this.viewport.getSelectedBodies().length > 0;
    return this.viewport.getSelectedFaceIds().length > 0;
  }

  private schedulePreview() {
    if (this.previewDebounce) clearTimeout(this.previewDebounce);
    this.previewDebounce = window.setTimeout(() => {
      this.previewDebounce = 0;
      const feature = this.buildFeature();
      if (this.editId) this.store.setEditPreview(feature);
      else this.store.setPreview(feature);
    }, PREVIEW_DEBOUNCE_MS);
  }

  /** Only the fields the chosen kind reads, so the JSON matches the engine's per-kind reader. */
  private kindFields(v: TextureValues): Partial<Record<string, Num | boolean | string>> {
    const extra: Partial<Record<string, Num | boolean | string>> = {};
    if (v.offset) extra.offset = v.offset;
    // Written explicitly rather than left to the engine default, so a saved document says what it is.
    extra.profile = v.profile;
    if (v.boundaryInset) extra.boundaryInset = v.boundaryInset;
    if (ANGLE_KINDS.has(v.kind) && v.angle) extra.angle = v.angle;
    // direction transforms the height field (out = h, in = h-1, both = centred), so every kind honours it.
    extra.direction = v.direction;
    // The engine drops smooth at zero, so an untouched texture keeps its geometry and cache identity.
    if (v.smooth) extra.smooth = v.smooth;
    // A heightmap never carries projection. Only the seam control the mode reads is sent, and triplanar is omitted as the
    // default, so old documents hash unchanged.
    if (PROJECTION_KINDS.has(v.kind)) {
      if (v.projection !== "triplanar") extra.projection = v.projection;
      if (v.projection === "triplanar" && v.seamBlend !== 0.5) extra.seamBlend = v.seamBlend;
      if (v.projection === "box" && v.seamBand !== 0.5) extra.seamBand = v.seamBand;
    }
    // amplitude and the slope mask apply to every kind and ride only off their
    // defaults, so an untouched texture carries none of them.
    if (v.amplitude !== 1) extra.amplitude = v.amplitude;
    if (v.slopeMin !== 0) extra.slopeMin = v.slopeMin;
    if (v.slopeMax !== 180) extra.slopeMax = v.slopeMax;
    // mesh detail (target edge length) and a hard triangle budget, off by default
    if (v.targetEdge > 0) extra.targetEdge = v.targetEdge;
    if (v.triBudget > 0) extra.triBudget = v.triBudget;
    // Under FACET sharpness also drives the cellular wall width and the terrace count, so every kind needs it there.
    if (ANGLE_KINDS.has(v.kind) || v.profile === "facet") {
      if (v.sharpness) extra.sharpness = v.sharpness;
    }
    if (SEED_KINDS.has(v.kind)) extra.seed = v.seed;
    if (v.kind === "image") {
      if (v.imagePath) extra.imagePath = v.imagePath;
      extra.invert = v.invert;
    }
    return extra;
  }

  private buildFeature(): Feature | null {
    const v = this.values;
    const base = {
      id: this.previewId,
      type: "texture" as const,
      kind: v.kind,
      depth: v.depth,
      scale: v.scale,
      ...(v.colorSlot != null ? { colorSlot: v.colorSlot } : {}), // two-tone inlay slot (any kind)
      ...this.kindFields(v),
    };
    if (this.mode === "faces") {
      const sel = this.viewport.selectedFacesForPressPull();
      if (!sel || !sel.faceIds.length) return null;
      // Bind the target body, or the engine resolves the faces against the last created one. A texture applies to one
      // body, so faces off the first are dropped.
      const body = sel.bodyId ?? undefined;
      const selectors = body
        ? sel.selectors.filter((_, i) => this.viewport.faceIdToBodyId(sel.faceIds[i]!) === body)
        : sel.selectors;
      if (!selectors.length) return null;
      return {
        ...base,
        ...(body ? { body } : {}),
        faces: selectors.length === 1 ? selectors[0]! : selectors,
      } as Feature;
    }
    const body = this.viewport.getSelectedBodies()[0];
    if (!body) return null;
    return { ...base, body } as Feature;
  }

  /** One attempt: the build has landed, so a second refusal is real and says so. */
  private runHeldCommit() {
    if (!this.pendingCommit) return;
    this.pendingCommit = false;
    this.commit();
  }

  private commit() {
    if (!this.active) return;
    const feature = this.buildFeature();
    if (!feature) {
      // The selection is briefly empty while a chunked reply lands, so hold the commit and try once more after it.
      if (this.building && !this.pendingCommit) {
        this.pendingCommit = true;
        setPrompt("Adding the texture, waiting for the model…");
        return;
      }
      setPrompt(
        this.mode === "faces"
          ? "No faces selected, click one or more faces · Esc to cancel"
          : "No body selected, click a body · Esc to cancel",
      );
      return;
    }
    if (this.editId) {
      const id = this.editId;
      this.store.endEditPreview(false); // replaceFeature triggers the rebuild
      this.store.replaceFeature(id, feature);
    } else {
      this.store.setPreview(null);
      this.store.addFeature(feature);
    }
    const id = feature.id;
    this.cleanup();
    this.onDone?.(id);
  }

  cancel() {
    if (!this.active) return;
    if (this.editId) this.store.endEditPreview();
    else this.store.setPreview(null);
    this.cleanup();
    this.onDone?.(null);
  }

  private cleanup() {
    document.removeEventListener("keydown", this.escHandler, true);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.previewDebounce) clearTimeout(this.previewDebounce);
    this.previewDebounce = 0;
    panel.hide();
    this.unsubBuild?.();
    this.unsubBuild = null;
    this.editId = null;
    this.awaitingRollback = false;
    this.pendingCommit = false;
    this.savedFaceSelectors = [];
    this.savedBodyId = null;
    this.lastFaceIds = [];
    this.lastBodyIds = [];
    this.rebuildLanded = false;
    // consumed members would dangle in the next tool's selection (same reason
    // a boolean clears it after consuming the tool bodies), clear both kinds.
    this.viewport.clearSelection();
    this.viewport.setSelectedBodies([]);
    this.active = false;
    setPrompt(null);
  }
}
