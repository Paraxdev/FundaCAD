// Interactive Pattern: repeat a body along an axis or around one, set up in the
// viewport rather than in a dialog.
//
// It used to be a modal that asked "rectangular or circular?" and then dropped a
// feature with made-up numbers into the timeline for you to correct in the value
// rows. Everything about a pattern is spatial — which way it runs, how far
// apart, how many — and none of it was.
//
// Three axis arrows say which way. Click one and it becomes the direction (or,
// for a circular pattern, the axis it turns about); the chosen one is the one
// the drag reads. Dragging sets the spacing or the sweep, with the copies drawn
// as you go, and the count is a key away in either direction. Type into either
// field for an exact answer.
//
// The copies are ghosts, not a rebuild. A pattern is a rigid repeat whose cells
// this side knows exactly, so asking the kernel to union twenty solids per frame
// would make the drag unusable in order to show it something it already has.
// features/patternMath holds the arithmetic and sidecar/builder.py's
// _pattern_linear / _pattern_circular apply the same rule, which is what makes
// the ghost a preview rather than a suggestion.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Axis3, Feature } from "../types";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import { axisDragDistance } from "./manipulator";
import {
  circularAngles,
  clampCount,
  describePattern,
  linearOffsets,
  MIN_COUNT,
} from "./patternMath";

export type PatternKind = "linear" | "circular";

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const HOT = 0xffe9a8; // hovered / chosen arrow
const AXES: { name: Axis3; dir: THREE.Vector3; color: number }[] = [
  { name: "X", dir: new THREE.Vector3(1, 0, 0), color: 0xff5a5a },
  { name: "Y", dir: new THREE.Vector3(0, 1, 0), color: 0x5ad15a },
  { name: "Z", dir: new THREE.Vector3(0, 0, 1), color: 0x5a9bff },
];

/** Starting numbers. A pattern of one is not a pattern, so the tool opens with
 *  something to look at — the drag then corrects it, which is a smaller job than
 *  conjuring it from nothing. */
const START_COUNT = 4;
const START_ANGLE = 360;

export class PatternTool {
  active = false;
  private kind: PatternKind = "linear";
  private bodies: string[] = [];
  private centroid = new THREE.Vector3(); // where the bodies are
  private anchor = new THREE.Vector3(); // where the gizmo sits (see placeGizmo)
  private axis = 0; // index into AXES
  private count = START_COUNT;
  private value = 0; // mm between copies (linear) or degrees swept (circular)

  private gizmo: THREE.Group | null = null;
  private arrows: { group: THREE.Group; mat: THREE.MeshBasicMaterial; axis: number }[] = [];
  private hoverAxis = -1;
  private grabbing = false;
  private grabValue = 0;
  private grabRef = 0; // drag origin: a distance (linear) or an angle (circular)
  private downPos = { x: 0, y: 0 };
  private downOnGizmo = false;
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

  start(kind: PatternKind, bodies: string[], onDone: (id: string | null) => void) {
    if (this.active) return;
    this.active = true;
    this.kind = kind;
    this.bodies = bodies;
    this.onDone = onDone;
    this.count = START_COUNT;
    this.centroid.copy(this.viewport.bodiesCentroid(bodies));
    if (kind === "linear") {
      this.axis = 0; // X
      // One body-width apart, so the opening state is a row of copies that touch
      // rather than a heap in the same place — the gesture starts from something
      // you can see and stretch, not from nothing.
      this.value = this.bodySpan(AXES[0]!.dir) || 20;
    } else {
      this.axis = 2; // Z
      this.value = START_ANGLE;
    }
    this.placeGizmo();

    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);

    this.buildGizmo();
    this.dim.show(
      kind === "linear"
        ? [
            { name: "spacing", label: "Spacing", kind: "length" },
            { name: "count", label: "Copies", kind: "count" },
          ]
        : [
            { name: "angle", label: "Angle", kind: "angle" },
            { name: "count", label: "Copies", kind: "count" },
          ],
      () => this.commit(),
      () => this.cancel(),
    );
    this.pushFields();
    this.refreshPrompt();
    this.updateGhosts();
    this.raf = requestAnimationFrame(this.boundTick);
  }

  /** How far the pattern's bodies reach along a direction — the natural first
   *  spacing, since copies one span apart are copies just touching. */
  private bodySpan(dir: THREE.Vector3): number {
    const box = this.viewport.bodiesBox(this.bodies);
    if (!box) return 0;
    const size = box.getSize(new THREE.Vector3());
    return Math.abs(size.dot(dir));
  }

  /** Put the gizmo where the gesture actually happens.
   *
   *  A linear pattern runs FROM the bodies, so the arrows belong on them. A
   *  circular one turns about a world axis through the origin — the arrows
   *  belong ON that axis, at the bodies' height, or the gizmo reads as "it turns
   *  about here" and points at a centre the copies plainly do not orbit. */
  private placeGizmo() {
    if (this.kind === "linear") {
      this.anchor.copy(this.centroid);
      return;
    }
    const dir = this.axisDir();
    this.anchor.copy(dir).multiplyScalar(this.centroid.dot(dir));
  }

  private axisDir(): THREE.Vector3 {
    return AXES[this.axis]!.dir;
  }

  private axisName(): Axis3 {
    return AXES[this.axis]!.name;
  }

  // --- the copies ------------------------------------------------------------

  /** Where every copy sits, copy 0 being the original. The one place the two
   *  kinds differ geometrically, and it goes through patternMath so the ghosts
   *  and the kernel cannot disagree. */
  private transforms(): THREE.Matrix4[] {
    const dir = this.axisDir();
    if (this.kind === "linear") {
      return linearOffsets(this.count, this.value).map((d) =>
        new THREE.Matrix4().makeTranslation(dir.x * d, dir.y * d, dir.z * d),
      );
    }
    // Circular turns about the WORLD axis through the origin, which is what the
    // kernel does (_rot_for is a global rotation). Turning about the bodies' own
    // centroid instead would preview a pattern nobody is going to get.
    return circularAngles(this.count, this.value).map((deg) =>
      new THREE.Matrix4().makeRotationAxis(dir, (deg * Math.PI) / 180),
    );
  }

  private updateGhosts() {
    this.viewport.setPatternGhost(this.bodies, this.transforms());
  }

  // --- input -----------------------------------------------------------------

  private onMove(e: PointerEvent) {
    if (this.grabbing) {
      const raw = this.grabValue + (this.dragAt(e) - this.grabRef);
      const stepped =
        this.kind === "linear"
          ? snap(raw, this.viewport.snapStep(this.anchor, e.shiftKey))
          : snap(raw, e.shiftKey ? 1 : 15); // sweeps land on the angles people mean
      if (stepped === this.value) return;
      this.value = stepped;
      this.pushFields();
      this.refreshPrompt();
      this.updateGhosts();
      return;
    }
    this.hoverAxis = this.hitAxis(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hoverAxis >= 0 ? "grab" : "default";
  }

  /** The drag's scalar for the current kind: a distance along the axis, or an
   *  angle about it. Both are read from the same pointer, so both can be the
   *  same gesture — take hold of the arrow and pull. */
  private dragAt(e: PointerEvent): number {
    if (this.kind === "linear") {
      return axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axisDir());
    }
    const dir = this.axisDir();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir, this.anchor);
    const p = this.viewport.screenToPlane(e.clientX, e.clientY, plane);
    if (!p) return this.grabRef;
    // Any two perpendiculars to the axis will do as a basis: the drag is read as
    // a DIFFERENCE from where it was grabbed, so the basis cancels out.
    const u = new THREE.Vector3(1, 0, 0);
    if (Math.abs(u.dot(dir)) > 0.9) u.set(0, 1, 0);
    const e1 = u.clone().sub(dir.clone().multiplyScalar(u.dot(dir))).normalize();
    const e2 = new THREE.Vector3().crossVectors(dir, e1);
    const r = p.clone().sub(this.anchor);
    return (Math.atan2(r.dot(e2), r.dot(e1)) * 180) / Math.PI;
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    const hit = this.hitAxis(e.clientX, e.clientY);
    this.downOnGizmo = hit >= 0;
    if (hit < 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // Pressing an arrow that is not the current one CHANGES the axis and starts
    // dragging in the same gesture — the axis is a choice you make by pulling
    // the direction you want, not a mode you enter first.
    if (hit !== this.axis) {
      this.axis = hit;
      if (this.kind === "linear") this.value = this.bodySpan(this.axisDir()) || this.value;
      this.placeGizmo(); // a circular pattern's gizmo lives on the axis it turns about
      this.pushFields();
      this.updateGhosts();
    }
    this.grabbing = true;
    this.grabValue = this.value;
    this.grabRef = this.dragAt(e);
    this.refreshPrompt();
    this.viewport.domElement.style.cursor = "grabbing";
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.grabbing) {
      this.grabbing = false;
      this.viewport.domElement.style.cursor = this.hoverAxis >= 0 ? "grab" : "default";
      return;
    }
    const moved =
      Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    if (!this.downOnGizmo && !moved) this.commit();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      this.cancel();
      return;
    }
    // The count, without leaving the viewport for a number field. Both spellings,
    // because both are what people reach for.
    const up = e.key === "]" || e.key === "ArrowUp" || e.key === "+";
    const down = e.key === "[" || e.key === "ArrowDown" || e.key === "-";
    if (!up && !down) return;
    const next = clampCount(this.count + (up ? 1 : -1));
    if (next === this.count) return;
    e.preventDefault();
    e.stopPropagation();
    this.count = next;
    this.pushFields();
    this.refreshPrompt();
    this.updateGhosts();
  }

  // --- readouts --------------------------------------------------------------

  /** Show what the gesture currently means, without stamping over a number the
   *  user is in the middle of typing. */
  private pushFields() {
    const key = this.kind === "linear" ? "spacing" : "angle";
    const out: Record<string, number> = {};
    if (!this.dim.isUserDriven(key) || this.grabbing) out[key] = this.value;
    if (!this.dim.isUserDriven("count")) out["count"] = this.count;
    this.dim.updateFromCursor(out);
  }

  private promptKey = "";
  private refreshPrompt() {
    const body = describePattern(this.kind, this.count, this.value, this.axisName());
    if (body === this.promptKey) return;
    this.promptKey = body;
    setPrompt(`${body} · drag an arrow · [ and ] change the count · click to apply · Esc`);
  }

  // --- gizmo -----------------------------------------------------------------

  private buildGizmo() {
    const g = new THREE.Group();
    this.gizmo = g;
    for (let i = 0; i < AXES.length; i++) {
      const a = AXES[i]!;
      const mat = new THREE.MeshBasicMaterial({ color: a.color, depthTest: false });
      const arrow = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 34, 10), mat);
      shaft.position.y = 17;
      const head = new THREE.Mesh(new THREE.ConeGeometry(3.6, 11, 12), mat);
      head.position.y = 39;
      shaft.renderOrder = 999;
      head.renderOrder = 999;
      arrow.add(shaft, head);
      arrow.quaternion.setFromUnitVectors(Y_AXIS, a.dir);
      g.add(arrow);
      this.arrows.push({ group: arrow, mat, axis: i });
    }
    this.viewport.addToScene(g);
  }

  private hitAxis(x: number, y: number): number {
    if (!this.gizmo) return -1;
    const hit = this.viewport.rayFrom(x, y).intersectObjects(this.gizmo.children, true)[0];
    if (!hit) return -1;
    for (const a of this.arrows) {
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        if (o === a.group) return a.axis;
        o = o.parent;
      }
    }
    return -1;
  }

  private tick() {
    if (!this.active || !this.gizmo) return;
    const k = this.viewport.pixelWorldSize(this.anchor);
    this.gizmo.position.copy(this.anchor);
    this.gizmo.scale.setScalar(k);
    for (const a of this.arrows) {
      const chosen = a.axis === this.axis;
      const hot = chosen || a.axis === this.hoverAxis;
      a.mat.color.set(hot ? HOT : AXES[a.axis]!.color);
      // The chosen axis is the one the drag reads; the other two stay drawn
      // rather than hidden, because an axis you cannot see is an axis you cannot
      // switch to.
      a.mat.opacity = chosen ? 1 : 0.45;
      a.mat.transparent = !chosen;
    }
    // Below and right of the gizmo, not on top of it: the three arrows ARE the
    // control here, and a value panel over them is a panel over the thing you
    // have to click. (Every other tool anchors its fields on the gizmo because
    // its gizmo is one arrow the panel sits beside.)
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x + 24, s.y + 84);
    this.readFields();
    this.raf = requestAnimationFrame(this.boundTick);
  }

  /** A typed value overrides the drag. Read every frame, because the field has
   *  no change event this tool can subscribe to — the same read-back
   *  planeOffsetTool does, and gated the same way so a display value written by
   *  a drag is never mistaken for one the user typed. */
  private readFields() {
    if (this.grabbing) return;
    let changed = false;
    const key = this.kind === "linear" ? "spacing" : "angle";
    if (this.dim.isUserDriven(key)) {
      const v = this.dim.getValue(key);
      if (v != null && Math.abs(v - this.value) > 1e-6) {
        this.value = v;
        changed = true;
      }
    }
    if (this.dim.isUserDriven("count")) {
      const v = this.dim.getValue("count");
      // A typed count is not held to the drag's ceiling: MAX_DRAG_COUNT exists
      // because a number reached by holding a key down is not a number anyone
      // meant, and a typed one plainly is.
      if (v != null) {
        const n = Math.max(MIN_COUNT, Math.round(v));
        if (n !== this.count) {
          this.count = n;
          changed = true;
        }
      }
    }
    if (!changed) return;
    this.refreshPrompt();
    this.updateGhosts();
  }

  // --- ending ----------------------------------------------------------------

  private commit() {
    if (!this.active) return;
    this.readFields();
    const count = Math.max(MIN_COUNT, Math.round(this.count));
    const axis = this.axisName();
    const value = this.value;
    const bodies = this.bodies;
    const kind = this.kind;
    const done = this.onDone;
    this.cleanup();
    // A pattern of one copy is the body you already had. Committing it would put
    // a feature in the timeline that does nothing, which is a worse answer than
    // saying so and leaving the model alone.
    if (count < 2) {
      setPrompt(null);
      done?.(null);
      return;
    }
    const id = this.store.nextId();
    this.store.addFeature(
      kind === "linear"
        ? ({ id, type: "patternLinear", count, spacing: value, axis, bodies } as Feature)
        : ({ id, type: "patternCircular", count, angle: value, axis, bodies } as Feature),
    );
    done?.(id);
  }

  cancel() {
    const done = this.onDone;
    this.cleanup();
    done?.(null);
  }

  private cleanup() {
    const el = this.viewport.domElement;
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown, true);
    el.removeEventListener("pointerup", this.boundUp);
    window.removeEventListener("keydown", this.boundKey, true);
    el.style.cursor = "default";
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.dim.hide();
    this.viewport.clearPatternGhost();
    if (this.gizmo) {
      this.viewport.removeFromScene(this.gizmo);
      for (const a of this.arrows) {
        a.mat.dispose();
        for (const c of a.group.children) (c as THREE.Mesh).geometry.dispose();
      }
      this.gizmo = null;
      this.arrows = [];
    }
    this.viewport.suspendPicking = false;
    this.active = false;
    this.grabbing = false;
    this.hoverAxis = -1;
    this.promptKey = "";
    setPrompt(null);
  }
}

// Deliberately not here: an arbitrary direction. The axis is one of the three
// global axes, which is what the kernel's rotation and offset helpers take and
// what the value row you edit afterwards can offer as a choice. A pattern
// running along a picked EDGE is the obvious next thing and is a different
// feature — it needs a stored reference to the edge so it FOLLOWS that edge when
// the model changes, which is the whole reason to pick one rather than type a
// vector.
