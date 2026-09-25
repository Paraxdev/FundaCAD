// Interactive Pattern: repeat a body along an axis or around one, set up in the
// viewport rather than in a dialog.
//
// It used to be a modal that asked "rectangular or circular?" and then dropped a
// feature with made-up numbers into the timeline for you to correct in the value
// rows. Everything about a pattern is spatial, which way it runs, how far
// apart, how many, and none of it was.
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
// features/patternMath holds the arithmetic and the Python engine's `builder.py`'s
// _pattern_linear / _pattern_circular apply the same rule, which is what makes
// the ghost a preview rather than a suggestion.
//
// FEATURES mode repeats a hole (or another cut/join feature) instead of a whole
// body: `features` names which ones, and every "the bodies" below reads instead
// as "the faces those features own" (faceOwnedByFeatures, resolved once at
// start()). The gizmo, ghosts and starting spacing all key off that face set
// rather than the body's; committing writes `features` and no `bodies`, the
// engine repeats the feature's cut/join instead of copying the body outright.
//
// WHERE a circular pattern turns is features/patternAxis: through the origin,
// through the middle of the body (the start for a feature, whose part is rarely
// centred on the origin), or about an edge or face clicked on the model, which
// the pattern then follows. C switches origin and middle; the axis is drawn.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Axis3, Feature, Selector, Vec3 } from "../types";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { isEditableTarget } from "../ui/focus";
import { logError } from "../ui/logStore";
import { snap } from "../ui/units";
import { axisDragDistance } from "./manipulator";
import {
  circularAngles,
  clampCount,
  describePattern,
  linearOffsets,
  MIN_COUNT,
} from "./patternMath";
import { facesOwnedByFeatures, featureLabel, spansBody } from "./patternSources";
import {
  axisLine,
  canonicalDir,
  circularAxisFields,
  defaultAxisPlace,
  type AxisPlace,
  type PickedAxis,
} from "./patternAxis";
import { CanvasGesture } from "./canvasGesture";

export type PatternKind = "linear" | "circular";

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const HOT = 0xffe9a8; // hovered / chosen arrow
const AXES: { name: Axis3; dir: THREE.Vector3; color: number }[] = [
  { name: "X", dir: new THREE.Vector3(1, 0, 0), color: 0xff5a5a },
  { name: "Y", dir: new THREE.Vector3(0, 1, 0), color: 0x5ad15a },
  { name: "Z", dir: new THREE.Vector3(0, 0, 1), color: 0x5a9bff },
];

/** Starting numbers. A pattern of one is not a pattern, so the tool opens with
 *  something to look at, the drag then corrects it, which is a smaller job than
 *  conjuring it from nothing. */
const START_COUNT = 4;
const START_ANGLE = 360;

export class PatternTool {
  active = false;
  private kind: PatternKind = "linear";
  private bodies: string[] = [];
  private features: string[] = []; // features mode when non-empty, see the file header
  private faceIds: number[] = []; // the above features' own faces, resolved once at start()
  private promptPrefix = ""; // "Pattern Hole1: " in features mode, "" in body mode
  private centroid = new THREE.Vector3(); // where the bodies (or the patterned faces) are
  private anchor = new THREE.Vector3(); // where the gizmo sits (see placeGizmo)
  private axis = 0; // index into AXES
  private place: AxisPlace = "origin"; // circular only, see patternAxis.ts
  private picked: PickedAxis | null = null;
  private middle = new THREE.Vector3(); // the patterned body's box centre
  private pickNote = ""; // why the last click did not give an axis
  private pickSeq = 0; // a pick answered after a newer one, or after the tool closed, is dropped
  private pending: Promise<void> | null = null; // the axis pick still waiting on the engine
  private axisLineObj: THREE.Line | null = null;
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

  private dim = new DimInput();
  private onDone: ((id: string | null) => void) | null = null;

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

  start(
    kind: PatternKind,
    bodies: string[],
    onDone: (id: string | null) => void,
    features?: string[],
  ) {
    if (this.active) return;
    this.active = true;
    this.kind = kind;
    this.bodies = bodies;
    this.features = features ?? [];
    this.faceIds = this.features.length ? this.repeatedFaces() : [];
    this.promptPrefix = this.features.length ? `Pattern ${this.sourceLabels()}: ` : "";
    this.onDone = onDone;
    this.count = START_COUNT;
    this.centroid.copy(
      this.features.length
        ? this.viewport.facesCentroid(this.faceIds)
        : this.viewport.bodiesCentroid(bodies),
    );
    const box = this.viewport.bodiesBox(this.features.length ? this.bodiesOfFaces() : bodies);
    if (box) box.getCenter(this.middle);
    else this.middle.copy(this.centroid);
    this.place = defaultAxisPlace(this.features.length > 0);
    this.picked = null;
    this.pickNote = "";
    if (kind === "linear") {
      this.axis = 0; // X
      // One span apart, so the opening state is a row of copies that touch
      // rather than a heap in the same place, the gesture starts from something
      // you can see and stretch, not from nothing.
      this.value = this.span(AXES[0]!.dir) || 20;
    } else {
      this.axis = 2; // Z
      this.value = START_ANGLE;
    }
    this.placeGizmo();

    this.viewport.suspendPicking = true;
    this.gesture.attach();

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
      () => this.commitSoon(),
      () => this.cancel(),
    );
    this.pushFields();
    this.refreshPrompt();
    this.updateGhosts();
    this.gesture.frame();
  }

  /** The bodies the patterned faces lie on. */
  private bodiesOfFaces(): string[] {
    const bodies = this.store.buildState.result?.bodies ?? [];
    const out = new Set<string>();
    for (const id of this.faceIds) {
      const b = bodies.find((x) => id >= x.faceStart && id < x.faceStart + x.faceCount);
      if (b) out.add(b.id);
    }
    return [...out];
  }

  /** The line a circular pattern turns about, as three.js vectors. */
  private turnLine(): { origin: THREE.Vector3; dir: THREE.Vector3 } {
    const m = this.middle;
    const l = axisLine(this.place, this.axisName(), [m.x, m.y, m.z], this.picked);
    return {
      origin: new THREE.Vector3(...l.origin),
      dir: new THREE.Vector3(...l.dir).normalize(),
    };
  }

  /** The faces the features made, less the ones they only changed. */
  private repeatedFaces(): number[] {
    const bodies = this.store.buildState.result?.bodies ?? [];
    const owned = facesOwnedByFeatures(bodies, this.features);
    const kept = owned.filter((id) => {
      const body = bodies.find((b) => id >= b.faceStart && id < b.faceStart + b.faceCount);
      const face = this.viewport.facesBox([id]);
      const whole = body ? this.viewport.bodiesBox([body.id]) : null;
      return !(face && whole && spansBody(face, whole));
    });
    return kept.length ? kept : owned;
  }

  /** How far the pattern's target reaches along a direction, the natural first
   *  spacing, since copies one span apart are copies just touching. The bodies'
   *  own span in body mode; in features mode the patterned FACES' span, a hole
   *  in a large plate opens on a gap the size of the hole, not the plate. */
  private span(dir: THREE.Vector3): number {
    const box = this.features.length
      ? this.viewport.facesBox(this.faceIds)
      : this.viewport.bodiesBox(this.bodies);
    if (!box) return 0;
    const size = box.getSize(new THREE.Vector3());
    return Math.abs(size.dot(dir));
  }

  /** The feature(s) this pattern repeats, by name where one was given. */
  private sourceLabels(): string {
    return this.features
      .map((id) => {
        const f = this.store.document.features.find((x) => x.id === id);
        return f ? featureLabel(f) : id;
      })
      .join(", ");
  }

  /** Put the gizmo where the gesture actually happens.
   *
   *  A linear pattern runs FROM the bodies, so the arrows belong on them. A
   *  circular one turns about a world axis through the origin, the arrows
   *  belong ON that axis, at the bodies' height, or the gizmo reads as "it turns
   *  about here" and points at a centre the copies plainly do not orbit. */
  private placeGizmo() {
    if (this.kind === "linear") {
      this.anchor.copy(this.centroid);
      return;
    }
    const { origin, dir } = this.turnLine();
    this.anchor.copy(origin).addScaledVector(dir, this.centroid.clone().sub(origin).dot(dir));
    this.drawAxis();
  }

  /** The axis itself, a line through the part, so where the copies turn is
   *  seen rather than inferred from the ghosts. */
  private drawAxis() {
    if (this.kind !== "circular") return;
    const { origin, dir } = this.turnLine();
    const box = this.viewport.bodiesBox((this.store.buildState.result?.bodies ?? []).map((b) => b.id));
    const reach = Math.max(box ? box.getSize(new THREE.Vector3()).length() : 0, 50);
    const a = origin.clone().addScaledVector(dir, -reach);
    const b = origin.clone().addScaledVector(dir, reach);
    if (!this.axisLineObj) {
      const mat = new THREE.LineBasicMaterial({ color: HOT, depthTest: false, transparent: true, opacity: 0.9 });
      this.axisLineObj = new THREE.Line(new THREE.BufferGeometry(), mat);
      this.axisLineObj.renderOrder = 998;
      this.viewport.addToScene(this.axisLineObj);
    }
    this.axisLineObj.geometry.setFromPoints([a, b]);
    this.axisLineObj.geometry.computeBoundingSphere();
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
    // Turned about the same line the engine will turn about, see patternAxis.
    const { origin, dir: about } = this.turnLine();
    const to = new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z);
    const from = new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z);
    return circularAngles(this.count, this.value).map((deg) =>
      to.clone().multiply(new THREE.Matrix4().makeRotationAxis(about, (deg * Math.PI) / 180)).multiply(from),
    );
  }

  private updateGhosts() {
    if (this.features.length) this.viewport.setPatternFeatureGhost(this.faceIds, this.transforms());
    else this.viewport.setPatternGhost(this.bodies, this.transforms());
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
    if (this.kind === "circular") {
      this.viewport.hoverEntity(this.hoverAxis >= 0 ? null : this.viewport.pickEntity(e.clientX, e.clientY));
    }
  }

  /** The drag's scalar for the current kind: a distance along the axis, or an
   *  angle about it. Both are read from the same pointer, so both can be the
   *  same gesture, take hold of the arrow and pull. */
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
    // dragging in the same gesture, the axis is a choice you make by pulling
    // the direction you want, not a mode you enter first.
    if (hit !== this.axis || this.place === "picked") {
      this.axis = hit;
      if (this.place === "picked") this.place = "centre";
      if (this.kind === "linear") this.value = this.span(this.axisDir()) || this.value;
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
    if (this.downOnGizmo || moved) return;
    // A circular pattern's click on the model picks the axis; off the model it
    // applies, as it always did.
    const hit = this.kind === "circular" ? this.viewport.pickEntity(e.clientX, e.clientY) : null;
    if (!hit) {
      this.commitSoon();
      return;
    }
    const p = this.pickAxis(hit, e.clientX, e.clientY).catch((err: unknown) => { logError(err, { source: "pattern" }); });
    this.pending = p;
    void p.finally(() => { if (this.pending === p) this.pending = null; });
  }

  /** The axis an edge or face names, asked of the engine so the preview turns
   *  about exactly the line the rebuild will. */
  private async pickAxis(hit: import("../viewport/picking").Hit, x: number, y: number) {
    let ref: Selector | null = null;
    if (hit.kind === "edge") {
      ref = hit.selector;
    } else {
      const f = this.viewport.pickFaceForPressPull(x, y);
      if (f) ref = f.bodyId ? ({ ...f.selector, body: f.bodyId } as Selector) : f.selector;
    }
    if (!ref) return;
    const seq = ++this.pickSeq;
    const reply = await this.store.patternAxis(ref);
    if (!this.active || seq !== this.pickSeq) return;
    if (!reply || !("axis" in reply)) {
      this.pickNote = reply && "reason" in reply ? `${reply.reason}. ` : "";
      this.promptKey = "";
      this.refreshPrompt();
      return;
    }
    this.picked = { origin: reply.axis.origin, dir: canonicalDir(reply.axis.dir as Vec3), ref };
    this.place = "picked";
    this.pickNote = "";
    this.placeGizmo();
    this.promptKey = "";
    this.refreshPrompt();
    this.updateGhosts();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      this.cancel();
      return;
    }
    if (e.key === "Enter") {
      if (isEditableTarget(e.target)) return; // the value box submits it
      e.preventDefault();
      e.stopPropagation();
      this.commitSoon();
      return;
    }
    if (this.kind === "circular" && (e.key === "c" || e.key === "C") && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      this.place = this.place === "origin" ? "centre" : "origin";
      this.placeGizmo();
      this.promptKey = "";
      this.refreshPrompt();
      this.updateGhosts();
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
    if (this.kind === "linear") {
      setPrompt(`${this.promptPrefix}${body} · drag an arrow · [ and ] change the count · Enter or click to apply · Esc`);
      return;
    }
    const where =
      this.place === "picked" ? "the picked axis" : this.place === "centre" ? "through the part's middle" : "through the origin";
    setPrompt(
      `${this.promptPrefix}${this.pickNote}${body}, ${where} · click an edge or face to turn about it · C origin or middle · [ ] count · Enter or click off the part to apply · Esc`,
    );
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
    this.gesture.frame();
  }

  /** A typed value overrides the drag. Read every frame, because the field has
   *  no change event this tool can subscribe to, the same read-back
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

  /** Applies once an axis pick still on its way to the engine has landed, so
   *  Enter straight after clicking an edge turns about that edge. */
  private commitSoon() {
    if (this.pending) void this.pending.then(() => this.commit());
    else this.commit();
  }

  private commit() {
    if (!this.active) return;
    this.readFields();
    const count = Math.max(MIN_COUNT, Math.round(this.count));
    const axis = this.axisName();
    const m = this.middle;
    const placed = circularAxisFields(this.place, axis, [m.x, m.y, m.z], this.picked);
    const value = this.value;
    // features and bodies are mutually exclusive on the feature itself, the
    // engine refuses both together, so never write more than one.
    const target = this.features.length ? { features: this.features } : { bodies: this.bodies };
    const kind = this.kind;
    const done = this.onDone;
    this.cleanup();
    // A pattern of one copy is the body (or feature) you already had. Committing
    // it would put a feature in the timeline that does nothing, which is a
    // worse answer than saying so and leaving the model alone.
    if (count < 2) {
      setPrompt(null);
      done?.(null);
      return;
    }
    const id = this.store.nextId();
    this.store.addFeature(
      kind === "linear"
        ? ({ id, type: "patternLinear", count, spacing: value, axis, ...target } as Feature)
        : ({ id, type: "patternCircular", count, angle: value, ...placed, ...target } as Feature),
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
    this.gesture.detach();
    el.style.cursor = "default";
    this.dim.hide();
    this.viewport.clearPatternGhost();
    this.viewport.clearPatternFeatureGhost();
    this.viewport.hoverEntity(null);
    this.pickSeq++;
    this.pending = null;
    if (this.axisLineObj) {
      this.viewport.removeFromScene(this.axisLineObj);
      this.axisLineObj.geometry.dispose();
      (this.axisLineObj.material as THREE.Material).dispose();
      this.axisLineObj = null;
    }
    this.picked = null;
    this.pickNote = "";
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
    this.features = [];
    this.faceIds = [];
    this.promptPrefix = "";
    setPrompt(null);
  }
}

// Deliberately not here yet: a LINEAR pattern along a picked edge. The circular
// one takes a picked axis (patternAxis.ts); the linear one still runs along X, Y
// or Z.
