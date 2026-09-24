// Aiming the key light on the canvas, in Render: a stalk stands on the model's
// centre pointing at the light, and dragging its ball swings the light round
// the model. Writes the two angles the render settings hold (keyAzimuth,
// keyElevation), snapped like a datum tilt, with boxes to type them exactly.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { renderPrefs, setRenderPref } from "../ui/renderPrefs";
import { keyAngles, keyDirection } from "../viewport/keyLight";
import { CanvasGesture } from "./canvasGesture";
import { snapDegrees } from "./transformGizmo";
import { foldDegrees, tiltStep } from "./datumPoseTool";
import { aimFollow, aimPoint, createAimStalk, STALK_PX, type AimStalk } from "./aimStalk";

/** A warm white, the colour of the light being aimed rather than of a tool. */
const SUN = 0xffd66b;

/** The angles a drag lands on: the light's direction turned by the drag, each
 *  angle snapped to `step` degrees (0 is free). */
export function aimedAngles(
  start: { azimuth: number; elevation: number },
  from: THREE.Vector3,
  now: THREE.Vector3,
  step: number,
): { azimuth: number; elevation: number } {
  const d = aimFollow(new THREE.Vector3(...keyDirection(start.azimuth, start.elevation)), from, now);
  const a = keyAngles([d.x, d.y, d.z]);
  return {
    azimuth: foldDegrees(snapDegrees(a.azimuth, step)),
    elevation: Math.max(-90, Math.min(90, snapDegrees(a.elevation, step))),
  };
}

export class LightAimTool {
  active = false;
  stalk: AimStalk | null = null;
  private hover = false;
  private dragging = false;
  private before = { azimuth: 0, elevation: 0 };
  private grab = { azimuth: 0, elevation: 0 };
  private from = new THREE.Vector3();
  private foot = new THREE.Vector3();
  private downOnStalk = false;
  private downPos = { x: 0, y: 0 };
  private dim = new DimInput();
  private onDone: (() => void) | null = null;
  private readonly gesture: CanvasGesture;

  constructor(private viewport: Viewport) {
    this.gesture = new CanvasGesture(viewport.domElement, {
      move: (e) => this.onMove(e),
      down: (e) => this.onDown(e),
      up: (e) => this.onUp(e),
      key: (e) => this.onKey(e),
      frame: () => this.tick(),
    });
  }

  get angles(): { azimuth: number; elevation: number } {
    const p = renderPrefs();
    return { azimuth: p.keyAzimuth, elevation: p.keyElevation };
  }

  start(onDone?: () => void) {
    if (this.active) return;
    this.active = true;
    this.onDone = onDone ?? null;
    this.before = this.angles;
    this.viewport.suspendPicking = true;
    this.gesture.attach();
    this.stalk = createAimStalk({ rays: true, color: SUN });
    this.viewport.addToScene(this.stalk.group);
    this.dim.show(
      [
        { name: "azimuth", label: "Azimuth", kind: "angle" },
        { name: "elevation", label: "Elevation", kind: "angle" },
      ],
      () => this.finish(),
      () => this.cancel(),
    );
    this.dim.updateFromCursor({ ...this.before });
    setPrompt("Drag the sun to aim the key light · 5° steps, Shift 1°, Alt free · type exact angles · Enter · Esc");
    this.gesture.frame();
  }

  private ray(e: PointerEvent) {
    return this.viewport.rayFrom(e.clientX, e.clientY);
  }

  private radius(): number {
    return STALK_PX * this.viewport.pixelWorldSize(this.foot);
  }

  private onMove(e: PointerEvent) {
    if (this.dragging) {
      const now = aimPoint(this.ray(e).ray, this.foot, this.radius()).sub(this.foot).normalize();
      const a = aimedAngles(this.grab, this.from, now, tiltStep(e));
      this.write(a);
      return;
    }
    const h = !!this.stalk?.hit(this.ray(e));
    if (h !== this.hover) this.viewport.requestRender();
    this.hover = h;
    this.viewport.domElement.style.cursor = h ? "grab" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    this.downOnStalk = !!this.stalk?.hit(this.ray(e));
    if (!this.downOnStalk) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.dim.takeOver("azimuth");
    this.dragging = true;
    this.grab = this.angles;
    this.from.copy(aimPoint(this.ray(e).ray, this.foot, this.radius())).sub(this.foot).normalize();
    this.viewport.domElement.style.cursor = "grabbing";
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.dragging) {
      this.dragging = false;
      this.viewport.domElement.style.cursor = this.hover ? "grab" : "default";
      this.viewport.requestRender();
      return;
    }
    const moved = Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    if (!this.downOnStalk && !moved) this.finish();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") this.cancel();
  }

  private write(a: { azimuth: number; elevation: number }) {
    setRenderPref("keyAzimuth", a.azimuth);
    setRenderPref("keyElevation", a.elevation);
    this.dim.updateFromCursor({ ...this.angles });
    this.viewport.requestRender();
  }

  private readTyped() {
    const a = this.angles;
    const az = this.dim.isUserDriven("azimuth") ? this.dim.getValue("azimuth") : null;
    const el = this.dim.isUserDriven("elevation") ? this.dim.getValue("elevation") : null;
    if (az != null && Math.abs(az - a.azimuth) > 1e-9) setRenderPref("keyAzimuth", az);
    if (el != null && Math.abs(el - a.elevation) > 1e-9) setRenderPref("keyElevation", el);
  }

  private tick() {
    if (!this.active || !this.stalk) return;
    const box = this.viewport.modelBox();
    if (!this.dragging) {
      if (box && !box.isEmpty()) box.getCenter(this.foot);
      else this.foot.set(0, 0, 0);
    }
    const k = this.viewport.pixelWorldSize(this.foot);
    const a = this.angles;
    const dir = new THREE.Vector3(...keyDirection(a.azimuth, a.elevation));
    this.stalk.place(this.foot, dir, k, this.viewport.camera, this.dragging || this.hover);
    const s = this.viewport.projectToScreen(this.foot);
    this.dim.position(s.x + STALK_PX + 40, s.y);
    if (!this.dragging) this.readTyped();
    this.gesture.frame();
  }

  private finish() {
    if (!this.active) return;
    this.readTyped();
    this.cleanup();
  }

  cancel() {
    if (!this.active) return;
    setRenderPref("keyAzimuth", this.before.azimuth);
    setRenderPref("keyElevation", this.before.elevation);
    this.cleanup();
  }

  private cleanup() {
    this.gesture.detach();
    this.viewport.domElement.style.cursor = "default";
    this.dim.hide();
    this.stalk?.dispose();
    this.stalk = null;
    this.viewport.suspendPicking = false;
    this.active = false;
    this.dragging = false;
    this.hover = false;
    setPrompt(null);
    const done = this.onDone;
    this.onDone = null;
    done?.();
    this.viewport.requestRender();
  }
}
