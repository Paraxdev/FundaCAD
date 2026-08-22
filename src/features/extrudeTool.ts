// Interactive Extrude (MCAD-style): select one or more profile AREAS, then set
// the distance by moving the cursor along the profile normal (live solid preview +
// arrow manipulator + numeric box). Areas can be pre-selected in the sketch or
// picked here: plain click picks one and starts the depth drag, Ctrl-click adds
// more (Enter to confirm the set). A ring (annulus) area previews/extrudes as a
// tube; selecting several areas unions them.
//
// The operation is DECIDED, never asked: New Body when nothing exists, Cut when
// the profile pushes into existing material, Join when it pulls away from it — a
// profile drawn on a face and pulled off it is the common case, and it joins. The
// commit used to stop on a four-way modal to have that answer confirmed, which
// put a decision in front of every extrude in order to change the few where the
// guess is wrong. The prompt names the operation while you drag instead, and
// Properties edits it afterwards (document/optionFields.ts has carried the row
// for a while), so the answer is both visible before and changeable after.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { SketchOverlay, WorldRegion } from "../sketch/overlay";
import type { DocumentStore } from "../document/store";
import type { Feature } from "../types";
import { pointInRegion } from "../sketch/region";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { axisDragDistance, fluentRelease } from "./manipulator";
import { regionAnchor } from "./regionNudge";
import { OP_WORD, plannedOperation, type ExtrudeOp } from "./extrudeOperation";

type Phase = "pick" | "drag";
type Op = ExtrudeOp;

export class ExtrudeTool {
  active = false;
  private phase: Phase = "pick";
  private selected: WorldRegion[] = [];
  private distance = 10;
  private preview: THREE.Group | null = null;
  private previewMat: THREE.MeshStandardMaterial | null = null;
  private previewKey = ""; // depth+sign+selection of the built preview geometry
  private arrow: THREE.ArrowHelper | null = null;
  private dim = new DimInput();
  private hitScratch = new THREE.Vector3();
  private onDone: ((id: string | null) => void) | null = null;

  // --- edit mode (re-opening a committed extrude) ---
  private editId: string | null = null; // committed feature id being edited
  private editOp: Op | null = null; // saved operation — an edit keeps it rather than re-guessing
  private editHiddenBodies: string[] | undefined; // participants captured at creation — KEPT
  /** while editing, this sketch is forced visible so its regions exist
   *  (consumed sketches hide by default) — main.ts's isSketchVisible honors it. */
  forcedSketchId: string | null = null;

  /** Fluent grab: the cursor's projection along the normal at the moment the
   *  passive handle was pressed. Null for every other entry, where the depth
   *  free-tracks the cursor's ABSOLUTE projection. Holding the button changes
   *  what the gesture means — the depth has to grow from where you took hold,
   *  not snap to wherever the arrow tip happened to project. */
  private grabProj: number | null = null;
  private fluentGrab = false;
  private downPos = { x: 0, y: 0 };

  private boundMove: (e: PointerEvent) => void;
  private boundDown: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;

  constructor(
    private viewport: Viewport,
    private overlay: SketchOverlay,
    private store: DocumentStore,
  ) {
    this.boundMove = (e) => this.onMove(e);
    this.boundDown = (e) => this.onDown(e);
    this.boundUp = (e) => this.onUp(e);
    this.boundKey = (e) => this.onKey(e);
  }

  /** `opts.grabAt` is the direct-manipulation entry (features/regionNudge.ts):
   *  the user pressed the handle that appears the moment a profile is selected,
   *  so we arm from that pre-selection AND begin scrubbing inside the same
   *  pointerdown. */
  start(onDone: (id: string | null) => void, opts?: { grabAt?: { x: number; y: number } }) {
    if (this.active) return;
    // Read the pre-selection BEFORE installing anything: a handle whose regions
    // have gone (the sketch was hidden or re-solved between the paint and the
    // press) must not arm the pick phase, which would be a bait-and-switch into
    // a tool nobody asked for, holding toolBusy() until noticed.
    const pre = this.overlay.selectedRegions();
    if (opts?.grabAt && !pre.length) return;
    this.active = true;
    this.phase = "pick";
    this.onDone = onDone;
    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown);
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);
    // honour any areas pre-selected in the sketch
    this.selected = pre;
    if (this.selected.length) {
      this.beginDrag();
      if (opts?.grabAt) this.grabHandle(opts.grabAt.x, opts.grabAt.y);
    } else {
      setPrompt("Click a profile · Ctrl-click adds areas · Enter");
    }
  }

  /** Take hold of the arrow at (x, y) without a fresh pointerdown of our own —
   *  the press that started the gesture landed on the passive selection handle,
   *  before this tool existed. */
  private grabHandle(clientX: number, clientY: number) {
    const first = this.selected[0];
    if (this.phase !== "drag" || !first) return;
    this.fluentGrab = true;
    this.downPos = { x: clientX, y: clientY };
    this.grabProj = axisDragDistance(
      this.viewport,
      clientX,
      clientY,
      this.anchor(),
      first.plane.n,
    );
    // Start at nothing rather than at beginDrag's default 10 mm: the depth is
    // about to follow the hand that is already on the arrow, and a solid that
    // sprang to 10 mm before the first movement would read as the grab itself
    // having done something.
    this.distance = 0;
    this.updatePreview();
    this.viewport.domElement.style.cursor = "grabbing";
  }

  /** Re-open a committed extrude for editing: the model rolls back to just
   *  before it, its sketch is forced visible, the saved profile areas are
   *  pre-selected, and the saved distance seeds (and locks) the input — retype
   *  or Ctrl-click areas, then commit to REPLACE the feature in place (same id,
   *  one undo step). Returns false when the distance is a parameter expression
   *  (the value rows' job). */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = this.store.document.features.find((x) => x.id === featureId);
    if (!f || f.type !== "extrude") return false;
    if (typeof f.distance !== "number" || this.store.isParamBound({ kind: "feature", feature: f.id, field: "distance" }))
      return false; // parameter-driven distance — the value rows' job

    this.active = true;
    this.phase = "pick";
    this.onDone = onDone;
    this.editId = featureId;
    this.editOp = f.operation;
    this.editHiddenBodies = f.hiddenBodies;
    this.distance = f.distance;
    this.forcedSketchId = f.sketch;

    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown);
    window.addEventListener("keydown", this.boundKey, true);

    // roll the model back so the pre-extrude state is what previews/op-guesses
    // see (exactly what the tool saw at creation), then rebuild the overlay so
    // the now-forced-visible sketch contributes regions to select from.
    this.store.beginEditPreview(featureId);
    this.overlay.update(this.store.document);
    const saved: [number, number, number][] = (
      f.regions ?? (f.region ? [f.region] : [])
    ) as [number, number, number][];
    this.overlay.selectRegionsByPoints(saved);
    this.selected = this.overlay.selectedRegions();
    if (this.selected.length) {
      this.beginDrag();
    } else {
      setPrompt("Its areas are gone, click a profile · Esc");
    }
    return true;
  }

  private onMove(e: PointerEvent) {
    if (this.phase === "pick") {
      const r = this.regionUnder(e.clientX, e.clientY);
      this.overlay.setHoverRegion(r);
      this.viewport.domElement.style.cursor = r ? "pointer" : "default";
      return;
    }
    if (!this.selected.length) return;
    const first = this.selected[0];
    if (!first) return;
    const plane = first.plane;
    const anchor = this.anchor();
    if (!this.dim.isUserDriven("distance")) {
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, anchor, plane.n);
      // Relative once the handle has been grabbed, absolute otherwise — see
      // grabProj. Both come off the same projection; only the origin differs.
      const d = this.grabProj == null ? proj : proj - this.grabProj;
      this.distance = d;
      this.dim.updateFromCursor({ distance: Math.abs(d) });
    } else {
      const v = this.dim.getValue("distance");
      if (v != null) this.distance = v; // the field is the truth: typed sign wins
    }
    this.positionDim(anchor);
    this.updatePreview();
  }

  /** Park the depth input at a STABLE spot near the profile — anchored to the
   *  selection center (which doesn't move while you drag depth), offset off the
   *  geometry and clamped inside the viewport. Following the cursor made the box
   *  (and its buttons) impossible to click. */
  private positionDim(anchor: THREE.Vector3 = this.anchor()) {
    const s = this.viewport.projectToScreen(anchor);
    const rect = this.viewport.domElement.getBoundingClientRect();
    const boxW = 160, boxH = 46, m = 12;
    const fx = Math.max(rect.left + m, Math.min(s.x + 28, rect.right - boxW - m));
    const fy = Math.max(rect.top + m, Math.min(s.y + 28, rect.bottom - boxH - m));
    this.dim.position(fx - 16, fy - 16); // dim.position adds a +16 cursor offset
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.phase === "pick") {
      const r = this.regionUnder(e.clientX, e.clientY);
      if (!r) return;
      e.preventDefault();
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;
      this.overlay.toggleRegionSelection(r, additive);
      this.selected = this.overlay.selectedRegions();
      // plain click picks one area and goes straight to depth; Ctrl-click keeps
      // accumulating (Enter confirms the set)
      if (!additive && this.selected.length) this.beginDrag();
      return;
    }
    e.preventDefault();
    // Ctrl-click keeps changing WHICH areas, even once the depth is being set.
    // The prompt has said "Ctrl-click areas" for as long as the edit flow has
    // existed and the tool did not honour it: every click in the drag phase
    // committed, the modified one included — so re-opening an extrude to fix
    // the areas it caught ended the moment you tried to.
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const r = this.regionUnder(e.clientX, e.clientY);
      // A modifier click on empty space is not a commit either: it is a miss,
      // and committing on a miss is how a correction becomes a mistake.
      if (!r) return;
      this.overlay.toggleRegionSelection(r, true);
      this.selected = this.overlay.selectedRegions();
      if (!this.selected.length) {
        // Every area taken off. There is nothing to extrude and nothing for the
        // arrow to hang from, so drop back to picking rather than hold a drag
        // over an empty set.
        this.phase = "pick";
        this.dim.hide();
        this.disposePreviewGeom();
        this.previewKey = "";
        // The arrow too: updatePreview early-returns on an empty set, so left
        // alone it would hang in the air pointing out of nothing.
        if (this.arrow) {
          this.viewport.removeFromScene(this.arrow);
          this.arrow.dispose();
          this.arrow = null;
        }
        setPrompt("Click a profile area · Esc");
        return;
      }
      this.positionDim();
      this.updatePreview();
      return;
    }
    this.commit();
  }

  /** Only the fluent gesture ends on a release. Every other entry keeps the
   *  free-track-then-click flow, where a pointerup is just the tail of the
   *  click that onDown already handled. */
  private onUp(e: PointerEvent) {
    if (e.button !== 0 || !this.fluentGrab || this.phase !== "drag") return;
    const release = fluentRelease({
      fluent: true,
      moved: Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3,
      // The same threshold commit() uses to ignore a zero extrude.
      meaningful: Math.abs(this.distance) >= 1e-3,
    });
    // Cleared BEFORE dispatching, not in cleanup: commit() can decline and
    // leave the tool alive (a zero depth is ignored rather than committed), and
    // a stale flag would then make the NEXT release of any click re-run this
    // decision on a gesture that ended long ago.
    this.fluentGrab = false;
    if (release === "commit") return this.commit();
    if (release === "cancel") return this.cancel();
    // Stayed armed: a press that never travelled is the way IN to the full
    // tool. The depth keeps tracking relative to where the arrow was taken
    // hold of, which is exactly where the pointer still is, so nothing jumps.
    this.viewport.domElement.style.cursor = "default";
  }

  private onKey(e: KeyboardEvent) {
    if (this.dim.isActive && e.target instanceof HTMLInputElement) {
      if (e.key === "Escape") this.cancel();
      return;
    }
    if (e.key === "Escape") this.cancel();
    else if (e.key === "Enter" && this.phase === "pick" && this.selected.length) this.beginDrag();
  }

  private beginDrag() {
    this.phase = "drag";
    this.overlay.setHoverRegion(null);
    this.dim.show([{ name: "distance", label: "D" }], () => this.commit(), () => this.cancel());
    if (this.editId) {
      // seed the SIGNED saved distance and lock the field (userDriven): extrude's
      // onMove free-tracks the cursor and would clobber the seed on the first
      // move otherwise. Cursor-scrub is deliberately off in edit mode — retype
      // or commit. (Seeding the abs value would silently drop a cut's sign the
      // moment getValue is read back — the DimInput abs-display trap.)
      this.dim.seed("distance", this.distance);
    } else {
      this.distance = 10;
    }
    this.shownOp = null;
    this.promptKey = "";
    this.refreshPrompt();
    this.positionDim();
    this.updatePreview();
  }

  // --- geometry helpers ---
  /** the front-most region whose material (loop minus holes) contains the cursor */
  private regionUnder(cx: number, cy: number): WorldRegion | null {
    const ray = this.viewport.rayFrom(cx, cy).ray;
    let best: WorldRegion | null = null;
    let bestDist = Infinity;
    for (const wr of this.overlay.regions) {
      if (!ray.intersectPlane(wr.plane.plane, this.hitScratch)) continue;
      const p2d = wr.plane.to2D(this.hitScratch);
      if (!pointInRegion(p2d, wr.region)) continue;
      const d = ray.origin.distanceToSquared(this.hitScratch);
      if (d < bestDist) {
        bestDist = d;
        best = wr;
      }
    }
    return best;
  }

  /** average of the selected areas' interior points — the arrow anchor.
   *  Shared with the passive handle so the two arrows stand in the same place
   *  across the hand-off (features/regionNudge.ts). */
  private anchor(): THREE.Vector3 {
    return regionAnchor(this.selected);
  }

  private updatePreview() {
    if (!this.selected.length) return;
    this.refreshPrompt();
    const sign = this.distance >= 0 ? 1 : -1;
    const depth = Math.abs(this.distance);
    const cut = sign < 0;

    const ids = this.selected
      .map((s) => `${s.sketchId}:${s.interior3D.x.toFixed(2)},${s.interior3D.y.toFixed(2)}`)
      .join("|");
    const key = `${depth.toFixed(3)}:${sign}:${ids}`;
    if (key !== this.previewKey) {
      this.previewKey = key;
      this.disposePreviewGeom();
      if (!this.previewMat) {
        this.previewMat = new THREE.MeshStandardMaterial({
          transparent: true,
          opacity: 0.5,
          metalness: 0.1,
          roughness: 0.6,
        });
      }
      this.preview = new THREE.Group();
      for (const wr of this.selected) {
        const shape = new THREE.Shape(wr.region.loop.map((p) => p.clone()));
        for (const h of wr.region.holes) {
          shape.holes.push(new THREE.Path(h.map((p) => p.clone())));
        }
        const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
        geo.applyMatrix4(wr.plane.basisMatrix(sign)); // local +Z -> plane normal (flipped on cut)
        this.preview.add(new THREE.Mesh(geo, this.previewMat));
      }
      this.viewport.addToScene(this.preview);
    }
    this.previewMat?.color.set(cut ? 0xff5c5c : 0x5b9bff);

    // arrow manipulator along the (shared) normal, anchored at the selection center
    const first = this.selected[0];
    if (!first) return;
    const plane = first.plane;
    const anchor = this.anchor();
    const dir = plane.n.clone().multiplyScalar(sign);
    if (!this.arrow) {
      this.arrow = new THREE.ArrowHelper(dir, anchor, depth || 1, 0xffd24a, 6, 3);
      this.viewport.addToScene(this.arrow);
    } else {
      this.arrow.position.copy(anchor);
      this.arrow.setDirection(dir);
      this.arrow.setLength(Math.max(depth, 1), 6, 3);
    }
  }

  // Does the extrude direction push INTO existing material? One of the four facts
  // features/extrudeOperation.ts reads, and the only one that needs the scene: it
  // steps each area's interior a hair along the direction and asks the model.
  //
  // This replaced a pure drag-SIGN guess, which defaulted "push a face through the
  // model" to Join and silently no-op'd (the union was already inside the body).
  private entersSolid(): boolean {
    if (!this.selected.length) return false;
    const sign = this.distance >= 0 ? 1 : -1;
    let inside = 0;
    for (const wr of this.selected) {
      // step the area's interior a hair along the extrude direction, off its face
      const p = wr.interior3D.clone().addScaledVector(wr.plane.n, sign * 0.05);
      if (this.viewport.pointInSolid(p)) inside++;
    }
    return inside * 2 > this.selected.length; // majority of selected areas
  }

  /** The situation the rules in features/extrudeOperation.ts read, measured off
   *  the live model and the live selection. Everything the commit modal used to
   *  pre-sort its list by, gathered in one place. */
  private plannedOperation(): Op {
    return plannedOperation({
      savedOperation: this.editId ? this.editOp : null,
      hasSolid: (this.store.buildState.result?.mesh.positions.length ?? 0) > 0,
      entersSolid: this.entersSolid(),
      allGlyphs: this.selected.length > 0 && this.selected.every((wr) => wr.entityId !== undefined),
    });
  }

  /** The operation, on the prompt line, following the drag across zero.
   *
   *  This is what replaced the commit dialog. The dialog's one honest job was
   *  saying which boolean you were about to get; a line that says so while you
   *  are still dragging does that job without stopping the gesture to do it.
   *
   *  Gated on the two things the answer can turn on — which side of zero the
   *  depth is, and how many areas are selected — because this runs on every
   *  pointermove and plannedOperation() casts a ray through the whole model per
   *  selected area. Nothing else moves during a drag: the model and the areas
   *  are fixed, and the depth's MAGNITUDE cannot change which boolean is meant.
   *  A dropped frame of a stale word is not a risk here; a raycast per area per
   *  move on an imported assembly is. */
  private shownOp: Op | null = null;
  private promptKey = "";
  private refreshPrompt() {
    if (this.phase !== "drag") return;
    const key = `${this.distance >= 0 ? "+" : "-"}${this.selected.length}`;
    if (key === this.promptKey) return;
    this.promptKey = key;
    const op = this.plannedOperation();
    if (op === this.shownOp) return;
    this.shownOp = op;
    const word = OP_WORD[op];
    setPrompt(
      this.editId
        ? `${word} · Ctrl-click areas · drag or type a value · click to apply · Esc`
        : `${word} · drag or type a depth, negative cuts · click to commit · Esc`,
    );
  }

  private commit() {
    if (!this.selected.length) return this.cancel();
    const v = this.dim.getValue("distance");
    // GATE on isUserDriven: while dragging, the field displays |distance| —
    // reading it back unconditionally strips the drag's sign and sends the
    // extrude the wrong way ("Cut removed nothing" on cut-toward-body).
    // Typed values (userDriven) carry their own sign and win.
    if (v != null && this.dim.isUserDriven("distance")) this.distance = v;
    if (Math.abs(this.distance) < 1e-3) return; // ignore zero
    const op = this.plannedOperation();
    const first = this.selected[0];
    if (!first) return;
    const hiddenBodies = this.editId ? this.editHiddenBodies : this.store.hiddenBodyIds();
    const feature: Feature = {
      id: this.editId ?? this.store.nextId(),
      type: "extrude",
      sketch: first.sketchId,
      distance: Math.round(this.distance * 1000) / 1000,
      operation: op,
      regions: this.selected.map((wr) => [wr.interior3D.x, wr.interior3D.y, wr.interior3D.z]),
      // capture the participants NOW: bodies hidden at creation stay excluded
      // from this boolean forever; later eye toggles are pure display. When
      // EDITING, the ORIGINAL capture is kept — re-capturing here would let
      // display toggles rewrite committed boolean history.
      ...(hiddenBodies !== undefined ? { hiddenBodies } : {}),
    };
    const id = feature.id;
    if (this.editId) {
      this.store.endEditPreview(false); // replaceFeature triggers the rebuild
      this.store.replaceFeature(this.editId, feature);
    } else {
      this.store.addFeature(feature);
    }
    this.overlay.clearRegionSelection();
    this.cleanup();
    this.onDone?.(id);
  }

  cancel() {
    if (this.editId) {
      this.store.endEditPreview();
      this.overlay.clearRegionSelection();
    }
    this.cleanup();
    this.onDone?.(null);
  }

  private cleanup() {
    const el = this.viewport.domElement;
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown);
    el.removeEventListener("pointerup", this.boundUp);
    window.removeEventListener("keydown", this.boundKey, true);
    el.style.cursor = "default";
    this.fluentGrab = false;
    this.grabProj = null;
    this.dim.hide();
    this.disposePreviewGeom();
    this.previewMat?.dispose();
    this.previewMat = null;
    this.previewKey = "";
    if (this.arrow) {
      this.viewport.removeFromScene(this.arrow);
      this.arrow.dispose();
      this.arrow = null;
    }
    this.overlay.setHoverRegion(null);
    this.viewport.suspendPicking = false;
    this.active = false;
    this.selected = [];
    if (this.editId !== null || this.forcedSketchId !== null) {
      this.editId = null;
      this.editOp = null;
      this.editHiddenBodies = undefined;
      this.forcedSketchId = null;
      this.overlay.update(this.store.document); // re-hide the consumed sketch
    }
    setPrompt(null);
  }

  /** remove + dispose the preview group's geometries (the material is reused) */
  private disposePreviewGeom() {
    if (!this.preview) return;
    this.viewport.removeFromScene(this.preview);
    for (const child of this.preview.children) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    this.preview = null;
  }
}
