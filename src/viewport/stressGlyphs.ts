// What the Stress panel draws over the model besides the face tints: an arrow
// per force load with a tip you drag to aim and size it, small arrows into the
// faces a pressure pushes on, the gravity arrow at the body's centre, the axis
// of each pinned support, and the probe's markers on the coloured body. It
// also owns the pointer while those are live: the arrow's tip, and in probe
// mode the hover readout and the click that pins one.
//
// Deliberately not a tool, like SelectionNudge: the panel stays open while the
// user selects faces for it, so nothing here may take the canvas. A press is
// claimed only when it lands on an arrow's tip, and a probe click only once it
// is known to be a click and not the start of an orbit.
//
// What to draw arrives from ui/panels.ts as plain numbers (setModel), and what
// a drag means goes back as a patch for a load; the arithmetic of both lives in
// ui/stress.ts where node can test it. Per-frame work stays out of Vue: glyphs
// are a constant size on screen, so a rAF pass rescales them while they show.

import * as THREE from "three";
import type { Vec3 } from "../types";
import type { Viewport } from "./viewport";
import { escapeClaimed } from "../ui/escapeClaim";
import {
  AXES, forceDragLabel, forceDragPatch, forceDragStart, forceToArrowPx, GRAVITY_MARK_COLOR, LOAD_MARK_COLOR,
  PINNED_MARK_COLOR, snapDrag, type ForceDirection, type ForceDragStart, type SnapCandidate,
} from "../ui/stress";

export type StressGlyphHost = Pick<
  Viewport,
  | "addToScene" | "removeFromScene" | "rayFrom" | "pixelWorldSize" | "projectToScreen"
  | "camera" | "domElement" | "requestRender" | "pickStressOverlay" | "stressOverlayPoint"
>;

export interface ForceGlyph {
  loadId: number;
  /** The centre of the load's faces, where the arrow stands. */
  anchor: Vec3;
  /** Unit direction of the force as it is applied, a negative force's sign
   *  included. */
  dir: Vec3;
  /** The force's size, N. */
  force: number;
  /** `dir` as the panel names it, kept on a drag along it: the load's own
   *  direction, or for a negative force the name of the way it really pushes. */
  direction: ForceDirection;
  /** "Into the face" for this load, when its faces have one. */
  into: Vec3 | null;
}

export interface StressGlyphModel {
  forces: ForceGlyph[];
  /** `dir` is the way the pressure pushes; `pull` marks a negative one, drawn
   *  from the face outward rather than ending on it. */
  pressures: { at: Vec3; dir: Vec3; pull?: boolean }[];
  gravity: { at: Vec3; dir: Vec3 } | null;
  pins: { from: Vec3; to: Vec3 }[];
}

export type ForcePatch = ReturnType<typeof forceDragPatch>;
export type ProbeHit = NonNullable<ReturnType<Viewport["pickStressOverlay"]>>;

export interface StressGlyphHandlers {
  /** A drag of a load's arrow moved it to `patch`. */
  forceDrag(loadId: number, patch: ForcePatch): void;
  /** The drag ended, or was cancelled with Esc and the load should go back. */
  forceDragEnd(loadId: number, cancelled: boolean): void;
  /** The readout for a point of the coloured body, or null for none. */
  probeLabel(hit: ProbeHit): string | null;
  /** A probe click: pin a marker there. */
  pinProbe(hit: ProbeHit): void;
  /** Esc in probe mode. */
  leaveProbe(): void;
}

// Pixel sizes of the drawn glyphs, in the same units handles use.
const SHAFT_R = 1.6;
const HEAD_R = 5;
const HEAD_LEN = 13;
/** The invisible ball at an arrow's tip a press must land in. */
const GRAB_R = 11;
const PRESSURE_PX = 24;
const GRAVITY_PX = 64;
const PROBE_R = 3.5;
/** How far a press may travel and still be a probe click rather than an orbit. */
const CLICK_SLOP_PX = 5;
/** How far a press on an arrow's tip must travel before it changes the load,
 *  so a click or a tremble on the tip leaves it as it is. */
const DRAG_SLOP_PX = 3;
/** The dark rim drawn behind every arrow, px, so it reads over a light body
 *  as well as over the dark background. */
const EDGE_PX = 1.2;
const EDGE_COLOR = 0x1b1f24;

interface Arrow {
  group: THREE.Group;
  shaft: THREE.Mesh;
  head: THREE.Mesh;
  shaftEdge: THREE.Mesh;
  headEdge: THREE.Mesh;
  grab: THREE.Mesh | null;
  /** The arrow's root in world space and its direction. */
  at: THREE.Vector3;
  dir: THREE.Vector3;
  /** Drawn length in pixels; for a pressure arrow the tip is the root. */
  px: number;
  tipAtRoot: boolean;
}

const Y = new THREE.Vector3(0, 1, 0);

export class StressGlyphs {
  private model: StressGlyphModel = { forces: [], pressures: [], gravity: null, pins: [] };
  private arrows: Arrow[] = [];
  private forceArrows = new Map<number, Arrow>();
  private lines: THREE.Line[] = [];
  private probes: { mesh: THREE.Mesh; tri: number; weights: Vec3; label: HTMLElement }[] = [];
  private shared: {
    shaft: THREE.CylinderGeometry; head: THREE.ConeGeometry; shaftEdge: THREE.CylinderGeometry; headEdge: THREE.ConeGeometry;
    grab: THREE.SphereGeometry; ball: THREE.SphereGeometry; hidden: THREE.Material;
  } | null = null;
  private materials = new Map<number, THREE.Material>();
  private attached = false;
  private raf = 0;
  private probe = false;
  private drag: {
    loadId: number; glyph: ForceGlyph; candidates: SnapCandidate[]; start: ForceDragStart;
    from: { x: number; y: number }; moved: boolean;
  } | null = null;
  private hoverTip: number | null = null;
  private press: { x: number; y: number } | null = null;
  private label: HTMLElement | null = null;
  private readonly onMove = (e: PointerEvent) => this.move(e);
  private readonly onDown = (e: PointerEvent) => this.down(e);
  private readonly onUp = (e: PointerEvent) => this.up(e);
  private readonly onKey = (e: KeyboardEvent) => this.key(e);
  private readonly onLeave = () => this.showLabel(null);
  private readonly tick = () => this.frame();

  constructor(
    private host: StressGlyphHost,
    private handlers: StressGlyphHandlers,
  ) {}

  /** Draw this model, replacing the last one. An empty model detaches. */
  setModel(m: StressGlyphModel) {
    this.model = m;
    this.rebuild();
  }

  /** Probe mode on or off. Off drops the hover readout. */
  setProbe(on: boolean) {
    this.probe = on;
    if (!on) this.showLabel(null);
    this.syncAttach();
  }

  /** The pinned probes, each where its triangle is drawn now. */
  setProbePins(pins: { tri: number; weights: Vec3; label: string }[]) {
    for (const p of this.probes) {
      // The ball and its material are shared, so only the mesh goes.
      this.host.removeFromScene(p.mesh);
      p.label.remove();
    }
    this.probes = [];
    const shared = this.geometries();
    for (const p of pins) {
      const mesh = new THREE.Mesh(shared.ball, this.material(0xffffff));
      mesh.renderOrder = 1000;
      mesh.raycast = () => {};
      this.host.addToScene(mesh);
      const label = this.makeLabel("stress-probe-pin");
      label.textContent = p.label;
      this.probes.push({ mesh, tri: p.tri, weights: p.weights, label });
    }
    this.syncAttach();
    this.place();
    this.loop();
  }

  /** Take everything off the view and give the canvas back. */
  dispose() {
    this.model = { forces: [], pressures: [], gravity: null, pins: [] };
    this.probe = false;
    this.drag = null;
    this.clearDrawn();
    this.setProbePins([]);
    this.showLabel(null);
    this.label?.remove();
    this.label = null;
    this.detach();
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    if (this.shared) {
      this.shared.shaft.dispose();
      this.shared.head.dispose();
      this.shared.shaftEdge.dispose();
      this.shared.headEdge.dispose();
      this.shared.grab.dispose();
      this.shared.ball.dispose();
      this.shared.hidden.dispose();
      this.shared = null;
    }
    this.host.requestRender();
  }

  // --- drawing -----------------------------------------------------------------

  private geometries() {
    if (!this.shared) {
      // A unit shaft along +Y from 0 to 1, stretched per arrow; the head's base at 0.
      const shaft = new THREE.CylinderGeometry(SHAFT_R, SHAFT_R, 1, 10);
      shaft.translate(0, 0.5, 0);
      const head = new THREE.ConeGeometry(HEAD_R, HEAD_LEN, 16);
      head.translate(0, HEAD_LEN / 2, 0);
      // The rim: the same shapes a little fatter, drawn first. The head's rim
      // starts a little below the head and ends a little past its point.
      const shaftEdge = new THREE.CylinderGeometry(SHAFT_R + EDGE_PX, SHAFT_R + EDGE_PX, 1, 10);
      shaftEdge.translate(0, 0.5, 0);
      const headEdge = new THREE.ConeGeometry(HEAD_R + EDGE_PX, HEAD_LEN + 3 * EDGE_PX, 16);
      headEdge.translate(0, (HEAD_LEN + 3 * EDGE_PX) / 2 - EDGE_PX, 0);
      this.shared = {
        shaft, head, shaftEdge, headEdge,
        grab: new THREE.SphereGeometry(GRAB_R, 10, 8),
        ball: new THREE.SphereGeometry(PROBE_R, 12, 8),
        hidden: new THREE.MeshBasicMaterial({ visible: false, depthTest: false }),
      };
    }
    return this.shared;
  }

  /** Drawn through the model like every other handle, so a load on a face
   *  turned away from the camera is still there to grab. */
  private material(color: number): THREE.Material {
    let m = this.materials.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
      this.materials.set(color, m);
    }
    return m;
  }

  private makeArrow(at: Vec3, dir: Vec3, px: number, color: number, grabbable: boolean, tipAtRoot = false): Arrow {
    const g = this.geometries();
    const mat = this.material(color);
    const edge = this.material(EDGE_COLOR);
    const group = new THREE.Group();
    group.renderOrder = 999;
    const shaft = new THREE.Mesh(g.shaft, mat);
    const head = new THREE.Mesh(g.head, mat);
    const shaftEdge = new THREE.Mesh(g.shaftEdge, edge);
    const headEdge = new THREE.Mesh(g.headEdge, edge);
    shaft.renderOrder = head.renderOrder = 999;
    shaftEdge.renderOrder = headEdge.renderOrder = 998;
    group.add(shaftEdge, headEdge, shaft, head);
    let grab: THREE.Mesh | null = null;
    if (grabbable) {
      grab = new THREE.Mesh(g.grab, g.hidden);
      group.add(grab);
    }
    const a: Arrow = { group, shaft, head, shaftEdge, headEdge, grab, at: new THREE.Vector3(...at), dir: new THREE.Vector3(...dir).normalize(), px, tipAtRoot };
    this.shape(a);
    this.host.addToScene(group);
    this.arrows.push(a);
    return a;
  }

  /** Lay out an arrow's parts for its length in pixels. A pressure arrow is
   *  drawn ending at its root, pointing into the face it stands on. */
  private shape(a: Arrow) {
    const shaftLen = Math.max(1, a.px - HEAD_LEN);
    a.shaft.scale.set(1, shaftLen, 1);
    a.shaftEdge.scale.set(1, shaftLen, 1);
    if (a.tipAtRoot) {
      // Built along -Y from the root outward, then turned to the direction:
      // the head's point lands on the root.
      a.head.position.set(0, -HEAD_LEN, 0);
      a.shaft.position.set(0, -a.px, 0);
    } else {
      a.shaft.position.set(0, 0, 0);
      a.head.position.set(0, shaftLen, 0);
    }
    a.shaftEdge.position.copy(a.shaft.position);
    a.headEdge.position.copy(a.head.position);
    a.grab?.position.set(0, a.px - HEAD_LEN / 2, 0);
    a.group.quaternion.setFromUnitVectors(Y, a.dir);
  }

  /** The arrows share their geometry and materials, so only their groups go;
   *  the axis lines own theirs. */
  private clearDrawn() {
    for (const a of this.arrows) this.host.removeFromScene(a.group);
    this.arrows = [];
    this.forceArrows.clear();
    for (const l of this.lines) {
      l.removeFromParent();
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
    }
    this.lines = [];
  }

  private rebuild() {
    this.clearDrawn();
    const m = this.model;
    for (const f of m.forces) {
      const a = this.makeArrow(f.anchor, f.dir, forceToArrowPx(f.force), LOAD_MARK_COLOR, true);
      a.group.userData.loadId = f.loadId;
      this.forceArrows.set(f.loadId, a);
    }
    for (const p of m.pressures) this.makeArrow(p.at, p.dir, PRESSURE_PX, LOAD_MARK_COLOR, false, !p.pull);
    if (m.gravity) this.makeArrow(m.gravity.at, m.gravity.dir, GRAVITY_PX, GRAVITY_MARK_COLOR, false);
    for (const p of m.pins) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...p.from), new THREE.Vector3(...p.to)]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: PINNED_MARK_COLOR, depthTest: false, transparent: true, opacity: 0.95 }));
      line.renderOrder = 998;
      line.raycast = () => {};
      this.host.addToScene(line);
      this.lines.push(line);
    }
    this.syncAttach();
    this.place();
    this.loop();
  }

  /** One pass of the loop: place everything, then come back next frame while
   *  there is something to hold in place. */
  private frame() {
    this.raf = 0;
    this.place();
    this.loop();
  }

  /** Keep the frame loop running while the pointer is ours and something is
   *  drawn. Idempotent, so every change can ask for it. */
  private loop() {
    if (this.raf || !this.attached || !(this.arrows.length || this.probes.length)) return;
    if (typeof requestAnimationFrame === "function") this.raf = requestAnimationFrame(this.tick);
  }

  /** Hold every glyph at its size on screen, and the probe markers where their
   *  triangles are drawn now. Asks for a render only when something moved, so
   *  an idle view stays idle. */
  private place() {
    let changed = false;
    for (const a of this.arrows) {
      const k = this.host.pixelWorldSize(a.at);
      if (Math.abs(a.group.scale.x - k) > 1e-3 * k || !a.group.position.equals(a.at)) {
        a.group.position.copy(a.at);
        a.group.scale.setScalar(k);
        changed = true;
      }
      // A raycast reads matrixWorld, which only a render refreshes.
      a.group.updateMatrixWorld(true);
    }
    for (const p of this.probes) {
      const at = this.host.stressOverlayPoint(p.tri, p.weights);
      p.mesh.visible = !!at;
      p.label.style.display = at ? "" : "none";
      if (!at) continue;
      const v = new THREE.Vector3(...at);
      const k = this.host.pixelWorldSize(v);
      if (!p.mesh.position.equals(v) || Math.abs(p.mesh.scale.x - k) > 1e-3 * k) {
        p.mesh.position.copy(v);
        p.mesh.scale.setScalar(k);
        changed = true;
      }
      const s = this.host.projectToScreen(v);
      p.label.style.left = `${s.x + 8}px`;
      p.label.style.top = `${s.y - 8}px`;
    }
    if (changed) this.host.requestRender();
  }

  // --- the pointer ---------------------------------------------------------------

  private syncAttach() {
    const want = this.arrows.length > 0 || this.probe || this.probes.length > 0;
    if (want) this.attach();
    else this.detach();
  }

  private attach() {
    if (this.attached) return;
    this.attached = true;
    const el = this.host.domElement;
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerdown", this.onDown, true);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("pointerleave", this.onLeave);
    window.addEventListener("keydown", this.onKey, true);
  }

  private detach() {
    if (!this.attached) return;
    this.attached = false;
    const el = this.host.domElement;
    el.removeEventListener("pointermove", this.onMove);
    el.removeEventListener("pointerdown", this.onDown, true);
    el.removeEventListener("pointerup", this.onUp);
    el.removeEventListener("pointerleave", this.onLeave);
    window.removeEventListener("keydown", this.onKey, true);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.hoverTip !== null) this.setCursor(null);
    this.hoverTip = null;
  }

  /** The load whose arrow tip is under the cursor, if any. */
  private tipAt(x: number, y: number): number | null {
    const grabs = [...this.forceArrows.entries()].filter(([, a]) => a.grab);
    if (!grabs.length) return null;
    const hit = this.host.rayFrom(x, y).intersectObjects(grabs.map(([, a]) => a.grab!), false)[0];
    if (!hit) return null;
    return grabs.find(([, a]) => a.grab === hit.object)?.[0] ?? null;
  }

  private setCursor(c: string | null) {
    const el = this.host.domElement;
    if (c) el.style.cursor = c;
    else if (el.style.cursor === "grab" || el.style.cursor === "grabbing" || el.style.cursor === "crosshair") el.style.cursor = "";
  }

  private down(e: PointerEvent) {
    if (e.button !== 0) return;
    const loadId = this.tipAt(e.clientX, e.clientY);
    if (loadId !== null) {
      const glyph = this.model.forces.find((f) => f.loadId === loadId);
      if (!glyph) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // Keep the drag when the pointer leaves the canvas. A browser that has
      // lost track of the pointer refuses, and the drag then ends at the edge.
      try { this.host.domElement.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      // The direction the arrow already has first, then "into the face" when
      // the faces have one, then the axes. A snap keeps the first of a tie, and
      // on a face square to an axis "into" is that axis exactly, so a drag
      // straight along the arrow only resizes it and keeps its name.
      const candidates: SnapCandidate[] = [{ key: glyph.direction, dir: glyph.dir }];
      if (glyph.into && glyph.direction !== "into") candidates.push({ key: "into", dir: glyph.into });
      for (const [key, dir] of Object.entries(AXES)) {
        if (key !== glyph.direction) candidates.push({ key: key as ForceDirection, dir });
      }
      // Measured from where the press landed on the tip, not from the tip.
      const press = this.dragAt(e.clientX, e.clientY, glyph, candidates);
      const start = forceDragStart(glyph.force, press ? press.length / this.host.pixelWorldSize(new THREE.Vector3(...glyph.anchor)) : null);
      this.drag = { loadId, glyph, candidates, start, from: { x: e.clientX, y: e.clientY }, moved: false };
      this.setCursor("grabbing");
      return;
    }
    if (this.probe) this.press = { x: e.clientX, y: e.clientY };
  }

  private move(e: PointerEvent) {
    if (this.drag) {
      this.dragTo(e.clientX, e.clientY);
      return;
    }
    const tip = this.tipAt(e.clientX, e.clientY);
    if (tip !== this.hoverTip) {
      this.hoverTip = tip;
      this.setCursor(tip !== null ? "grab" : this.probe ? "crosshair" : null);
    }
    if (tip !== null || !this.probe) {
      if (this.probe) this.showLabel(null);
      return;
    }
    if (this.host.domElement.style.cursor !== "crosshair") this.setCursor("crosshair");
    const hit = this.host.pickStressOverlay(e.clientX, e.clientY);
    const text = hit ? this.handlers.probeLabel(hit) : null;
    this.showLabel(text, e.clientX, e.clientY);
  }

  /** Where the pointer at (x, y) puts an arrow's tip: in the plane through
   *  the arrow's root facing the camera, snapped. */
  private dragAt(x: number, y: number, glyph: ForceGlyph, candidates: SnapCandidate[]) {
    const root = new THREE.Vector3(...glyph.anchor);
    const view = this.host.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(view, root);
    const p = this.host.rayFrom(x, y).ray.intersectPlane(plane, new THREE.Vector3());
    if (!p) return null;
    const v = p.sub(root);
    return snapDrag([v.x, v.y, v.z], [view.x, view.y, view.z], candidates);
  }

  private dragTo(x: number, y: number) {
    const d = this.drag!;
    if (!d.moved && Math.hypot(x - d.from.x, y - d.from.y) <= DRAG_SLOP_PX) return;
    d.moved = true;
    const snapped = this.dragAt(x, y, d.glyph, d.candidates);
    if (!snapped || !(snapped.length > 0)) return;
    const patch = forceDragPatch(snapped, this.host.pixelWorldSize(new THREE.Vector3(...d.glyph.anchor)), d.start);
    this.handlers.forceDrag(d.loadId, patch);
    this.showLabel(forceDragLabel(patch), x, y);
  }

  private up(e: PointerEvent) {
    if (this.drag) {
      const id = this.drag.loadId;
      this.drag = null;
      try { this.host.domElement.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
      this.setCursor(this.tipAt(e.clientX, e.clientY) !== null ? "grab" : null);
      this.showLabel(null);
      this.handlers.forceDragEnd(id, false);
      return;
    }
    const press = this.press;
    this.press = null;
    if (!this.probe || !press) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP_PX) return;
    const hit = this.host.pickStressOverlay(e.clientX, e.clientY);
    if (hit) this.handlers.pinProbe(hit);
  }

  private key(e: KeyboardEvent) {
    if (e.key !== "Escape" || escapeClaimed()) return;
    if (this.drag) {
      const id = this.drag.loadId;
      this.drag = null;
      this.showLabel(null);
      this.setCursor(null);
      e.stopImmediatePropagation();
      this.handlers.forceDragEnd(id, true);
      return;
    }
    if (this.probe) {
      // Only probe mode ends: the panel and its setup stay as they are.
      e.stopImmediatePropagation();
      this.setCursor(null);
      this.handlers.leaveProbe();
    }
  }

  // --- labels ----------------------------------------------------------------------

  private makeLabel(cls: string): HTMLElement {
    const el = document.createElement("div");
    el.className = `stress-glyph-label ${cls}`;
    document.body.appendChild(el);
    return el;
  }

  /** The live readout beside the cursor; null hides it. */
  private showLabel(text: string | null, x = 0, y = 0) {
    if (text === null) {
      if (this.label) this.label.style.display = "none";
      return;
    }
    if (typeof document === "undefined") return;
    this.label ??= this.makeLabel("stress-cursor-label");
    this.label.textContent = text;
    this.label.style.display = "";
    this.label.style.left = `${x + 14}px`;
    this.label.style.top = `${y + 14}px`;
  }
}
