// The `thread` feature finds its face again on every build, so an edited hole is rethreaded at its new size.
// Standard sizes (ISO fine, UNC, UNF, Tr, ACME) come from the Screws plugin.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, Selector } from "../types";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { toast } from "../ui/toast";
import { snap } from "../ui/units";
import { axisDragDistance } from "./manipulator";
import { screwPath } from "./screwMath";
import { MIN_THREAD_TURNS, coarsePitchFor, grooveProfile, threadAngleDeg, threadTurns } from "./threadMath";
import { CanvasGesture } from "./canvasGesture";

/** Long enough that a drag across a shank is one kernel build rather than fifty, short enough to feel live. */
const SETTLE_MS = 350;

type Phase = "pick" | "size";

export class ThreadTool {
  active = false;
  private phase: Phase = "pick";
  private axis = new THREE.Vector3(0, 0, 1); // start -> end, unit
  private origin = new THREE.Vector3(); // point ON the axis where the thread begins
  private radial = new THREE.Vector3(1, 0, 0); // unit, perpendicular to the axis
  private radius = 0;
  private face: Selector | null = null;
  private external = true;
  private pitch = 1;
  private length = 0;
  private maxLength = 0;
  private grabbing = false;
  // The pointerup of the click that picked the face must not commit the default thread,
  // so a commit waits for the next press.
  private armed = false;
  private grabLength = 0;
  private grabProj = 0;
  private helix: THREE.Line | null = null;
  private previewTimer = 0;
  // Opened lazily: a gesture that commits before the value settles skips a round trip nobody saw.
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
      this.beginSize(
        withBody(pre.selectors[0]!, pre.bodyId),
        pre.faceIds[0],
        pre.round.radius,
        pre.round.solidInside,
        pre.round.cylinder.axis,
        pre.round.cylinder.point,
        pre.round.radial,
      );
      return;
    }
    setPrompt("Click a round face, a shank or a bore, to thread · Esc");
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
    // The drag owns the length now even if it was just typed, or the box argues with the hand.
    this.dim.takeOver("length");
    this.dim.updateFromCursor({ pitch: this.pitch, length: this.length });
    this.valueChanged();
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.phase === "pick") {
      const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
      // A click that misses the body falls through and orbits.
      if (!hit) return;
      const round = this.viewport.roundFaceAt(hit.faceId, hit.anchor);
      if (!round) {
        setPrompt("That face is not round. A thread needs a cylinder, a shank or a bore · Esc");
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      this.beginSize(
        withBody(hit.selector, hit.bodyId),
        hit.faceId,
        round.radius,
        round.solidInside,
        round.cylinder.axis,
        round.cylinder.point,
        round.radial,
      );
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
    if (!this.armed) return;
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

  private beginSize(
    face: Selector,
    faceId: number,
    radius: number,
    solidInside: boolean,
    axis: readonly [number, number, number],
    point: readonly [number, number, number],
    radial: THREE.Vector3,
  ) {
    const d = new THREE.Vector3(axis[0], axis[1], axis[2]).normalize();
    const p = new THREE.Vector3(point[0], point[1], point[2]);
    // The thread runs the length of the clicked face, not of the body it belongs to.
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
    this.axis.copy(d);
    this.origin.copy(p).addScaledVector(d, lo);
    this.radius = radius;
    this.face = face;
    this.external = solidInside;
    this.maxLength = hi - lo;
    this.pitch = coarsePitchFor(2 * radius);
    this.length = this.maxLength;
    // Any meridian works; the one under the cursor keeps the first turn where the user was looking.
    const r = radial.clone().sub(this.axis.clone().multiplyScalar(radial.dot(this.axis)));
    this.radial.copy(r.lengthSq() > 1e-12 ? r.normalize() : anyPerpendicular(this.axis));
    this.phase = "size";
    this.armed = false;
    this.viewport.clearHover();
    this.dim.show(
      [
        { name: "pitch", label: "P", kind: "length", positive: true },
        { name: "length", label: "L", kind: "length", positive: true },
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

  // Every value change goes through here, so the helix and the kernel preview never show different threads.
  private valueChanged() {
    this.drawHelix();
    this.prompt();
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = 0;
      this.pushPreview();
    }, SETTLE_MS);
  }

  // Drawn by screwPath, the engine's own spine function: a preview that drifts from it is believed.
  private drawHelix() {
    const angle = threadAngleDeg(this.length, this.pitch);
    const at = this.origin.clone().addScaledVector(this.radial, this.radius);
    const pts =
      angle > 0
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
    this.helix.geometry = new THREE.BufferGeometry().setFromPoints(pts.map((q) => new THREE.Vector3(q[0], q[1], q[2])));
    this.helix.computeLineDistances();
    this.viewport.requestRender();
  }

  // Null features (a pitch too coarse) withdraw the preview rather than leave the last good one standing;
  // the engine's refusal reaches the value boxes through the preview error channel.
  private pushPreview() {
    if (this.phase !== "size") return;
    const features = this.buildFeatures();
    this.store.setPreview(features);
    this.previewing = true;
  }

  private tick() {
    if (this.phase === "size") {
      const s = this.viewport.projectToScreen(this.origin);
      this.dim.position(s.x, s.y);
      if (!this.grabbing) {
        const p = this.dim.isUserDriven("pitch") ? this.dim.getValue("pitch") : null;
        const l = this.dim.isUserDriven("length") ? this.dim.getValue("length") : null;
        let moved = false;
        if (p != null && p > 0 && Math.abs(p - this.pitch) > 1e-9) {
          this.pitch = p;
          moved = true;
        }
        if (l != null && l > 0 && Math.abs(l - this.length) > 1e-9) {
          this.length = l;
          moved = true;
        }
        if (moved) this.valueChanged();
      }
      this.gesture.frame();
    }
  }

  private buildFeatures(): Feature[] | null {
    const profile = grooveProfile(this.radius, this.pitch, this.external);
    if (!profile || !this.face) return null;
    const thread = {
      id: this.store.nextId(),
      type: "thread",
      face: this.face,
      profile,
      pitch: this.pitch,
      starts: 1,
      hand: "right",
      operation: "cut",
      axis: [this.axis.x, this.axis.y, this.axis.z],
      ...(this.length < this.maxLength - 1e-6 ? { length: Math.round(this.length * 1e4) / 1e4 } : {}),
    } as Feature;
    return [thread];
  }

  private commit() {
    if (this.phase !== "size") return this.cancel();
    if (threadTurns(this.length, this.pitch) < MIN_THREAD_TURNS) {
      setPrompt(`A thread needs at least one full turn, ${this.pitch}mm at this pitch · Esc`);
      return;
    }
    const features = this.buildFeatures();
    if (!features) {
      toast("That pitch is too coarse for this diameter, the groove would reach the axis.");
      return;
    }
    // Cleanup before the write, so addFeatures' rebuild is the only one; after it the part
    // would build twice and flash the pre-commit state.
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
      // setPreview(null) schedules its own rebuild; one wasted build is cheaper than a frame
      // of the uncommitted thread still standing.
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

function withBody(sel: Selector, body: string | null): Selector {
  return body && !("body" in sel && sel.body) ? ({ ...sel, body } as Selector) : sel;
}

/** Fallback meridian when the cursor's radial is degenerate, a click dead on the axis end cap. */
function anyPerpendicular(d: THREE.Vector3): THREE.Vector3 {
  const up = Math.abs(d.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  return new THREE.Vector3().crossVectors(up, d).normalize();
}
