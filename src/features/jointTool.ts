// Setting a joint's OFFSET where the joint is, by dragging its moving body along
// the mate axis.
//
// A joint puts one body's face flush on another's; `offset` is how far it then
// slides along the shared axis, a standoff or an overlap. That is a distance on
// the model, so it belongs on the model: take hold of the arrow standing on the
// mate axis and pull, the body slides with it. The value box is still there and
// still authoritative, the same contract every other manipulator keeps.
//
// The arrow stands on the REAL mate axis, which only the sidecar can place (it
// alone resolves the two face selectors to a frame). It arrives each rebuild in
// the build result's datumMarks, keyed by the joint's id (the joint handler
// publishes it there, see builder._handle_joint). No mark, no arrow: the tool
// stands down and the value rows take the offset, the same fallback the revolve
// and extrude arrows use when the geometry cannot carry them.
//
// Live preview, unlike the revolve arrow: a joint is a rigid RELOCATE, not a
// sweep through the kernel, so the body can follow the drag frame by frame
// without lurching. The store coalesces the rebuilds.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, Vec3 } from "../types";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import { axisDragDistance, createDragHandle, leanOutOfView, type DragHandle } from "./manipulator";
import { CanvasGesture } from "./canvasGesture";

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);

type Joint = Extract<Feature, { type: "joint" }>;

export class JointTool {
  active = false;

  private id: string | null = null;
  private base = new THREE.Vector3(); // the mate axis origin, offset 0
  private dir = new THREE.Vector3(1, 0, 0); // the mate axis direction
  private anchor = new THREE.Vector3(); // where the handle stands: base + offset*dir
  private offset = 0;

  private gizmo: THREE.Group | null = null;
  private handle: DragHandle | null = null;
  private quat = new THREE.Quaternion();

  private hovering = false;
  private grabbing = false;
  private grabProj = 0;
  private grabOffset = 0;
  private downPos = { x: 0, y: 0 };
  private downOnGizmo = false;

  private dim = new DimInput();
  private onDone: ((id: string | null) => void) | null = null;
  private previewing = false;

  private readonly gesture: CanvasGesture;

  constructor(
    private viewport: Viewport,
    private store: DocumentStore,
  ) {
    this.gesture = new CanvasGesture(viewport.domElement, {
      move: (e) => this.onMove(e),
      down: (e) => this.onDown(e),
      up: (e) => this.onUp(e),
      key: (e) => this.onKey(e),
      frame: () => this.tick(),
    });
  }

  /** Open the offset arrow on a committed joint. False sends the caller to the
   *  value rows: a parameter drives the offset, or the sidecar could not place
   *  the mate axis this build (a reference no longer resolves), so there is no
   *  line to stand the arrow on. */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = this.store.document.features.find((x) => x.id === featureId);
    if (!f || f.type !== "joint") return false;
    const jt = f as Joint;
    if (this.store.isParamBound({ kind: "feature", feature: jt.id, field: "offset" })) return false;
    const saved = jt.offset;
    if (saved != null && typeof saved !== "number") return false;
    const mark = this.store.buildState.result?.datumMarks?.[featureId];
    if (!mark || mark.kind !== "axis") return false;

    this.active = true;
    this.id = featureId;
    this.onDone = onDone;
    this.offset = saved ?? 0;
    this.base.copy(v3(mark.origin));
    this.dir.copy(v3(mark.dir));
    if (this.dir.lengthSq() < 1e-12) this.dir.set(0, 0, 1);
    this.dir.normalize();

    this.viewport.suspendPicking = true;
    this.gesture.attach();
    this.handle = createDragHandle();
    this.gizmo = this.handle.group;
    this.viewport.addToScene(this.gizmo);
    this.dim.show(
      [{ name: "offset", label: "Offset", kind: "length" }],
      () => this.commit(),
      () => this.cancel(),
    );
    this.dim.updateFromCursor({ offset: this.offset });
    setPrompt("Drag the arrow to slide the joined body along the mate axis. The offset can be typed. Enter applies, Esc cancels.");
    this.gesture.frame();
    return true;
  }

  private onMove(e: PointerEvent) {
    if (this.grabbing) {
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.base, this.dir);
      const raw = this.grabOffset + (proj - this.grabProj);
      const stepped = snap(raw, this.viewport.snapStep(this.anchor, e.shiftKey));
      if (stepped === this.offset) return;
      this.offset = stepped;
      this.dim.updateFromCursor({ offset: this.offset });
      this.pushPreview();
      return;
    }
    const over = this.pick(e.clientX, e.clientY);
    this.hovering = over;
    this.viewport.domElement.style.cursor = over ? "grab" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    this.downOnGizmo = this.pick(e.clientX, e.clientY);
    if (!this.downOnGizmo) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.grabbing = true;
    this.dim.takeOver("offset");
    this.grabOffset = this.offset;
    this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.base, this.dir);
    this.viewport.domElement.style.cursor = "grabbing";
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.grabbing) {
      this.grabbing = false;
      this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
      this.commit();
      return;
    }
    const moved = Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    if (!this.downOnGizmo && !moved) this.commit();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") this.cancel();
  }

  private tick() {
    if (!this.active || !this.gizmo) return;
    this.anchor.copy(this.base).addScaledVector(this.dir, this.offset);
    const fwd = this.viewport.camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().setFromMatrixColumn(this.viewport.camera.matrixWorld, 0).normalize();
    this.quat.setFromUnitVectors(Y_AXIS, leanOutOfView(this.dir, fwd, right));
    this.gizmo.position.copy(this.anchor);
    this.gizmo.quaternion.copy(this.quat);
    this.gizmo.scale.setScalar(this.viewport.pixelWorldSize(this.anchor));
    this.handle?.paint({ hot: this.hovering || this.grabbing });
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
    if (!this.grabbing) this.readField();
    this.gesture.frame();
  }

  /** Take a typed offset once the user has actually typed it. */
  private readField() {
    const o = this.dim.getValue("offset");
    if (o != null && this.dim.isUserDriven("offset") && Math.abs(o - this.offset) > 1e-9) {
      this.offset = o;
      this.pushPreview();
    }
  }

  private pick(x: number, y: number): boolean {
    if (!this.gizmo) return false;
    return this.viewport.rayFrom(x, y).intersectObjects(this.gizmo.children, false).length > 0;
  }

  private pushPreview() {
    if (!this.active || !this.id) return;
    const f = this.store.document.features.find((x) => x.id === this.id);
    if (!f || f.type !== "joint") return;
    const next = { ...f, offset: this.offset || undefined } as Feature;
    if (this.previewing) {
      this.store.setEditPreview(next);
    } else {
      this.previewing = true;
      this.store.beginEditPreview(this.id, next);
    }
  }

  private commit() {
    if (!this.active || !this.id) return;
    const id = this.id;
    const offset = this.offset;
    const done = this.onDone;
    this.cleanup(false);
    // Offset 0 drops the field so a joint that never slid reads exactly as it did
    // before the tool was opened on it.
    this.store.updateFeature(id, { offset: offset || undefined } as unknown as Partial<Feature>);
    done?.(id);
  }

  cancel() {
    const done = this.onDone;
    this.cleanup(true);
    done?.(null);
  }

  private cleanup(rebuild = true) {
    this.gesture.detach();
    this.viewport.domElement.style.cursor = "default";
    if (this.previewing) {
      this.previewing = false;
      this.store.endEditPreview(rebuild);
    }
    this.dim.hide();
    if (this.gizmo) {
      this.viewport.removeFromScene(this.gizmo);
      this.handle?.dispose();
      this.gizmo = null;
      this.handle = null;
    }
    this.viewport.suspendPicking = false;
    this.active = false;
    this.grabbing = false;
    this.hovering = false;
    this.id = null;
    this.onDone = null;
    setPrompt(null);
  }
}
