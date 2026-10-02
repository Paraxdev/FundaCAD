// Driving a mechanism where its drive joint is: an arrow along the joint's axis
// for a slider drive (the offset), a dial about it for a revolute one (the angle).
//
// The drive is the one number that moves the whole linkage, so it belongs on the
// model the way a joint's offset and angle do (see jointTool.ts, whose handles
// these are): take hold and the linkage follows, rebuilt by the engine each step.
// The value box is still there and still authoritative.
//
// The axis is the drive joint's reference frame as the engine solved it, which
// only the engine can place. It arrives each rebuild in the build result's
// datumMarks under the mechanism's id. No mark (no drive, or the linkage did not
// close this build), no handle: the tool stands down and the value rows take over.
// A mechanism fresh from the starter has no drive value, and the engine then
// leaves the parts as modelled; the mark's `value` says where that is, and the
// handle starts from it rather than from 0, which would jump the linkage.
//
// Unlike the joint's handles this one keeps working when the drive value is a
// bare reference to a parameter (`crank_angle`): the drag then writes the
// parameter, the way the fillet arrow does, so everything else that reads it moves
// too. A real expression stays refused, a drag cannot write a number into it.
//
// The preview builds in place, so the features after the mechanism (an
// interference check, a body that joins the moved parts) stay on screen while the
// linkage moves.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, ParamTarget, Vec3 } from "../types";
import { driveField, driveStart } from "../document/mechanism";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { toast } from "../ui/toast";
import { snap } from "../ui/units";
import {
  axisDragDistance,
  createDragHandle,
  createRotationArc,
  leanOutOfView,
  type DragHandle,
} from "./manipulator";
import {
  ROTATE_SNAP_DEG,
  angleInFrame,
  ringDragDegenerate,
  rotationFrame,
  snapDegrees,
} from "./transformGizmo";
import { unwrapTurn } from "./screwMath";
import { CanvasGesture } from "./canvasGesture";

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);

export class MechanismTool {
  active = false;

  private id: string | null = null;
  /** `offset` for a slider drive (the arrow), `angle` for a revolute one (the dial) */
  private field: "offset" | "angle" = "angle";
  /** the parameter the drive value merely references, written instead of the field */
  private paramRef: string | null = null;
  private base = new THREE.Vector3(); // the drive axis origin, value 0 for a slider
  private dir = new THREE.Vector3(0, 0, 1); // the drive axis direction
  private anchor = new THREE.Vector3(); // where the handle stands
  private dialX = new THREE.Vector3(1, 0, 0); // an in-plane reference perpendicular to dir
  private value = 0;
  private opened = 0;

  private gizmo: THREE.Group | null = null;
  private handle: DragHandle | null = null;
  private quat = new THREE.Quaternion();

  private hovering = false;
  private grabbing = false;
  private grabProj = 0;
  private grabValue = 0;
  private grabTurn = 0;
  private lastTurn = 0;
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

  /** Open the drive handle on a committed mechanism. False sends the caller to the
   *  value rows: there is no drive (or it names a rigid joint), an expression drives
   *  the value, the engine published no drive axis this build, or the value is
   *  unset and the mark does not say where the linkage stands. */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = this.store.document.features.find((x) => x.id === featureId);
    if (!f || f.type !== "mechanism") return false;
    const values = f as unknown as Record<string, unknown>;
    const field = driveField(values);
    if (!field) return false;
    const target: ParamTarget = { kind: "feature", feature: f.id, field };
    const paramRef = this.store.bareParamRef(target);
    if (this.store.isParamBound(target) && !paramRef) return false;
    const mark = this.store.buildState.result?.datumMarks?.[featureId];
    if (!mark || mark.kind !== "axis") return false;
    const start = driveStart(values[field], mark);
    if (start === null) return false;

    this.active = true;
    this.id = featureId;
    this.field = field;
    this.paramRef = paramRef;
    this.onDone = onDone;
    this.value = start;
    this.opened = this.value;
    this.base.copy(v3(mark.origin));
    this.dir.copy(v3(mark.dir));
    if (this.dir.lengthSq() < 1e-12) this.dir.set(0, 0, 1);
    this.dir.normalize();
    const up = Math.abs(this.dir.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    this.dialX.copy(up).cross(this.dir).normalize();

    this.viewport.suspendPicking = true;
    this.gesture.attach();
    this.handle = field === "offset" ? createDragHandle() : createRotationArc();
    this.gizmo = this.handle.group;
    this.viewport.addToScene(this.gizmo);
    this.dim.show(
      [field === "offset"
        ? { name: "offset", label: "Drive offset", kind: "length" }
        : { name: "angle", label: "Drive angle", kind: "angle" }],
      () => this.commit(),
      () => this.cancel(),
    );
    this.dim.updateFromCursor({ [field]: this.value });
    setPrompt(field === "offset"
      ? "Drag the arrow to slide the drive joint, the linkage follows. The value can be typed. Enter applies, Esc cancels."
      : "Drag the dial to turn the drive joint, the linkage follows. The value can be typed. Enter applies, Esc cancels.");
    this.gesture.frame();
    return true;
  }

  private onMove(e: PointerEvent) {
    if (this.grabbing) {
      let next: number;
      if (this.field === "offset") {
        const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.base, this.dir);
        next = snap(this.grabValue + (proj - this.grabProj), this.viewport.snapStep(this.anchor, e.shiftKey));
      } else {
        const now = this.cursorTurn(e.clientX, e.clientY);
        if (now === null) return; // the view went edge-on mid-drag; hold the value
        this.lastTurn = unwrapTurn(this.lastTurn, now);
        next = snapDegrees(this.grabValue + (this.lastTurn - this.grabTurn), e.shiftKey ? 0 : ROTATE_SNAP_DEG);
      }
      if (next === this.value) return;
      this.value = next;
      this.dim.updateFromCursor({ [this.field]: this.value });
      this.pushPreview();
      return;
    }
    this.hovering = this.over(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    this.downOnGizmo = this.over(e.clientX, e.clientY);
    if (!this.downOnGizmo) return;
    if (this.field === "offset") {
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.base, this.dir);
    } else {
      const start = this.cursorTurn(e.clientX, e.clientY);
      if (start === null) return; // edge-on: leave the press to the orbit
      this.grabTurn = start;
      this.lastTurn = start;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    this.grabbing = true;
    this.dim.takeOver(this.field);
    this.grabValue = this.value;
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
    // a slider's arrow rides at the drive value along the axis; a dial stays put
    this.anchor.copy(this.base);
    if (this.field === "offset") this.anchor.addScaledVector(this.dir, this.value);
    const px = this.viewport.pixelWorldSize(this.anchor);
    this.gizmo.position.copy(this.anchor);
    if (this.field === "offset") {
      const fwd = this.viewport.camera.getWorldDirection(new THREE.Vector3());
      const right = new THREE.Vector3().setFromMatrixColumn(this.viewport.camera.matrixWorld, 0).normalize();
      this.quat.setFromUnitVectors(Y_AXIS, leanOutOfView(this.dir, fwd, right));
      this.gizmo.quaternion.copy(this.quat);
    } else {
      const dy = new THREE.Vector3().crossVectors(this.dir, this.dialX).normalize();
      this.gizmo.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(this.dialX, dy, this.dir));
    }
    this.gizmo.scale.setScalar(px);
    this.handle?.paint({ hot: this.hovering || this.grabbing });
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
    if (!this.grabbing) this.readField();
    this.gesture.frame();
  }

  /** Take a typed value once the user has actually typed it. */
  private readField() {
    const v = this.dim.getValue(this.field);
    if (v == null || !this.dim.isUserDriven(this.field) || Math.abs(v - this.value) <= 1e-9) return;
    this.value = v;
    this.pushPreview();
  }

  /** Where the cursor sits about the drive axis, in degrees, read in the axis's own
   *  plane. Null when that plane is nearly edge-on (see JointTool.cursorTurn). */
  private cursorTurn(x: number, y: number): number | null {
    const view = this.viewport.camera.getWorldDirection(new THREE.Vector3());
    if (ringDragDegenerate(view.dot(this.dir))) return null;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.dir, this.anchor);
    const at = this.viewport.screenToPlane(x, y, plane);
    if (!at) return null;
    return (angleInFrame(at, this.anchor, rotationFrame(this.dir)) * 180) / Math.PI;
  }

  private over(x: number, y: number): boolean {
    if (!this.gizmo) return false;
    return this.viewport.rayFrom(x, y).intersectObjects(this.gizmo.children, false).length > 0;
  }

  private pushPreview() {
    if (!this.active || !this.id) return;
    const f = this.store.document.features.find((x) => x.id === this.id);
    if (!f || f.type !== "mechanism") return;
    const next = { ...f, [this.field]: this.value } as Feature;
    if (this.previewing) {
      this.store.setEditPreview(next);
    } else {
      this.previewing = true;
      this.store.beginEditPreview(this.id, next, { inPlace: true });
    }
  }

  private commit() {
    if (!this.active || !this.id) return;
    const id = this.id;
    const done = this.onDone;
    if (Math.abs(this.value - this.opened) <= 1e-9) {
      this.cleanup(true);
      done?.(id);
      return;
    }
    if (this.paramRef) {
      const refused = this.store.commitFeatureEdit(id, null, { name: this.paramRef, value: this.value });
      if (refused) toast(refused, { kind: "warning" });
      // A commit has ended the preview itself; after a refusal this puts the
      // committed model back.
      this.cleanup(true);
    } else {
      const patch = { [this.field]: this.value } as unknown as Partial<Feature>;
      this.cleanup(false);
      this.store.updateFeature(id, patch);
    }
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
    this.paramRef = null;
    this.id = null;
    this.onDone = null;
    setPrompt(null);
  }
}
