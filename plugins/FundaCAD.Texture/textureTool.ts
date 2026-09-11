// Texture tool: printed surface texture (knurl/hex/waves/ribs/voronoi/noise/image
// heightmap). Unlike Fillet/Chamfer/Press-Pull, this tool has NO drag gizmo, it
// rides the ambient viewport selection (click / Ctrl-click toggles faces, or a
// whole body in Bodies mode) and drives a docked TexturePanel for the kind +
// numeric knobs. An rAF tick diffs the ambient selection each frame (rather than
// hijacking viewport.onSelectionChange, which main.ts owns) and refreshes the
// panel's summary line + live preview when it changes. The preview is the REAL
// sidecar-computed displacement at viewport density, debounced like Fillet/
// PressPull (store.setPreview()/setEditPreview()). Commit promotes the preview
// to a real feature (records undo); Esc (via the panel) or Cancel reverts.

import { contributedPalette, setPrompt } from "fundacad";
import type { DocumentStore, Feature, Num, Selector, Viewport } from "fundacad";
import * as panel from "./panel";
import { ANGLE_KINDS, SEED_KINDS, asTexture, type TextureMode, type TextureValues } from "./textureForm";

// Warm texture ticks are ~10-70ms sidecar-side (geometry-skeleton cache), so a
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

  // --- edit mode (re-opening a committed texture) ---
  private editId: string | null = null;
  private savedFaceSelectors: Selector[] = [];
  private savedBodyId: string | null = null;
  private awaitingRollback = false;
  private unsubBuild: (() => void) | null = null;

  // --- ambient-selection diffing (rAF tick, not viewport.onSelectionChange,
  // that single callback slot belongs to main.ts) ---
  private lastFaceIds: number[] = [];
  private lastBodyIds: string[] = [];
  private raf = 0;
  private boundTick: () => void;
  private previewDebounce = 0;
  // WHILE A REBUILD IS IN FLIGHT THE AMBIENT SELECTION IS NOT AN ANSWER.
  //
  // Membership IS the ambient selection for this tool, and this tool rebuilds
  // on its own preview, so every keystroke in the Depth box puts the thing the
  // gesture is standing on through a rebuild. A chunked reply reaches the screen
  // in installments, and the one that opens it does not carry the body being
  // edited (it is held back until its own chunk lands), so for a few frames the
  // viewport truthfully reports nothing selected. Read as a deselect, that ends
  // the gesture: the members go, the preview is cleared, and Add is refused with
  // "No faces selected" over a face that is plainly lit up on screen.
  //
  // The viewport now carries the selection across a stream (viewport.ts,
  // streamMemo), so it comes back by the time the build completes. This covers
  // the frames in between, which is the part no restore can help with: for that
  // moment the body genuinely is not on screen.
  private building = false;
  // A build COMPLETED and the selection is still empty. Distinct from the flag
  // above: this one says the restore had its chance and did not find the face
  // (a real drift), so the members are put back explicitly.
  private rebuildLanded = false;
  // Add was pressed while a rebuild was in flight. The tick can afford to skip
  // those frames; a commit cannot, the person has finished and is waiting, so
  // it is held and run when the build lands instead of being refused against a
  // selection that is only briefly empty.
  private pendingCommit = false;

  // Esc lives on the TOOL, not the panel: the tool is active from the moment the
  // edit path starts rolling the model back (before any panel exists) until
  // cleanup, and a commit the tool refuses leaves it active with the panel still
  // up. Anything narrower leaves a window where main.ts's Esc handlers are all
  // gated off by toolBusy() and the user has no way out at all.
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
    // don't clobber the mode the user's already browsing in (e.g. came from
    // Select: Bodies with something pre-selected)
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

  /** Re-open a committed texture for editing: the model rolls back to just
   *  before the feature, its saved member faces/body are re-selected in the
   *  ambient selection (best-effort, a stale reference just shows as an empty
   *  selection, the same way a moved fillet edge can miss), the panel seeds from
   *  the saved values, and commit REPLACES the feature in place (same id, one
   *  undo step). Returns false when a numeric field holds a parameter
   *  expression (not tool-editable), the caller falls back to the value rows. */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = asTexture(this.store.document.features.find((x) => x.id === featureId));
    if (!f) return false;
    const numeric = [f.depth, f.scale, f.angle, f.offset, f.sharpness, f.boundaryInset, f.seed];
    if (numeric.some((v) => v !== undefined && typeof v !== "number")) return false; // parameter, the value rows' job
    const fields = ["depth", "scale", "angle", "offset", "sharpness", "boundaryInset", "seed"];
    if (fields.some((field) => this.store.isParamBound({ kind: "feature", feature: f.id, field })))
      return false; // parameter-driven field, the value rows' job

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

  /** Re-select the saved member faces/body in the ambient selection so the
   *  drag-free "membership" (which IS the ambient selection for this tool)
   *  starts where the committed feature left off. Best-effort: a face whose
   *  saved point no longer matches anything within tolerance is just not
   *  re-highlighted (same risk a moved fillet edge accepts on re-anchor). */
  private seedSelectionFromSaved() {
    if (this.mode === "body") {
      if (this.savedBodyId) this.viewport.setSelectedBodies([this.savedBodyId]);
    } else {
      const ids: number[] = [];
      // the saved point was minted from the DISPLACED preview mesh, so on the
      // rolled-back (undisplaced) model it floats up to depth+offset off the
      // surface, tell the matcher to expect that.
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
        // Whatever colours a plugin says this document has, which is usually
        // none. Empty is already how the panel says "there is no inlay colour to
        // choose", it has been passed an empty palette on a document with no
        // bodies since the row existed, so a build with nothing contributing
        // one needs no second answer.
        palette: contributedPalette(),
      },
      {
        onCommit: (v) => { this.values = v; this.commit(); },
        onCancel: () => this.cancel(),
        onChange: (v) => { this.values = v; this.pushPreview(); },
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

  /** rAF tick: diff the ambient selection (not viewport.onSelectionChange,
   *  that single slot belongs to main.ts) and refresh the panel + preview when
   *  it moves, so clicking faces in the viewport feels live. */
  private tick() {
    if (!this.active) return;
    if (this.awaitingRollback) {
      this.raf = requestAnimationFrame(this.boundTick);
      return;
    }
    // Mid-rebuild the ambient selection is in an unknown state, not a new one.
    // Diffing against it here is what turned the tool's own preview into the
    // thing that ended the gesture.
    if (this.building) {
      this.raf = requestAnimationFrame(this.boundTick);
      return;
    }
    if (this.mode === "faces") {
      const cur = this.viewport.getSelectedFaceIds();
      // a rebuild (our own preview landing, usually) wiped the selection, the
      // members are still the tool's; restore them instead of treating the
      // wipe as a user deselect. Face ids are stable here: displacement never
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

  /** Live preview: every change (selection or params, any kind) debounces into
   *  the same sidecar-preview pipeline Fillet/PressPull use, the REAL
   *  displaced mesh at viewport density, ~half a second behind the slider.
   *  (A GPU vertex-shader preview was tried and dropped: it can only move
   *  vertices that already exist, invisible on a 2-triangle flat face, and
   *  without normal recomputation the shading never changes, so even dense
   *  meshes barely showed it.) An empty selection cancels any pending preview
   *  and clears an uncommitted one. */
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

  /** kind-specific extra fields, only the ones that apply to the chosen kind,
   *  so the emitted JSON stays a clean match for the sidecar's per-kind reader
   *  instead of every kind carrying every other kind's leftover defaults. */
  private kindFields(v: TextureValues): Partial<Record<string, Num | boolean | string>> {
    const extra: Partial<Record<string, Num | boolean | string>> = {};
    if (v.offset) extra.offset = v.offset;
    // profile applies to EVERY kind, and is written out explicitly rather than
    // relying on the sidecar default so a saved document says what it is
    extra.profile = v.profile;
    if (v.boundaryInset) extra.boundaryInset = v.boundaryInset;
    if (ANGLE_KINDS.has(v.kind) && v.angle) extra.angle = v.angle;
    // direction is generic in the sidecar, it transforms the height field
    // (out = h, in = h-1, both = centred) rather than the pattern, so EVERY
    // kind honours it. It used to ride along with the angle, which left
    // noise/voronoi/image permanently embossing outward.
    extra.direction = v.direction;
    // sharpness shapes the lattice/wave kinds under either profile, and under
    // FACET it also drives the cellular wall width and the terrace count, so
    // voronoi/noise/image need it too, which they never used to get.
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
      // Bind the target body. Without it the sidecar falls back to the ACTIVE
      // (last-created) body and resolves the face selector against the wrong
      // shape, so with >1 body the texture lands on a random face of the last
      // body, not the one clicked. A texture applies to a single body, so if the
      // selection spans bodies keep only faces on the bound (first) one rather
      // than silently resolving the rest against the wrong shape.
      const body = sel.bodyId ?? undefined;
      const selectors = body
        ? sel.selectors.filter((_, i) => this.viewport.faceIdToBodyId(sel.faceIds[i]!) === body)
        : sel.selectors;
      if (!selectors.length) return null;
      return { ...base, ...(body ? { body } : {}), faces: selectors.length === 1 ? selectors[0]! : selectors } as Feature;
    }
    const body = this.viewport.getSelectedBodies()[0];
    if (!body) return null;
    return { ...base, body } as Feature;
  }

  /** Run a commit that was held for a rebuild. One attempt: the build has
   *  landed and the selection is whatever it is now, so a second refusal is a
   *  real one and says so. */
  private runHeldCommit() {
    if (!this.pendingCommit) return;
    this.pendingCommit = false;
    this.commit();
  }

  private commit() {
    if (!this.active) return;
    const feature = this.buildFeature();
    if (!feature) {
      // MID-REBUILD IS NOT AN ANSWER. The selection this reads is briefly empty
      // while a chunked reply is landing, so refusing here told somebody that
      // nothing was selected while the face they picked was lit up in front of
      // them, and left the panel open with no way to tell what had gone wrong.
      // Hold it and try once more when the build lands.
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
