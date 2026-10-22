// Cross section (Inspect): a clipping plane along an axis, a clicked face or a datum plane. Editing shows the handle,
// the offset box and the F and G keys; confirming keeps the cut on as a view state the Viewport keeps through rebuilds.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { Plane3, PlaneDef, SectionView, Vec3 } from "../types";
import { SECTION_GHOSTS, sameSectionView } from "../document/sectionView";
import { DimInput } from "../sketch/dimInput";
import { clearPrompt, setPrompt } from "../ui/prompt";
import { isEditableTarget } from "../ui/focus";
import { snap } from "../ui/units";
import { axisDragDistance, createDragHandle, nameHandle, HANDLE_UP, type DragHandle } from "./manipulator";
import { pickPlaneTarget } from "./facePlanePick";
import { awaitTreePick, treePickRefusal } from "../ui/treePick";
import { SketchPlane } from "../sketch/plane";
import {
  GHOST_DEFAULT,
  clipPlaneAt,
  ghostAlpha,
  ghostLabel,
  nextGhostLevel,
  sectionAnchor,
  sectionCentre,
  sectionFromPlaneDef,
} from "./sectionMath";
import { CanvasGesture } from "./canvasGesture";

const AXES: Record<string, Vec3> = {
  X: [1, 0, 0],
  Y: [0, 1, 0],
  Z: [0, 0, 1],
};

function baseDef(plane: Plane3): PlaneDef {
  const p = new SketchPlane(plane);
  return { origin: p.origin.toArray(), normal: p.n.toArray(), xdir: p.u.toArray() };
}

/** `pick` leaves the plane to the user's next click on a face or a construction plane. */
export type SectionSource =
  | { kind: "axis"; axis: "X" | "Y" | "Z" }
  | { kind: "plane"; def: PlaneDef }
  | { kind: "pick" };

export type SectionPhase = "off" | "aiming" | "editing" | "on";

export interface SectionDeps {
  /** Another tool or a sketch owns the gesture. */
  toolBusy?: () => boolean;
  datumDef?: (id: string) => PlaneDef | null;
  /** After an explicit confirm, not one forced by another tool taking the screen. */
  afterEdit?: () => void;
  /** Where the cut is saved. The tool writes every change to it and takes on any change it did not write. */
  saved?: {
    get(): Readonly<SectionView> | null;
    set(v: SectionView | null): void;
    onChange(fn: (v: Readonly<SectionView> | null) => void): () => void;
  };
}

export class SectionTool {
  private state: SectionPhase = "off";
  private listeners = new Set<(p: SectionPhase) => void>();

  private plane = new THREE.Plane();
  private origin: Vec3 = [0, 0, 0]; // a point on the defining plane
  private normal: Vec3 = [0, 0, 1]; // its unit normal, also the drag axis
  private offset = 0;
  private side: 1 | -1 = 1;
  private ghost = GHOST_DEFAULT;

  private gizmo: THREE.Group | null = null;
  private handle: DragHandle | null = null;
  private hovering = false;
  private grabbing = false;
  private grabOffset = 0;
  private grabProj = 0;
  private sawIdle = false;
  private onDone: (() => void) | null = null;
  private releaseTree: (() => void) | null = null;
  private writing = false;
  /** The cut as the store holds it, normalised, so the echo of a write is not mistaken for a change. */
  private savedCut: Readonly<SectionView> | null = null;
  private editPrompt = "";

  private dim = new DimInput();
  private pointV = new THREE.Vector3();
  private axisV = new THREE.Vector3();

  private readonly gesture: CanvasGesture;
  private readonly pickGesture: CanvasGesture;

  constructor(
    private viewport: Viewport,
    private deps: SectionDeps = {},
  ) {
    this.gesture = new CanvasGesture(viewport.domElement, {
      move: (e) => this.onMove(e),
      down: (e) => this.onDown(e),
      up: (e) => this.onUp(e),
      key: (e) => this.onKey(e),
      frame: () => this.tick(),
    });
    this.pickGesture = new CanvasGesture(viewport.domElement, {
      move: (e) => this.onPickMove(e),
      down: (e) => this.onPickDown(e),
      key: (e) => this.onPickKey(e),
    });
    deps.saved?.onChange((v) => this.adopt(v));
  }

  get phase(): SectionPhase {
    return this.state;
  }

  /** A cut is drawn. Not counted by toolBusy(), so every other tool works with the cut on. */
  get active(): boolean {
    return this.state === "editing" || this.state === "on";
  }

  get editing(): boolean {
    return this.state === "editing";
  }

  /** Waiting for the face or plane to cut along, a modal pick that toolBusy() counts. */
  get picking(): boolean {
    return this.state === "aiming";
  }

  onChange(fn: (p: SectionPhase) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private setPhase(p: SectionPhase) {
    if (p === this.state) return;
    this.state = p;
    for (const fn of [...this.listeners]) fn(p);
  }

  start(src: SectionSource | "X" | "Y" | "Z", onDone?: () => void) {
    if (this.state !== "off") return;
    if (!this.viewport.modelBox()) return;
    this.onDone = onDone ?? null;
    const source: SectionSource = typeof src === "string" ? { kind: "axis", axis: src } : src;
    if (source.kind === "pick") this.beginPick();
    // A world axis has no clicked point, so the cut starts through the middle of the model.
    else if (source.kind === "axis") this.arm(this.modelCentre(), AXES[source.axis] ?? [0, 0, 1]);
    else this.armOn(source.def);
  }

  /** Keep the cut and put the handle away, applying a valid typed offset first. */
  confirm() {
    if (this.state !== "editing") return;
    this.applyTypedOffset();
    this.finishEdit();
    this.deps.afterEdit?.();
  }

  /** Bring the handle back on the cut that is on. */
  edit() {
    if (this.state === "on") this.beginEdit();
  }

  /** Keep the other half, without moving the cut. */
  flip() {
    if (!this.active) return;
    this.side = this.side === 1 ? -1 : 1;
    this.pushPlane();
    this.save();
  }

  /** Remove the cut, from any phase. */
  stop() {
    const had = this.active;
    this.clear();
    if (had) this.save(null);
  }

  private clear() {
    const was = this.state;
    if (was === "off") return;
    if (was === "aiming") this.endPick();
    else {
      if (was === "editing") {
        this.dropChrome();
        clearPrompt(this.editPrompt);
      }
      this.viewport.setSectionView(null);
    }
    this.setPhase("off");
    this.finishDone();
  }

  private save(cut: SectionView | null = this.view()) {
    const saved = this.deps.saved;
    if (!saved) return;
    this.writing = true;
    try {
      saved.set(cut);
    } finally {
      this.writing = false;
    }
    this.savedCut = saved.get();
  }

  private view(): SectionView {
    return {
      origin: [...this.origin],
      normal: [...this.normal],
      offset: this.offset,
      side: this.side,
      ghost: SECTION_GHOSTS[this.ghost] ?? "soft",
    };
  }

  /** A cut that changed under the tool (an open, New, a version, an assistant's edit) ends any aim or edit. */
  private adopt(v: Readonly<SectionView> | null) {
    if (this.writing || sameSectionView(v, this.savedCut)) return;
    this.savedCut = v;
    if (!v) return this.clear();
    this.endEdit();
    this.origin = [...v.origin];
    this.normal = [...v.normal];
    this.offset = v.offset;
    this.side = v.side;
    const level = SECTION_GHOSTS.indexOf(v.ghost);
    this.ghost = level < 0 ? GHOST_DEFAULT : level;
    this.pushPlane();
    this.setPhase("on");
  }

  /** For a document swap: an aim ends, an edit is kept on, and nothing else changes. */
  endEdit() {
    if (this.state === "aiming") {
      this.endPick();
      this.setPhase("off");
      this.finishDone();
    } else if (this.state === "editing") this.finishEdit();
  }

  private finishDone() {
    const done = this.onDone;
    this.onDone = null;
    done?.();
  }

  private modelCentre(): Vec3 {
    const box = this.viewport.modelBox();
    const c = box ? box.getCenter(this.pointV) : this.pointV.set(0, 0, 0);
    return [c.x, c.y, c.z];
  }

  /** Anchored on the point of the plane nearest the model: a face plane's own origin is the world origin projected
   *  onto it, which for an off centre part puts the handle off screen. */
  private armOn(def: PlaneDef) {
    const { origin, normal } = sectionFromPlaneDef(def);
    this.arm(sectionAnchor(origin, normal, this.modelCentre()), normal);
  }

  // --- aiming ----------------------------------------------------------------

  private beginPick() {
    this.viewport.suspendPicking = true;
    this.viewport.showAllPlanes(true);
    this.pickGesture.attach();
    this.releaseTree = awaitTreePick((pick) => {
      const def = pick.kind === "datumPlane" ? pick.def : pick.kind === "basePlane" ? baseDef(pick.plane) : null;
      if (!def) return treePickRefusal(pick, "a plane, or a face picked in the view");
      this.endPick();
      this.armOn(def);
      return true;
    }, () => this.stop());
    setPrompt("Click a face or plane to cut along · Esc");
    this.setPhase("aiming");
  }

  private endPick() {
    this.releaseTree?.();
    this.releaseTree = null;
    this.viewport.suspendPicking = false;
    this.viewport.showAllPlanes(false);
    this.pickGesture.detach();
    this.viewport.clearHover();
    this.viewport.hoverDatum(null);
    setPrompt(null);
  }

  private onPickMove(e: PointerEvent) {
    const target = pickPlaneTarget(this.viewport, e.clientX, e.clientY);
    if (target?.kind === "face") {
      this.viewport.hoverFaceAt(e.clientX, e.clientY);
      this.viewport.hoverPlane(null);
      this.viewport.hoverDatum(null);
    } else {
      this.viewport.clearHover();
      this.viewport.hoverPlane(target?.kind === "base" ? target.spec : null);
      this.viewport.hoverDatum(target?.kind === "datum" ? target.id : null);
    }
  }

  private onPickDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const def = this.planeAt(e.clientX, e.clientY);
    if (!def) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.endPick();
    this.armOn(def);
  }

  private onPickKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    this.endPick();
    this.setPhase("off");
    this.finishDone();
  }

  /** A construction plane wins over the body behind it: the user placed it on purpose. */
  private planeAt(x: number, y: number): PlaneDef | null {
    const datum = this.viewport.pickDatumAt(x, y);
    if (datum) {
      const def = this.deps.datumDef?.(datum);
      if (def) return def;
    }
    const target = pickPlaneTarget(this.viewport, x, y);
    if (!target || target.kind === "unusable") return null;
    if (target.kind === "base") return baseDef(target.spec);
    return target.spec;
  }

  // --- editing ---------------------------------------------------------------

  private arm(origin: Vec3, normal: Vec3) {
    this.origin = origin;
    this.normal = normal;
    this.offset = 0;
    this.side = 1;
    this.pushPlane();
    this.save();
    this.beginEdit();
  }

  private beginEdit() {
    this.sawIdle = false;
    this.gesture.attach();
    this.handle = nameHandle(createDragHandle(), "section");
    this.gizmo = this.handle.group;
    this.viewport.addToScene(this.gizmo, "section");
    this.dim.show([{ name: "offset", label: "Offset", kind: "length" }], () => this.confirm());
    this.dim.updateFromCursor({ offset: this.offset });
    this.place();
    this.prompt();
    this.setPhase("editing");
    this.gesture.frame();
    this.viewport.requestRender();
  }

  private finishEdit() {
    this.dropChrome();
    clearPrompt(this.editPrompt);
    this.setPhase("on");
  }

  private dropChrome() {
    this.gesture.detach();
    this.viewport.domElement.style.cursor = "default";
    this.dim.hide();
    if (this.gizmo) {
      this.viewport.removeFromScene(this.gizmo);
      this.handle?.dispose();
      this.gizmo = null;
      this.handle = null;
    }
    this.grabbing = false;
    this.hovering = false;
    this.viewport.requestRender();
  }

  /** The viewport owns the cut from here, including putting it back after every rebuild. */
  private pushPlane() {
    const c = clipPlaneAt(this.origin, this.normal, this.offset, this.side);
    this.plane.set(this.axisV.set(c.normal[0], c.normal[1], c.normal[2]), c.constant);
    this.viewport.setSectionView({ plane: this.plane, ghost: ghostAlpha(this.ghost) });
  }

  private centre(): THREE.Vector3 {
    const c = sectionCentre(this.origin, this.normal, this.offset);
    return this.pointV.set(c[0], c[1], c[2]);
  }

  private onMove(e: PointerEvent) {
    if (this.grabbing) {
      const proj = this.dragProj(e.clientX, e.clientY);
      const raw = this.grabOffset + (proj - this.grabProj);
      const stepped = snap(raw, this.viewport.snapStep(this.centre(), e.shiftKey));
      if (stepped === this.offset) return;
      this.offset = stepped;
      this.pushPlane();
      this.save();
      this.dim.updateFromCursor({ offset: this.offset });
      return;
    }
    this.hovering = this.hitGizmo(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
  }

  private dragProj(x: number, y: number): number {
    const o = this.origin;
    const n = this.normal;
    return axisDragDistance(
      this.viewport,
      x,
      y,
      new THREE.Vector3(o[0], o[1], o[2]),
      this.axisV.set(n[0], n[1], n[2]),
    );
  }

  private onDown(e: PointerEvent) {
    // Only the handle is ours, every other click still selects through the cut.
    if (e.button !== 0 || !this.hitGizmo(e.clientX, e.clientY)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.grabbing = true;
    this.grabOffset = this.offset;
    this.grabProj = this.dragProj(e.clientX, e.clientY);
  }

  private onUp(e: PointerEvent) {
    if (e.button === 0) this.grabbing = false;
  }

  private onKey(e: KeyboardEvent) {
    const letter = e.ctrlKey || e.metaKey || e.altKey ? "" : e.key.toLowerCase();
    // Our box holds focus from the moment editing starts, so Esc there is ours, and F and G are too until something
    // is typed: no offset starts with either letter.
    const ownDim = this.dim.isActive && this.dim.ownsTarget(e.target);
    const ours = e.key === "Escape" || ((letter === "f" || letter === "g") && !this.dim.isUserDriven("offset"));
    if (isEditableTarget(e.target) && !(ownDim && ours)) return;
    if (e.key === "Escape") this.confirm();
    else if (letter === "f") {
      e.preventDefault();
      e.stopImmediatePropagation(); // F is also Fillet
      this.flip();
    } else if (letter === "g") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.ghost = nextGhostLevel(this.ghost);
      this.pushPlane();
      this.save();
      this.prompt();
    }
  }

  private tick() {
    if (this.state !== "editing" || !this.gizmo) return;
    // Another tool taking the screen confirms the edit, on a rise only: a flag already up when editing began
    // (a chooser closing, a Move gizmo) must not end it on its first frame.
    if (this.deps.toolBusy?.()) {
      if (this.sawIdle) return this.finishEdit();
    } else this.sawIdle = true;
    this.gesture.frame();
    this.place();
    if (!this.grabbing && this.dim.isUserDriven("offset")) {
      // Read the typed value only through isUserDriven, never the |value| the box shows while dragging.
      const v = this.dim.getValue("offset");
      if (v != null && Math.abs(v - this.offset) > 1e-6) {
        this.offset = v;
        this.pushPlane();
        this.save();
      }
    }
  }

  private place() {
    const g = this.gizmo;
    if (!g) return;
    const c = this.centre();
    g.position.copy(c);
    g.quaternion.setFromUnitVectors(
      HANDLE_UP,
      this.axisV.set(this.normal[0], this.normal[1], this.normal[2]).multiplyScalar(this.side),
    );
    g.scale.setScalar(this.viewport.pixelWorldSize(c));
    // The viewport renders on demand and a raycast reads matrixWorld, so without this the handle is hit tested
    // where it was drawn last.
    g.updateMatrixWorld(true);
    this.handle?.paint({ hot: this.hovering || this.grabbing });
    const s = this.viewport.projectToScreen(c);
    this.dim.position(s.x, s.y);
  }

  private applyTypedOffset() {
    if (!this.dim.isUserDriven("offset")) return;
    const v = this.dim.getValue("offset");
    if (v == null || v === this.offset) return;
    this.offset = v;
    this.pushPlane();
    this.save();
  }

  private prompt() {
    this.editPrompt =
      "Drag the handle or type an offset · F flips the kept side · " +
      `G changes how the cut half shows (${ghostLabel(this.ghost)}) · Enter or Esc keeps the cut`;
    setPrompt(this.editPrompt);
  }

  private hitGizmo(x: number, y: number): boolean {
    const gizmo = this.gizmo;
    if (!gizmo) return false;
    return this.viewport.probe(x, y, (rc) => rc.intersectObjects(gizmo.children, false).length > 0) ?? false;
  }
}
