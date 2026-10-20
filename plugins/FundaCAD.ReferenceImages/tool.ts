// Inserting an image, calibrating it from two points and a distance, and
// dragging it along its plane.

import * as THREE from "three";
import { fieldNumber, setPrompt, toast } from "fundacad";
import type { Engine, PlaneSpec, SketchPlane } from "fundacad";
import { calibrate, moved, onImage, type V2 } from "./calibrate";
import { pixelSize, type ImageLayer } from "./quads";
import { freshId, patched, readRefImage, type RefImage } from "./refImage";
import { calibrating, selected } from "./state";

const MAX_BYTES = 32 * 1024 * 1024;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };
/** Where an inserted image starts, before it is calibrated. */
const START_WIDTH = 100;

interface Drag { id: string; plane: THREE.Plane; frame: SketchPlane; from: V2; start: RefImage }

export class RefImageTool {
  /** True from the first click of a calibration or a drag to its end. */
  active = false;
  private drag: Drag | null = null;
  private suspendedBefore = false;
  private gesture = 0;

  constructor(private readonly e: Engine, private readonly layer: ImageLayer) {}

  missing(id: string): boolean {
    return this.layer.missing(id);
  }

  images(): RefImage[] {
    return this.e.store.referenceImages().map(readRefImage).filter((r): r is RefImage => r !== null);
  }

  private image(id: string): RefImage | undefined {
    return this.images().find((r) => r.id === id);
  }

  /** Writes passing `coalesce` share one undo step until endGesture. */
  write(id: string, change: Partial<RefImage>, coalesce?: string) {
    const key = coalesce ? { coalesce: `${coalesce}:${id}:${this.gesture}` } : {};
    this.e.store.setReferenceImages(patched(this.e.store.referenceImages(), id, change), key);
  }

  endGesture() {
    this.gesture++;
  }

  remove(id: string) {
    this.e.store.setReferenceImages(this.e.store.referenceImages().filter((r) => r.id !== id).map((r) => structuredClone(r)));
    if (selected.value === id) selected.value = null;
  }

  insert() {
    if (this.e.toolBusy()) return;
    this.e.starters.pickPlane("Select a plane or a flat face to put the image on", (spec, _face, datumId) => {
      this.chooseFile(spec, datumId);
    });
  }

  private chooseFile(plane: PlaneSpec, datumId: string | null) {
    document.getElementById("ri-file-input")?.remove();
    const input = document.createElement("input");
    input.type = "file";
    input.id = "ri-file-input";
    input.accept = "image/png,image/jpeg,.png,.jpg,.jpeg";
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (file) void this.add(file, plane, datumId);
    });
    input.addEventListener("cancel", () => input.remove());
    document.body.appendChild(input);
    input.click();
  }

  async add(file: File, plane: PlaneSpec, datumId: string | null): Promise<string | null> {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const mime = file.type === "image/png" || file.type === "image/jpeg" ? file.type : MIME[ext];
    if (!mime) { toast("A reference image has to be a PNG or a JPEG"); return null; }
    if (file.size > MAX_BYTES) { toast("That image is over 32 MB, save a smaller copy and insert that"); return null; }
    const put = this.e.geometry.blobPut?.bind(this.e.geometry);
    if (!put) { toast("Inserting an image needs the geometry engine"); return null; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const px = await pixelSize(bytes, mime);
    if (!px) { toast(`${file.name} could not be read as an image`); return null; }
    let hash: string;
    try {
      hash = await put(bytes);
    } catch (err) {
      toast(`The image could not be stored: ${(err as Error).message}`);
      return null;
    }
    this.layer.prime(hash, bytes, mime);
    const list = this.e.store.referenceImages();
    const id = freshId(list);
    const entry: RefImage = {
      id, name: file.name, image: hash, mime, px, plane, ...(datumId ? { planeId: datumId } : {}),
      at: [0, 0], width: START_WIDTH, angle: 0, flipX: false, flipY: false, opacity: 0.5, locked: false, hidden: false,
    };
    this.e.store.setReferenceImages([...list.map((r) => structuredClone(r)), { ...entry }]);
    selected.value = id;
    return id;
  }

  // --- calibrate ---------------------------------------------------------------

  startCalibrate(id: string) {
    const r = this.image(id);
    if (!r) return;
    if (r.locked) { toast("The image is locked, unlock it to calibrate"); return; }
    if (this.e.toolBusy()) return;
    this.begin();
    calibrating.value = { id, stage: "first" };
    setPrompt("Click the first point on the image");
  }

  /** The typed distance; an error to show, or null when it is done. */
  finishCalibrate(raw: string): string | null {
    const step = calibrating.value;
    if (!step || step.stage !== "distance") return null;
    const r = this.image(step.id);
    const next = r ? calibrate(r, step.a, step.b, fieldNumber(raw)) : null;
    if (!r || !next) return "Type a length above zero";
    this.write(r.id, { at: next.at, width: next.width });
    this.end();
    return null;
  }

  cancel() {
    if (this.drag) {
      this.write(this.drag.id, { at: this.drag.start.at }, "move");
      this.drag = null;
      this.stopDrag();
      this.endGesture();
    }
    this.end();
  }

  private begin() {
    this.active = true;
    this.suspendedBefore = this.e.viewport.suspendPicking;
    this.e.viewport.suspendPicking = true;
    this.e.viewport.domElement.addEventListener("pointerdown", this.onCalibrateDown, true);
    window.addEventListener("keydown", this.onKey, true);
  }

  private end() {
    if (!calibrating.value) return;
    this.active = false;
    calibrating.value = null;
    this.e.viewport.domElement.removeEventListener("pointerdown", this.onCalibrateDown, true);
    window.removeEventListener("keydown", this.onKey, true);
    this.e.viewport.suspendPicking = this.suspendedBefore;
    setPrompt(null);
  }

  /** The point under the cursor in the image's plane coordinates, null off its plane. */
  pointOn(r: RefImage, clientX: number, clientY: number): V2 | null {
    const frame = this.layer.planeOf(r);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(frame.n, frame.origin);
    const hit = this.e.viewport.screenToPlane(clientX, clientY, plane);
    if (!hit) return null;
    const p = frame.to2D(hit);
    return [p.x, p.y];
  }

  private onCalibrateDown = (ev: PointerEvent) => {
    const step = calibrating.value;
    if (ev.button !== 0 || !step || step.stage === "distance") return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const r = this.image(step.id);
    if (!r) { this.end(); return; }
    const p = this.pointOn(r, ev.clientX, ev.clientY);
    if (!p || !onImage(r, p)) { setPrompt("Click a point on the image itself"); return; }
    if (step.stage === "first") {
      calibrating.value = { id: step.id, stage: "second", a: p };
      setPrompt("Click the second point on the image");
    } else {
      calibrating.value = { id: step.id, stage: "distance", a: step.a, b: p };
      setPrompt("Type the real distance between the two points");
    }
  };

  private onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    this.cancel();
  };

  // --- drag to move -------------------------------------------------------------

  /** A Shift drag on the selected, unlocked image moves it along its plane, one undo step. */
  readonly onDragDown = (ev: PointerEvent) => {
    if (ev.button !== 0 || !ev.shiftKey || this.active || this.e.toolBusy()) return;
    const id = selected.value;
    const r = id ? this.image(id) : undefined;
    if (!r || r.locked || r.hidden) return;
    const from = this.pointOn(r, ev.clientX, ev.clientY);
    if (!from || !onImage(r, from)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const frame = this.layer.planeOf(r);
    this.drag = { id: r.id, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(frame.n, frame.origin), frame, from, start: r };
    this.active = true;
    const el = this.e.viewport.domElement;
    el.setPointerCapture?.(ev.pointerId);
    el.addEventListener("pointermove", this.onDragMove);
    el.addEventListener("pointerup", this.onDragUp);
    window.addEventListener("keydown", this.onKey, true);
  };

  private onDragMove = (ev: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    const hit = this.e.viewport.screenToPlane(ev.clientX, ev.clientY, d.plane);
    if (!hit) return;
    const p = d.frame.to2D(hit);
    this.write(d.id, { at: moved(d.start, [p.x - d.from[0], p.y - d.from[1]]).at }, "move");
  };

  private onDragUp = (ev: PointerEvent) => {
    this.e.viewport.domElement.releasePointerCapture?.(ev.pointerId);
    this.drag = null;
    this.stopDrag();
    this.endGesture();
  };

  private stopDrag() {
    const el = this.e.viewport.domElement;
    el.removeEventListener("pointermove", this.onDragMove);
    el.removeEventListener("pointerup", this.onDragUp);
    window.removeEventListener("keydown", this.onKey, true);
    this.active = false;
  }
}
