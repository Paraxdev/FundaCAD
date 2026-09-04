// Setting a revolve's PITCH where the revolve is, by dragging the end of the
// sweep up the axis it turns about.
//
// A thread is a revolve that climbs, and a climb is a distance, so it belongs on
// the model rather than in a number field on the far side of the screen: take
// hold of the end of the thread, pull, watch the helix stretch. The value box is
// still there and still authoritative, as it is for every other manipulator.
//
// WHAT THE ARROW MOVES and what it WRITES are not the same number. Pitch is per
// turn, so a ten turn thread rises ten times its pitch: dragging the end 10mm
// sets a pitch of 1. The drag therefore reads a RISE and divides (screwMath's
// pitchFromRise). One millimetre of cursor to one millimetre of pitch would send
// the end flying ten times faster than the hand holding it.
//
// Nothing is written to the document until the gesture ends. A revolve of a
// dozen turns is a real sweep through the kernel and a rebuild per frame would
// make the drag lurch; the dashed helix is the same curve the sidecar sweeps
// along, so it says exactly where the geometry is going.
//
// TWO controls, because a revolve has two numbers and they are different KINDS
// of quantity. The straight arrow runs along the axis and sets how far one turn
// climbs. The curved one rides the sweep's own circle, at the real radius, in
// the real plane, and sets how far it turns in all — drag it round and the turns
// pile up, which is the only way 3600 degrees is an answer somebody arrives at
// rather than types. Each points the way its own number grows, and they leave
// the same anchor at right angles, so neither has to be labelled.
//
// The curved one stops where the geometry would. Past one turn, a climb shorter
// than the profile is tall makes each turn run into the last, so the arrow meets
// a wall exactly there (screwMath.clampDragAngle) instead of letting the user
// build something the sidecar will refuse. That wall is how the limit is meant
// to be found: by feel, while asking for it.
//
// A TYPED value is not a drag, though, and used to get the drag's treatment: the
// box read 600 degrees, the dashed line ran round twice, and the solid underneath
// went on being the 360 it was built as. Two things on screen said different
// numbers and the shaded one is the one that gets believed. So a value that is
// typed goes through the store's edit preview once the typing settles — the real
// feature, rebuilt by the sidecar, in the timeline position it will occupy. A
// preview is not an undo step, so the value box stays the thing that commits.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { SketchOverlay } from "../sketch/overlay";
import type { DocumentStore } from "../document/store";
import type { Feature, Vec3 } from "../types";
import { detectRegions, pointInRegion } from "../sketch/region";
import { resolveEntities } from "../sketch/resolve";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import {
  axisDragDistance,
  createDragHandle,
  leanOutOfView,
  type DragHandle,
} from "./manipulator";
import {
  arcSpanDeg,
  clampDragAngle,
  clampDragPitch,
  pitchFromRise,
  revolveAxis,
  riseOf,
  screwPath,
  sweepArc,
  unwrapTurn,
} from "./screwMath";
import {
  ROTATE_SNAP_DEG,
  angleInFrame,
  ringDragDegenerate,
  rotationFrame,
  snapDegrees,
} from "./transformGizmo";
import { themeColor } from "../viewport/themeColors";
import { CanvasGesture } from "./canvasGesture";

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** How long a typed field has to stand still before the sidecar is asked to
 *  build it. Long enough that typing "600" is one rebuild rather than three
 *  (of which "6" and "60" are sweeps nobody wants), short enough to read as
 *  the model answering the keystroke. */
const TYPED_PREVIEW_MS = 350;

// The angle arrow, in SCREEN pixels. Its length is spent as arc along the real
// sweep circle (screwMath.arcSpanDeg), so it stays the same size to the hand
// whether the revolve is a 2mm thread or a 200mm flange.
//
// 72 is longer than the straight arrow's 45 on purpose: an arc reads shorter
// than a line of the same length because it is turning away from you, and this
// one is also the more likely of the two to be seen at a glance.
const ARC_PX = 72;
const ARC_TUBE_PX = 2.2;
/** Invisible and generous, like the straight handle's grab volumes: the drawn
 *  tube is thin because it is a line, not because aiming should be hard. */
const ARC_GRAB_PX = 9;
const HEAD_LEN_PX = 15;
const HEAD_R_PX = 5.2;
/** Enough segments that the curve reads as one at the widest span it may open
 *  to (MAX_ARC_DEG), and few enough to rebuild without thinking about it. */
const ARC_SEGMENTS = 20;

type Revolve = Extract<Feature, { type: "revolve" }>;

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);

export class RevolvePitchTool {
  active = false;

  private id: string | null = null;
  private at: Vec3 = [0, 0, 0]; // a point of the profile, where the path starts
  private axis = { origin: [0, 0, 0] as Vec3, dir: [0, 0, 1] as Vec3 };
  private base = new THREE.Vector3(); // the axis point level with the profile
  private dir = new THREE.Vector3(0, 0, 1);
  private pitch = 0;
  private angle = 360;
  /** How tall the profile is along the axis, and so the shortest climb that
   *  keeps one turn clear of the last. Zero means "not measured". */
  private minPitch = 0;

  /** How far the profile stands off the axis: the radius the angle arrow rides,
   *  and what turns its pixel length into degrees of sweep. */
  private radius = 0;

  private gizmo: THREE.Group | null = null;
  private handle: DragHandle | null = null;
  private helix: THREE.Line | null = null;
  private arc: THREE.Group | null = null;
  private arcTube: THREE.Mesh | null = null;
  private arcGrab: THREE.Mesh | null = null;
  private arcHead: THREE.Mesh | null = null;
  private arcMat: THREE.MeshLambertMaterial | null = null;
  /** What the arc geometry was last built for. Rebuilding it every frame would
   *  be a tube and a curve per frame for a shape that only moves when the sweep
   *  or the zoom does; the span is quantised so an orbit does not thrash it. */
  private arcKey = "";
  private arcEnd = new THREE.Vector3();
  private arcTangent = new THREE.Vector3(1, 0, 0);
  private anchor = new THREE.Vector3(); // the end of the sweep: where the handle stands
  private quat = new THREE.Quaternion();

  private hovering = false;
  private hoveringArc = false;
  private grabbing = false;
  private grabbingAngle = false;
  private grabRise = 0;
  private grabProj = 0;
  /** The cursor's angle about the axis when the arc was taken hold of, and the
   *  sweep it stood at. Absolute rather than incremental, so a snap step cannot
   *  accumulate its rounding over ten turns. */
  private grabTurn = 0;
  private grabAngle = 360;
  /** The running, UNWRAPPED cursor angle: the only thing that knows which turn
   *  the drag is on, since a reading is folded into half a circle either way. */
  private lastTurn = 0;
  private downPos = { x: 0, y: 0 };
  private downOnGizmo = false;

  private dim = new DimInput();
  private onDone: ((id: string | null) => void) | null = null;
  /** Set once a typed value has opened the store's edit preview. Opened LAZILY,
   *  because opening it rebuilds: a gesture that only ever drags the arrow
   *  should not pay for a round trip it never looks at. */
  private previewing = false;
  private previewTimer = 0;

  private readonly gesture: CanvasGesture;

  constructor(
    private viewport: Viewport,
    private store: DocumentStore,
    private overlay: SketchOverlay,
  ) {
    this.gesture = new CanvasGesture(viewport.domElement, {
      move: (e) => this.onMove(e),
      down: (e) => this.onDown(e),
      up: (e) => this.onUp(e),
      key: (e) => this.onKey(e),
      frame: () => this.tick(),
    });
  }

  /** Open the arrow on a committed revolve. False sends the caller to the value
   *  rows instead, and covers everything this gesture has no answer for: a
   *  parameter drives the numbers, the feature never recorded which area it
   *  spins, or that area sits on the axis and so has no side to climb from. */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = this.store.document.features.find((x) => x.id === featureId);
    if (!f || f.type !== "revolve") return false;
    const rev = f as Revolve;
    const bound = (field: string) =>
      this.store.isParamBound({ kind: "feature", feature: rev.id, field });
    if (bound("pitch") || bound("angle")) return false;
    if (typeof rev.angle !== "number" || rev.angle === 0) return false;
    const savedPitch = rev.pitch;
    if (savedPitch != null && typeof savedPitch !== "number") return false;

    const at = rev.regions?.[0];
    if (!at) return false; // nothing on the feature says where its profile is

    const axis = revolveAxis(rev.axis);
    // screwPath is the arbiter of whether this revolve HAS a path: it refuses a
    // profile centred on the axis, the same refusal the sidecar makes. Asking it
    // here means the arrow is never offered for a gesture that could not be
    // built, and means one implementation of the rule rather than two.
    if (!screwPath(at as Vec3, axis, rev.angle, savedPitch ?? 0, 2).length) return false;

    this.active = true;
    this.id = featureId;
    this.onDone = onDone;
    this.at = [at[0], at[1], at[2]];
    this.axis = axis;
    this.dir.set(axis.dir[0], axis.dir[1], axis.dir[2]);
    const rel = v3(this.at).sub(v3(axis.origin));
    this.base.copy(v3(axis.origin)).addScaledVector(this.dir, rel.dot(this.dir));
    this.angle = rev.angle;
    this.pitch = savedPitch ?? 0;
    this.minPitch = this.profileHeight(rev.sketch);
    this.radius = v3(this.at).sub(this.base).length();

    this.viewport.suspendPicking = true;
    this.gesture.attach();

    this.buildGizmo();
    this.buildHelix();
    this.buildArc();
    this.dim.show(
      [
        { name: "pitch", label: "Pitch", kind: "length" },
        { name: "angle", label: "Angle", kind: "angle" },
      ],
      () => this.commit(),
      () => this.cancel(),
    );
    // Shown, not SEEDED. Seeding locks a field against cursor tracking, which is
    // right for a value the gesture must not touch and exactly wrong for the one
    // the arrow drives: the box read 0 through the whole drag.
    this.dim.updateFromCursor({ pitch: this.pitch, angle: this.angle });
    setPrompt(
      "Drag the straight arrow to set how far one turn climbs, the curved one to " +
        "set how far it turns in all, so ten times round is 3600 degrees. " +
        "Either value can be typed. Enter applies, Esc cancels.",
    );
    this.refresh();
    this.gesture.frame();
    return true;
  }

  // --- geometry --------------------------------------------------------------

  /** The profile's extent along the axis: the shortest climb that clears one
   *  turn of the last.
   *
   *  Built from the DOCUMENT rather than from what is drawn. A sketch a revolve
   *  has consumed is hidden by default, so its regions are not in the overlay at
   *  all, and reading them from there measured every real thread as zero. The
   *  same two calls the overlay makes, against the same plane object, give the
   *  same regions whether or not anything is drawing them.
   *
   *  Zero means "could not measure", not "no height", and leaves the drag
   *  unclamped with the kernel's own refusal as the backstop. */
  private profileHeight(sketchId: string): number {
    const doc = this.store.document;
    const sk = doc.features.find((x) => x.id === sketchId);
    if (!sk || sk.type !== "sketch") return 0;
    let regions;
    let plane;
    try {
      plane = this.overlay.planeFor(sk.plane);
      regions = detectRegions(sk.id, resolveEntities(sk, doc.parameters));
    } catch {
      return 0; // a sketch that will not resolve is not this tool's problem
    }
    // The region the revolve actually spins, not the sketch: a sketch holding
    // two profiles would otherwise be measured by whichever is taller, and the
    // arrow would refuse pitches the shorter one can perfectly well take.
    const uv = plane.to2D(v3(this.at));
    const region = regions.find((r) => pointInRegion(uv, r));
    if (!region) return 0;
    let lo = Infinity;
    let hi = -Infinity;
    // The outer loop bounds the whole region, holes included, so it alone
    // decides how tall the section is.
    const w = new THREE.Vector3();
    for (const q of region.loop) {
      const a = plane.to3D(q.x, q.y, w).sub(this.base).dot(this.dir);
      if (a < lo) lo = a;
      if (a > hi) hi = a;
    }
    return Number.isFinite(lo) && Number.isFinite(hi) ? hi - lo : 0;
  }

  /** Redraw the path and move the handle to its far end. One call, because a
   *  handle standing anywhere but ON the curve it stretches is a lie about what
   *  the gesture does. */
  private refresh() {
    // The arc is left to the next tick: its span is measured in screen pixels,
    // so it needs a camera, and tick is where the camera is already being read.
    const pts = screwPath(this.at, this.axis, this.angle, this.pitch);
    const end = pts[pts.length - 1];
    if (end) this.anchor.set(end[0], end[1], end[2]);
    if (this.helix) {
      this.helix.geometry.dispose();
      this.helix.geometry = new THREE.BufferGeometry().setFromPoints(pts.map(v3));
      this.helix.computeLineDistances();
    }
  }

  // --- pointer ---------------------------------------------------------------

  private onMove(e: PointerEvent) {
    if (this.grabbing) {
      // Measured from `base`, which does not move. Measuring from `anchor`
      // instead feeds the gesture its own output: the anchor is recomputed from
      // the pitch every frame, so each move shifts the origin the next one is
      // read against, and a steady drag up produces a value that stalls and then
      // runs backwards.
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.base, this.dir);
      const raw = pitchFromRise(this.grabRise + (proj - this.grabProj), this.angle);
      if (raw == null) return;
      // Snap the PITCH, not the rise. The pitch is the number that lands in the
      // document and on the drawing, so it is the one that should come to rest
      // on a round value; snapping the rise would give a clean height on screen
      // and 1.0416 in the field.
      const stepped = clampDragPitch(
        snap(raw, this.viewport.snapStep(this.anchor, e.shiftKey)),
        this.minPitch,
        this.angle,
      );
      if (stepped === this.pitch) return;
      this.pitch = stepped;
      this.dim.updateFromCursor({ pitch: this.pitch });
      this.refresh();
      return;
    }
    if (this.grabbingAngle) {
      const now = this.cursorTurn(e.clientX, e.clientY);
      if (now === null) return; // the view went edge-on mid-drag; hold the value
      this.lastTurn = unwrapTurn(this.lastTurn, now);
      const raw = this.grabAngle + (this.lastTurn - this.grabTurn);
      // Shift lifts the step, the way it does on the move gizmo's rings and on
      // the pitch arrow. The default step is the app's one rotation step rather
      // than a second convention invented here.
      const stepped = clampDragAngle(
        snapDegrees(raw, e.shiftKey ? 0 : ROTATE_SNAP_DEG),
        this.pitch,
        this.minPitch,
      );
      if (stepped === this.angle) return;
      this.angle = stepped;
      this.dim.updateFromCursor({ angle: this.angle });
      this.refresh();
      return;
    }
    const over = this.pick(e.clientX, e.clientY);
    this.hovering = over === "pitch";
    this.hoveringArc = over === "angle";
    this.viewport.domElement.style.cursor = over ? "grab" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    const over = this.pick(e.clientX, e.clientY);
    this.downOnGizmo = over === "pitch";
    if (over === "pitch") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.grabbing = true;
      // The hand is now the authority on this number, even if it was typed a
      // moment ago; otherwise the arrow moves and the box argues with it.
      this.dim.takeOver("pitch");
      this.grabRise = riseOf(this.angle, this.pitch);
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.base, this.dir);
      this.viewport.domElement.style.cursor = "grabbing";
      return;
    }
    if (over !== "angle") return;
    const start = this.cursorTurn(e.clientX, e.clientY);
    if (start === null) return; // edge-on: leave the press to the orbit
    e.preventDefault();
    e.stopImmediatePropagation();
    this.downOnGizmo = true; // a press on either control is a press on the tool
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
      this.viewport.domElement.style.cursor =
        this.hovering || this.hoveringArc ? "grab" : "default";
      // Letting go of a handle is NOT the end of the gesture. A revolve has two
      // numbers and a handle each, so committing here shut the tool the moment
      // the first one was set and the second could not be reached without
      // reopening: drag the pitch, and the angle arc was already gone.
      //
      // So a release stays armed and pushes the drag through the sidecar
      // instead. That is the other half of it — the drag itself only moves the
      // dashed helix, because a rebuild per frame lurches, so without a build on
      // release you would go on aiming the second handle at the shape you
      // started with. manipulator.fluentRelease already says "stay" for every
      // gesture begun on a tool's own gizmo; this one was the exception.
      this.pushPreview();
      return;
    }
    const moved =
      Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    if (!this.downOnGizmo && !moved) this.commit();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") this.cancel();
  }

  private tick() {
    if (!this.active || !this.gizmo) return;
    // The arrow points the way the climb goes, so a negative pitch turns it over
    // and the glyph says which way the thread runs without reading a sign.
    const sign = riseOf(this.angle, this.pitch) < 0 ? -1 : 1;
    // Tipped back out of the screen when the axis points at the camera. Looking
    // down a thread's own axis is not an odd view of it, it is the view that
    // shows the turns, and the arrow collapsed to a blob there with no length to
    // read or aim at, next to a curved arrow that reads perfectly from the same
    // angle. leanOutOfView is for DRAWING only: the drag still measures along
    // the true axis, where axisDragDistance already handles the steep case.
    const fwd = this.viewport.camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3()
      .setFromMatrixColumn(this.viewport.camera.matrixWorld, 0)
      .normalize();
    this.quat.setFromUnitVectors(
      Y_AXIS,
      leanOutOfView(this.dir.clone().multiplyScalar(sign), fwd, right),
    );
    this.gizmo.position.copy(this.anchor);
    this.gizmo.quaternion.copy(this.quat);
    this.gizmo.scale.setScalar(this.viewport.pixelWorldSize(this.anchor));
    this.handle?.paint({ hot: this.hovering || this.grabbing });
    this.drawArc();
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
    if (!this.grabbing && !this.grabbingAngle) this.readFields();
    this.gesture.frame();
  }

  /** Take a typed value once the user has actually typed it. A field only counts
   *  as user-driven after they touch it, so this cannot fight the arrow. */
  private readFields() {
    let changed = false;
    const a = this.dim.getValue("angle");
    if (a != null && this.dim.isUserDriven("angle") && a !== 0 && Math.abs(a - this.angle) > 1e-9) {
      this.angle = a;
      changed = true;
    }
    const p = this.dim.getValue("pitch");
    if (p != null && this.dim.isUserDriven("pitch") && Math.abs(p - this.pitch) > 1e-9) {
      this.pitch = p;
      changed = true;
    }
    if (changed) {
      this.refresh();
      this.schedulePreview();
    }
  }

  // --- live preview ----------------------------------------------------------

  /** Ask for a rebuild once the typing has settled. Restarting the timer on
   *  every change is what makes a number typed digit by digit build once. */
  private schedulePreview() {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = 0;
      this.pushPreview();
    }, TYPED_PREVIEW_MS);
  }

  /** Build the revolve as the boxes currently read it, in its own place in the
   *  timeline. The feature is taken from the document each time rather than
   *  cached, so anything else that changed about it (its areas, its operation)
   *  is carried along instead of being reverted by the preview. */
  private pushPreview() {
    if (!this.active || !this.id) return;
    const f = this.store.document.features.find((x) => x.id === this.id);
    if (!f || f.type !== "revolve") return;
    const next = { ...f, angle: this.angle, pitch: this.pitch || undefined } as Feature;
    if (this.previewing) {
      this.store.setEditPreview(next);
    } else {
      this.previewing = true;
      this.store.beginEditPreview(this.id, next);
    }
  }

  // --- scene -----------------------------------------------------------------

  private buildGizmo() {
    this.handle = createDragHandle();
    this.gizmo = this.handle.group;
    this.viewport.addToScene(this.gizmo);
  }

  /** The path the profile travels: the sidecar's spine, drawn. */
  private buildHelix() {
    const mat = new THREE.LineDashedMaterial({
      color: 0xffd24a,
      dashSize: 1.6,
      gapSize: 1.1,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
    });
    const line = new THREE.Line(new THREE.BufferGeometry(), mat);
    line.renderOrder = 999;
    this.helix = line;
    this.viewport.addToScene(line);
  }

  /** The angle arrow: a run of the sweep's own circle with a head on the end.
   *
   *  Built empty and filled in by drawArc, because its shape depends on the
   *  camera and there is no camera worth reading before the first frame. */
  private buildArc() {
    const group = new THREE.Group();
    group.renderOrder = 999;
    // Lit and depth-free like the straight handle, so the two read as one set of
    // controls rather than as a control and a piece of annotation. Its colour
    // comes from the same accent token, resolved at paint time.
    const mat = new THREE.MeshLambertMaterial({
      color: themeColor("--accent", 0xff7a3c),
      emissive: themeColor("--accent", 0xff7a3c),
      emissiveIntensity: 0.5,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const tube = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    const head = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 14), mat);
    const grab = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ visible: false, depthTest: false }),
    );
    tube.renderOrder = 999;
    head.renderOrder = 999;
    group.add(tube, head, grab);
    this.arc = group;
    this.arcTube = tube;
    this.arcHead = head;
    this.arcGrab = grab;
    this.arcMat = mat;
    this.viewport.addToScene(group);
  }

  /** Put the arrow back on the circle at this zoom. Cheap when nothing moved,
   *  which is most frames. */
  private drawArc() {
    if (!this.arc || !this.arcTube || !this.arcGrab || !this.arcHead || !this.arcMat) return;
    const mmPerPx = this.viewport.pixelWorldSize(this.anchor);
    const span =
      arcSpanDeg(this.radius, mmPerPx, ARC_PX) * (this.angle < 0 ? -1 : 1);
    // Quantised so an orbit, which changes mmPerPx every frame under a
    // perspective camera, does not rebuild a tube sixty times a second for a
    // shape that has not visibly moved.
    const key = `${this.angle.toFixed(4)}|${this.pitch.toFixed(4)}|${Math.round(span * 2)}`;
    if (key !== this.arcKey) {
      this.arcKey = key;
      const pts = sweepArc(this.at, this.axis, this.angle, this.pitch, span, ARC_SEGMENTS);
      if (pts.length < 2) {
        this.arc.visible = false;
        return;
      }
      this.arc.visible = true;
      const curve = new THREE.CatmullRomCurve3(pts.map(v3));
      this.arcTube.geometry.dispose();
      this.arcTube.geometry = new THREE.TubeGeometry(
        curve,
        ARC_SEGMENTS,
        ARC_TUBE_PX * mmPerPx,
        8,
        false,
      );
      this.arcGrab.geometry.dispose();
      this.arcGrab.geometry = new THREE.TubeGeometry(
        curve,
        ARC_SEGMENTS,
        ARC_GRAB_PX * mmPerPx,
        6,
        false,
      );
      const last = pts[pts.length - 1]!;
      const prev = pts[pts.length - 2]!;
      this.arcEnd.set(last[0], last[1], last[2]);
      this.arcTangent.set(last[0] - prev[0], last[1] - prev[1], last[2] - prev[2]);
      if (this.arcTangent.lengthSq() > 1e-18) this.arcTangent.normalize();
    }
    // The head follows the zoom exactly, since moving and scaling a cone costs
    // nothing and a head that steps in size is the one part a user would notice.
    this.arcHead.scale.set(HEAD_R_PX * mmPerPx, HEAD_LEN_PX * mmPerPx, HEAD_R_PX * mmPerPx);
    this.arcHead.quaternion.setFromUnitVectors(Y_AXIS, this.arcTangent);
    // Stood FORWARD along the tangent by half its length. A cone is modelled
    // about its own centre, so placing it on the end of the tube would bury half
    // the head in the line it is meant to cap; this puts its base there and its
    // point out past the end, which is where an arrow's point belongs.
    this.arcHead.position
      .copy(this.arcEnd)
      .addScaledVector(this.arcTangent, (HEAD_LEN_PX * mmPerPx) / 2);
    const hot = this.hoveringArc || this.grabbingAngle;
    const c = themeColor(hot ? "--accent-hot" : "--accent", hot ? 0xff9a5c : 0xff7a3c);
    this.arcMat.color.set(c);
    this.arcMat.emissive.set(c);
  }

  /** Where the cursor sits on the sweep circle, in degrees about the axis.
   *
   *  Read against the axis's own plane, which is the only reading that stays
   *  put as the camera moves. Null when that plane is nearly edge-on: the arc
   *  is a line on screen there and a pixel of pointer movement would be an
   *  unbounded jump in angle, so refusing is better than spinning the sweep
   *  (see transformGizmo.ringDragDegenerate, which the move gizmo's rings use
   *  for the same reason). */
  private cursorTurn(x: number, y: number): number | null {
    const view = this.viewport.camera.getWorldDirection(new THREE.Vector3());
    if (ringDragDegenerate(view.dot(this.dir))) return null;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.dir, this.anchor);
    const at = this.viewport.screenToPlane(x, y, plane);
    if (!at) return null;
    // The pivot is where that plane crosses the axis, which is the axis point
    // level with the arrow rather than the one level with the profile.
    const pivot = this.base
      .clone()
      .addScaledVector(this.dir, this.anchor.clone().sub(this.base).dot(this.dir));
    return (angleInFrame(at, pivot, rotationFrame(this.dir)) * 180) / Math.PI;
  }

  /** Which control the cursor is over, or neither.
   *
   *  By DISTANCE, not by order. The two leave the same anchor at right angles,
   *  so a ray cast from anywhere except straight down one of them passes through
   *  both: measured at a three-quarter view, the straight arrow's grab volume
   *  answers yes at a point a third of the way along the curve, and asking it
   *  first would hand it presses aimed squarely at the arc. Whichever surface
   *  the ray reaches first is the one drawn on top, which is the one the hand
   *  was aiming at. */
  private pick(x: number, y: number): "pitch" | "angle" | null {
    const rc = this.viewport.rayFrom(x, y);
    const arrow = this.gizmo ? rc.intersectObjects(this.gizmo.children, false)[0] : undefined;
    // The HEAD is in the set as well as the grab tube. The tube ends where the
    // head begins, so without it the point of the arrow, which is the part of an
    // arrow a hand goes for, was the one place on the control that took no
    // press: measured along the curve, the last tenth answered nothing at all.
    const parts = this.arc?.visible
      ? [this.arcGrab, this.arcHead].filter((o): o is THREE.Mesh => !!o)
      : [];
    const curve = rc.intersectObjects(parts, false)[0];
    if (!arrow) return curve ? "angle" : null;
    if (!curve) return "pitch";
    return curve.distance < arrow.distance ? "angle" : "pitch";
  }

  // --- ending ----------------------------------------------------------------

  private commit() {
    if (!this.active || !this.id) return;
    const id = this.id;
    const { pitch, angle } = this;
    const done = this.onDone;
    // false: the write below schedules the rebuild, and closing the preview with
    // its own would build the pre-commit model for one frame on the way past.
    this.cleanup(false);
    // A pitch of zero is the flat revolve, and the field is dropped rather than
    // written as 0 so a revolve that never climbed reads exactly as it did
    // before this tool was ever opened on it.
    this.store.updateFeature(id, {
      angle,
      pitch: pitch || undefined,
    } as unknown as Partial<Feature>);
    done?.(id);
  }

  cancel() {
    const done = this.onDone;
    this.cleanup(true);
    done?.(null);
  }

  private cleanup(rebuild = true) {
    const el = this.viewport.domElement;
    this.gesture.detach();
    el.style.cursor = "default";
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = 0;
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
    if (this.helix) {
      this.viewport.removeFromScene(this.helix);
      this.helix.geometry.dispose();
      (this.helix.material as THREE.Material).dispose();
      this.helix = null;
    }
    if (this.arc) {
      this.viewport.removeFromScene(this.arc);
      this.arcTube?.geometry.dispose();
      this.arcGrab?.geometry.dispose();
      this.arcHead?.geometry.dispose();
      (this.arcGrab?.material as THREE.Material | undefined)?.dispose();
      this.arcMat?.dispose();
      this.arc = null;
      this.arcTube = null;
      this.arcGrab = null;
      this.arcHead = null;
      this.arcMat = null;
      this.arcKey = "";
    }
    this.viewport.suspendPicking = false;
    this.active = false;
    this.grabbing = false;
    this.grabbingAngle = false;
    this.hovering = false;
    this.hoveringArc = false;
    this.id = null;
    this.onDone = null;
    setPrompt(null);
  }
}
