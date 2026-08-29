// Interactive Thread: click a round face, and the thread that belongs on it
// appears — the ISO coarse pitch for that diameter, running the length of the
// face, cut the right way round for a shank or a bore.
//
// It writes two features, because that is honestly what a thread is here: the
// meridian profile as a sketch, and the climbing revolve that sweeps it
// (builder._screw_revolve). Both stay in the timeline and both stay editable —
// the pitch, the arc and the operation are ordinary value rows afterwards, and
// the profile is an ordinary sketch. Nothing about the thread is a special case
// the rest of the app has to know about, which is why there is no `thread`
// feature type.
//
// The drag sets the LENGTH, along the axis, from the end of the face the thread
// starts at: pull it back to thread only part of a shank. Pitch is typed.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, PlaneDef, SketchEntity } from "../types";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { toast } from "../ui/toast";
import { snap } from "../ui/units";
import { axisDragDistance } from "./manipulator";
import {
  MIN_THREAD_TURNS, coarsePitchFor, threadAngleDeg, threadProfile, threadTurns,
} from "./threadMath";

type Phase = "pick" | "size";

export class ThreadTool {
  active = false;
  private phase: Phase = "pick";
  private axis = new THREE.Vector3(0, 0, 1); // start -> end, unit
  private origin = new THREE.Vector3(); // point ON the axis where the thread begins
  private radial = new THREE.Vector3(1, 0, 0); // unit, perpendicular to the axis
  private radius = 0;
  private external = true;
  private pitch = 1;
  private length = 0;
  private maxLength = 0;
  private grabbing = false;
  // The pointerdown that PICKED the face is followed by its own pointerup, and
  // treating that as "click to commit" committed the default thread before the
  // user had seen it. Sizing only starts listening for a commit from the next
  // press onward.
  private armed = false;
  private grabLength = 0;
  private grabProj = 0;
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

  start(onDone: (id: string | null) => void) {
    if (this.active) return;
    this.active = true;
    this.phase = "pick";
    this.onDone = onDone;
    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);

    const pre = this.viewport.selectedFacesForPressPull();
    if (pre && pre.round && pre.faceIds.length === 1 && pre.faceIds[0] != null) {
      this.beginSize(pre.faceIds[0], pre.round.radius, pre.round.solidInside,
        pre.round.cylinder.axis, pre.round.cylinder.point, pre.round.radial);
      return;
    }
    setPrompt("Click a round face — a shank or a bore — to thread · Esc");
  }

  private onMove(e: PointerEvent) {
    if (this.phase === "pick") {
      const faceId = this.viewport.hoverFaceAt(e.clientX, e.clientY);
      this.viewport.domElement.style.cursor = faceId != null ? "pointer" : "default";
      return;
    }
    if (!this.grabbing) return;
    const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.origin, this.axis);
    const raw = this.grabLength + (proj - this.grabProj);
    const stepped = Math.max(
      this.pitch * MIN_THREAD_TURNS,
      Math.min(this.maxLength, snap(raw, this.viewport.snapStep(this.origin, e.shiftKey))),
    );
    if (stepped === this.length) return;
    this.length = stepped;
    this.dim.updateFromCursor({ pitch: this.pitch, length: this.length });
    this.prompt();
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.phase === "pick") {
      const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (!hit) return; // missed the body — let the click orbit
      const round = this.viewport.roundFaceAt(hit.faceId, hit.anchor);
      if (!round) {
        setPrompt("That face is not round. A thread needs a cylinder — a shank or a bore · Esc");
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      this.beginSize(hit.faceId, round.radius, round.solidInside,
        round.cylinder.axis, round.cylinder.point, round.radial);
      return;
    }
    // In sizing: a drag anywhere pulls the length, a click commits.
    this.armed = true;
    this.grabbing = true;
    this.grabLength = this.length;
    this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.origin, this.axis);
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0 || this.phase !== "size") return;
    if (!this.armed) return; // the release of the click that picked the face
    const dragged = this.grabbing && Math.abs(this.length - this.grabLength) > 1e-6;
    this.grabbing = false;
    if (!dragged) this.commit();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") this.cancel();
  }

  private prompt() {
    const turns = threadTurns(this.length, this.pitch);
    setPrompt(
      `${this.external ? "External" : "Internal"} thread · ⌀${(2 * this.radius).toFixed(2)} × ` +
      `${this.pitch}mm pitch · ${turns.toFixed(1)} turns · drag or type · click to commit · Esc`,
    );
  }

  /** Everything the thread needs, recovered from the face that was clicked: the
   *  cylinder it lies on, which end of it the thread starts at, and which way the
   *  material is. */
  private beginSize(
    faceId: number, radius: number, solidInside: boolean,
    axis: readonly [number, number, number], point: readonly [number, number, number],
    radial: THREE.Vector3,
  ) {
    const d = new THREE.Vector3(axis[0], axis[1], axis[2]).normalize();
    const p = new THREE.Vector3(point[0], point[1], point[2]);
    // The face's own extent along the axis — the thread runs the length of the
    // cylinder that was clicked, not of the body it belongs to.
    let lo = Infinity;
    let hi = -Infinity;
    for (const tri of this.viewport.faceTriangles(faceId)) {
      for (const v of [tri.a, tri.b, tri.c]) {
        const t = v.clone().sub(p).dot(d);
        lo = Math.min(lo, t);
        hi = Math.max(hi, t);
      }
    }
    if (!Number.isFinite(lo) || !(hi > lo)) {
      toast("That face has no length along its axis to thread.");
      this.cancel();
      return;
    }
    // Orient the axis start -> end so the thread climbs the way it runs, and put
    // the profile at the near end.
    this.axis.copy(d);
    this.origin.copy(p).addScaledVector(d, lo);
    this.radius = radius;
    this.external = solidInside;
    this.maxLength = hi - lo;
    this.pitch = coarsePitchFor(2 * radius);
    this.length = this.maxLength;
    // The meridian the profile is drawn on. Any radial does; the one under the
    // cursor keeps the first turn where the user was looking.
    const r = radial.clone().sub(this.axis.clone().multiplyScalar(radial.dot(this.axis)));
    this.radial.copy(r.lengthSq() > 1e-12 ? r.normalize() : anyPerpendicular(this.axis));
    this.phase = "size";
    this.armed = false;
    this.viewport.clearHover();
    this.dim.show(
      [
        { name: "pitch", label: "P", kind: "length" },
        { name: "length", label: "L", kind: "length" },
      ],
      () => this.commit(),
      () => this.cancel(),
    );
    const s = this.viewport.projectToScreen(this.origin);
    this.dim.position(s.x, s.y);
    this.dim.updateFromCursor({ pitch: this.pitch, length: this.length });
    this.prompt();
    this.raf = requestAnimationFrame(this.boundTick);
  }

  /** Keep the readout on the part, and take typed values live. */
  private tick() {
    if (this.phase === "size") {
      const s = this.viewport.projectToScreen(this.origin);
      this.dim.position(s.x, s.y);
      if (!this.grabbing) {
        const p = this.dim.isUserDriven("pitch") ? this.dim.getValue("pitch") : null;
        const l = this.dim.isUserDriven("length") ? this.dim.getValue("length") : null;
        if (p != null && p > 0 && Math.abs(p - this.pitch) > 1e-9) { this.pitch = p; this.prompt(); }
        if (l != null && l > 0 && Math.abs(l - this.length) > 1e-9) { this.length = l; this.prompt(); }
      }
      this.raf = requestAnimationFrame(this.boundTick);
    }
  }

  /** The profile sketch + the climbing revolve that sweeps it. */
  private buildFeatures(): Feature[] | null {
    const profile = threadProfile(this.radius, this.pitch, this.external);
    if (!profile) return null;
    const angle = threadAngleDeg(this.length, this.pitch);
    if (!(angle > 0)) return null;
    // A meridian plane: it CONTAINS the axis, so the sketch's own +X is radial
    // (out from the axis) and its +Y is the axis direction — which is the frame
    // threadProfile answers in, so its numbers go in untouched.
    const normal = new THREE.Vector3().crossVectors(this.axis, this.radial).normalize();
    const plane: PlaneDef = {
      origin: [this.origin.x, this.origin.y, this.origin.z],
      normal: [normal.x, normal.y, normal.z],
      xdir: [this.radial.x, this.radial.y, this.radial.z],
    };
    const entities: SketchEntity[] = profile.map((a, i) => {
      const b = profile[(i + 1) % profile.length]!;
      return { type: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y } as SketchEntity;
    });
    const sketchId = this.store.nextId();
    const revolveId = `${sketchId}t`; // distinct from nextId(), which cannot see the un-added sketch
    return [
      { id: sketchId, type: "sketch", plane, entities, name: "Thread profile" } as Feature,
      {
        id: revolveId, type: "revolve", sketch: sketchId,
        axis: { origin: [this.origin.x, this.origin.y, this.origin.z], dir: [this.axis.x, this.axis.y, this.axis.z] },
        angle, pitch: this.pitch, operation: "cut",
      } as Feature,
    ];
  }

  private commit() {
    if (this.phase !== "size") return this.cancel();
    if (threadTurns(this.length, this.pitch) < MIN_THREAD_TURNS) {
      setPrompt(`A thread needs at least one full turn — ${this.pitch}mm at this pitch · Esc`);
      return;
    }
    const features = this.buildFeatures();
    if (!features) {
      toast("That pitch is too coarse for this diameter — the groove would reach the axis.");
      return;
    }
    this.store.addFeatures(features);
    const last = features[features.length - 1]!;
    this.cleanup();
    this.onDone?.(last.id);
  }

  cancel() {
    this.cleanup();
    this.onDone?.(null);
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
    this.viewport.clearHover();
    this.viewport.suspendPicking = false;
    this.active = false;
    this.grabbing = false;
    this.armed = false;
    this.phase = "pick";
    setPrompt(null);
  }
}

/** Any unit vector perpendicular to `d` — the fallback meridian when the cursor's
 *  own radial is degenerate (a click dead on the axis end cap). */
function anyPerpendicular(d: THREE.Vector3): THREE.Vector3 {
  const up = Math.abs(d.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  return new THREE.Vector3().crossVectors(up, d).normalize();
}
