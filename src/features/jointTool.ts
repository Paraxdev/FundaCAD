// Driving a joint where the joint is: an arrow that slides the moving body along
// the mate axis (offset), and a dial that turns it about that axis (angle).
//
// A joint puts one body's face flush on another's; `offset` is how far it then
// slides along the shared axis (a standoff or an overlap), and `angle` is how
// far it turns about it (the clocking, and a revolute joint's whole freedom).
// Both are quantities on the model, so they belong on the model: take hold of
// the arrow and pull, or the dial and swing. The value boxes are still there and
// still authoritative, the same contract every other manipulator keeps.
//
// Both handles stand on the REAL mate axis, which only the sidecar can place (it
// alone resolves the two face selectors to a frame). It arrives each rebuild in
// the build result's datumMarks, keyed by the joint's id (the joint handler
// publishes it there, see builder._handle_joint). No mark, no handles: the tool
// stands down and the value rows take over, the same fallback the revolve and
// extrude arrows use when the geometry cannot carry them.
//
// Live preview, unlike the revolve arrow: a joint is a rigid RELOCATE, not a
// sweep through the kernel, so the body follows the drag frame by frame without
// lurching. The store coalesces the rebuilds.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, Vec3 } from "../types";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
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

type Joint = Extract<Feature, { type: "joint" }>;

export class JointTool {
  active = false;

  private id: string | null = null;
  private base = new THREE.Vector3(); // the mate axis origin, offset 0
  private dir = new THREE.Vector3(1, 0, 0); // the mate axis direction
  private anchor = new THREE.Vector3(); // where the handles stand: base + offset*dir
  private offset = 0;
  private angle = 0;

  // the offset arrow
  private gizmo: THREE.Group | null = null;
  private handle: DragHandle | null = null;
  private quat = new THREE.Quaternion();
  // the angle dial
  private dial: THREE.Group | null = null;
  private dialHandle: DragHandle | null = null;
  private dialX = new THREE.Vector3(1, 0, 0); // an in-plane reference perpendicular to dir

  private hovering = false;
  private hoveringDial = false;
  private grabbing = false;
  private grabbingAngle = false;
  private grabProj = 0;
  private grabOffset = 0;
  private grabTurn = 0;
  private grabAngle = 0;
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

  /** Open the handles on a committed joint. False sends the caller to the value
   *  rows: a parameter drives the numbers, or the sidecar could not place the
   *  mate axis this build (a reference no longer resolves), so there is no line
   *  to stand the handles on. */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = this.store.document.features.find((x) => x.id === featureId);
    if (!f || f.type !== "joint") return false;
    const jt = f as Joint;
    const bound = (field: string) =>
      this.store.isParamBound({ kind: "feature", feature: jt.id, field });
    if (bound("offset") || bound("angle")) return false;
    if (jt.offset != null && typeof jt.offset !== "number") return false;
    if (jt.angle != null && typeof jt.angle !== "number") return false;
    const mark = this.store.buildState.result?.datumMarks?.[featureId];
    if (!mark || mark.kind !== "axis") return false;

    this.active = true;
    this.id = featureId;
    this.onDone = onDone;
    this.offset = jt.offset ?? 0;
    this.angle = jt.angle ?? 0;
    this.base.copy(v3(mark.origin));
    this.dir.copy(v3(mark.dir));
    if (this.dir.lengthSq() < 1e-12) this.dir.set(0, 0, 1);
    this.dir.normalize();
    // A stable in-plane reference for the dial's frame, whichever way the axis
    // points: cross with world Z unless the axis IS world Z, then use world X.
    const up = Math.abs(this.dir.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    this.dialX.copy(up).cross(this.dir).normalize();

    this.viewport.suspendPicking = true;
    this.gesture.attach();
    this.handle = createDragHandle();
    this.gizmo = this.handle.group;
    this.viewport.addToScene(this.gizmo);
    this.dialHandle = createRotationArc();
    this.dial = this.dialHandle.group;
    this.viewport.addToScene(this.dial);
    this.dim.show(
      [
        { name: "offset", label: "Offset", kind: "length" },
        { name: "angle", label: "Angle", kind: "angle" },
      ],
      () => this.commit(),
      () => this.cancel(),
    );
    this.dim.updateFromCursor({ offset: this.offset, angle: this.angle });
    setPrompt("Drag the arrow to slide the joined body along the mate axis, the dial to turn it about the axis. Either can be typed. Enter applies, Esc cancels.");
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
    if (this.grabbingAngle) {
      const now = this.cursorTurn(e.clientX, e.clientY);
      if (now === null) return; // the view went edge-on mid-drag; hold the value
      this.lastTurn = unwrapTurn(this.lastTurn, now);
      const raw = this.grabAngle + (this.lastTurn - this.grabTurn);
      const stepped = snapDegrees(raw, e.shiftKey ? 0 : ROTATE_SNAP_DEG);
      if (stepped === this.angle) return;
      this.angle = stepped;
      this.dim.updateFromCursor({ angle: this.angle });
      this.pushPreview();
      return;
    }
    const over = this.pick(e.clientX, e.clientY);
    this.hovering = over === "offset";
    this.hoveringDial = over === "angle";
    this.viewport.domElement.style.cursor = over ? "grab" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    const over = this.pick(e.clientX, e.clientY);
    this.downOnGizmo = over !== null;
    if (over === "offset") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.grabbing = true;
      this.dim.takeOver("offset");
      this.grabOffset = this.offset;
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.base, this.dir);
      this.viewport.domElement.style.cursor = "grabbing";
      return;
    }
    if (over !== "angle") return;
    const start = this.cursorTurn(e.clientX, e.clientY);
    if (start === null) return; // edge-on: leave the press to the orbit
    e.preventDefault();
    e.stopImmediatePropagation();
    this.downOnGizmo = true;
    this.grabbingAngle = true;
    this.dim.takeOver("angle");
    this.grabTurn = start;
    this.lastTurn = start;
    this.grabAngle = this.angle;
    this.viewport.domElement.style.cursor = "grabbing";
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.grabbing || this.grabbingAngle) {
      this.grabbing = false;
      this.grabbingAngle = false;
      this.viewport.domElement.style.cursor = this.hovering || this.hoveringDial ? "grab" : "default";
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
    if (!this.active || !this.gizmo || !this.dial) return;
    this.anchor.copy(this.base).addScaledVector(this.dir, this.offset);
    const px = this.viewport.pixelWorldSize(this.anchor);
    // the offset arrow, along the axis (tipped out of view when the axis aims at
    // the camera, exactly as the revolve pitch arrow is)
    const fwd = this.viewport.camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().setFromMatrixColumn(this.viewport.camera.matrixWorld, 0).normalize();
    this.quat.setFromUnitVectors(Y_AXIS, leanOutOfView(this.dir, fwd, right));
    this.gizmo.position.copy(this.anchor);
    this.gizmo.quaternion.copy(this.quat);
    this.gizmo.scale.setScalar(px);
    this.handle?.paint({ hot: this.hovering || this.grabbing });
    // the angle dial, ringed in the plane perpendicular to the axis (local Z is
    // the rotation axis = dir, so the ring lies where a turn about it lives)
    const dy = new THREE.Vector3().crossVectors(this.dir, this.dialX).normalize();
    this.dial.position.copy(this.anchor);
    this.dial.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(this.dialX, dy, this.dir));
    this.dial.scale.setScalar(px);
    this.dialHandle?.paint({ hot: this.hoveringDial || this.grabbingAngle });
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
    if (!this.grabbing && !this.grabbingAngle) this.readFields();
    this.gesture.frame();
  }

  /** Take typed values once the user has actually typed them. */
  private readFields() {
    let changed = false;
    const o = this.dim.getValue("offset");
    if (o != null && this.dim.isUserDriven("offset") && Math.abs(o - this.offset) > 1e-9) {
      this.offset = o;
      changed = true;
    }
    const a = this.dim.getValue("angle");
    if (a != null && this.dim.isUserDriven("angle") && Math.abs(a - this.angle) > 1e-9) {
      this.angle = a;
      changed = true;
    }
    if (changed) this.pushPreview();
  }

  /** Where the cursor sits about the mate axis, in degrees, read in the axis's
   *  own plane so it stays put as the camera moves. Null when that plane is
   *  nearly edge-on: a pixel of movement there is an unbounded jump in angle. */
  private cursorTurn(x: number, y: number): number | null {
    const view = this.viewport.camera.getWorldDirection(new THREE.Vector3());
    if (ringDragDegenerate(view.dot(this.dir))) return null;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.dir, this.anchor);
    const at = this.viewport.screenToPlane(x, y, plane);
    if (!at) return null;
    return (angleInFrame(at, this.anchor, rotationFrame(this.dir)) * 180) / Math.PI;
  }

  /** Which handle the cursor is over, by ray distance so the nearer surface wins
   *  wherever the two overlap on screen. */
  private pick(x: number, y: number): "offset" | "angle" | null {
    const rc = this.viewport.rayFrom(x, y);
    const arrow = this.gizmo ? rc.intersectObjects(this.gizmo.children, false)[0] : undefined;
    const ring = this.dial ? rc.intersectObjects(this.dial.children, false)[0] : undefined;
    if (!arrow) return ring ? "angle" : null;
    if (!ring) return "offset";
    return ring.distance < arrow.distance ? "angle" : "offset";
  }

  private pushPreview() {
    if (!this.active || !this.id) return;
    const f = this.store.document.features.find((x) => x.id === this.id);
    if (!f || f.type !== "joint") return;
    const next = { ...f, offset: this.offset || undefined, angle: this.angle || undefined } as Feature;
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
    const { offset, angle } = this;
    const done = this.onDone;
    this.cleanup(false);
    // 0 drops the field so a joint that never slid or turned reads exactly as it
    // did before the tool was opened on it.
    this.store.updateFeature(id, {
      offset: offset || undefined,
      angle: angle || undefined,
    } as unknown as Partial<Feature>);
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
    if (this.dial) {
      this.viewport.removeFromScene(this.dial);
      this.dialHandle?.dispose();
      this.dial = null;
      this.dialHandle = null;
    }
    this.viewport.suspendPicking = false;
    this.active = false;
    this.grabbing = false;
    this.grabbingAngle = false;
    this.hovering = false;
    this.hoveringDial = false;
    this.id = null;
    this.onDone = null;
    setPrompt(null);
  }
}
