// Interactive Text on Face: click a flat, round or conical face, type, and the
// letters are embossed (or engraved) where the click was, wrapped onto a round
// face at their true size.
//
// It writes one `textOnFace` feature. A round face is stored by its fingerprint
// plus the anchor as fractions of the face's (u, v) range, both from the
// engine's faceAnchor op, so the text stays at the same spot round the face
// when its radius is edited later. A flat face is stored by the picked point.
//
// While the panel is open a click or drag on the model moves the anchor (the
// yellow dot); the kernel builds the text again once the hand lets go.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, Selector, Vec3 } from "../types";
import { DimInput } from "../sketch/dimInput";
import { TextPanel, type TextValues } from "../sketch/textPanel";
import { fetchFonts } from "../sketch/textCache";
import { setPrompt } from "../ui/prompt";
import { toast } from "../ui/toast";
import { CanvasGesture } from "./canvasGesture";

const SETTLE_MS = 350;

type Phase = "pick" | "type";

interface Anchor {
  face: Selector;
  body: string;
  point: Vec3;
  at: [number, number] | null;
}

export class TextOnFaceTool {
  active = false;
  private phase: Phase = "pick";
  private anchor: Anchor | null = null;
  private values: TextValues = { text: "Text", height: 8, style: "regular", align: "center", angle: 0 };
  private depth = 1;
  private engrave = false;
  private dragging = false;
  private dragPoint: { point: THREE.Vector3; selector: Selector; bodyId: string | null } | null = null;
  // Each faceAnchor ask gets a ticket, a reply that comes back after a newer
  // ask (or after the tool closed) is dropped.
  private ticket = 0;
  private marker: THREE.Points | null = null;
  private previewTimer = 0;
  private previewing = false;
  private fonts: string[] = [];

  private dim = new DimInput();
  private panel = new TextPanel();
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
      key: (e) => { if (e.key === "Escape") this.cancel(); },
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
    if (!this.fonts.length) void fetchFonts().then((f) => { this.fonts = f; });
    setPrompt("Click a flat, round or conical face to put text on · Esc");
  }

  private onMove(e: PointerEvent) {
    if (this.phase === "pick") {
      const faceId = this.viewport.hoverFaceAt(e.clientX, e.clientY);
      this.viewport.domElement.style.cursor = faceId != null ? "pointer" : "default";
      return;
    }
    if (!this.dragging) return;
    const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
    if (!hit) return;
    this.dragPoint = { point: hit.anchor, selector: hit.selector, bodyId: hit.bodyId };
    this.placeMarker(hit.anchor);
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
    if (!hit) return; // missed the body, let the click orbit
    e.preventDefault();
    e.stopImmediatePropagation();
    if (this.phase === "pick") {
      void this.resolve(hit.selector, hit.bodyId, hit.anchor, { x: e.clientX, y: e.clientY });
      return;
    }
    this.dragging = true;
    this.dragPoint = { point: hit.anchor, selector: hit.selector, bodyId: hit.bodyId };
    this.placeMarker(hit.anchor);
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0 || !this.dragging) return;
    this.dragging = false;
    const d = this.dragPoint;
    this.dragPoint = null;
    if (d) void this.resolve(d.selector, d.bodyId, d.point, null);
  }

  /** Ask the engine where the point sits on the face, and anchor the text
   *  there. `screen` is set for the first pick, which opens the panels. */
  private async resolve(sel: Selector, bodyId: string | null, point: THREE.Vector3, screen: { x: number; y: number } | null) {
    const ticket = ++this.ticket;
    const p: Vec3 = [point.x, point.y, point.z];
    const reply = await this.store.faceAnchor(sel, bodyId, p);
    if (!this.active || ticket !== this.ticket) return;
    if (!reply) {
      toast("The engine could not place text on that face.");
      return;
    }
    if ("reason" in reply) {
      setPrompt(`Text cannot go there, ${reply.reason} · Esc`);
      return;
    }
    if (reply.surface === "sphere" || reply.surface === "other") {
      setPrompt("That face is not flat, round or conical. Text needs a plane, a cylinder or a cone · Esc");
      if (this.anchor) this.placeMarker(new THREE.Vector3(...this.anchor.point));
      return;
    }
    const round = reply.surface !== "plane" && reply.fp;
    this.anchor = {
      face: round
        ? ({ kind: "face", by: "match", fp: reply.fp, body: reply.body } as unknown as Selector)
        : ({ kind: "face", by: "nearest", point: p, body: reply.body } as Selector),
      body: reply.body,
      point: p,
      at: round ? reply.at : null,
    };
    this.placeMarker(point);
    if (screen) this.beginType(screen);
    else this.valueChanged();
  }

  private beginType(screen: { x: number; y: number }) {
    this.phase = "type";
    this.viewport.clearHover();
    this.viewport.domElement.style.cursor = "default";
    this.dim.show(
      [{ name: "depth", label: "D", kind: "length", positive: true }],
      () => this.commit(),
      () => this.cancel(),
      {
        label: "Engrave",
        title: "Cut the letters into the face instead of standing them up",
        initial: this.engrave,
        onChange: (on) => { this.engrave = on; this.valueChanged(); },
      },
      undefined,
      () => this.readDepth(),
    );
    this.dim.updateFromCursor({ depth: this.depth });
    // The panel goes on the far side of the canvas from the click, so it covers
    // neither the letters nor the dot that drags them.
    const left = screen.x > window.innerWidth / 2;
    const at = { x: left ? 16 : window.innerWidth - 332, y: screen.y - 120 };
    this.panel.show(at, this.fonts, this.values, {
      onChange: (v) => { this.values = v; this.valueChanged(); },
      onCommit: (v) => { this.values = v; this.commit(); },
      onCancel: () => this.cancel(),
    });
    this.valueChanged();
    this.gesture.frame();
  }

  private readDepth() {
    const d = this.dim.isUserDriven("depth") ? this.dim.getValue("depth") : null;
    if (d != null && d > 0 && Math.abs(d - this.depth) > 1e-9) {
      this.depth = d;
      this.valueChanged();
    }
  }

  private prompt() {
    setPrompt(
      `${this.engrave ? "Engrave" : "Emboss"} "${this.values.text.trim()}" · click or drag on the face to move it · ` +
      "Add or Enter to commit · Esc",
    );
  }

  private valueChanged() {
    if (this.phase !== "type") return;
    this.prompt();
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = 0;
      if (this.phase !== "type") return;
      this.store.setPreview(this.buildFeatures());
      this.previewing = true;
    }, SETTLE_MS);
  }

  private tick() {
    if (this.phase !== "type" || !this.anchor) return;
    const s = this.viewport.projectToScreen(new THREE.Vector3(...this.anchor.point));
    this.dim.position(s.x, s.y + 60);
    this.gesture.frame();
  }

  private placeMarker(at: THREE.Vector3) {
    if (!this.marker) {
      const mat = new THREE.PointsMaterial({ color: 0xffd24a, size: 12, sizeAttenuation: false, depthTest: false, transparent: true });
      this.marker = new THREE.Points(new THREE.BufferGeometry(), mat);
      this.marker.renderOrder = 999;
      this.viewport.addToScene(this.marker);
    }
    this.marker.geometry.dispose();
    this.marker.geometry = new THREE.BufferGeometry().setFromPoints([at]);
    this.viewport.requestRender();
  }

  /** The feature as it would be committed, null while there is nothing to write. */
  buildFeatures(): Feature[] | null {
    const a = this.anchor;
    const v = this.values;
    if (!a || !v.text.trim()) return null;
    const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
    const feature = {
      id: this.store.nextId(), type: "textOnFace", face: a.face, body: a.body, text: v.text,
      height: v.height, depth: this.depth, operation: this.engrave ? "cut" : "join",
      ...(v.font ? { font: v.font } : {}),
      ...(v.style !== "regular" ? { style: v.style } : {}),
      align: v.align,
      ...(v.angle ? { angle: v.angle } : {}),
      point: a.point.map(round4) as Vec3,
      ...(a.at ? { at: [round4(a.at[0]), round4(a.at[1])] } : {}),
    } as Feature;
    return [feature];
  }

  private commit() {
    if (this.phase !== "type") return this.cancel();
    const features = this.buildFeatures();
    if (!features) {
      toast("Type some text to put on the face.");
      return;
    }
    this.cleanup();
    this.store.addFeatures(features);
    this.onDone?.(features[0]!.id);
  }

  cancel() {
    if (!this.active) return;
    this.cleanup();
    this.onDone?.(null);
  }

  private cleanup() {
    this.gesture.detach();
    this.viewport.domElement.style.cursor = "default";
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = 0;
    if (this.previewing) {
      this.previewing = false;
      this.store.setPreview(null);
    }
    if (this.marker) {
      this.viewport.removeFromScene(this.marker);
      this.marker.geometry.dispose();
      (this.marker.material as THREE.Material).dispose();
      this.marker = null;
    }
    this.ticket++;
    this.dim.hide();
    this.panel.hide();
    this.viewport.clearHover();
    this.viewport.suspendPicking = false;
    this.active = false;
    this.dragging = false;
    this.dragPoint = null;
    this.anchor = null;
    this.phase = "pick";
    setPrompt(null);
  }
}
