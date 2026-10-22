// The handle offered on a selection you could pull. Not a tool: no toolBusy(), no suspendPicking, no value. Grabbing
// it hands the gesture to the real tool, which mounts the same glyph on the same axis in the same pointerdown.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import { createDragHandle, nameHandle, HANDLE_UP, handleScale, leanOutOfView, type DragHandle } from "./manipulator";

// Dimmer than an armed handle since it is an offer, but 0.55 was dim enough to miss against a lit face, the
// selection toolbar and the Z axis through the same pixels.
const IDLE_OPACITY = 0.75;
const HOT_OPACITY = 1;

/** Everything that varies between the things you can pull. */
export interface NudgePlacement {
  /** Where the handle stands, world space. */
  anchor: THREE.Vector3;
  /** Recomputed every frame: an edge handle's axis is defined against the camera, a face handle's is the face normal. */
  axis: (viewport: Viewport) => THREE.Vector3;
  /** The handle was pressed here: arm the real gesture, already grabbed. */
  grab: (clientX: number, clientY: number) => void;
}

export class SelectionNudge {
  /** Supplied by whoever watched the selection change; null offers nothing. */
  private want: NudgePlacement | null = null;

  private handle: DragHandle | null = null;
  private axis = new THREE.Vector3(1, 0, 0);
  private quat = new THREE.Quaternion();
  private hovering = false;
  private raf = 0;

  private boundMove: (e: PointerEvent) => void;
  private boundDown: (e: PointerEvent) => void;
  private boundTick: () => void;

  constructor(
    private viewport: Viewport,
    private deps: {
      /** Never show over an active tool/sketch, its own gizmos own the screen. */
      toolBusy: () => boolean;
    },
  ) {
    this.boundMove = (e) => this.onMove(e);
    this.boundDown = (e) => this.onDown(e);
    this.boundTick = () => this.tick();
  }

  /** Offer the handle at this placement; null hides it. */
  show(place: NudgePlacement | null) {
    if (!place) {
      this.hide();
      return;
    }
    this.want = place;
    this.viewport.domElement.addEventListener("pointermove", this.boundMove);
    this.viewport.domElement.addEventListener("pointerdown", this.boundDown, true);
    if (!this.raf) this.raf = requestAnimationFrame(this.boundTick);
  }

  hide() {
    this.want = null;
    this.unmount();
    const el = this.viewport.domElement;
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown, true);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Reconciled every frame because tools start from places this cannot subscribe to, and so the handle comes back
   *  when a tool ends. Runs only while something is selected. */
  private tick() {
    this.raf = requestAnimationFrame(this.boundTick);
    if (!this.want || this.deps.toolBusy()) {
      this.unmount();
      return;
    }
    if (!this.handle) this.mount();
    if (!this.handle) return;
    const { anchor } = this.want;
    const group = this.handle.group;
    this.axis.copy(this.want.axis(this.viewport));
    // Drawn along a leaned axis, never measured along one: looking straight down a face normal collapses the glyph.
    // Safe since the grab derives its own axis from the real geometry.
    const cam = this.viewport.camera;
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const camRight = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    this.quat.setFromUnitVectors(HANDLE_UP, leanOutOfView(this.axis, fwd, camRight));
    group.position.copy(anchor);
    group.quaternion.copy(this.quat);
    // Scaled as manipulator.handleScale does; the armed tool applies the same product, or the handle jumps at handover.
    const k = this.viewport.pixelWorldSize(anchor);
    group.scale.setScalar(k * handleScale(this.viewport.modelDiagonal(), k));
    // Raycasts read matrixWorld, which only a render refreshes, so between draws the handle would be hit tested where it was.
    group.updateMatrixWorld(true);
  }

  private mount() {
    this.handle = nameHandle(createDragHandle(), "nudge");
    this.handle.paint({ opacity: IDLE_OPACITY });
    this.viewport.addToScene(this.handle.group);
  }

  private unmount() {
    if (!this.handle) return;
    this.viewport.removeFromScene(this.handle.group);
    this.handle.dispose();
    this.handle = null;
    this.hovering = false;
  }

  private onMove(e: PointerEvent) {
    const hit = this.hitTest(e.clientX, e.clientY);
    if (hit === this.hovering) return;
    this.hovering = hit;
    this.handle?.paint({ hot: hit, opacity: hit ? HOT_OPACITY : IDLE_OPACITY });
    // Only on a change: the viewport renders on demand, and repainting on every miss would defeat that.
    this.viewport.requestRender();
    // Cursor only while we own it, or clearing it would fight the viewport's own hover cursor.
    if (hit) this.viewport.domElement.style.cursor = "grab";
    else if (this.viewport.domElement.style.cursor === "grab") {
      this.viewport.domElement.style.cursor = "default";
    }
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || !this.want) return;
    if (this.deps.toolBusy()) return;
    if (!this.hitTest(e.clientX, e.clientY)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const grab = this.want.grab;
    // Unmount first, or the tool's identical handle z-fights. Not hide(): `want` survives, so the offer returns when
    // the tool ends, and a rebuild meanwhile is safe since setModel keeps the selection and replaces `want`.
    this.unmount();
    grab(e.clientX, e.clientY);
  }

  private hitTest(x: number, y: number): boolean {
    const handle = this.handle;
    if (!handle) return false;
    return this.viewport.probe(x, y, (rc) => rc.intersectObjects(handle.group.children, false).length > 0) ?? false;
  }
}
