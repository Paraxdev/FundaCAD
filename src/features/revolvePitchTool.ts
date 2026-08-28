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
import { axisDragDistance, createDragHandle, type DragHandle } from "./manipulator";
import { clampDragPitch, pitchFromRise, revolveAxis, riseOf, screwPath } from "./screwMath";

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** How long a typed field has to stand still before the sidecar is asked to
 *  build it. Long enough that typing "600" is one rebuild rather than three
 *  (of which "6" and "60" are sweeps nobody wants), short enough to read as
 *  the model answering the keystroke. */
const TYPED_PREVIEW_MS = 350;

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

  private gizmo: THREE.Group | null = null;
  private handle: DragHandle | null = null;
  private helix: THREE.Line | null = null;
  private anchor = new THREE.Vector3(); // the end of the sweep: where the handle stands
  private quat = new THREE.Quaternion();

  private hovering = false;
  private grabbing = false;
  private grabRise = 0;
  private grabProj = 0;
  private downPos = { x: 0, y: 0 };
  private downOnGizmo = false;
  private raf = 0;

  private dim = new DimInput();
  private onDone: ((id: string | null) => void) | null = null;
  /** Set once a typed value has opened the store's edit preview. Opened LAZILY,
   *  because opening it rebuilds: a gesture that only ever drags the arrow
   *  should not pay for a round trip it never looks at. */
  private previewing = false;
  private previewTimer = 0;

  private boundMove: (e: PointerEvent) => void;
  private boundDown: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;
  private boundTick: () => void;

  constructor(
    private viewport: Viewport,
    private store: DocumentStore,
    private overlay: SketchOverlay,
  ) {
    this.boundMove = (e) => this.onMove(e);
    this.boundDown = (e) => this.onDown(e);
    this.boundUp = (e) => this.onUp(e);
    this.boundKey = (e) => this.onKey(e);
    this.boundTick = () => this.tick();
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

    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);

    this.buildGizmo();
    this.buildHelix();
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
      "Drag the arrow to set how far one turn climbs, or type a pitch. " +
        "Angle is how far it turns in all, so 3600 is ten turns. Enter applies, Esc cancels.",
    );
    this.refresh();
    this.raf = requestAnimationFrame(this.boundTick);
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
    this.hovering = this.hitGizmo(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    this.downOnGizmo = this.hitGizmo(e.clientX, e.clientY);
    if (this.downOnGizmo) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.grabbing = true;
      this.grabRise = riseOf(this.angle, this.pitch);
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.base, this.dir);
      this.viewport.domElement.style.cursor = "grabbing";
    }
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.grabbing) {
      this.grabbing = false;
      this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
      this.commit();
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
    this.quat.setFromUnitVectors(Y_AXIS, this.dir.clone().multiplyScalar(sign));
    this.gizmo.position.copy(this.anchor);
    this.gizmo.quaternion.copy(this.quat);
    this.gizmo.scale.setScalar(this.viewport.pixelWorldSize(this.anchor));
    this.handle?.paint({ hot: this.hovering || this.grabbing });
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
    if (!this.grabbing) this.readFields();
    this.raf = requestAnimationFrame(this.boundTick);
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

  private hitGizmo(x: number, y: number): boolean {
    if (!this.gizmo) return false;
    return this.viewport.rayFrom(x, y).intersectObjects(this.gizmo.children, false).length > 0;
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
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown, true);
    el.removeEventListener("pointerup", this.boundUp);
    window.removeEventListener("keydown", this.boundKey, true);
    el.style.cursor = "default";
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
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
    this.viewport.suspendPicking = false;
    this.active = false;
    this.grabbing = false;
    this.hovering = false;
    this.id = null;
    this.onDone = null;
    setPrompt(null);
  }
}
