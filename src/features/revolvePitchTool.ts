// Revolve pitch and angle on the model. The straight arrow drags a rise and divides it into a pitch per turn
// (screwMath.pitchFromRise); the curved one sets the sweep and stops where turns would collide (clampDragAngle).

import * as THREE from "three";
import { asFeature } from "../types";
import type { Viewport } from "../viewport/viewport";
import type { SketchOverlay } from "../sketch/overlay";
import type { DocumentStore } from "../document/store";
import type { Feature, Vec3 } from "../types";
import { detectRegions, pointInRegion } from "../sketch/region";
import { resolveEntities } from "../sketch/resolve";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import { axisDragDistance, createDragHandle, nameHandle, leanOutOfView, type DragHandle } from "./manipulator";
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
import { ROTATE_SNAP_DEG, angleInFrame, ringDragDegenerate, rotationFrame, snapDegrees } from "./transformGizmo";
import { themeColor } from "../viewport/themeColors";
import { CanvasGesture } from "./canvasGesture";
import { hitPx, hitScale } from "../input/pointerKind";

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Typing "600" is one rebuild rather than three, yet still reads as the model answering the keystroke. */
const TYPED_PREVIEW_MS = 350;

// In screen pixels, spent as arc along the sweep circle (screwMath.arcSpanDeg). Longer than the straight arrow's
// 45, since an arc reads shorter than a line of the same length.
const ARC_PX = 72;
const ARC_TUBE_PX = 2.2;
/** Invisible and generous, like the straight handle's grab volumes. */
const ARC_GRAB_PX = 9;
const HEAD_LEN_PX = 15;
const HEAD_R_PX = 5.2;
/** Smooth at MAX_ARC_DEG, few enough to rebuild without thinking about it. */
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
  /** The shortest climb that keeps one turn clear of the last. Zero means not measured. */
  private minPitch = 0;

  /** The radius the angle arrow rides, which turns its pixel length into degrees. */
  private radius = 0;

  private gizmo: THREE.Group | null = null;
  private handle: DragHandle | null = null;
  private helix: THREE.Line | null = null;
  private arc: THREE.Group | null = null;
  private arcTube: THREE.Mesh | null = null;
  private arcGrab: THREE.Mesh | null = null;
  private arcHead: THREE.Mesh | null = null;
  private arcMat: THREE.MeshLambertMaterial | null = null;
  /** What the arc was last built for, the span quantised so an orbit does not rebuild it every frame. */
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
  /** Absolute rather than incremental, so a snap step cannot accumulate its rounding over ten turns. */
  private grabTurn = 0;
  private grabAngle = 360;
  /** Unwrapped, the only thing that knows which turn the drag is on, since a reading folds into half a circle. */
  private lastTurn = 0;
  private downPos = { x: 0, y: 0 };
  private downOnGizmo = false;

  private dim = new DimInput();
  private onDone: ((id: string | null) => void) | null = null;
  /** Set once a typed value opened the store's edit preview, lazily since opening it rebuilds. */
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

  /** False sends the caller to the value rows: a parameter drives the numbers, the feature recorded no area, or
   *  that area sits on the axis with no side to climb from. */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = this.store.document.features.find((x) => x.id === featureId);
    if (!f || f.type !== "revolve") return false;
    const rev = f as Revolve;
    const bound = (field: string) => this.store.isParamBound({ kind: "feature", feature: rev.id, field });
    if (bound("pitch") || bound("angle")) return false;
    if (typeof rev.angle !== "number" || rev.angle === 0) return false;
    const savedPitch = rev.pitch;
    if (savedPitch != null && typeof savedPitch !== "number") return false;

    const at = rev.regions?.[0];
    if (!at) return false; // nothing on the feature says where its profile is

    const axis = revolveAxis(rev.axis);
    // screwPath refuses a profile centred on the axis as the engine does, so one implementation decides.
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
    // Shown, not seeded: seeding locks a field against cursor tracking, and the box read 0 through the whole drag.
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

  /** From the document, not the overlay, which hides a consumed sketch and so measured every thread as zero. Zero
   *  means could not measure, leaving the kernel's refusal as the backstop. */
  private profileHeight(sketchId: string): number {
    const doc = this.store.document;
    const sk = doc.features.find((x) => x.id === sketchId);
    const sketch = asFeature(sk, "sketch");
    if (!sketch) return 0;
    let regions;
    let plane;
    try {
      plane = this.overlay.planeFor(sketch.plane);
      regions = detectRegions(sketch.id, resolveEntities(sketch, doc.parameters));
    } catch {
      return 0; // a sketch that will not resolve is not this tool's problem
    }
    // The region the revolve spins, not the sketch, or a taller second profile would set the limit.
    const uv = plane.to2D(v3(this.at));
    const region = regions.find((r) => pointInRegion(uv, r));
    if (!region) return 0;
    let lo = Infinity;
    let hi = -Infinity;
    // The outer loop bounds the whole region, holes included.
    const w = new THREE.Vector3();
    for (const q of region.loop) {
      const a = plane.to3D(q.x, q.y, w).sub(this.base).dot(this.dir);
      if (a < lo) lo = a;
      if (a > hi) hi = a;
    }
    return Number.isFinite(lo) && Number.isFinite(hi) ? hi - lo : 0;
  }

  /** One call, because a handle anywhere but on the curve it stretches lies about the gesture. */
  private refresh() {
    // The arc waits for the next tick, which already reads the camera its pixel span needs.
    const pts = screwPath(this.at, this.axis, this.angle, this.pitch);
    const end = pts[pts.length - 1];
    if (end) this.anchor.set(end[0], end[1], end[2]);
    if (this.helix) {
      this.helix.geometry.dispose();
      this.helix.geometry = new THREE.BufferGeometry().setFromPoints(pts.map(v3));
      this.helix.computeLineDistances();
    }
  }

  // A drag moves only the dashed helix, the curve the engine sweeps along. A rebuild per frame of a revolve with a
  // dozen turns makes the drag lurch, so the engine builds on release.
  private onMove(e: PointerEvent) {
    if (this.grabbing) {
      // Measured from `base`, which does not move. `anchor` is recomputed from the pitch every frame, so measuring
      // from it feeds the drag its own output and the value stalls, then runs backwards.
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.base, this.dir);
      const raw = pitchFromRise(this.grabRise + (proj - this.grabProj), this.angle);
      if (raw == null) return;
      // Snap the pitch, the number that lands in the document, not the rise.
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
      // Shift lifts the step; the default is the app's one rotation step.
      const stepped = clampDragAngle(snapDegrees(raw, e.shiftKey ? 0 : ROTATE_SNAP_DEG), this.pitch, this.minPitch);
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
      // The hand now owns this number even if it was just typed, or the arrow and the box argue.
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
      this.viewport.domElement.style.cursor = this.hovering || this.hoveringArc ? "grab" : "default";
      // A release stays armed and pushes the drag through the engine, so the second handle is aimed at the built shape.
      // Committing here closed the tool before the other number could be set.
      this.pushPreview();
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
    // A negative pitch turns the arrow over, so the glyph says which way the thread runs.
    const sign = riseOf(this.angle, this.pitch) < 0 ? -1 : 1;
    // Tipped back out of the screen when looking down the axis, the view that shows the turns. For drawing only:
    // the drag still measures along the true axis.
    const fwd = this.viewport.camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().setFromMatrixColumn(this.viewport.camera.matrixWorld, 0).normalize();
    this.quat.setFromUnitVectors(Y_AXIS, leanOutOfView(this.dir.clone().multiplyScalar(sign), fwd, right));
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

  /** A field counts as user driven only after it is touched, so this cannot fight the arrow. */
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

  /** A typed value is rebuilt by the engine, or the box reads 600 while the shaded solid stays the 360 it was built
   *  as. Restarting the timer on every change makes a number typed digit by digit build once. */
  private schedulePreview() {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = 0;
      this.pushPreview();
    }, TYPED_PREVIEW_MS);
  }

  /** Taken from the document each time, not cached, so other changes to the feature are carried, not reverted.
   *  A preview is not an undo step, so the value box stays the thing that commits. */
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

  private buildGizmo() {
    this.handle = nameHandle(createDragHandle(), "pitch");
    this.gizmo = this.handle.group;
    this.viewport.addToScene(this.gizmo);
  }

  /** The path the profile travels: the engine's spine, drawn. */
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

  /** Built empty and filled in by drawArc, since its shape needs a camera. */
  private buildArc() {
    const group = new THREE.Group();
    group.renderOrder = 999;
    // Lit and depth-free like the straight handle, from the same accent token, so the two read as one set.
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
    const span = arcSpanDeg(this.radius, mmPerPx, ARC_PX) * (this.angle < 0 ? -1 : 1);
    // Quantised so an orbit, which changes mmPerPx every frame in perspective, does not rebuild the tube 60 times a
    // second. The pointer kind is in it, since the grab tube is finger sized on touch.
    const key = `${this.angle.toFixed(4)}|${this.pitch.toFixed(4)}|${Math.round(span * 2)}|${hitScale()}`;
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
      this.arcTube.geometry = new THREE.TubeGeometry(curve, ARC_SEGMENTS, ARC_TUBE_PX * mmPerPx, 8, false);
      this.arcGrab.geometry.dispose();
      this.arcGrab.geometry = new THREE.TubeGeometry(curve, ARC_SEGMENTS, hitPx(ARC_GRAB_PX) * mmPerPx, 6, false);
      const last = pts[pts.length - 1]!;
      const prev = pts[pts.length - 2]!;
      this.arcEnd.set(last[0], last[1], last[2]);
      this.arcTangent.set(last[0] - prev[0], last[1] - prev[1], last[2] - prev[2]);
      if (this.arcTangent.lengthSq() > 1e-18) this.arcTangent.normalize();
    }
    // The head follows the zoom exactly: it is cheap, and a head that steps in size is noticed.
    this.arcHead.scale.set(HEAD_R_PX * mmPerPx, HEAD_LEN_PX * mmPerPx, HEAD_R_PX * mmPerPx);
    this.arcHead.quaternion.setFromUnitVectors(Y_AXIS, this.arcTangent);
    // Forward by half its length, since a cone is modelled about its centre and would bury half its head in the tube.
    this.arcHead.position.copy(this.arcEnd).addScaledVector(this.arcTangent, (HEAD_LEN_PX * mmPerPx) / 2);
    const hot = this.hoveringArc || this.grabbingAngle;
    const c = themeColor(hot ? "--accent-hot" : "--accent", hot ? 0xff9a5c : 0xff7a3c);
    this.arcMat.color.set(c);
    this.arcMat.emissive.set(c);
  }

  /** Degrees about the axis, read in the axis's own plane. Null when that plane is nearly edge-on
   *  (see transformGizmo.ringDragDegenerate). */
  private cursorTurn(x: number, y: number): number | null {
    const view = this.viewport.camera.getWorldDirection(new THREE.Vector3());
    if (ringDragDegenerate(view.dot(this.dir))) return null;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.dir, this.anchor);
    const at = this.viewport.screenToPlane(x, y, plane);
    if (!at) return null;
    // The axis point level with the arrow, not the one level with the profile.
    const pivot = this.base.clone().addScaledVector(this.dir, this.anchor.clone().sub(this.base).dot(this.dir));
    return (angleInFrame(at, pivot, rotationFrame(this.dir)) * 180) / Math.PI;
  }

  /** By distance, not order: the two leave the anchor at right angles, so a ray passes through both, and the
   *  straight arrow's grab volume answers a third of the way along the curve. */
  private pick(x: number, y: number): "pitch" | "angle" | null {
    // The head too: the tube ends where the head begins, so without it the last tenth of the curve, the point a
    // hand goes for, took no press.
    const parts = this.arc?.visible ? [this.arcGrab, this.arcHead].filter((o): o is THREE.Mesh => !!o) : [];
    const gizmo = this.gizmo;
    return this.viewport.probe(x, y, (rc): "pitch" | "angle" | null => {
      const arrow = gizmo ? rc.intersectObjects(gizmo.children, false)[0] : undefined;
      const curve = rc.intersectObjects(parts, false)[0];
      if (!arrow) return curve ? "angle" : null;
      if (!curve) return "pitch";
      return curve.distance < arrow.distance ? "angle" : "pitch";
    });
  }

  private commit() {
    if (!this.active || !this.id) return;
    const id = this.id;
    const { pitch, angle } = this;
    const done = this.onDone;
    // false: the write below schedules the rebuild, and closing with its own would flash the pre-commit model.
    this.cleanup(false);
    // A zero pitch drops the field, so a revolve that never climbed reads exactly as it did before.
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
