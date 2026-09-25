// Interactive Hole: click a flat face, then click more spots on the same face
// to add holes (click a hole again to take it away). The box sets the size, a
// standard name ("M3") or a plain diameter, and the depth or "through"; its
// switch steps the hole type. Everything else, fit, tap drill, counterbore and
// countersink dimensions, drill point, is a row under the feature afterwards.
//
// The preview is the real cut from the engine, so a hole that cannot be built
// says why in the box instead of committing a red history entry.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, HoleType, Selector, Vec3 } from "../types";
import { asFeature } from "../types";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { CanvasGesture } from "./canvasGesture";
import { previewVerdict } from "./previewVerdict";
import { featureNumFields } from "../document/numFields";
import { planeXDir } from "./planeMath";
import {
  CLEARANCE, HOLE_TYPES, INSERT, isHoleSize, newHoleFields, parseHoleSize, type HoleSize,
} from "./holeStandards";
import { rebaseHole, trackedFace, upgradeFace, withExtent } from "./holeFace";

type HoleFeature = Extract<Feature, { type: "hole" }>;

const SETTLE_MS = 120;
const TYPE_LABEL: Record<HoleType, string> = {
  simple: "Simple", counterbore: "Counterbore", countersink: "Countersink", insert: "Insert",
};
const THROUGH = /^\s*(thr(u|ough)?|all)\s*$/i;

export class HoleTool {
  active = false;
  private phase: "pick" | "place" = "pick";
  private editId: string | null = null;
  private base: HoleFeature | null = null;
  private face: Selector | null = null;
  private bodyId: string | null = null;
  private origin = new THREE.Vector3();
  private normal = new THREE.Vector3(0, 0, 1);
  /** The face's true geometric centre (viewport.faceAreaCentroidWorld), the
   *  origin for the X/Y offset fields and what Center snaps to. Distinct from
   *  `origin`, an arbitrary in-plane point only used for the pick plane. */
  private center = new THREE.Vector3();
  // In-plane axes for the X/Y offset fields.
  private xdir = new THREE.Vector3(1, 0, 0);
  private ydir = new THREE.Vector3(0, 1, 0);
  private lastXText = "";
  private lastYText = "";
  private points: Vec3[] = [];
  // Set while a placed hole's marker is being dragged (index into `points`);
  // null the rest of the time, including for a plain click that adds one.
  private dragIndex: number | null = null;
  private dragMoved = false;
  // Kept across uses, the next hole is usually the same as the last one.
  private holeType: HoleType = "simple";
  private size: HoleSize = "M3";
  private diameter: number | null = null;
  private through = true;
  private depth: number | null = null;
  /** Type, size or diameter changed in this session, so an edit re-derives its dimensions. */
  private resized = false;
  private previewId = "";
  private previewTimer = 0;
  private previewing = false;
  private lastSizeText = "";
  private lastDepthText = "";
  private downPos = { x: 0, y: 0 };
  // The release of the click that picked the face must not also toggle a hole there.
  private armed = false;
  private markers: THREE.Group | null = null;

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
      key: (e) => { if (e.key === "Escape") this.cancel(); },
      frame: () => this.tick(),
    });
  }

  start(onDone: (id: string | null) => void) {
    if (this.active) return;
    this.open(onDone);
    this.editId = null;
    this.base = null;
    this.diameter = null;
    this.depth = null;
    const pre = this.viewport.selectedFacesForPressPull();
    const fid = pre?.faceIds.length === 1 ? pre.faceIds[0] : undefined;
    const plane = fid !== undefined ? this.viewport.planarFace(fid) : null;
    if (pre && plane && fid !== undefined) {
      // No click landed on the face this time (it was already selected), so the
      // sensible default is its true centre, not pre.anchor's by:"nearest" point.
      const at = this.viewport.faceAreaCentroidWorld(fid);
      this.begin(at, plane.normal, plane.origin, pre.bodyId, fid);
      return;
    }
    setPrompt("Click a flat face where the hole goes · Esc");
  }

  /** Reopen a hole to move, add or remove positions. False when a parameter
   *  drives one of its numbers or its face cannot be found, the rows are the
   *  edit surface then. */
  startEdit(id: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = asFeature(this.store.document.features.find((x) => x.id === id), "hole");
    if (!f || !f.face || f.sketch || !f.points.length) return false;
    const values = f as unknown as Record<string, unknown>;
    for (const [field] of featureNumFields("hole", values)) {
      if (typeof values[field] === "string" || this.store.isParamBound({ kind: "feature", feature: id, field })) return false;
    }
    const placed = rebaseHole(f.face, f.points, this.store.buildState.result?.trackedFaces?.[id]);
    const first = placed.points[0]!;
    const at = new THREE.Vector3(first[0], first[1], first[2]);
    const plane = this.viewport.planarFaceThrough(at, f.body ?? null);
    if (!plane) return false;
    this.open(onDone);
    this.editId = id;
    this.base = f;
    this.holeType = f.holeType ?? "simple";
    if (isHoleSize(f.size)) this.size = f.size;
    this.diameter = f.standard === "custom" && typeof f.diameter === "number" ? f.diameter : null;
    this.through = f.extent === "through" && this.holeType !== "insert";
    this.depth = typeof f.depth === "number" ? f.depth : null;
    this.store.beginEditPreview(id, f);
    this.begin(at, plane.normal, plane.origin, f.body ?? null, plane.faceId, placed.face, placed.points);
    return true;
  }

  private open(onDone: (id: string | null) => void) {
    this.active = true;
    this.phase = "pick";
    this.resized = false;
    this.onDone = onDone;
    this.viewport.suspendPicking = true;
    this.gesture.attach();
  }

  private onMove(e: PointerEvent) {
    if (this.dragIndex != null) {
      if (Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3) this.dragMoved = true;
      if (this.dragMoved) {
        const p = this.pointOnPlane(e.clientX, e.clientY);
        if (p) {
          this.points[this.dragIndex] = round3(p);
          if (this.dragIndex === 0) this.seedOffset();
          this.valueChanged();
        }
      }
      this.viewport.domElement.style.cursor = "grabbing";
      return;
    }
    const faceId = this.viewport.hoverFaceAt(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = faceId != null ? "crosshair" : "default";
  }

  private pointOnPlane(clientX: number, clientY: number): THREE.Vector3 | null {
    return this.viewport.rayFrom(clientX, clientY).ray.intersectPlane(
      new THREE.Plane().setFromNormalAndCoplanarPoint(this.normal, this.origin), new THREE.Vector3());
  }

  /** The index of the placed hole nearest `p`, within its own pick radius, or -1. */
  private pointNear(p: THREE.Vector3): number {
    const reach = Math.max(this.currentDiameter() / 2, this.viewport.pixelWorldSize(p) * 8);
    return this.points.findIndex((q) => p.distanceTo(new THREE.Vector3(q[0], q[1], q[2])) <= reach);
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    if (this.phase !== "pick") {
      // A press starting on an already-placed hole grabs it (drag to move); a
      // press elsewhere on the face falls through to onUp's add/remove-on-tap.
      const p = this.pointOnPlane(e.clientX, e.clientY);
      const idx = p ? this.pointNear(p) : -1;
      if (idx >= 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.dragIndex = idx;
        this.dragMoved = false;
      } else {
        this.dragIndex = null;
      }
      this.armed = true;
      return;
    }
    const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
    if (!hit) return; // missed the body, let the click orbit
    e.preventDefault();
    e.stopImmediatePropagation();
    const plane = this.viewport.planarFace(hit.faceId);
    if (!plane) {
      setPrompt("That face is curved, a hole needs a flat face · Esc");
      return;
    }
    this.begin(hit.anchor, plane.normal, plane.origin, hit.bodyId, hit.faceId);
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0 || this.phase !== "place" || !this.armed) return;
    if (this.dragIndex != null) {
      const moved = this.dragMoved;
      this.dragIndex = null;
      this.dragMoved = false;
      this.viewport.domElement.style.cursor = "crosshair";
      if (moved) {
        this.armed = false;
        this.dim.focus();
        return; // the drag already committed the new position live
      }
      // A tap with no drag: fall through to the ordinary remove-on-click below.
    }
    if (Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3) return;
    const p = this.pointOnPlane(e.clientX, e.clientY);
    if (!p) return;
    const near = this.pointNear(p);
    if (near >= 0) {
      this.points.splice(near, 1);
      if (near === 0) this.seedOffset();
    } else {
      const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (!hit || hit.normal.dot(this.normal) < 0.99) return;
      this.points.push(round3(p));
      if (this.points.length === 1) this.seedOffset();
    }
    this.valueChanged();
    this.dim.focus();
  }

  private begin(
    at: THREE.Vector3, normal: THREE.Vector3, origin: THREE.Vector3, bodyId: string | null,
    faceId: number | null, face?: Selector, points?: Vec3[],
  ) {
    this.phase = "place";
    this.armed = false;
    this.normal.copy(normal).normalize();
    this.origin.copy(origin);
    this.bodyId = bodyId;
    // The true geometric middle, not faceCentroidWorld's by:"nearest" anchor
    // (origin, above): that one snaps onto a single triangle's centroid, which
    // for a two-triangle quad sits well off the middle a person means.
    this.center.copy(faceId != null ? this.viewport.faceAreaCentroidWorld(faceId) : origin);
    const xd = planeXDir([this.normal.x, this.normal.y, this.normal.z]) ?? [1, 0, 0];
    this.xdir.set(xd[0], xd[1], xd[2]);
    this.ydir.crossVectors(this.normal, this.xdir).normalize();
    const onPlane = at.clone().addScaledVector(this.normal, -this.normal.dot(at.clone().sub(origin)));
    const n: Vec3 = [this.normal.x, this.normal.y, this.normal.z];
    this.face = face ? upgradeFace(face, n) : trackedFace(round3(onPlane), n, bodyId);
    this.points = points ? points.map((q) => [...q] as Vec3) : [round3(onPlane)];
    this.previewId = this.editId ?? this.store.nextId();
    this.viewport.clearHover();
    const centerBtn = document.createElement("button");
    centerBtn.type = "button";
    centerBtn.className = "dim-btn";
    centerBtn.title = "Move the hole to the centre of the face";
    centerBtn.textContent = "Center";
    centerBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.centerFirstPoint();
    });
    this.dim.show(
      [
        { name: "size", label: "Size", kind: "count", free: true },
        { name: "depth", label: "Depth", kind: "length", free: true },
        // Offset from the face centre (this.center) along its own xdir/ydir, so
        // a hole can be placed exactly without pixel-hunting for the click spot.
        { name: "x", label: "X", kind: "length" },
        { name: "y", label: "Y", kind: "length" },
      ],
      () => this.commit(),
      () => this.cancel(),
      {
        label: TYPE_LABEL[this.holeType],
        title: "Hole type: simple, counterbore, countersink or heat-set insert",
        initial: false,
        onChange: () => this.nextType(),
      },
      centerBtn,
    );
    this.lastSizeText = this.sizeText();
    this.dim.seedText("size", this.lastSizeText);
    this.seedDepth();
    this.seedOffset();
    this.valueChanged();
    this.gesture.frame();
  }

  /** X/Y offset fields track `points[0]` only: the common case is one hole, and
   *  a bolt circle's other spots are placed by clicking, not typed. */
  private seedOffset() {
    const p0 = this.points[0];
    if (!p0) return;
    const rel = new THREE.Vector3(p0[0], p0[1], p0[2]).sub(this.center);
    this.dim.seed("x", rel.dot(this.xdir));
    this.dim.seed("y", rel.dot(this.ydir));
    this.lastXText = this.dim.getRaw("x");
    this.lastYText = this.dim.getRaw("y");
  }

  private applyOffset() {
    if (!this.points.length) return;
    const xv = this.dim.getValue("x");
    const yv = this.dim.getValue("y");
    if (xv == null || yv == null) return;
    const p = this.center.clone().addScaledVector(this.xdir, xv).addScaledVector(this.ydir, yv);
    this.points[0] = round3(p);
    this.valueChanged();
  }

  private centerFirstPoint() {
    if (!this.points.length) return;
    this.points[0] = round3(this.center.clone());
    this.seedOffset();
    this.valueChanged();
    this.dim.focus();
  }

  private nextType() {
    this.holeType = HOLE_TYPES[(HOLE_TYPES.indexOf(this.holeType) + 1) % HOLE_TYPES.length]!;
    this.dim.setToggle(false);
    this.dim.setToggleLabel(TYPE_LABEL[this.holeType]);
    this.resized = true;
    if (this.holeType === "insert") {
      if (!INSERT[this.size]) this.size = "M5";
      this.diameter = null;
      this.depth = null;
      this.lastSizeText = this.sizeText();
      this.dim.seedText("size", this.lastSizeText);
    }
    this.seedDepth();
    this.valueChanged();
  }

  /** Size and depth are read by this tool rather than the box, a size name
   *  and "through" not being numbers, so it is this tool that has to refuse
   *  what it could not read instead of building the last value it could. */
  private typedProblem(): string | null {
    if (this.dim.isUserDriven("size") && !parseHoleSize(this.dim.getRaw("size"))) {
      return `Size: "${this.dim.getRaw("size").trim()}" is not a size, type M5 or a diameter`;
    }
    const depthText = this.dim.getRaw("depth");
    if (this.dim.isUserDriven("depth") && !(THROUGH.test(depthText) && this.holeType !== "insert")) {
      const v = this.dim.getValue("depth");
      if (v == null) return `Depth: "${depthText.trim()}" is not a number`;
      if (v <= 0) return "Depth must be more than 0";
    }
    return null;
  }

  private sizeText(): string {
    return this.diameter != null ? String(this.diameter) : this.size;
  }

  private blind(): boolean {
    return this.holeType === "insert" || !this.through;
  }

  private seedDepth() {
    if (!this.blind()) this.dim.seedText("depth", "through");
    else this.dim.seed("depth", this.depth ?? (this.defaults().depth as number));
    this.lastDepthText = this.dim.getRaw("depth");
  }

  private defaults() {
    const b = this.base;
    return newHoleFields(this.holeType, this.size, this.blind() ? "blind" : "through",
      b?.standard === "tap" ? "tap" : "clearance", b?.fit ?? "normal");
  }

  private currentDiameter(): number {
    const d = this.diameter ?? this.defaults().diameter;
    return typeof d === "number" ? d : CLEARANCE[this.size][1];
  }

  /** Take what was typed, as it is typed. */
  private tick() {
    if (this.phase !== "place") return;
    const first = this.points[0];
    const anchor = first ? new THREE.Vector3(first[0], first[1], first[2]) : this.origin;
    this.positionDim(anchor);
    let changed = false;
    const sizeText = this.dim.getRaw("size");
    if (sizeText !== this.lastSizeText) {
      this.lastSizeText = sizeText;
      const parsed = parseHoleSize(sizeText);
      if (parsed && "size" in parsed && (parsed.size !== this.size || this.diameter != null)) {
        if (this.holeType !== "insert" || INSERT[parsed.size]) {
          this.size = parsed.size;
          this.diameter = null;
          changed = true;
        }
      } else if (parsed && "diameter" in parsed && parsed.diameter !== this.diameter && this.holeType !== "insert") {
        this.diameter = parsed.diameter;
        changed = true;
      }
      if (changed) this.resized = true;
    }
    const depthText = this.dim.getRaw("depth");
    if (depthText !== this.lastDepthText) {
      this.lastDepthText = depthText;
      if (THROUGH.test(depthText) && this.holeType !== "insert") {
        if (!this.through) { this.through = true; changed = true; }
      } else {
        const v = this.dim.getValue("depth");
        if (v != null && v > 0 && (this.through || v !== this.depth)) {
          this.through = false;
          this.depth = v;
          changed = true;
        }
      }
    }
    if (changed) this.valueChanged();
    const xText = this.dim.getRaw("x");
    const yText = this.dim.getRaw("y");
    if (xText !== this.lastXText || yText !== this.lastYText) {
      this.lastXText = xText;
      this.lastYText = yText;
      this.applyOffset(); // valueChanged() runs inside, redraws + reschedules the preview
    }
    this.gesture.frame();
  }

  /** Beside the model rather than over it: the face under the box is where the
   *  next click goes. */
  private positionDim(anchor: THREE.Vector3) {
    const s = this.viewport.projectToScreen(anchor);
    const box = this.viewport.modelBox();
    if (!box) return this.dim.position(s.x + 24, s.y + 24);
    let minX = Infinity;
    let maxX = -Infinity;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const c = this.viewport.projectToScreen(new THREE.Vector3(x, y, z));
      minX = Math.min(minX, c.x);
      maxX = Math.max(maxX, c.x);
    }
    const right = maxX + 8;
    this.dim.position(right + 240 < window.innerWidth ? right : Math.max(0, minX - 280), s.y - 16);
  }

  private valueChanged() {
    this.drawMarkers();
    const n = this.points.length;
    const what = this.diameter != null ? `⌀${this.diameter}` : this.size;
    setPrompt(
      `${TYPE_LABEL[this.holeType]} ${what} · ${n} hole${n === 1 ? "" : "s"} · click the face to add, ` +
      "click a hole to remove · depth or \"through\" · Enter to commit · Esc",
    );
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = 0;
      this.pushPreview();
    }, SETTLE_MS);
  }

  private pushPreview() {
    if (this.phase !== "place") return;
    const f = this.points.length ? this.buildFeature() : null;
    if (this.editId) this.store.setEditPreview(f);
    else this.store.setPreview(f);
    this.previewing = true;
  }

  private buildFeature(): HoleFeature {
    const fresh = this.defaults();
    const keep = this.base && !this.resized ? this.base : null;
    const f: HoleFeature = {
      ...(keep ?? fresh),
      ...(this.base && !keep ? { drillPoint: this.base.drillPoint, flip: this.base.flip, tapped: this.base.tapped } : {}),
      id: this.previewId,
      type: "hole",
      holeType: this.holeType,
      face: this.face!,
      points: this.points.map((q) => [...q] as Vec3),
      extent: this.blind() ? "blind" : "through",
    } as HoleFeature;
    if (this.bodyId) f.body = this.bodyId;
    if (this.diameter != null && this.holeType !== "insert") {
      f.diameter = this.diameter;
      f.standard = "custom";
    }
    if (this.blind() && this.depth != null) f.depth = this.depth;
    for (const k of Object.keys(f) as (keyof HoleFeature)[]) if (f[k] === undefined) delete f[k];
    return f;
  }

  private drawMarkers() {
    if (!this.markers) {
      this.markers = new THREE.Group();
      this.markers.renderOrder = 999;
      this.viewport.addToScene(this.markers);
    }
    for (const c of [...this.markers.children]) {
      this.markers.remove(c);
      (c as THREE.LineLoop).geometry.dispose();
      ((c as THREE.LineLoop).material as THREE.Material).dispose();
    }
    const r = this.currentDiameter() / 2;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.normal);
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      ring.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
    }
    for (const p of this.points) {
      const mat = new THREE.LineBasicMaterial({ color: 0xffd24a, depthTest: false, transparent: true });
      const loop = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ring), mat);
      loop.quaternion.copy(q);
      loop.position.set(p[0], p[1], p[2]);
      this.markers.add(loop);
    }
    this.viewport.requestRender();
  }

  private commit() {
    if (this.phase !== "place") return this.cancel();
    if (!this.points.length) {
      setPrompt("Click the face to place a hole first · Esc");
      return;
    }
    const typed = this.typedProblem();
    if (typed) return this.dim.flag(typed);
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = 0;
      this.pushPreview();
    }
    const verdict = previewVerdict(this.store);
    if (verdict.kind === "refused") {
      setPrompt(`Hole refused: ${verdict.reason} · change it or Esc`);
      return;
    }
    // The preview built this very face, so its extent is the one to keep.
    this.face = withExtent(this.face!, this.store.buildState.result?.trackedFaces?.[this.previewId]);
    const feature = this.buildFeature();
    const editId = this.editId;
    this.cleanup(false);
    if (editId) {
      this.store.endEditPreview(false);
      this.store.replaceFeature(editId, feature);
    } else {
      this.store.addFeature(feature);
    }
    if (verdict.kind === "wait") this.store.verifyCommit(feature.id, "Hole");
    this.onDone?.(feature.id);
  }

  cancel() {
    if (!this.active) return;
    this.cleanup(true);
    this.onDone?.(null);
  }

  private cleanup(cancelled: boolean) {
    this.gesture.detach();
    this.viewport.domElement.style.cursor = "default";
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = 0;
    if (this.editId) {
      if (cancelled) this.store.endEditPreview();
    } else if (this.previewing) {
      this.store.setPreview(null);
    }
    this.previewing = false;
    if (this.markers) {
      for (const c of this.markers.children) {
        (c as THREE.LineLoop).geometry.dispose();
        ((c as THREE.LineLoop).material as THREE.Material).dispose();
      }
      this.viewport.removeFromScene(this.markers);
      this.markers = null;
    }
    this.dim.hide();
    this.viewport.clearHover();
    this.viewport.suspendPicking = false;
    this.active = false;
    this.phase = "pick";
    this.dragIndex = null;
    this.dragMoved = false;
    setPrompt(null);
  }
}

function round3(v: THREE.Vector3): Vec3 {
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return [r(v.x), r(v.y), r(v.z)];
}
