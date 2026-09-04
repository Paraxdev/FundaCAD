// Interactive Draft: pick a solid face, grab the handle on it and swing the face
// over to the taper you want, or type the angle. Same gesture as Offset Face —
// grab an arrow on the face and scrub along its normal — but the drag reads as an
// ANGLE about the neutral line rather than as a distance (see draftMath.ts).
//
// Like Offset Face, the result cannot be faked client-side (OCCT's
// BRepOffsetAPI_DraftAngle re-solves every neighbouring wall), so the preview is
// sidecar-driven: the un-committed feature goes through store.setPreview() and
// the normal rebuild pipeline renders it. Commit promotes it (records undo);
// Esc reverts.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, Selector } from "../types";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import { axisDragDistance, createDragHandle, type DragHandle } from "./manipulator";
import { MAX_DRAFT_DEG, draftAngle, draftDelta, draftLever, pullAxisFor, type Axis3 } from "./draftMath";
import { CanvasGesture } from "./canvasGesture";

type Phase = "pick" | "drag";

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Angle steps the drag lands on, in degrees. Draft is specified in whole or half
 *  degrees on every drawing and in every print profile; a free 3.7194° is a
 *  number nobody asked for. Shift takes the finer step, as everywhere else. */
const ANGLE_STEP = 1;
const ANGLE_STEP_FINE = 0.1;

export class DraftTool {
  active = false;
  private phase: Phase = "pick";
  private faces: Selector[] = [];
  private faceIds: number[] = [];
  private bodyId: string | null = null;
  private anchor = new THREE.Vector3();
  private axis = new THREE.Vector3(0, 0, 1); // the FACE normal: what the drag runs along
  private pull: Axis3 = "Z";
  private lever = 0;
  private quat = new THREE.Quaternion();
  private angle = 0;
  private previewId = "";

  private gizmo: THREE.Group | null = null;
  private handle: DragHandle | null = null;
  private hovering = false;
  private grabbing = false;
  private grabAngle = 0;
  private grabProj = 0;
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

  start(onDone: (id: string | null) => void) {
    if (this.active) return;
    this.active = true;
    this.phase = "pick";
    this.onDone = onDone;
    this.viewport.suspendPicking = true;
    this.gesture.attach();

    const pre = this.viewport.selectedFacesForPressPull();
    if (pre) this.beginDrag(pre.selectors, pre.faceIds, pre.anchor, pre.normal, pre.bodyId);
    else setPrompt("Click a face to draft · Ctrl-click adds more");
  }

  private onMove(e: PointerEvent) {
    if (this.phase === "pick") {
      const faceId = this.viewport.hoverFaceAt(e.clientX, e.clientY);
      this.viewport.domElement.style.cursor = faceId != null ? "pointer" : "default";
      return;
    }
    if (this.grabbing) {
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
      const raw = draftAngle(draftDelta(this.grabAngle, this.lever) + (proj - this.grabProj), this.lever);
      const stepped = snap(raw, e.shiftKey ? ANGLE_STEP_FINE : ANGLE_STEP);
      if (stepped === this.angle) return; // same step — don't re-trigger an OCCT rebuild
      this.angle = stepped;
      this.dim.updateFromCursor({ angle: this.angle });
      this.pushPreview();
      return;
    }
    this.hovering = this.hitGizmo(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.phase === "pick") {
      const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (!hit) return; // missed the body — let the click orbit
      e.preventDefault();
      e.stopImmediatePropagation();
      this.beginDrag([hit.selector], [hit.faceId], hit.anchor, hit.normal, hit.bodyId);
      return;
    }
    // Ctrl/Cmd-click another face on the SAME body adds it; every face in one
    // draft shares the angle and the pull axis (which is what the sidecar's
    // handler does with the list it is given).
    if (e.ctrlKey || e.metaKey) {
      const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (hit && hit.bodyId === this.bodyId) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.faces.push(hit.selector);
        this.faceIds.push(hit.faceId);
        this.pushPreview();
        this.prompt();
      }
      return;
    }
    this.downPos = { x: e.clientX, y: e.clientY };
    this.downOnGizmo = this.hitGizmo(e.clientX, e.clientY);
    if (this.downOnGizmo) {
      e.preventDefault();
      e.stopImmediatePropagation(); // don't orbit while dragging the handle
      this.grabbing = true;
      this.grabAngle = this.angle;
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
      this.viewport.domElement.style.cursor = "grabbing";
    }
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0 || this.phase !== "drag") return;
    if (this.grabbing) {
      this.grabbing = false;
      this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
      return;
    }
    const moved =
      Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    if (this.downOnGizmo || moved) return;
    this.commit();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { this.cancel(); return; }
    // The pull axis is a guess from the face's own normal, and on a face at 45°
    // to two of them it is a coin toss. X cycles it rather than making the user
    // commit and then correct the value row.
    if ((e.key === "x" || e.key === "X") && this.phase === "drag") {
      this.pull = this.pull === "X" ? "Y" : this.pull === "Y" ? "Z" : "X";
      this.lever = this.leverFor(this.pull);
      this.pushPreview();
      this.prompt();
    }
  }

  private prompt() {
    const n = this.faces.length > 1 ? `${this.faces.length} faces, ` : "";
    setPrompt(
      `${n}drag or type an angle (max ${MAX_DRAFT_DEG}°) · pull along ${this.pull}, X cycles · click to commit · Esc`,
    );
  }

  /** The height of the grab above the neutral plane for a given pull axis. The
   *  neutral plane is the body's minimum along that axis (builder._draft), and
   *  the bbox of the whole build is the closest thing the frontend has to it —
   *  a single-body document, which is what a draft is nearly always used on, is
   *  exact. */
  private leverFor(axis: Axis3): number {
    const bbox = this.store.buildState.result?.bbox;
    const min = (bbox?.min ?? [0, 0, 0]) as [number, number, number];
    const a: [number, number, number] = [this.anchor.x, this.anchor.y, this.anchor.z];
    return draftLever(a, min, axis);
  }

  private beginDrag(
    faces: Selector[], faceIds: number[], anchor: THREE.Vector3,
    normal: THREE.Vector3, bodyId: string | null = null,
  ) {
    this.faces = faces;
    this.faceIds = faceIds;
    this.bodyId = bodyId;
    this.anchor.copy(anchor);
    this.axis.copy(normal).normalize();
    this.pull = pullAxisFor([this.axis.x, this.axis.y, this.axis.z]);
    this.lever = this.leverFor(this.pull);
    this.phase = "drag";
    this.angle = 0;
    this.previewId = this.store.nextId();
    this.viewport.clearHover();
    this.buildGizmo();
    this.dim.show([{ name: "angle", label: "∠", kind: "angle" }], () => this.commit(), () => this.cancel());
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
    this.dim.updateFromCursor({ angle: 0 });
    this.prompt();
    this.gesture.frame();
  }

  /** keep the handle a constant on-screen size, point it the way we're dragging,
   *  and keep a typed value previewing live (the pointer may be still). */
  private tick() {
    if (this.phase === "drag" && this.gizmo) {
      const sign = this.angle < 0 ? -1 : 1;
      const dir = this.axis.clone().multiplyScalar(sign);
      this.quat.setFromUnitVectors(Y_AXIS, dir);
      const k = this.viewport.pixelWorldSize(this.anchor);
      this.gizmo.position.copy(this.anchor);
      this.gizmo.quaternion.copy(this.quat);
      this.gizmo.scale.setScalar(k);
      // Tone tracks which way the wall leans: amber opens the face out, red
      // undercuts it (which a mould cannot draw, and which is worth flagging
      // before the commit rather than after).
      this.handle?.paint({
        hot: this.hovering || this.grabbing,
        tone: sign < 0 ? "cut" : "idle",
      });
      const s = this.viewport.projectToScreen(this.anchor);
      this.dim.position(s.x, s.y);
      if (!this.grabbing && this.dim.isUserDriven("angle")) {
        const v = this.dim.getValue("angle");
        if (v != null && Math.abs(v - this.angle) > 1e-6) {
          this.angle = Math.max(-MAX_DRAFT_DEG, Math.min(MAX_DRAFT_DEG, v));
          this.pushPreview();
        }
      }
      this.gesture.frame();
    }
  }

  private pushPreview() {
    this.store.setPreview(Math.abs(this.angle) < 1e-6 ? null : this.buildFeature());
  }

  /** The shared drag handle; tick() scales it to a constant screen size. */
  private buildGizmo() {
    this.handle = createDragHandle();
    const g = this.handle.group;
    this.gizmo = g;
    this.viewport.addToScene(g);
  }

  private hitGizmo(x: number, y: number): boolean {
    if (!this.gizmo) return false;
    const ray = this.viewport.rayFrom(x, y);
    return ray.intersectObjects(this.gizmo.children, false).length > 0;
  }

  private buildFeature(): Feature {
    const a = Math.round(this.angle * 1000) / 1000;
    const faces = this.faces.length === 1 ? (this.faces[0] ?? this.faces) : this.faces;
    return { id: this.previewId, type: "draft", faces, angle: a, axis: this.pull } as Feature;
  }

  private commit() {
    if (this.phase !== "drag") return this.cancel();
    const v = this.dim.getValue("angle");
    if (v == null && this.dim.isUserDriven("angle")) {
      setPrompt("That number can't be read · Esc");
      return;
    }
    if (v != null && this.dim.isUserDriven("angle")) {
      this.angle = Math.max(-MAX_DRAFT_DEG, Math.min(MAX_DRAFT_DEG, v));
    }
    if (Math.abs(this.angle) < 1e-3) {
      // keep the tool alive: silently cancelling reads as "nothing happened"
      setPrompt("Nothing to commit yet");
      return;
    }
    const feature = this.buildFeature();
    this.store.setPreview(null); // addFeature re-adds it as a committed feature
    this.store.addFeature(feature);
    this.cleanup();
    this.onDone?.(feature.id);
  }

  cancel() {
    this.cleanup();
    this.onDone?.(null);
  }

  private cleanup() {
    const el = this.viewport.domElement;
    this.gesture.detach();
    el.style.cursor = "default";
    this.store.setPreview(null);
    this.dim.hide();
    this.disposeGizmo();
    this.viewport.clearHover();
    this.viewport.suspendPicking = false;
    this.active = false;
    this.grabbing = false;
    this.hovering = false;
    this.angle = 0;
    setPrompt(null);
  }

  private disposeGizmo() {
    if (!this.gizmo) return;
    this.viewport.removeFromScene(this.gizmo);
    this.handle?.dispose();
    this.gizmo = null;
    this.handle = null;
  }
}
