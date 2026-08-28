// Interactive multi-body Move: one gizmo at the selection's centroid carrying
// three arrows and three rings. Grab an arrow to slide the bodies along that
// axis; grab a ring to turn them about it. Both drive a LIVE preview (the mesh
// and its edges transformed in place, no sidecar round-trip) — type a value for
// precision, click off the gizmo / Enter to commit, Esc to revert.
//
// Rotation is the addition, and it needed one thing that was not obvious. The
// `move` feature turns about the WORLD ORIGIN and only then translates, so a
// body 300mm out along the part, turned a quarter turn, used to swing 424mm
// across the scene instead of spinning where it stands. The correction is
// arithmetic, not a new feature — see features/transformGizmo.composeMove — and
// it lives there with its control test rather than inline here, because the
// symptom of getting it wrong is a body in a plausible-looking wrong place.
//
// The preview and the committed feature are built from the SAME six numbers, so
// they cannot disagree about what the drag meant.
//
// A cube at each arrow's tip RESIZES along that axis, about the same origin the
// rings turn about. It commits a second feature (a `scale`, written before the
// `move`), and the preview composes the two in that same order, because they are
// applied in that order on rebuild and a preview built the other way round
// agrees only while one of them is the identity.
//
// The gizmo's ORIGIN is draggable, and snaps to the model — a corner, the middle
// of an edge, the centre of a face. That is what turns "rotate this" into
// "rotate this about that corner", which is the only form of the request anyone
// actually has. Dragging it never moves the part: the translation absorbs the
// change of pivot exactly (see `setPivot`), so the origin is a statement about
// the NEXT drag and not itself an edit.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature } from "../types";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import { axisDragDistance } from "./manipulator";
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
  ROTATE_SNAP_DEG,
} from "./transformGizmo";

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const HOT = 0xffe9a8; // hovered / grabbed handle
const AXES = [
  { dir: new THREE.Vector3(1, 0, 0), color: 0xff5a5a }, // X red
  { dir: new THREE.Vector3(0, 1, 0), color: 0x5ad15a }, // Y green
  { dir: new THREE.Vector3(0, 0, 1), color: 0x5a9bff }, // Z blue
];

// Gizmo units are SCREEN PIXELS: the whole group is scaled by pixelWorldSize
// every frame, so it is the same size on a 6mm part and a 600mm one.
//
// The arrows reach past the rings rather than stopping inside them. An arrow
// only ever crosses the OTHER two rings — the ring you turn about X lies in the
// YZ plane, which the X arrow passes through at its centre — so the crossings
// are two per arrow and both are near the tips, where an arrow is thick enough
// to read over a ring drawn behind it.
const ARROW_SHAFT = 52;
const ARROW_HEAD = 20;
const ARROW_HEAD_R = 7;
const RING_RADIUS = 46;
const RING_TUBE = 2.4;
/** How wide the invisible band a ring is grabbed by is, in gizmo units. The
 *  drawn tube is 2.4 and nobody can reliably hit a 2px torus in 3D. */
const RING_GRAB = 8;
/** The draggable origin, in gizmo units. Small enough that it never covers the
 *  arrows' own root and large enough to grab. */
const ORIGIN_R = 5.5;
/** Lit while the origin is sitting on a point the model actually has, rather
 *  than wherever the cursor was. The one thing the handle has to say. */
const SNAPPED = 0x64d2ff;
const ORIGIN_IDLE = 0xdfe6ee;
/** The resize cube, past the arrowhead so the two never share a pixel. */
const SCALE_BOX = 9;
const SCALE_AT = ARROW_SHAFT + ARROW_HEAD + 11;
/** How far the value fields sit off the gizmo's centre, in SCREEN pixels.
 *  Clear of the outermost handle, so the boxes never cover the thing they are
 *  reporting on. */
const FIELDS_OFFSET_PX = SCALE_AT + 18;

/** Which handle a press landed on. Two families, so they can be hit-tested
 *  separately and a ring behind an arrow can never steal the arrow's press. */
type Grab = { kind: "axis" | "ring" | "origin" | "size"; index: number } | null;

export class MoveTool {
  active = false;
  private bodies: string[] = [];
  /** the gizmo's origin: what the arrows start from and what the rings turn
   *  about. The selection centroid, and fixed for the session. */
  private anchor = new THREE.Vector3();
  private t = new THREE.Vector3(); // current translation
  private rot = new THREE.Quaternion(); // current rotation, about `anchor`
  private previewId = "";

  private gizmo: THREE.Group | null = null;
  private arrows: { group: THREE.Group; mat: THREE.MeshBasicMaterial; axis: number }[] = [];
  private rings: { mesh: THREE.Mesh; grab: THREE.Mesh; mat: THREE.MeshBasicMaterial; axis: number }[] = [];
  private cubes: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; axis: number }[] = [];
  /** per-axis resize about `anchor`, 1 meaning untouched */
  private scl = new THREE.Vector3(1, 1, 1);
  private grabScale = 1;
  private scaleId = "";
  private origin: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial } | null = null;
  /** the origin is sitting on real model geometry, not on empty space */
  private pivotSnapped = false;
  private hover: Grab = null;
  private grab: Grab = null;
  /** the handle a typed value retargets: the last one actually dragged */
  private last: Grab = null;
  private grabVal = 0;
  private grabProj = 0;
  /** where the cursor sat on the ring when it was grabbed, and the rotation the
   *  selection already carried at that moment */
  private grabAngle = 0;
  private grabRot = new THREE.Quaternion();
  /** total turn on the grabbed ring, degrees — the value the field shows */
  private ringDeg = 0;
  private downPos = { x: 0, y: 0 };
  private raf = 0;

  private dim = new DimInput();
  private onDone: ((id: string | null) => void) | null = null;

  private boundMove: (e: PointerEvent) => void;
  private boundDown: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;
  private boundTick: () => void;

  constructor(
    private viewport: Viewport,
    private store: DocumentStore,
  ) {
    this.boundMove = (e) => this.onMove(e);
    this.boundDown = (e) => this.onDown(e);
    this.boundUp = (e) => this.onUp(e);
    this.boundKey = (e) => this.onKey(e);
    this.boundTick = () => this.tick();
  }

  start(bodies: string[], onDone: (id: string | null) => void) {
    if (this.active) return;
    this.active = true;
    this.bodies = bodies;
    this.onDone = onDone;
    this.t.set(0, 0, 0);
    this.rot.identity();
    this.ringDeg = 0;
    this.last = null;
    this.previewId = this.store.nextId();
    this.scaleId = "";
    this.scl.set(1, 1, 1);
    this.anchor.copy(this.viewport.bodiesCentroid(bodies));
    this.viewport.beginBodyMoveGhost(bodies); // live transform during drag (no rebuild)
    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);

    this.buildGizmo();
    this.dim.show(
      [
        { name: "move", label: "Move", kind: "length" },
        { name: "turn", label: "Angle", kind: "angle" },
        { name: "size", label: "Scale", kind: "count" },
      ],
      () => this.commit(),
      () => this.cancel(),
    );
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x + FIELDS_OFFSET_PX, s.y);
    this.dim.updateFromCursor({ move: 0, turn: 0, size: 1 });
    setPrompt(
      "Drag an arrow to slide, a ring to turn, a cube to resize, the centre to move what those act about · Enter · Esc",
    );
    this.raf = requestAnimationFrame(this.boundTick);
  }

  private comp(i: number): number {
    return this.t.getComponent(i);
  }
  private setComp(i: number, v: number) {
    this.t.setComponent(i, v);
  }

  // --- rotation ------------------------------------------------------------

  /** Where the cursor sits on the ring for `axis`, as an angle about the gizmo.
   *
   *  The cursor ray is intersected with the ring's own plane, which is the only
   *  reading that stays put as the camera moves. Null when that plane is nearly
   *  edge-on, where a pixel of pointer movement is an unbounded jump in angle —
   *  the ring is a line on screen there, and refusing is better than spinning
   *  the part (see transformGizmo.ringDragDegenerate). */
  private ringAngle(axis: number, clientX: number, clientY: number): number | null {
    const ax = AXES[axis];
    if (!ax) return null;
    const dir = ax.dir;
    const view = this.viewport.camera.getWorldDirection(new THREE.Vector3());
    if (ringDragDegenerate(view.dot(dir))) return null;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir, this.anchor);
    const at = this.viewport.screenToPlane(clientX, clientY, plane);
    if (!at) return null;
    return angleInFrame(at, this.anchor, rotationFrame(dir));
  }

  /** Turn to `deg` about the grabbed ring's axis, from where the selection
   *  stood when the ring was taken hold of. Absolute rather than incremental:
   *  an incremental one accumulates the snap's rounding error every frame, and
   *  after a full turn the part is degrees out from what the field says. */
  private applyRing(axis: number, deg: number) {
    const ax = AXES[axis];
    if (!ax) return;
    this.ringDeg = deg;
    const step = new THREE.Quaternion().setFromAxisAngle(ax.dir, (deg * Math.PI) / 180);
    this.rot.copy(step).multiply(this.grabRot);
    this.dim.updateFromCursor({ turn: deg });
    this.refreshPreview();
  }

  /** Move what the gizmo turns about, WITHOUT moving the selection.
   *
   *  `where` is a point in the scene as it stands, so it is on the ghost rather
   *  than on the original body: the pivot is stored in the body's own
   *  coordinates, which is what the feature's rotation is applied in, so the
   *  point has to come back through the current transform first.
   *
   *  Then the translation absorbs the change. The feature's translation carries
   *  the pivot correction (c - R·c); swapping c for c' and adding the difference
   *  back into t leaves the composed transform bit for bit what it was, which is
   *  the promise this handle makes — the part does not twitch when you decide
   *  where to turn it from. */
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
      const ax = AXES[g.index];
      if (!ax) return;
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, ax.dir);
      const raw = this.grabVal + (proj - this.grabProj);
      const stepped = snap(raw, this.viewport.snapStep(this.anchor, e.shiftKey));
      if (stepped === this.comp(g.index)) return;
      this.setComp(g.index, stepped);
      this.dim.updateFromCursor({ move: stepped });
      this.refreshPreview();
      return;
    }
    if (g?.kind === "origin") {
      const hit = this.viewport.pointAt(e.clientX, e.clientY);
      // Off the model entirely: slide the origin in the plane facing the
      // camera through where it already is, so it still follows the cursor
      // instead of sticking. It is a pivot, not a constraint — putting it in
      // mid-air is a legitimate thing to want.
      const at = hit?.p ?? this.freePivotPoint(e.clientX, e.clientY);
      this.pivotSnapped = !!hit && hit.kind !== "surface";
      if (at) this.setPivot(at);
      return;
    }
    if (g?.kind === "size") {
      const ax = AXES[g.index];
      if (!ax) return;
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, ax.dir);
      // Ratio, not difference: the handle sits a fixed number of PIXELS out
      // from the origin, so how far it started from the pivot in millimetres
      // depends on the zoom. A difference would resize by an amount that
      // changed with how far in you were.
      if (Math.abs(this.grabProj) < 1e-9) return;
      this.applySize(g.index, this.grabScale * (proj / this.grabProj));
      return;
    }
    if (g?.kind === "ring") {
      const now = this.ringAngle(g.index, e.clientX, e.clientY);
      if (now === null) return; // the view went edge-on mid-drag; hold the value
      const turned = (angleDelta(this.grabAngle, now) * 180) / Math.PI;
      // Shift lifts the step, the same way it lifts the translation step.
      const deg = snapDegrees(turned, e.shiftKey ? 0 : ROTATE_SNAP_DEG);
      if (Math.abs(deg - this.ringDeg) < 1e-9) return;
      this.applyRing(g.index, deg);
      return;
    }
    this.hover = this.hitHandle(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hover ? "grab" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    const hit = this.hitHandle(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.kind === "origin") {
      // nothing to seed: the origin follows the cursor from the first move
    } else if (hit.kind === "size") {
      const ax = AXES[hit.index];
      if (!ax) return;
      this.grabScale = this.scl.getComponent(hit.index);
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, ax.dir);
      this.dim.updateFromCursor({ size: this.grabScale });
    } else if (hit.kind === "ring") {
      const start = this.ringAngle(hit.index, e.clientX, e.clientY);
      if (start === null) return; // edge-on: leave the press alone
      this.grabAngle = start;
      this.grabRot.copy(this.rot);
      this.ringDeg = 0;
      this.dim.updateFromCursor({ turn: 0 });
    } else {
      const ax = AXES[hit.index];
      if (!ax) return;
      this.grabVal = this.comp(hit.index);
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, ax.dir);
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    this.grab = hit;
    this.last = hit;
    this.viewport.domElement.style.cursor = "grabbing";
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.grab) {
      this.grab = null;
      this.viewport.domElement.style.cursor = this.hover ? "grab" : "default";
      return;
    }
    const moved =
      Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    // a clean click in empty space (not on a handle) commits
    if (!moved && !this.hitHandle(e.clientX, e.clientY)) this.commit();
  }

  /** Where the cursor is, in the plane through the gizmo that faces the camera.
   *  The fallback when the pointer is over no geometry at all. */
  private freePivotPoint(clientX: number, clientY: number): THREE.Vector3 | null {
    const at = this.anchor.clone().applyMatrix4(this.transform());
    const n = this.viewport.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, at);
    return this.viewport.screenToPlane(clientX, clientY, plane);
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") this.cancel();
  }

  private tick() {
    if (!this.active || !this.gizmo) return;
    // The gizmo sits where the selection now is: the anchor carried through the
    // same transform the bodies are under. It has to, or turning the part
    // leaves the rings behind on the original centroid.
    const pos = this.anchor.clone().applyMatrix4(this.transform());
    const k = this.viewport.pixelWorldSize(pos);
    this.gizmo.position.copy(pos);
    // Deliberately NOT turned with the selection. dx/dy/dz are world axes and
    // so are rx/ry/rz, so an arrow that had rotated away from world X would
    // still slide the bodies along world X — a handle pointing one way and
    // acting another. The rings stay world-aligned for the same reason.
    this.gizmo.scale.setScalar(k);
    const lit = (kind: NonNullable<Grab>["kind"], i: number) =>
      (this.grab ? this.grab.kind === kind && this.grab.index === i
        : this.hover?.kind === kind && this.hover.index === i);
    for (const a of this.arrows) {
      const ax = AXES[a.axis];
      if (ax) a.mat.color.set(lit("axis", a.axis) ? HOT : ax.color);
    }
    for (const r of this.rings) {
      const ax = AXES[r.axis];
      if (ax) r.mat.color.set(lit("ring", r.axis) ? HOT : ax.color);
    }
    for (const c of this.cubes) {
      const ax = AXES[c.axis];
      if (ax) c.mat.color.set(lit("size", c.axis) ? HOT : ax.color);
    }
    if (this.origin) {
      const hot = lit("origin", 0);
      this.origin.mat.color.set(hot ? HOT : this.pivotSnapped ? SNAPPED : ORIGIN_IDLE);
    }
    const s = this.viewport.projectToScreen(pos);
    this.dim.position(s.x + FIELDS_OFFSET_PX, s.y);
    this.applyTyped();
    this.raf = requestAnimationFrame(this.boundTick);
  }

  /** A typed value retargets the handle most recently dragged.
   *
   *  The field is the truth, sign included: the old code re-applied the drag's
   *  sign onto |v|, so a typed "-0.3" after a positive move went +0.3 and a
   *  typed value could never cross zero. */
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

  /** The six numbers, from the one place that knows how to combine a pivot,
   *  a rotation and a translation. */
  private values() {
    return composeMove(this.anchor, this.rot, this.t);
  }

  /** The whole gizmo as one matrix, in the order the two features are applied:
   *  the resize first, then the move. */
  private transform(): THREE.Matrix4 {
    return moveMatrix(this.values()).multiply(scaleAbout(this.anchor, this.scl));
  }

  private resized(): boolean {
    return Math.abs(this.scl.x - 1) + Math.abs(this.scl.y - 1) + Math.abs(this.scl.z - 1) > 1e-9;
  }

  /** Resize along one axis. `f` is the factor for that axis alone; the other
   *  two are left where they are, which is what dragging ONE cube means. */
  private applySize(axis: number, f: number) {
    const v = Math.max(MIN_SCALE, f);
    if (Math.abs(this.scl.getComponent(axis) - v) < 1e-9) return;
    this.scl.setComponent(axis, v);
    this.dim.updateFromCursor({ size: v });
    this.refreshPreview();
  }

  /** Instant ghost: transform the moved bodies' mesh + edges in place (no
   *  sidecar round-trip, so the drag is snappy). The real `move` is committed
   *  on release. */
  private refreshPreview() {
    this.viewport.setBodyMoveTransform(this.transform());
  }

  private buildFeature(): Feature {
    const r = (n: number) => Math.round(n * 1000) / 1000;
    const v = this.values();
    return {
      id: this.previewId,
      type: "move",
      dx: r(v.dx),
      dy: r(v.dy),
      dz: r(v.dz),
      rx: r(v.rx),
      ry: r(v.ry),
      rz: r(v.rz),
      ...(this.bodies.length ? { bodies: this.bodies } : {}),
    };
  }

  private buildScale(): Feature {
    const r = (n: number) => Math.round(n * 1e6) / 1e6;
    if (!this.scaleId) this.scaleId = this.store.nextId();
    return {
      id: this.scaleId,
      type: "scale",
      factor: 1,
      sx: r(this.scl.x),
      sy: r(this.scl.y),
      sz: r(this.scl.z),
      // The point the gizmo was sitting on, not the body's own location: a
      // resize has to hold still the thing the user aimed at.
      about: [r(this.anchor.x), r(this.anchor.y), r(this.anchor.z)],
      ...(this.bodies.length ? { bodies: this.bodies } : {}),
    };
  }

  private buildGizmo() {
    const g = new THREE.Group();
    for (let i = 0; i < AXES.length; i++) {
      const a = AXES[i];
      if (!a) continue;
      const mat = new THREE.MeshBasicMaterial({ color: a.color, depthTest: false, depthWrite: false });
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, ARROW_SHAFT, 12), mat);
      shaft.position.y = ARROW_SHAFT / 2;
      const head = new THREE.Mesh(new THREE.ConeGeometry(ARROW_HEAD_R, ARROW_HEAD, 18), mat);
      head.position.y = ARROW_SHAFT + ARROW_HEAD / 2;
      const arrow = new THREE.Group();
      arrow.add(shaft, head);
      arrow.quaternion.setFromUnitVectors(Y_AXIS, a.dir);
      arrow.renderOrder = 999;
      shaft.renderOrder = 999;
      head.renderOrder = 999;
      arrow.userData.axis = i;
      g.add(arrow);
      this.arrows.push({ group: arrow, mat, axis: i });

      // One ring per axis, in that axis's own colour: the ring you turn about X
      // is red, like the arrow you slide along X, so the two families read as
      // one gizmo rather than as two stacked ones.
      const rmat = new THREE.MeshBasicMaterial({
        color: a.color, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 8, 96), rmat);
      // A torus is built in the XY plane, so its own axis is +Z.
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), a.dir);
      ring.renderOrder = 999;
      // The grab band is invisible and fat. Hit-testing the drawn 2px tube
      // means aiming at a two-pixel line in perspective, which is not a target.
      const grab = new THREE.Mesh(
        new THREE.TorusGeometry(RING_RADIUS, RING_GRAB, 6, 48),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      grab.quaternion.copy(ring.quaternion);
      grab.userData.ring = i;
      g.add(ring, grab);
      this.rings.push({ mesh: ring, grab, mat: rmat, axis: i });

      const cmat = new THREE.MeshBasicMaterial({
        color: a.color, depthTest: false, depthWrite: false,
      });
      const cube = new THREE.Mesh(
        new THREE.BoxGeometry(SCALE_BOX, SCALE_BOX, SCALE_BOX), cmat,
      );
      cube.position.copy(a.dir).multiplyScalar(SCALE_AT);
      cube.renderOrder = 999;
      cube.userData.size = i;
      g.add(cube);
      this.cubes.push({ mesh: cube, mat: cmat, axis: i });
    }
    const omat = new THREE.MeshBasicMaterial({
      color: ORIGIN_IDLE, depthTest: false, depthWrite: false,
    });
    const dot = new THREE.Mesh(new THREE.SphereGeometry(ORIGIN_R, 20, 14), omat);
    dot.renderOrder = 1000; // over the arrows' roots, which meet here
    dot.userData.origin = true;
    g.add(dot);
    this.origin = { mesh: dot, mat: omat };

    g.renderOrder = 999;
    this.gizmo = g;
    this.viewport.addToScene(g);
  }

  /** Which handle is under the cursor.
   *
   *  Arrows are tested FIRST and win outright. The two families overlap where
   *  an arrow crosses its neighbours' rings, and an arrow is the smaller target
   *  of the two — losing it to a ring drawn over it would make the commonest
   *  gesture the hard one. */
  private hitHandle(x: number, y: number): Grab {
    if (!this.gizmo) return null;
    const ray = this.viewport.rayFrom(x, y);
    // The origin is tested first and wins outright: it sits where all three
    // arrows meet, so anything else tested before it would take every press
    // aimed at the middle of the gizmo.
    if (this.origin && ray.intersectObject(this.origin.mesh, false).length) {
      return { kind: "origin", index: 0 };
    }
    const arrowParts: THREE.Object3D[] = [];
    for (const a of this.arrows) arrowParts.push(...a.group.children);
    const onArrow = ray.intersectObjects(arrowParts, false)[0];
    if (onArrow) {
      let o: THREE.Object3D | null = onArrow.object;
      while (o && o.userData.axis === undefined) o = o.parent;
      if (o) return { kind: "axis", index: o.userData.axis as number };
    }
    const onCube = ray.intersectObjects(this.cubes.map((c) => c.mesh), false)[0];
    if (onCube) return { kind: "size", index: onCube.object.userData.size as number };
    const onRing = ray.intersectObjects(this.rings.map((r) => r.grab), false)[0];
    if (onRing) return { kind: "ring", index: onRing.object.userData.ring as number };
    return null;
  }

  private commit() {
    if (!this.active) return;
    this.applyTyped();
    const v = this.values();
    // Measured on the composed transform, not on `t`: moving the pivot rewrites
    // t to keep the transform unchanged, so a session that only repositioned
    // the origin has a non-zero t and has not moved anything.
    const moved = Math.hypot(v.dx, v.dy, v.dz) > 1e-9;
    const turned = Math.abs(v.rx) + Math.abs(v.ry) + Math.abs(v.rz) > 1e-9;
    const sized = this.resized();
    if (!moved && !turned && !sized) return this.cancel(); // nothing happened
    const scaleFeature = sized ? this.buildScale() : null;
    const feature = moved || turned ? this.buildFeature() : null;
    this.viewport.endBodyMoveGhost(false); // keep the ghost pose; the rebuild replaces it
    // The resize goes in FIRST, which is the order the preview composed them
    // in: it holds the origin still, so the move that follows still turns about
    // the same point.
    if (scaleFeature) this.store.addFeature(scaleFeature);
    if (feature) this.store.addFeature(feature);
    const done = this.onDone;
    const id = feature?.id ?? scaleFeature?.id ?? null;
    this.cleanup();
    done?.(id);
  }

  cancel() {
    this.viewport.endBodyMoveGhost(true); // restore the mesh to its un-moved pose
    const done = this.onDone;
    this.cleanup();
    done?.(null);
  }

  private cleanup() {
    const el = this.viewport.domElement;
    this.viewport.endBodyMoveGhost(false); // no-op if commit/cancel already ended it
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown, true);
    el.removeEventListener("pointerup", this.boundUp);
    window.removeEventListener("keydown", this.boundKey, true);
    el.style.cursor = "default";
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.dim.hide();
    if (this.gizmo) {
      this.viewport.removeFromScene(this.gizmo);
      for (const a of this.arrows) {
        for (const c of a.group.children) if (c instanceof THREE.Mesh) c.geometry.dispose();
        a.mat.dispose();
      }
      for (const r of this.rings) {
        r.mesh.geometry.dispose();
        r.grab.geometry.dispose();
        (r.grab.material as THREE.Material).dispose();
        r.mat.dispose();
      }
      if (this.origin) {
        this.origin.mesh.geometry.dispose();
        this.origin.mat.dispose();
        this.origin = null;
      }
      for (const c of this.cubes) {
        c.mesh.geometry.dispose();
        c.mat.dispose();
      }
      this.gizmo = null;
      this.arrows = [];
      this.rings = [];
      this.cubes = [];
    }
    this.viewport.suspendPicking = false;
    this.active = false;
    this.grab = null;
    this.hover = null;
    this.t.set(0, 0, 0);
    this.rot.identity();
    this.ringDeg = 0;
    this.scl.set(1, 1, 1);
    this.pivotSnapped = false;
    setPrompt(null);
  }
}
