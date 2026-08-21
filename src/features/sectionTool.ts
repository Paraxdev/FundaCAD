// Cross-section MODE (Inspect): a clipping plane you drag through the model, defined
// by a world axis, a face you click, or a datum plane.
//
// It STAYS ON — orbit, select, fillet an edge you just exposed, and the cut is still
// there. The view state lives on the Viewport (setSectionView) so it survives the
// rebuilds those operations cause, and this file keeps no document state. While
// another tool owns the gesture the handle and offset box get out of the way and
// our keys go quiet, the same bargain selectionNudge.ts strikes: a passive
// affordance that ate Escape would be a mode the user never entered.
//
// And what it cuts away goes faint rather than VANISHING — watching half an assembly
// disappear tells you nothing about where the visible half sits inside it. The dial
// runs down to fully hidden, because a clean uncluttered cut is often right and was
// this tool's entire previous behaviour.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { PlaneDef, Vec3 } from "../types";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { isEditableTarget } from "../ui/focus";
import { snap } from "../ui/units";
import { axisDragDistance, createDragHandle, HANDLE_UP, type DragHandle } from "./manipulator";
import { pickFacePlaneAt } from "./facePlanePick";
import {
  GHOST_DEFAULT,
  clipPlaneAt,
  ghostAlpha,
  ghostLabel,
  nextGhostLevel,
  sectionAnchor,
  sectionCentre,
  sectionFromPlaneDef,
} from "./sectionMath";

const AXES: Record<string, Vec3> = {
  X: [1, 0, 0],
  Y: [0, 1, 0],
  Z: [0, 0, 1],
};

/** What defines the cut. `pick` defers the answer to the user's next click on a
 *  face or a construction plane — the tool owns that pick rather than the
 *  caller, so every entry point (ribbon, palette, menu) gets the same aiming
 *  behaviour without repeating the plumbing. */
export type SectionSource =
  | { kind: "axis"; axis: "X" | "Y" | "Z" }
  | { kind: "plane"; def: PlaneDef }
  | { kind: "pick" };

export interface SectionDeps {
  /** Another tool/sketch owns the gesture: stand down (but keep cutting). */
  toolBusy?: () => boolean;
  /** Placement of a datum-plane feature by id — the document lives outside this
   *  file, so clicking a construction plane asks the app what it is. */
  datumDef?: (id: string) => PlaneDef | null;
}

export class SectionTool {
  /** Cross-section mode is on (cutting). Deliberately NOT part of toolBusy():
   *  the whole point is that you keep working with the cut in place. */
  active = false;
  /** Waiting for the user to click the face/plane to cut along. THIS is a modal
   *  pick and does belong in toolBusy(). */
  picking = false;

  private plane = new THREE.Plane();
  private origin: Vec3 = [0, 0, 0]; // a point on the defining plane
  private normal: Vec3 = [0, 0, 1]; // its unit normal — also the drag axis
  private offset = 0;
  private side: 1 | -1 = 1; // which half to keep (F flips)
  private ghost = GHOST_DEFAULT;

  private gizmo: THREE.Group | null = null;
  private handle: DragHandle | null = null;
  private hovering = false;
  private grabbing = false;
  private grabOffset = 0;
  private grabProj = 0;
  private raf = 0;
  /** true while the handle + offset box are stood down for another tool */
  private standing = false;
  private onDone: (() => void) | null = null;

  private dim = new DimInput();
  private pointV = new THREE.Vector3();
  private axisV = new THREE.Vector3();

  private boundMove: (e: PointerEvent) => void;
  private boundDown: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;
  private boundTick: () => void;
  private boundPickMove: (e: PointerEvent) => void;
  private boundPickDown: (e: PointerEvent) => void;
  private boundPickKey: (e: KeyboardEvent) => void;

  constructor(
    private viewport: Viewport,
    private deps: SectionDeps = {},
  ) {
    this.boundMove = (e) => this.onMove(e);
    this.boundDown = (e) => this.onDown(e);
    this.boundUp = (e) => this.onUp(e);
    this.boundKey = (e) => this.onKey(e);
    this.boundTick = () => this.tick();
    this.boundPickMove = (e) => this.onPickMove(e);
    this.boundPickDown = (e) => this.onPickDown(e);
    this.boundPickKey = (e) => this.onPickKey(e);
  }

  /** Enter cross-section mode. The bare axis letters are the original call shape
   *  and still work. */
  start(src: SectionSource | "X" | "Y" | "Z", onDone?: () => void) {
    if (this.active || this.picking) return;
    if (!this.viewport.modelBox()) return;
    this.onDone = onDone ?? null;
    const source: SectionSource = typeof src === "string" ? { kind: "axis", axis: src } : src;
    if (source.kind === "pick") {
      this.beginPick();
      return;
    }
    if (source.kind === "axis") {
      // A world axis has no clicked point to anchor on, so the cut starts
      // through the middle of what is on screen.
      this.arm(this.modelCentre(), AXES[source.axis] ?? [0, 0, 1]);
      return;
    }
    this.armOn(source.def);
  }

  private modelCentre(): Vec3 {
    const box = this.viewport.modelBox();
    const c = box ? box.getCenter(this.pointV) : this.pointV.set(0, 0, 0);
    return [c.x, c.y, c.z];
  }

  /** Cut along a face / datum plane.
   *
   *  Anchored on the point of that plane NEAREST the model, not on the
   *  definition's own origin: a face plane's origin is the world origin
   *  projected onto it (planeMath explains why it has to be), which for an
   *  off-centre part can sit far outside the geometry — and the handle would
   *  stand out there, off screen, on a cut the user can see perfectly well. */
  private armOn(def: PlaneDef) {
    const { origin, normal } = sectionFromPlaneDef(def);
    this.arm(sectionAnchor(origin, normal, this.modelCentre()), normal);
  }

  // --- aiming: click a face or a construction plane --------------------------

  private beginPick() {
    this.picking = true;
    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundPickMove);
    el.addEventListener("pointerdown", this.boundPickDown, true);
    window.addEventListener("keydown", this.boundPickKey, true);
    setPrompt("Click a face or plane to cut along · Esc");
  }

  private endPick() {
    if (!this.picking) return;
    this.picking = false;
    this.viewport.suspendPicking = false;
    const el = this.viewport.domElement;
    el.removeEventListener("pointermove", this.boundPickMove);
    el.removeEventListener("pointerdown", this.boundPickDown, true);
    window.removeEventListener("keydown", this.boundPickKey, true);
    this.viewport.clearHover();
    setPrompt(null);
  }

  private onPickMove(e: PointerEvent) {
    this.viewport.hoverFaceAt(e.clientX, e.clientY); // show what the click would take
  }

  private onPickDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const def = this.planeAt(e.clientX, e.clientY);
    if (!def) return; // clicked nothing cuttable — stay in the pick rather than arm on a guess
    e.preventDefault();
    e.stopImmediatePropagation();
    this.endPick();
    this.armOn(def);
  }

  private onPickKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    this.endPick();
    const done = this.onDone;
    this.onDone = null;
    done?.();
  }

  /** A construction plane wins over the body behind it: it is a thing the user
   *  placed deliberately, so clicking it means it. */
  private planeAt(x: number, y: number): PlaneDef | null {
    const datum = this.viewport.pickDatumAt(x, y);
    if (datum) {
      const def = this.deps.datumDef?.(datum);
      if (def) return def;
    }
    return pickFacePlaneAt(this.viewport, x, y)?.def ?? null;
  }

  // --- the cut ---------------------------------------------------------------

  private arm(origin: Vec3, normal: Vec3) {
    this.active = true;
    this.origin = origin;
    this.normal = normal;
    this.offset = 0;
    this.side = 1;
    this.pushPlane();
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);
    this.handle = createDragHandle();
    this.gizmo = this.handle.group;
    this.viewport.addToScene(this.gizmo);
    this.showChrome();
    this.raf = requestAnimationFrame(this.boundTick);
  }

  /** Hand the current cut to the viewport, which owns it from here — including
   *  putting it back after every rebuild. */
  private pushPlane() {
    const c = clipPlaneAt(this.origin, this.normal, this.offset, this.side);
    this.plane.set(this.axisV.set(c.normal[0], c.normal[1], c.normal[2]), c.constant);
    this.viewport.setSectionView({ plane: this.plane, ghost: ghostAlpha(this.ghost) });
  }

  private centre(): THREE.Vector3 {
    const c = sectionCentre(this.origin, this.normal, this.offset);
    return this.pointV.set(c[0], c[1], c[2]);
  }

  private onMove(e: PointerEvent) {
    if (this.standing) return;
    if (this.grabbing) {
      const proj = this.dragProj(e.clientX, e.clientY);
      const raw = this.grabOffset + (proj - this.grabProj);
      const stepped = snap(raw, this.viewport.snapStep(this.centre(), e.shiftKey));
      if (stepped === this.offset) return;
      this.offset = stepped;
      this.pushPlane();
      this.dim.updateFromCursor({ offset: Math.abs(this.offset) });
      return;
    }
    this.hovering = this.hitGizmo(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
  }

  private dragProj(x: number, y: number): number {
    const o = this.origin;
    const n = this.normal;
    return axisDragDistance(
      this.viewport,
      x,
      y,
      new THREE.Vector3(o[0], o[1], o[2]),
      this.axisV.set(n[0], n[1], n[2]),
    );
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || this.standing) return;
    // Only OUR handle is ours. Every other click still belongs to the user —
    // selecting a face through the cut is most of the point of the mode.
    if (!this.hitGizmo(e.clientX, e.clientY)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.grabbing = true;
    this.grabOffset = this.offset;
    this.grabProj = this.dragProj(e.clientX, e.clientY);
  }

  private onUp(e: PointerEvent) {
    if (e.button === 0) this.grabbing = false;
  }

  private onKey(e: KeyboardEvent) {
    // Our keys are bare letters, and the mode outlives every other tool — so
    // while one of those is running, they are ITS keys.
    if (this.standing) return;
    // …and while the user is typing they are the FIELD's keys. This matters more
    // here than for a normal tool: the mode stays up across renames, parameter
    // edits and every dimension box in the app, so an unguarded "f" would flip
    // the kept half of the model from inside a text input the section has
    // nothing to do with.
    //
    // Escape aimed at OUR OWN offset box is the one carve-out, and it is not
    // optional: showChrome focuses that box the instant the mode arms, so
    // without it the very first Escape a user presses lands in an input and the
    // mode would have no way out at all. (DimInput deliberately leaves Escape to
    // the owning tool; sketchMode.onKey makes the identical carve-out.)
    const escInOwnDim = e.key === "Escape" && this.dim.isActive && this.dim.ownsTarget(e.target);
    if (!escInOwnDim && isEditableTarget(e.target)) return;
    if (e.key === "Escape") this.stop();
    else if (e.key === "f" || e.key === "F") {
      this.side = this.side === 1 ? -1 : 1;
      this.pushPlane();
    } else if (e.key === "g" || e.key === "G") {
      this.ghost = nextGhostLevel(this.ghost);
      this.pushPlane();
      this.prompt();
    }
  }

  private tick() {
    if (!this.active || !this.gizmo) return;
    this.raf = requestAnimationFrame(this.boundTick);
    // Reconcile rather than subscribe: a tool can arm from a shortcut, a menu,
    // the palette or the browser tree, and none of those route through anything
    // this file could listen to. One predicate call per frame, in a state the
    // user is deliberately in.
    const busy = this.deps.toolBusy?.() ?? false;
    if (busy !== this.standing) {
      this.standing = busy;
      if (busy) this.hideChrome();
      else this.showChrome();
    }
    if (this.standing) return;
    const c = this.centre();
    this.gizmo.position.copy(c);
    this.gizmo.quaternion.setFromUnitVectors(
      HANDLE_UP,
      this.axisV.set(this.normal[0], this.normal[1], this.normal[2]).multiplyScalar(this.side),
    );
    this.gizmo.scale.setScalar(this.viewport.pixelWorldSize(c));
    // The viewport renders on demand and a raycast reads matrixWorld, which only
    // a render refreshes — so between two draws the handle would be hit-tested
    // where it USED to be: visible, but not grabbable.
    this.gizmo.updateMatrixWorld(true);
    this.handle?.paint({ hot: this.hovering || this.grabbing });
    const s = this.viewport.projectToScreen(c);
    this.dim.position(s.x, s.y);
    if (!this.grabbing && this.dim.isUserDriven("offset")) {
      const v = this.dim.getValue("offset");
      // typed sign wins; only read back through isUserDriven, never the |value|
      // the box shows while dragging (the abs-display trap)
      if (v != null && Math.abs(v - this.offset) > 1e-6) {
        this.offset = v;
        this.pushPlane();
      }
    }
  }

  /** Enter in the field (or its check button) sets the exact offset. */
  private applyTypedOffset() {
    if (!this.dim.isUserDriven("offset")) return; // a dragged value is already live
    const v = this.dim.getValue("offset");
    if (v == null) return;
    this.offset = v;
    this.pushPlane();
  }

  private showChrome() {
    if (this.gizmo) this.gizmo.visible = true;
    this.dim.show(
      [{ name: "offset", label: "Offset", kind: "length" }],
      () => this.applyTypedOffset(),
      () => this.stop(),
    );
    this.dim.updateFromCursor({ offset: Math.abs(this.offset) });
    const s = this.viewport.projectToScreen(this.centre());
    this.dim.position(s.x, s.y);
    this.prompt();
    this.viewport.requestRender();
  }

  private hideChrome() {
    if (this.gizmo) this.gizmo.visible = false;
    this.hovering = false;
    this.grabbing = false;
    this.dim.hide();
    // No setPrompt(null) here: the tool that just took over has already written
    // its own line, and clearing would wipe it.
    this.viewport.requestRender();
  }

  private prompt() {
    setPrompt(
      `Section on (ghost: ${ghostLabel(this.ghost)}), drag the handle to move the cut · ` +
        `type a value + Enter · G ghosts more/less · F flips the kept side · Esc closes`,
    );
  }

  private hitGizmo(x: number, y: number): boolean {
    if (!this.gizmo || !this.gizmo.visible) return false;
    return this.viewport.rayFrom(x, y).intersectObjects(this.gizmo.children, false).length > 0;
  }

  stop() {
    const wasPicking = this.picking;
    this.endPick();
    if (!this.active) {
      // Stopped from the AIMING step (the Section button pressed again, say).
      // The caller is still owed its completion callback — the same one Escape
      // during the pick delivers — or a caller that armed us and waited would
      // wait forever, and the stale closure would fire on some later stop.
      if (wasPicking) {
        const done = this.onDone;
        this.onDone = null;
        done?.();
      }
      return;
    }
    const el = this.viewport.domElement;
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown, true);
    el.removeEventListener("pointerup", this.boundUp);
    window.removeEventListener("keydown", this.boundKey, true);
    el.style.cursor = "default";
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.dim.hide();
    this.viewport.setSectionView(null);
    if (this.gizmo) {
      this.viewport.removeFromScene(this.gizmo);
      this.handle?.dispose();
      this.gizmo = null;
      this.handle = null;
    }
    this.active = false;
    this.grabbing = false;
    this.hovering = false;
    // Only clear the prompt if it is still OURS: closing the mode from under a
    // running tool must not blank that tool's line.
    if (!this.standing) setPrompt(null);
    this.standing = false;
    const done = this.onDone;
    this.onDone = null;
    done?.();
  }
}
