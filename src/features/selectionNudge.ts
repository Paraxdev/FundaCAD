// The handle that appears the moment you select something you could pull.
// Selecting used to be a dead end: the entity lit up and you were expected to know
// some command would consume it.
//
// Deliberately NOT a tool — it sets no toolBusy() (a passive affordance that
// blocked every other command would be a mode nobody entered), does not touch
// suspendPicking, and owns no value, preview or document state. Grabbing it hands
// the gesture to the real tool, which owns all of that.
//
// One class serves every entity type. Pressing it arms a tool that mounts its OWN
// handle at the same anchor inside the same pointerdown, and if the two are not
// literally the same glyph on the same axis the handover is a visible jump that
// steers the drag somewhere the user did not aim. What differs — where it stands,
// which way it points, which tool takes over — arrives as a placement.
//
// Per-frame work stays out of Vue: the transform is written straight onto the
// Three.js object in a rAF loop, as the tool gizmos do.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import {
  createDragHandle,
  HANDLE_UP,
  handleScale,
  leanOutOfView,
  type DragHandle,
} from "./manipulator";

// Dimmer than an armed tool's handle: this is an offer, not a live control,
// and it must not compete with the selection itself for attention.
//
// It was 0.55, and 0.55 turned out to be dim enough to miss. The offer is a
// 45px glyph that has to hold its own against a lit orange face under it, the
// selection toolbar over it and the world Z axis passing straight through the
// same patch of screen in full-strength blue — and the report that came back
// was that selecting a face offers nothing and Press/Pull has to be armed from
// the keyboard. Three quarters still reads as an offer against the armed
// handle's full strength, which is the distinction this constant is for.
const IDLE_OPACITY = 0.75;
const HOT_OPACITY = 1;

/** Everything that varies between the things you can pull. */
export interface NudgePlacement {
  /** Where the handle stands, world space. */
  anchor: THREE.Vector3;
  /** Which way it points, recomputed EVERY FRAME. An edge handle's axis is
   *  defined against the camera — perpendicular to the edge, in the screen
   *  plane — so an orbit has to swing it round or it ends up edge-on and
   *  unclickable. A face handle's is the face normal and never moves. Both go
   *  through the same call so the loop does not have to know which it has. */
  axis: (viewport: Viewport) => THREE.Vector3;
  /** The handle was pressed here: arm the real gesture, already grabbed. */
  grab: (clientX: number, clientY: number) => void;
}

export class SelectionNudge {
  /** What we WANT drawn — supplied by whoever watched the selection change.
   *  Null = nothing to offer. */
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
      /** Never show over an active tool/sketch — its own gizmos own the screen. */
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

  /** Reconcile every frame rather than react to events.
   *
   *  A tool can start from a keyboard shortcut, a menu, the command palette or
   *  the browser tree, and a sketch can open from four more places — none of
   *  which route through anything this file could subscribe to. Asking
   *  toolBusy() once a frame covers all of them and, just as importantly, puts
   *  the handle BACK when the tool ends and the selection is still there. The
   *  loop only runs while something is selected, so this costs one predicate
   *  call per frame in a state the user is briefly in. */
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
    // Drawn along a leaned axis, never measured along one. An EDGE handle's axis
    // is rebuilt against the camera each frame and so always has screen length to
    // spare, but a FACE handle's is the face normal and holds still by design —
    // look straight down at a face and its 52px blob projects to a 20px disc with
    // no direction in it. Leaning is safe here precisely because this axis only
    // ever orients the glyph: the gesture it hands off to (want.grab) derives its
    // own axis from the real geometry.
    const cam = this.viewport.camera;
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const camRight = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    this.quat.setFromUnitVectors(HANDLE_UP, leanOutOfView(this.axis, fwd, camRight));
    group.position.copy(anchor);
    group.quaternion.copy(this.quat);
    // Pixel-scaled, then held to a fraction of the model's own on-screen size —
    // see manipulator.handleScale. The armed tool applies the SAME product, or
    // the handle would resize at the instant the gesture takes over.
    const k = this.viewport.pixelWorldSize(anchor);
    group.scale.setScalar(k * handleScale(this.viewport.modelDiagonal(), k));
    // The viewport renders on demand, and a raycast reads matrixWorld — which
    // is only refreshed by a render. Between two draws the handle would then be
    // hit-tested where it USED to be: visibly there, not grabbable. Two objects,
    // so composing it here every frame is cheaper than the bug.
    group.updateMatrixWorld(true);
  }

  private mount() {
    this.handle = createDragHandle();
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
    // Only on a CHANGE: the viewport renders on demand, and repainting on every
    // pointermove that happened to miss the handle would defeat that.
    this.viewport.requestRender();
    // Cursor only while we own it — clearing it unconditionally would fight the
    // viewport's own hover cursor every time the pointer left the handle.
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
    // Drop the scene object before handing over — the tool mounts its own
    // handle at the same anchor with the same axis, and two handles in one place
    // would z-fight. unmount(), not hide(): `want` survives, so the moment the
    // tool ends the tick puts the offer straight back. A rebuild in between is
    // fine now that setModel carries the selection over it — the placement is
    // rebuilt off the new geometry and replaces `want`.
    this.unmount();
    grab(e.clientX, e.clientY);
  }

  private hitTest(x: number, y: number): boolean {
    if (!this.handle) return false;
    return (
      this.viewport.rayFrom(x, y).intersectObjects(this.handle.group.children, false).length > 0
    );
  }
}
