// Multi-body Move: arrows slide, rings turn, cubes resize, squares slide in a plane, the origin is a draggable pivot.
// The `move` feature turns about the world origin, so the pivot correction lives in transformGizmo.composeMove.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import { featureValueRule } from "../document/numFields";
import { DimInput } from "../sketch/dimInput";
import { WORLD_FRAME, bodyMoveTarget, type Frame, type MoveCommit, type MoveTarget } from "./moveTarget";
import { setPrompt } from "../ui/prompt";
import { fmtLength, snap } from "../ui/units";
import { gizmoMoveStep, gizmoRotateStep, snapScaleFactor } from "../viewport/gizmoStep";
import { axisDragDistance, nameHandle } from "./manipulator";
import {
  angleDelta,
  angleInFrame,
  composeMove,
  moveMatrix,
  ringDragDegenerate,
  rotationFrame,
  scaleAbout,
  snapDegrees,
  MIN_SCALE,
} from "./transformGizmo";
import { CanvasGesture } from "./canvasGesture";
import { RotateDial } from "../viewport/rotateDial";
import { overlayMaterial } from "../viewport/overlayMaterial";
import { resolveShortcut } from "../input/shortcuts";
import { createSlimRing, ringLook, type SlimRing } from "./slimRing";

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const HOT = 0xffe9a8; // hovered / grabbed handle
const AXIS_NAME = ["x", "y", "z"];
const AXES = [
  { dir: new THREE.Vector3(1, 0, 0), color: 0xff5a5a }, // X red
  { dir: new THREE.Vector3(0, 1, 0), color: 0x5ad15a }, // Y green
  { dir: new THREE.Vector3(0, 0, 1), color: 0x5a9bff }, // Z blue
];

// Gizmo units are screen pixels: the group is scaled by pixelWorldSize every frame. The arrows reach past
// the rings so each crosses the other two rings near its tip, where it is thick enough to read over them.
const ARROW_LENGTH = 68;
const ARROW_HEAD = 16;
const ARROW_HEAD_R = 4.6;
const ARROW_SHAFT = ARROW_LENGTH - ARROW_HEAD;
const ARROW_SHAFT_R = 1.6;
/** Radius of the invisible grab cylinder: aim size is not draw size, and a uniform cylinder makes the tip as
 *  easy to hit as the root. */
const ARROW_GRAB_R = 6.5;
const RING_RADIUS = 46;
/** In gizmo units, small enough to never cover the arrows' root. */
const ORIGIN_R = 5.5;
/** Lit while the origin sits on a point the model actually has, rather than wherever the cursor was. */
const SNAPPED = 0x64d2ff;
const ORIGIN_IDLE = 0xdfe6ee;
/** The resize cube, past the arrowhead so the two never share a pixel. */
const SCALE_BOX = 9;
const SCALE_AT = ARROW_SHAFT + ARROW_HEAD + 11;
/** Centre offset of the planar-move square along each spanning axis, inside the rings and clear of the origin
 *  dot; its invisible hit quad is fatter. */
const PLANE_AT = 25;
const PLANE_SIZE = 14;
const PLANE_HIT = 21;
/** In screen pixels, clear of the outermost handle so the boxes never cover what they report. */
const FIELDS_OFFSET_PX = SCALE_AT + 18;

/** In screen pixels, for the selection toolbar that must clear it. The value fields sit to the side, so only
 *  the outermost handle matters vertically. */
export const GIZMO_REACH_PX = SCALE_AT + SCALE_BOX;

type Grab = { kind: "axis" | "ring" | "origin" | "size" | "plane"; index: number } | null;

function idlePrompt(canResize: boolean): string {
  const resize = canResize ? " a cube to resize," : "";
  return `Drag an arrow to slide, a square to slide in a plane, a ring to turn,${resize} the centre to move what those act about · Enter · Esc`;
}

function planeAxes(normal: number): [number, number] {
  return [(normal + 1) % 3, (normal + 2) % 3];
}

export class MoveTool {
  active = false;
  private target: MoveTarget | null = null;
  private frame: Frame = WORLD_FRAME;
  private copy = false;
  private suspendedBefore = false;
  /** The gizmo's origin, the selection centroid, fixed for the session. */
  private anchor = new THREE.Vector3();
  private t = new THREE.Vector3();
  private rot = new THREE.Quaternion(); // current rotation, about `anchor`

  private gizmo: THREE.Group | null = null;
  private arrows: { group: THREE.Group; mat: THREE.MeshBasicMaterial; axis: number }[] = [];
  private rings: { ring: SlimRing; axis: number }[] = [];
  private cubes: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; axis: number }[] = [];
  private planes: { mesh: THREE.Mesh; hit: THREE.Mesh; mat: THREE.MeshBasicMaterial; axis: number }[] = [];
  /** Where the cursor met the drag plane at grab, and the translation the selection carried then. */
  private grabPlanePoint = new THREE.Vector3();
  private grabT = new THREE.Vector3();
  /** per-axis resize about `anchor`, 1 meaning untouched */
  private scl = new THREE.Vector3(1, 1, 1);
  private grabScale = 1;
  private origin: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial } | null = null;
  private pivotSnapped = false;
  private hover: Grab = null;
  private grab: Grab = null;
  /** the handle a typed value retargets: the last one actually dragged */
  private last: Grab = null;
  private grabVal = 0;
  private grabProj = 0;
  /** Where the cursor sat on the ring at grab, and the rotation the selection carried then. */
  private grabAngle = 0;
  private grabRot = new THREE.Quaternion();
  /** total turn on the grabbed ring, degrees, the value the field shows */
  private ringDeg = 0;
  /** the unwrapped turn so far, radians, so one drag can go past half a turn */
  private ringTurn = 0;
  private lastRingAngle = 0;
  private ringStep = 0;
  private dial: RotateDial | null = null;
  private downPos = { x: 0, y: 0 };
  /** The selection's world box when the session opened, what resize steps measure against. */
  private box: THREE.Box3 | null = null;
  private stepLabel = "";

  private dim = new DimInput();
  private onDone: ((id: string | null) => void) | null = null;
  /** unsubscribes a settled drag's wait for its rebuild */
  private pendingReopen: (() => void) | null = null;
  /** Where a click that stood the tool down landed, so that same click can still pick the next body. */
  onClickThrough: ((x: number, y: number, additive: boolean) => void) | null = null;
  /** Raised by a body selection, so it draws only with the handles overlay on. Kept over a drag's re-open. */
  ambient = false;
  private unwatchOverlays: (() => void) | null = null;

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

  start(bodies: string[], onDone: (id: string | null) => void) {
    this.startTarget(bodyMoveTarget(this.viewport, this.store, bodies), onDone);
  }

  /** A session already up is cancelled first, so its gizmo never stays drawn on the old target. */
  startTarget(target: MoveTarget, onDone: (id: string | null) => void) {
    this.dropPendingReopen();
    if (this.active) this.cancel();
    this.copy = false;
    this.ambient = false;
    this.open(target, onDone);
  }

  markAmbient() {
    if (!this.active) return;
    this.ambient = true;
    this.syncHidden();
  }

  /** Move asked for over a selection's gizmo: the same session, now shown whatever the overlay switches say. */
  claim() {
    this.ambient = false;
    this.syncHidden();
  }

  private syncHidden() {
    this.dim.setHidden(this.active && this.ambient && !this.viewport.overlayOn("handles"));
  }

  private open(target: MoveTarget, onDone: (id: string | null) => void) {
    if (this.active) return;
    this.active = true;
    this.target = target;
    this.frame = target.frame;
    this.onDone = onDone;
    this.t.set(0, 0, 0);
    this.rot.identity();
    this.ringDeg = 0;
    this.last = null;
    this.scl.set(1, 1, 1);
    this.anchor.copy(target.centroid());
    this.box = target.box();
    target.begin();
    this.suspendedBefore = this.viewport.suspendPicking;
    this.viewport.suspendPicking = true;
    this.gesture.attach();

    this.buildGizmo();
    if (this.gizmo) this.placeGizmo(this.gizmo);
    this.dim.show(
      [
        { name: "move", label: "Move", icon: "move", kind: "length" },
        { name: "turn", label: "Angle", icon: "rotate", kind: "angle" },
        ...(target.handles.cubes.length
          ? [
              {
                name: "size",
                label: "Scale",
                icon: "scale",
                kind: "count" as const,
                ...featureValueRule("scale", "factor"),
              },
            ]
          : []),
      ],
      () => this.settleTyped(),
      () => this.cancel(),
      target.canCopy
        ? {
            label: "Copy",
            icon: "copy",
            title: "Leave the original where it is and move a copy",
            initial: this.copy,
            onChange: (on) => {
              this.copy = on;
              this.refreshPreview();
            },
          }
        : undefined,
    );
    this.unwatchOverlays = this.viewport.watchOverlays(() => this.syncHidden());
    this.syncHidden();
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x + FIELDS_OFFSET_PX, s.y);
    this.dim.updateFromCursor({ move: 0, turn: 0, size: 1 });
    setPrompt(idlePrompt(target.handles.cubes.length > 0));
    this.stepLabel = "";
    this.gesture.frame();
  }

  /** The slide step at the gizmo's current zoom. */
  private moveStep(fine: boolean): number {
    const at = this.gizmo?.position ?? this.anchor;
    return gizmoMoveStep(this.viewport.pixelWorldSize(at), fine);
  }

  private showStep(label: string) {
    if (label === this.stepLabel) return;
    this.stepLabel = label;
    setPrompt(`Step ${label} · Shift for finer`);
  }

  private comp(i: number): number {
    return this.t.dot(this.frame[i]!);
  }
  private setComp(i: number, v: number) {
    this.t.addScaledVector(this.frame[i]!, v - this.comp(i));
  }

  /** The ray meets the ring's own plane, the only reading stable as the camera moves. Null when that plane is
   *  nearly edge-on, where a pixel is an unbounded angle (see transformGizmo.ringDragDegenerate). */
  private ringAngle(axis: number, clientX: number, clientY: number): number | null {
    const dir = this.frame[axis];
    if (!dir) return null;
    const view = this.viewport.camera.getWorldDirection(new THREE.Vector3());
    if (ringDragDegenerate(view.dot(dir))) return null;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir, this.anchor);
    const at = this.viewport.screenToPlane(clientX, clientY, plane);
    if (!at) return null;
    return angleInFrame(at, this.anchor, rotationFrame(dir));
  }

  /** Absolute from the grab pose: an incremental turn accumulates the snap's rounding error every frame. */
  private applyRing(axis: number, deg: number) {
    const dir = this.frame[axis];
    if (!dir) return;
    this.ringDeg = deg;
    const step = new THREE.Quaternion().setFromAxisAngle(dir, (deg * Math.PI) / 180);
    this.rot.copy(step).multiply(this.grabRot);
    this.dim.updateFromCursor({ turn: deg });
    this.refreshPreview();
  }

  /** Moves the pivot, not the selection. `where` is on the ghost, so it comes back through the current transform,
   *  and t absorbs the change of (c - R·c) so the composed transform stays bit for bit the same. */
  private setPivot(where: THREE.Vector3) {
    const before = this.values();
    const inv = moveMatrix(before).invert();
    const next = where.clone().applyMatrix4(inv);
    const spinOld = this.anchor.clone().applyQuaternion(this.rot);
    const spinNew = next.clone().applyQuaternion(this.rot);
    this.t.add(this.anchor).sub(spinOld).sub(next).add(spinNew);
    this.anchor.copy(next);
  }

  private onMove(e: PointerEvent) {
    const g = this.grab;
    if (g?.kind === "axis") {
      const dir = this.frame[g.index];
      if (!dir) return;
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, dir);
      const raw = this.grabVal + (proj - this.grabProj);
      const step = this.moveStep(e.shiftKey);
      this.showStep(fmtLength(step));
      const stepped = snap(raw, step);
      if (stepped === this.comp(g.index)) return;
      this.setComp(g.index, stepped);
      this.dim.updateFromCursor({ move: stepped });
      this.refreshPreview();
      return;
    }
    if (g?.kind === "plane") {
      const p = this.planeDragPoint(g.index, e.clientX, e.clientY);
      if (!p) return; // view went edge-on to the plane mid-drag; hold the value
      const delta = p.clone().sub(this.grabPlanePoint);
      const step = this.moveStep(e.shiftKey);
      this.showStep(fmtLength(step));
      const [u, v] = planeAxes(g.index);
      let changed = false;
      for (const j of [u, v]) {
        const dj = this.frame[j]!;
        const stepped = snap(this.grabT.dot(dj) + delta.dot(dj), step);
        if (stepped !== this.comp(j)) {
          this.setComp(j, stepped);
          changed = true;
        }
      }
      if (!changed) return;
      const du = this.comp(u) - this.grabT.dot(this.frame[u]!);
      const dv = this.comp(v) - this.grabT.dot(this.frame[v]!);
      this.dim.updateFromCursor({ move: Math.hypot(du, dv) });
      this.refreshPreview();
      return;
    }
    if (g?.kind === "origin") {
      const hit = this.viewport.pointAt(e.clientX, e.clientY);
      // Off the model: slide the origin in the camera-facing plane, a pivot in mid-air is a legitimate want.
      const at = hit?.p ?? this.freePivotPoint(e.clientX, e.clientY);
      this.pivotSnapped = !!hit && hit.kind !== "surface";
      if (at) this.setPivot(at);
      return;
    }
    if (g?.kind === "size") {
      const dir = this.frame[g.index];
      if (!dir) return;
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, dir);
      // Ratio, not difference: the handle sits a fixed number of pixels out, so its distance in mm depends on zoom.
      if (Math.abs(this.grabProj) < 1e-9) return;
      const step = this.moveStep(e.shiftKey);
      this.showStep(fmtLength(step));
      const size = this.box?.getSize(new THREE.Vector3());
      const extent = size ? Math.abs(size.x * dir.x) + Math.abs(size.y * dir.y) + Math.abs(size.z * dir.z) : 0;
      this.applySize(g.index, snapScaleFactor(this.grabScale * (proj / this.grabProj), extent, step));
      return;
    }
    if (g?.kind === "ring") {
      const now = this.ringAngle(g.index, e.clientX, e.clientY);
      if (now === null) return; // the view went edge-on mid-drag; hold the value
      this.ringTurn += angleDelta(this.lastRingAngle, now);
      this.lastRingAngle = now;
      const stepDeg = gizmoRotateStep(e.shiftKey);
      this.showStep(`${stepDeg}°`);
      const deg = snapDegrees((this.ringTurn * 180) / Math.PI, stepDeg);
      if (Math.abs(deg - this.ringDeg) < 1e-9 && stepDeg === this.ringStep) return;
      this.ringStep = stepDeg;
      this.dial?.update(this.grabAngle, deg, stepDeg);
      this.viewport.requestRender();
      if (Math.abs(deg - this.ringDeg) < 1e-9) return;
      this.applyRing(g.index, deg);
      return;
    }
    this.hover = this.hitHandle(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hover ? "grab" : "default";
    if (e.buttons === 0) this.viewport.hoverThrough(this.hover ? null : e.clientX, e.clientY);
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    const hit = this.hitHandle(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.kind === "origin") {
      // nothing to seed: the origin follows the cursor from the first move
    } else if (hit.kind === "size") {
      const dir = this.frame[hit.index];
      if (!dir) return;
      this.grabScale = this.scl.getComponent(hit.index);
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, dir);
      this.dim.updateFromCursor({ size: this.grabScale });
    } else if (hit.kind === "ring") {
      const start = this.ringAngle(hit.index, e.clientX, e.clientY);
      if (start === null) return; // edge-on: leave the press alone
      this.grabAngle = start;
      this.lastRingAngle = start;
      this.ringTurn = 0;
      this.grabRot.copy(this.rot);
      this.ringDeg = 0;
      this.ringStep = gizmoRotateStep(e.shiftKey);
      const dir = this.frame[hit.index];
      if (dir && this.gizmo) {
        this.dial = new RotateDial(dir, AXES[hit.index]?.color ?? HOT);
        this.dial.update(start, 0, this.ringStep);
        this.gizmo.add(this.dial.group);
      }
      this.dim.updateFromCursor({ turn: 0 });
    } else if (hit.kind === "plane") {
      const p = this.planeDragPoint(hit.index, e.clientX, e.clientY);
      if (!p) return; // the plane went edge-on to the view; leave the press alone
      this.grabPlanePoint.copy(p);
      this.grabT.copy(this.t);
      this.dim.updateFromCursor({ move: 0 });
    } else {
      const dir = this.frame[hit.index];
      if (!dir) return;
      this.grabVal = this.comp(hit.index);
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, dir);
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    this.viewport.hoverThrough(null);
    this.grab = hit;
    this.viewport.gizmoDragging = true;
    this.last = hit;
    this.viewport.domElement.style.cursor = "grabbing";
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.grab) {
      this.grab = null;
      this.viewport.gizmoDragging = false;
      this.dropDial();
      this.stepLabel = "";
      setPrompt(idlePrompt(this.cubes.length > 0));
      this.viewport.domElement.style.cursor = this.hover ? "grab" : "default";
      // Each drag is its own timeline row, so undo undoes the last nudge and the next drag starts from this pose.
      this.settleDrag();
      return;
    }
    const moved = Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    // A clean click off the handles ends the session and is replayed, since picking is suspended while the
    // tool owns the pointer.
    if (!moved && !this.hitHandle(e.clientX, e.clientY)) {
      const through = this.onClickThrough;
      const at = { x: e.clientX, y: e.clientY, add: e.ctrlKey || e.metaKey };
      this.commit();
      through?.(at.x, at.y, at.add);
    }
  }

  /** The re-open waits for the rebuild: the gizmo is placed from the model, and the old one would double the
   *  next move. */
  private settleDrag() {
    this.commitAndReopen(true);
  }

  /** Re-opens like a drag once something was written, closes when nothing was. */
  private settleTyped() {
    const unplaced = this.typedWithoutHandle();
    if (unplaced) return this.dim.flag(unplaced);
    this.commitAndReopen(false);
  }

  /** A typed value only means something along a handle, so one typed before any handle was picked is refused. */
  private typedWithoutHandle(): string | null {
    const typed = (name: string) => {
      if (!this.dim.isUserDriven(name)) return false;
      const v = this.dim.getValue(name);
      return v !== null && Math.abs(v - (name === "size" ? 1 : 0)) > 1e-9;
    };
    const kind = this.last?.kind;
    if (typed("move") && kind === "size") return "A cube scales, type its factor in Scale";
    if (typed("move") && kind !== "axis") return "Click an arrow for the distance to run along";
    if (typed("turn") && kind !== "ring") return "Click a ring for the angle to turn about";
    if (typed("size") && kind !== "size") return "Click a cube for the scale to stretch along";
    return null;
  }

  private commitAndReopen(evenUnchanged: boolean) {
    const target = this.target;
    const done = this.onDone;
    const through = this.onClickThrough;
    // The last grabbed handle outlives the re-open, so a click on an arrow still says where the next typed distance goes.
    const chosen = this.last;
    const res = this.commit();
    if (!target || (!res && !evenUnchanged)) return;
    // Asked only once the rebuild has landed, so an owner that has closed by then can answer null.
    const reopen = () => {
      this.pendingReopen = null;
      if (this.active) return; // something else claimed the tool meanwhile
      const next = target.reopen();
      if (!next) return;
      this.open(next, done ?? (() => {}));
      this.onClickThrough = through;
      if (chosen?.kind !== "origin") this.last = chosen;
      if (chosen?.kind === "size") this.dim.focusField("size");
      else if (chosen?.kind === "ring") this.dim.focusField("turn");
    };
    // A drag that ended where it started writes nothing, so there is no rebuild to wait for.
    if (!res?.rebuild) return reopen();
    // Wait for the falling edge: onBuild replays the current state to a new subscriber before the round trip
    // is announced, and re-opening on that replay would count this drag twice.
    let started = false;
    const off = this.store.onBuild((s) => {
      if (s.building) {
        started = true;
        return;
      }
      if (!started) return;
      off();
      reopen();
    });
    this.pendingReopen = () => {
      off();
    };
  }

  private dropPendingReopen() {
    this.pendingReopen?.();
    this.pendingReopen = null;
  }

  /** Null when the plane is edge-on. Read live, which is safe: a planar drag only moves the gizmo within it. */
  private planeDragPoint(axis: number, clientX: number, clientY: number): THREE.Vector3 | null {
    const dir = this.frame[axis];
    if (!dir) return null;
    // The same degeneracy ringDragDegenerate guards for a ring viewed edge-on.
    const view = this.viewport.camera.getWorldDirection(new THREE.Vector3());
    if (Math.abs(view.dot(dir)) < 0.12) return null;
    const at = this.anchor.clone().applyMatrix4(this.transform());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir, at);
    return this.viewport.screenToPlane(clientX, clientY, plane);
  }

  /** The fallback when the pointer is over no geometry. */
  private freePivotPoint(clientX: number, clientY: number): THREE.Vector3 | null {
    const at = this.anchor.clone().applyMatrix4(this.transform());
    const n = this.viewport.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, at);
    return this.viewport.screenToPlane(clientX, clientY, plane);
  }

  private onKey(e: KeyboardEvent) {
    // The raised gizmo's field already has focus, so the tool's own key would otherwise be typed into it.
    if (this.ambient && resolveShortcut(e.key.toLowerCase(), e.shiftKey, "model", e.ctrlKey || e.metaKey) === "move") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.claim();
      return;
    }
    if (e.key !== "Escape") return;
    if (this.target?.ownsEscape) e.stopImmediatePropagation();
    this.cancel();
  }

  private tick() {
    if (!this.active || !this.gizmo) return;
    // The anchor carried through the bodies' transform, or turning the part leaves the rings on the old centroid.
    const pos = this.placeGizmo(this.gizmo);
    const lit = (kind: NonNullable<Grab>["kind"], i: number) =>
      this.grab
        ? this.grab.kind === kind && this.grab.index === i
        : (this.hover ?? this.last)?.kind === kind && (this.hover ?? this.last)?.index === i;
    for (const a of this.arrows) {
      const ax = AXES[a.axis];
      if (ax) a.mat.color.set(lit("axis", a.axis) ? HOT : ax.color);
    }
    const ringAt = (h: Grab) => (h?.kind === "ring" ? h.index : null);
    const ringAxes = this.rings.map((r) => r.axis);
    for (const r of this.rings) {
      const ax = AXES[r.axis];
      if (ax)
        r.ring.paint(
          ringLook(r.axis, ringAt(this.hover ?? this.last), this.grab ? (ringAt(this.grab) ?? -1) : null, ringAxes),
          ax.color,
        );
    }
    for (const c of this.cubes) {
      const ax = AXES[c.axis];
      if (ax) c.mat.color.set(lit("size", c.axis) ? HOT : ax.color);
    }
    for (const p of this.planes) {
      const ax = AXES[p.axis];
      if (!ax) continue;
      const hot = lit("plane", p.axis);
      p.mat.color.set(hot ? HOT : ax.color);
      p.mat.opacity = hot ? 0.85 : 0.5;
    }
    if (this.origin) {
      const hot = lit("origin", 0);
      this.origin.mat.color.set(hot ? HOT : this.pivotSnapped ? SNAPPED : ORIGIN_IDLE);
    }
    const s = this.viewport.projectToScreen(pos);
    this.dim.position(s.x + FIELDS_OFFSET_PX, s.y);
    if (this.dial) {
      this.gizmo.updateMatrixWorld();
      this.dial.placeLabel((w) => this.viewport.projectToScreen(w));
    }
    this.applyTyped();
    this.gesture.frame();
  }

  /** Run on open as well as every frame, so a press before the first frame is tested against the gizmo as drawn. */
  private placeGizmo(gizmo: THREE.Object3D): THREE.Vector3 {
    const pos = this.anchor.clone().applyMatrix4(this.transform());
    const k = this.viewport.pixelWorldSize(pos);
    if (!gizmo.position.equals(pos) || gizmo.scale.x !== k) this.viewport.requestRender();
    gizmo.position.copy(pos);
    // Not turned with the selection: the drags act along world axes, so the handles stay world aligned.
    gizmo.scale.setScalar(k);
    return pos;
  }

  /** The field is the truth, sign included, so a typed value can cross zero. */
  private applyTyped() {
    const l = this.last;
    if (this.grab || !l) return;
    if (l.kind === "axis" && this.dim.isUserDriven("move")) {
      const v = this.dim.getValue("move");
      if (v != null && Math.abs(v - this.comp(l.index)) > 1e-6) {
        this.setComp(l.index, v);
        this.refreshPreview();
      }
      return;
    }
    if (l.kind === "ring" && this.dim.isUserDriven("turn")) {
      const v = this.dim.getValue("turn");
      if (v != null && Math.abs(v - this.ringDeg) > 1e-6) this.applyRing(l.index, v);
      return;
    }
    if (l.kind === "size" && this.dim.isUserDriven("size")) {
      const v = this.dim.getValue("size");
      if (v != null && Math.abs(v - this.scl.getComponent(l.index)) > 1e-6) {
        this.applySize(l.index, v);
      }
    }
  }

  /** The six numbers the preview and the committed feature are both built from, so they cannot disagree. */
  private values() {
    return composeMove(this.anchor, this.rot, this.t);
  }

  /** Resize first, then move, the order the two features apply on rebuild. */
  private transform(): THREE.Matrix4 {
    return moveMatrix(this.values()).multiply(scaleAbout(this.anchor, this.scl));
  }

  private resized(): boolean {
    return Math.abs(this.scl.x - 1) + Math.abs(this.scl.y - 1) + Math.abs(this.scl.z - 1) > 1e-9;
  }

  /** `f` scales that axis alone, the other two stay put. */
  private applySize(axis: number, f: number) {
    const v = Math.max(MIN_SCALE, f);
    if (Math.abs(this.scl.getComponent(axis) - v) < 1e-9) return;
    if (this.target?.uniformScale) this.scl.setScalar(v);
    else this.scl.setComponent(axis, v);
    this.dim.updateFromCursor({ size: v });
    this.refreshPreview();
  }

  /** Instant ghost, no engine round-trip; the real write happens on release. */
  private refreshPreview() {
    this.target?.preview(this.transform(), this.copy);
  }

  private buildGizmo() {
    const g = new THREE.Group();
    const hs = this.target?.handles;
    for (let i = 0; i < AXES.length; i++) {
      const a = AXES[i];
      const dir = this.frame[i];
      if (!a || !dir || !hs) continue;
      if (hs.axes.includes(i)) {
        const mat = overlayMaterial(
          new THREE.MeshBasicMaterial({ color: a.color, depthTest: false, depthWrite: false }),
        );
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(ARROW_SHAFT_R, ARROW_SHAFT_R, ARROW_SHAFT, 12), mat);
        shaft.position.y = ARROW_SHAFT / 2;
        const head = new THREE.Mesh(new THREE.ConeGeometry(ARROW_HEAD_R, ARROW_HEAD, 18), mat);
        head.position.y = ARROW_SHAFT + ARROW_HEAD / 2;
        // `material.visible` keeps it out of the render list but in the raycast, which `object.visible` would not.
        const sleeve = new THREE.Mesh(
          new THREE.CylinderGeometry(ARROW_GRAB_R, ARROW_GRAB_R, ARROW_LENGTH, 8),
          new THREE.MeshBasicMaterial({ visible: false }),
        );
        sleeve.position.y = ARROW_LENGTH / 2;
        const arrow = new THREE.Group();
        arrow.add(shaft, head, sleeve);
        arrow.quaternion.setFromUnitVectors(Y_AXIS, dir);
        arrow.renderOrder = 999;
        shaft.renderOrder = 999;
        head.renderOrder = 999;
        arrow.userData.axis = i;
        nameHandle(arrow, `arrow ${AXIS_NAME[i]}`);
        g.add(arrow);
        this.arrows.push({ group: arrow, mat, axis: i });
      }

      // Each ring in its axis's colour, so the arrows and rings read as one gizmo.
      if (hs.rings.includes(i)) {
        const ring = createSlimRing(RING_RADIUS);
        // A torus is built in the XY plane, so its own axis is +Z.
        ring.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
        ring.band.userData.ring = i;
        nameHandle(ring.group, `ring ${AXIS_NAME[i]}`);
        g.add(ring.group);
        this.rings.push({ ring, axis: i });
      }

      if (hs.cubes.includes(i)) {
        const cmat = overlayMaterial(
          new THREE.MeshBasicMaterial({
            color: a.color,
            depthTest: false,
            depthWrite: false,
          }),
        );
        const cube = new THREE.Mesh(new THREE.BoxGeometry(SCALE_BOX, SCALE_BOX, SCALE_BOX), cmat);
        cube.quaternion.setFromUnitVectors(Y_AXIS, dir);
        cube.position.copy(dir).multiplyScalar(SCALE_AT);
        cube.renderOrder = 999;
        cube.userData.size = i;
        nameHandle(cube, `size ${AXIS_NAME[i]}`);
        g.add(cube);
        this.cubes.push({ mesh: cube, mat: cmat, axis: i });
      }

      // One translucent square per axis in the quadrant between the other two arrows; faint so it never hides
      // a ring, DoubleSide so it reads from either face.
      if (!hs.planes.includes(i)) continue;
      const [u, v] = planeAxes(i);
      const du = this.frame[u],
        dv = this.frame[v];
      if (!du || !dv) continue;
      const centre = du.clone().multiplyScalar(PLANE_AT).add(dv.clone().multiplyScalar(PLANE_AT));
      const pmat = new THREE.MeshBasicMaterial({
        color: a.color,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.5,
      });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE), pmat);
      quad.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      quad.position.copy(centre);
      // Over the depthTest:false rings and arrows, so the square always reads as foreground.
      quad.renderOrder = 1000;
      // Fatter invisible target, same idea as the arrow sleeve and ring band.
      const phit = new THREE.Mesh(
        new THREE.PlaneGeometry(PLANE_HIT, PLANE_HIT),
        new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
      );
      phit.quaternion.copy(quad.quaternion);
      phit.position.copy(centre);
      phit.userData.plane = i;
      nameHandle(phit, `plane ${[AXIS_NAME[u], AXIS_NAME[v]].sort().join("")}`);
      g.add(quad, phit);
      this.planes.push({ mesh: quad, hit: phit, mat: pmat, axis: i });
    }
    const omat = overlayMaterial(
      new THREE.MeshBasicMaterial({
        color: ORIGIN_IDLE,
        depthTest: false,
        depthWrite: false,
      }),
    );
    const dot = new THREE.Mesh(new THREE.SphereGeometry(ORIGIN_R, 20, 14), omat);
    dot.renderOrder = 1000; // over the arrows' roots, which meet here
    dot.userData.origin = true;
    nameHandle(dot, "origin");
    g.add(dot);
    this.origin = { mesh: dot, mat: omat };

    g.renderOrder = 999;
    this.gizmo = g;
    this.viewport.addToScene(g);
  }

  /** Arrows beat rings where they overlap: the arrow is the smaller target and the commonest gesture. */
  private hitHandle(x: number, y: number): Grab {
    if (!this.gizmo) return null;
    // Note: matrixWorld only follows placeGizmo on the next render.
    this.gizmo.updateMatrixWorld(true);
    const arrowParts: THREE.Object3D[] = [];
    for (const a of this.arrows) arrowParts.push(...a.group.children);
    const planeHits = this.planes.map((p) => p.hit);
    const cubeMeshes = this.cubes.map((c) => c.mesh);
    const ringBands = this.rings.map((r) => r.ring.band);
    // The family order holds per ray: a finger's extra rays are asked only when the one under it hits nothing.
    return this.viewport.probe(x, y, (ray): Grab => {
      // The origin first: it sits where all three arrows meet, so anything before it takes every middle press.
      if (this.origin && ray.intersectObject(this.origin.mesh, false).length) {
        return { kind: "origin", index: 0 };
      }
      const onArrow = ray.intersectObjects(arrowParts, false)[0];
      if (onArrow) {
        let o: THREE.Object3D | null = onArrow.object;
        while (o && o.userData.axis === undefined) o = o.parent;
        if (o) return { kind: "axis", index: o.userData.axis as number };
      }
      // Planes after arrows so a square never steals a press meant for the arrow root beside it.
      const onPlane = ray.intersectObjects(planeHits, false)[0];
      if (onPlane) return { kind: "plane", index: onPlane.object.userData.plane as number };
      const onCube = ray.intersectObjects(cubeMeshes, false)[0];
      if (onCube) return { kind: "size", index: onCube.object.userData.size as number };
      const onRing = ray.intersectObjects(ringBands, false)[0];
      if (onRing) return { kind: "ring", index: onRing.object.userData.ring as number };
      return null;
    });
  }

  private commit(): MoveCommit | null {
    if (!this.active || !this.target) return null;
    this.applyTyped();
    const v = this.values();
    // Measured on the composed transform, not `t`: moving the pivot rewrites t without moving anything.
    const moved = Math.hypot(v.dx, v.dy, v.dz) > 1e-9;
    const turned = Math.abs(v.rx) + Math.abs(v.ry) + Math.abs(v.rz) > 1e-9;
    const sized = this.resized();
    if (!moved && !turned && !sized) {
      this.cancel();
      return null;
    }
    const res = this.target.commit({
      values: v,
      scale: this.scl.clone(),
      pivot: this.anchor.clone(),
      matrix: this.transform(),
      moved,
      turned,
      sized,
      copy: this.copy,
    });
    this.copy = false; // one copy per drag, the next drag moves again
    const done = this.onDone;
    this.cleanup();
    done?.(res.id);
    return res;
  }

  /** Safe with nothing up, where it only drops a gizmo still waiting to come back after a drag's rebuild. */
  cancel() {
    this.dropPendingReopen();
    if (!this.active) return;
    this.target?.end(true);
    const done = this.onDone;
    this.cleanup();
    done?.(null);
  }

  private dropDial() {
    this.dial?.dispose();
    this.dial = null;
  }

  private cleanup() {
    const el = this.viewport.domElement;
    this.dropDial();
    this.target?.end(false); // no-op if commit/cancel already ended it
    this.target = null;
    this.gesture.detach();
    el.style.cursor = "default";
    this.unwatchOverlays?.();
    this.unwatchOverlays = null;
    this.dim.hide();
    this.dim.setHidden(false);
    if (this.gizmo) {
      this.viewport.removeFromScene(this.gizmo);
      for (const a of this.arrows) {
        for (const c of a.group.children) if (c instanceof THREE.Mesh) c.geometry.dispose();
        a.mat.dispose();
      }
      for (const r of this.rings) r.ring.dispose();
      if (this.origin) {
        this.origin.mesh.geometry.dispose();
        this.origin.mat.dispose();
        this.origin = null;
      }
      for (const c of this.cubes) {
        c.mesh.geometry.dispose();
        c.mat.dispose();
      }
      for (const p of this.planes) {
        p.mesh.geometry.dispose();
        p.hit.geometry.dispose();
        (p.hit.material as THREE.Material).dispose();
        p.mat.dispose();
      }
      this.gizmo = null;
      this.arrows = [];
      this.rings = [];
      this.cubes = [];
      this.planes = [];
    }
    this.viewport.suspendPicking = this.suspendedBefore;
    this.active = false;
    this.grab = null;
    this.viewport.gizmoDragging = false;
    this.hover = null;
    this.t.set(0, 0, 0);
    this.rot.identity();
    this.ringDeg = 0;
    this.scl.set(1, 1, 1);
    this.pivotSnapped = false;
    setPrompt(null);
  }
}
