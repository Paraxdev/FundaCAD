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
//
// It is previewed in two registers, and the split is the same one the revolve's
// pitch arrow makes for the same reason. While the hand is moving there is a
// dashed helix: the actual curve the sidecar will sweep along, drawn from the
// same arithmetic (screwMath), so it costs nothing per frame and cannot drift
// from what gets built. When the value settles there is the REAL thing, cut by
// the kernel, in the timeline position it will occupy. A twenty turn thread is a
// real sweep through OCCT and rebuilding it every frame would make the drag
// lurch; drawing only the curve would leave the user guessing whether a groove
// that coarse can be cut at all, which is the question they are actually asking.
//
// Before this the tool showed NOTHING while it was being sized. A face was
// picked, a number moved in a box, and the thread appeared on commit.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, PlaneDef, SketchEntity } from "../types";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { toast } from "../ui/toast";
import { snap } from "../ui/units";
import { axisDragDistance } from "./manipulator";
import { screwPath } from "./screwMath";
import {
  MIN_THREAD_TURNS, coarsePitchFor, threadAngleDeg, threadProfile, threadTurns,
} from "./threadMath";
import { CanvasGesture } from "./canvasGesture";

/** How long the value has to stand still before the kernel is asked to cut it.
 *  Long enough that a drag across a shank is one build rather than fifty, short
 *  enough to read as the model answering the hand. Same figure the revolve's
 *  pitch arrow uses, and for the same reason. */
const SETTLE_MS = 350;

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
  /** The curve the sidecar will sweep the profile along, drawn. */
  private helix: THREE.Line | null = null;
  private previewTimer = 0;
  /** Set once a real build has been asked for, so it can be withdrawn on the way
   *  out. Opened LAZILY: a gesture that commits before the value ever settles
   *  should not pay for a round trip nobody saw. */
  private previewing = false;

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

  start(onDone: (id: string | null) => void) {
    if (this.active) return;
    this.active = true;
    this.phase = "pick";
    this.onDone = onDone;
    this.viewport.suspendPicking = true;
    this.gesture.attach();

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
    // The hand is the authority on the length now, even if it was typed a
    // moment ago; otherwise the drag moves and the box argues with it.
    this.dim.takeOver("length");
    this.dim.updateFromCursor({ pitch: this.pitch, length: this.length });
    this.valueChanged();
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
    this.valueChanged();
    this.gesture.frame();
  }

  /** Redraw the curve the thread runs along, and ask for the real one once the
   *  value stops moving. One call, from every place either value changes, so
   *  the two registers can never be showing different threads. */
  private valueChanged() {
    this.drawHelix();
    this.prompt();
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = 0;
      this.pushPreview();
    }, SETTLE_MS);
  }

  /** The path the profile travels, from the same function the sidecar's spine
   *  comes from. A curve drawn any other way would be a second thing to keep in
   *  step, and a preview that has drifted is worse than none: it is believed. */
  private drawHelix() {
    const angle = threadAngleDeg(this.length, this.pitch);
    const at = this.origin.clone().addScaledVector(this.radial, this.radius);
    const pts = angle > 0
      ? screwPath(
          [at.x, at.y, at.z],
          {
            origin: [this.origin.x, this.origin.y, this.origin.z],
            dir: [this.axis.x, this.axis.y, this.axis.z],
          },
          angle,
          this.pitch,
        )
      : [];
    if (!this.helix) {
      const mat = new THREE.LineDashedMaterial({
        color: 0xffd24a,
        dashSize: 0.6,
        gapSize: 0.4,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      });
      this.helix = new THREE.Line(new THREE.BufferGeometry(), mat);
      this.helix.renderOrder = 999;
      this.viewport.addToScene(this.helix);
    }
    this.helix.geometry.dispose();
    this.helix.geometry = new THREE.BufferGeometry().setFromPoints(
      pts.map((q) => new THREE.Vector3(q[0], q[1], q[2])),
    );
    this.helix.computeLineDistances();
    this.viewport.requestRender();
  }

  /** Cut the thread for real, where it will land in the timeline.
   *
   *  A thread that cannot be built says so on the value boxes rather than
   *  silently doing nothing: the sidecar's refusal reaches them through the
   *  preview-error channel, which is watching this same build. */
  private pushPreview() {
    if (this.phase !== "size") return;
    const features = this.buildFeatures();
    // buildFeatures returns null for a pitch too coarse for the diameter, where
    // the groove would reach the axis. Withdraw the body rather than leaving the
    // last buildable one standing: there is nothing to show, and the boxes are
    // what say why.
    this.store.setPreview(features);
    this.previewing = true;
  }

  /** Keep the readout on the part, and take typed values live. */
  private tick() {
    if (this.phase === "size") {
      const s = this.viewport.projectToScreen(this.origin);
      this.dim.position(s.x, s.y);
      if (!this.grabbing) {
        const p = this.dim.isUserDriven("pitch") ? this.dim.getValue("pitch") : null;
        const l = this.dim.isUserDriven("length") ? this.dim.getValue("length") : null;
        let moved = false;
        if (p != null && p > 0 && Math.abs(p - this.pitch) > 1e-9) { this.pitch = p; moved = true; }
        if (l != null && l > 0 && Math.abs(l - this.length) > 1e-9) { this.length = l; moved = true; }
        if (moved) this.valueChanged();
      }
      this.gesture.frame();
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
    // Cleanup BEFORE the write, so the preview is withdrawn and the rebuild
    // addFeatures schedules is the only one: dropping it afterwards would build
    // the part twice and show the pre-commit state for a frame on the way past.
    this.cleanup();
    this.store.addFeatures(features);
    const last = features[features.length - 1]!;
    this.onDone?.(last.id);
  }

  cancel() {
    this.cleanup();
    this.onDone?.(null);
  }

  private cleanup() {
    const el = this.viewport.domElement;
    this.gesture.detach();
    el.style.cursor = "default";
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = 0;
    if (this.previewing) {
      this.previewing = false;
      // addFeatures (on commit) or the caller (on cancel) schedules the rebuild
      // that puts the real state back; setPreview(null) schedules one of its own
      // either way, and one wasted build on the way out is cheaper than a frame
      // of the un-committed thread still standing.
      this.store.setPreview(null);
    }
    if (this.helix) {
      this.viewport.removeFromScene(this.helix);
      this.helix.geometry.dispose();
      (this.helix.material as THREE.Material).dispose();
      this.helix = null;
    }
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
