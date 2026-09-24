// The node body tool: place nodes in 3D, link them into chains, move, turn and
// resize the picked one with the app's own gizmo, and watch the smooth body
// they make rebuild behind them.
//
// A click on a body puts a node on its surface, a click on a datum plane puts
// one on that plane, and a click in open space puts one on the plane facing
// the view through the picked node (the ground when nothing is picked). With
// "Link new nodes" on, each new node extends the chain from the picked one, so
// a limb is drawn by clicking along it. Alt-drag from a node pulls a linked
// copy out of it. Shift-click links the picked node to the one clicked.

import * as THREE from "three";
import { ALL_HANDLES, setPrompt } from "fundacad";
import type { Engine, Feature, Frame, MoveCommit, MoveResult, MoveTarget } from "fundacad";
import * as panel from "./panel";
import {
  NODE_TYPE, asNodeFeature, freshNodeId, halfExtent, link, nodesBox, numOf, rotationMatrix, roundSize,
  sizeLabel, unlinkNode,
  type NodeFeature, type NodeValues,
} from "./nodeForm";

const PREVIEW_DEBOUNCE_MS = 120;
const DOT_PX = 6;
const HIT_PX = 12;
const DRAG_PX = 4;
const PROMPT = "Click to place a node · Alt-drag a node to pull a linked one out · Shift-click to link · Del removes · Enter · Esc";

const NODE_COLOR = 0x3fb6a8;
const PICKED_COLOR = 0xffb347;
const FRAME_COLOR = 0x8a93a6;

type V3 = [number, number, number];

function centerOf(n: NodeValues): THREE.Vector3 {
  return new THREE.Vector3(numOf(n.x, 0), numOf(n.y, 0), numOf(n.z, 0));
}

function r6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export class NodeTool {
  active = false;
  private working: NodeFeature | null = null;
  private editId: string | null = null;
  private selected: string | null = null;
  private linkNew = true;
  private error: string | null = null;
  private onDone: ((id: string | null) => void) | null = null;

  private overlay: THREE.Group | null = null;
  private raf = 0;
  private previewTimer = 0;
  private down: { x: number; y: number; node: string | null; shift: boolean } | null = null;
  private pull: { id: string; plane: THREE.Plane; offset: THREE.Vector3 } | null = null;
  private savedClickThrough: ((x: number, y: number, additive: boolean) => void) | null = null;
  private suspendedBefore = false;
  private unsubBuild: (() => void) | null = null;

  private readonly onPointerDown = (e: PointerEvent) => this.pointerDown(e);
  private readonly onPointerMove = (e: PointerEvent) => this.pointerMove(e);
  private readonly onPointerUp = (e: PointerEvent) => this.pointerUp(e);
  private readonly onKey = (e: KeyboardEvent) => this.key(e);
  private readonly tick = () => this.frame();

  constructor(private readonly e: Engine) {}

  // --- lifecycle -------------------------------------------------------------

  start(onDone: (id: string | null) => void) {
    if (this.active) return;
    this.working = {
      id: this.e.store.nextId(),
      type: NODE_TYPE,
      nodes: [],
      chains: [],
      blend: 0,
      operation: "new",
    };
    this.editId = null;
    this.open(onDone);
  }

  /** Re-open a committed node body. False when a parameter drives one of its
   *  positions, since a drag would be written over by the parameter. */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = asNodeFeature(this.e.store.document.features.find((x) => x.id === featureId));
    if (!f) return false;
    this.working = structuredClone(f);
    this.working.nodes ??= [];
    this.working.chains ??= [];
    this.editId = featureId;
    this.e.store.beginEditPreview(featureId, f as unknown as Feature);
    this.open(onDone);
    return true;
  }

  private open(onDone: (id: string | null) => void) {
    this.active = true;
    this.onDone = onDone;
    this.selected = null;
    this.error = null;
    const el = this.e.viewport.domElement;
    this.suspendedBefore = this.e.viewport.suspendPicking;
    this.e.viewport.suspendPicking = true;
    el.addEventListener("pointerdown", this.onPointerDown, true);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("keydown", this.onKey, true);
    this.savedClickThrough = this.e.tools.move.onClickThrough;
    this.e.tools.move.onClickThrough = (x, y, additive) => this.clickAt(x, y, additive, null);
    this.unsubBuild = this.e.store.onBuild(() => {
      const err = this.e.store.previewError;
      if (err !== this.error) {
        this.error = err;
        this.publish();
      }
    });
    this.overlay = new THREE.Group();
    this.overlay.renderOrder = 997;
    this.e.viewport.addToScene(this.overlay);
    panel.open(this.viewState(), {
      select: (id) => this.select(id),
      setValue: (id, field, raw) => this.setValue(id, field, raw),
      setFeature: (patch) => this.patchFeature(patch),
      removeNode: (id) => this.removeNode(id),
      removeChain: (i) => this.removeChain(i),
      setLinkNew: (on) => {
        this.linkNew = on;
        this.publish();
      },
      commit: () => this.commit(),
      cancel: () => this.cancel(),
    });
    setPrompt(PROMPT);
    this.redraw();
    this.frame();
  }

  commit() {
    if (!this.active || !this.working) return;
    if (!this.working.nodes.length) {
      this.cancel();
      return;
    }
    const feature = structuredClone(this.working) as unknown as Feature;
    const id = this.working.id;
    const editing = this.editId;
    this.cleanup();
    if (editing) {
      this.e.store.endEditPreview(false);
      this.e.store.replaceFeature(editing, feature);
    } else {
      this.e.store.setPreview(null);
      this.e.store.addFeature(feature);
    }
    const done = this.onDone;
    this.onDone = null;
    done?.(id);
  }

  cancel() {
    if (!this.active) return;
    const editing = this.editId;
    this.cleanup();
    if (editing) this.e.store.endEditPreview();
    else this.e.store.setPreview(null);
    const done = this.onDone;
    this.onDone = null;
    done?.(null);
  }

  private cleanup() {
    if (this.e.tools.move.active) this.e.tools.move.cancel();
    const el = this.e.viewport.domElement;
    el.removeEventListener("pointerdown", this.onPointerDown, true);
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("keydown", this.onKey, true);
    this.e.tools.move.onClickThrough = this.savedClickThrough;
    this.savedClickThrough = null;
    this.e.viewport.suspendPicking = this.suspendedBefore;
    this.unsubBuild?.();
    this.unsubBuild = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = 0;
    this.clearOverlay();
    if (this.overlay) this.e.viewport.removeFromScene(this.overlay);
    this.overlay = null;
    panel.close();
    setPrompt(null);
    this.active = false;
    this.pull = null;
    this.down = null;
  }

  // --- the document ----------------------------------------------------------

  private node(id: string | null): NodeValues | null {
    return (id && this.working?.nodes.find((n) => n.id === id)) || null;
  }

  private changed(opts: { immediate?: boolean } = {}) {
    this.redraw();
    this.publish();
    if (this.previewTimer) clearTimeout(this.previewTimer);
    const run = () => {
      this.previewTimer = 0;
      this.pushPreview();
    };
    if (opts.immediate) run();
    else this.previewTimer = window.setTimeout(run, PREVIEW_DEBOUNCE_MS);
  }

  private pushPreview() {
    if (!this.active || !this.working) return;
    const f = this.working.nodes.length ? (structuredClone(this.working) as unknown as Feature) : null;
    if (this.editId) this.e.store.setEditPreview(f, { hold: true });
    else this.e.store.setPreview(f, { hold: true });
  }

  private boundFields(): Set<string> {
    const out = new Set<string>();
    const fid = this.editId;
    if (!fid || !this.working) return out;
    for (const n of this.working.nodes) {
      for (const k of ["x", "y", "z", "sx", "sy", "sz", "rx", "ry", "rz"]) {
        if (this.e.store.isParamBound({ kind: "feature", feature: fid, field: `nodes.${n.id}.${k}` })) out.add(`${n.id}.${k}`);
      }
    }
    return out;
  }

  private viewState(): panel.NodeView {
    return {
      editing: this.editId !== null,
      feature: structuredClone(this.working!),
      selected: this.selected,
      linkNew: this.linkNew,
      bound: this.boundFields(),
      error: this.error,
    };
  }

  private publish() {
    if (this.active && this.working) panel.update(this.viewState());
  }

  private addNode(at: THREE.Vector3, like: NodeValues | null): string {
    const w = this.working!;
    const id = freshNodeId(w.nodes);
    const size = like ? null : roundSize(this.e.viewport.pixelWorldSize(at) * 30);
    w.nodes.push({
      id,
      x: r6(at.x),
      y: r6(at.y),
      z: r6(at.z),
      sx: like ? like.sx : size!,
      sy: like ? like.sy : size!,
      sz: like ? like.sz : size!,
      rx: 0,
      ry: 0,
      rz: 0,
    });
    return id;
  }

  private setValue(id: string, field: keyof NodeValues & string, raw: string): string | null {
    const n = this.node(id);
    if (!n || field === "id") return null;
    const v = Number(raw.trim());
    if (raw.trim() === "" || !Number.isFinite(v)) return "Type a number";
    if ((field === "sx" || field === "sy" || field === "sz") && !(v > 0)) return "A radius must be greater than 0";
    (n as unknown as Record<string, unknown>)[field] = v;
    this.reopenGizmo();
    this.changed();
    return null;
  }

  private patchFeature(patch: Partial<Pick<NodeFeature, "blend" | "operation">>) {
    if (!this.working) return;
    Object.assign(this.working, patch);
    this.changed();
  }

  private removeNode(id: string) {
    const w = this.working;
    if (!w) return;
    w.nodes = w.nodes.filter((n) => n.id !== id);
    w.chains = unlinkNode(w.chains, id);
    if (this.selected === id) this.select(null);
    this.changed();
  }

  private removeChain(index: number) {
    const w = this.working;
    if (!w) return;
    w.chains = w.chains.filter((_, i) => i !== index);
    this.changed();
  }

  // --- picking a node --------------------------------------------------------

  private select(id: string | null) {
    if (this.e.tools.move.active) this.e.tools.move.cancel();
    this.selected = this.node(id) ? id : null;
    this.redraw();
    this.publish();
    if (this.selected) this.e.tools.move.startTarget(this.target(this.selected), () => {});
  }

  /** The gizmo placed again after its node moved by some other route. */
  private reopenGizmo() {
    if (this.selected && this.e.tools.move.active) this.select(this.selected);
  }

  /** The node drawn nearest the cursor, within reach of its dot. */
  private nodeAt(x: number, y: number): string | null {
    let best: string | null = null;
    let bestD = HIT_PX;
    for (const n of this.working?.nodes ?? []) {
      const s = this.e.viewport.projectToScreen(centerOf(n));
      const d = Math.hypot(s.x - x, s.y - y);
      if (d <= bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best;
  }

  /** Where a click in the view puts a new node. */
  private placeAt(x: number, y: number): THREE.Vector3 | null {
    const vp = this.e.viewport;
    const ray = vp.rayFrom(x, y).ray.clone();
    const hit = vp.surfaceHitAt(x, y);
    if (hit) return ray.at(hit.distance, new THREE.Vector3());
    const datum = vp.pickDatumAt(x, y);
    if (datum) {
      const f = this.e.store.document.features.find((d) => d.id === datum);
      if (f && f.type === "datumPlane") {
        const p = this.e.datumPlaneDef(f as Extract<Feature, { type: "datumPlane" }>);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
          new THREE.Vector3(...p.normal).normalize(),
          new THREE.Vector3(...p.origin),
        );
        const at = ray.intersectPlane(plane, new THREE.Vector3());
        if (at) return at;
      }
    }
    const view = vp.viewDirection();
    const sel = this.node(this.selected);
    if (sel) {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(view, centerOf(sel));
      return ray.intersectPlane(plane, new THREE.Vector3());
    }
    const ground = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    if (Math.abs(view.z) > 0.15) {
      const at = ray.intersectPlane(ground, new THREE.Vector3());
      if (at) return at;
    }
    const facing = new THREE.Plane().setFromNormalAndCoplanarPoint(view, vp.cameraTarget());
    return ray.intersectPlane(facing, new THREE.Vector3());
  }

  private clickAt(x: number, y: number, _additive: boolean, shift: boolean | null) {
    if (!this.active || !this.working) return;
    const hit = this.nodeAt(x, y);
    if (hit) {
      if (shift && this.selected && hit !== this.selected) {
        this.working.chains = link(this.working.chains, this.selected, hit);
        this.select(hit);
        this.changed({ immediate: true });
        return;
      }
      this.select(hit);
      return;
    }
    const at = this.placeAt(x, y);
    if (!at) return;
    const from = this.node(this.selected);
    const id = this.addNode(at, from);
    if (from && this.linkNew) this.working.chains = link(this.working.chains, from.id, id);
    this.select(id);
    this.changed({ immediate: true });
  }

  // --- pointer and keys ------------------------------------------------------

  private pointerDown(e: PointerEvent) {
    if (e.button !== 0 || !this.active) return;
    const node = this.nodeAt(e.clientX, e.clientY);
    if (e.altKey && node) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (this.e.tools.move.active) this.e.tools.move.cancel();
      const src = this.node(node)!;
      const c = centerOf(src);
      const id = this.addNode(c, src);
      this.working!.chains = link(this.working!.chains, node, id);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.e.viewport.viewDirection(), c);
      const grab = this.e.viewport.screenToPlane(e.clientX, e.clientY, plane) ?? c.clone();
      this.pull = { id, plane, offset: c.clone().sub(grab) };
      this.selected = id;
      this.e.viewport.domElement.setPointerCapture?.(e.pointerId);
      this.changed();
      return;
    }
    // With the gizmo up, a press is the gizmo's unless it lands on another
    // node's dot, or links with Shift.
    if (this.e.tools.move.active && (!node || (node === this.selected && !e.shiftKey))) return;
    this.down = { x: e.clientX, y: e.clientY, node, shift: e.shiftKey };
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  private pointerMove(e: PointerEvent) {
    if (!this.pull) return;
    const at = this.e.viewport.screenToPlane(e.clientX, e.clientY, this.pull.plane);
    const n = this.node(this.pull.id);
    if (!at || !n) return;
    at.add(this.pull.offset);
    n.x = r6(at.x);
    n.y = r6(at.y);
    n.z = r6(at.z);
    this.changed();
  }

  private pointerUp(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.pull) {
      const id = this.pull.id;
      this.pull = null;
      this.e.viewport.domElement.releasePointerCapture?.(e.pointerId);
      this.select(id);
      this.changed({ immediate: true });
      return;
    }
    const d = this.down;
    this.down = null;
    if (!d) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > DRAG_PX) return;
    this.clickAt(e.clientX, e.clientY, false, d.shift);
  }

  private key(e: KeyboardEvent) {
    if (!this.active) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (this.e.tools.move.active) {
        this.select(null);
        return;
      }
      this.cancel();
      return;
    }
    if (typing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.commit();
    } else if ((e.key === "Delete" || e.key === "Backspace") && this.selected) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.removeNode(this.selected);
    }
  }

  // --- the gizmo's target ----------------------------------------------------

  private target(id: string): MoveTarget {
    const n0 = structuredClone(this.node(id)!);
    const m = rotationMatrix(numOf(n0.rx, 0), numOf(n0.ry, 0), numOf(n0.rz, 0));
    const frame: Frame = [0, 1, 2].map((j) => new THREE.Vector3(m[0]![j]!, m[1]![j]!, m[2]![j]!)) as unknown as Frame;
    const c0 = centerOf(n0);
    const r0 = new THREE.Matrix4().makeBasis(frame[0], frame[1], frame[2]);
    const bound = this.boundFields();
    let previewed = false;
    const apply = (matrix: THREE.Matrix4) => {
      const n = this.node(id);
      if (!n) return;
      const pos = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      matrix.decompose(pos, q, s);
      const c = c0.clone().applyMatrix4(matrix);
      const turned = new THREE.Matrix4().makeRotationFromQuaternion(q).multiply(r0);
      const eul = new THREE.Euler().setFromRotationMatrix(turned, "ZYX");
      const put = (k: keyof NodeValues & string, v: number) => {
        if (!bound.has(`${id}.${k}`)) (n as unknown as Record<string, unknown>)[k] = r6(v);
      };
      put("x", c.x);
      put("y", c.y);
      put("z", c.z);
      put("rx", THREE.MathUtils.radToDeg(eul.x));
      put("ry", THREE.MathUtils.radToDeg(eul.y));
      put("rz", THREE.MathUtils.radToDeg(eul.z));
      put("sx", numOf(n0.sx, 5) * s.x);
      put("sy", numOf(n0.sy, 5) * s.y);
      put("sz", numOf(n0.sz, 5) * s.z);
    };
    const restore = () => {
      const n = this.node(id);
      if (n) Object.assign(n, structuredClone(n0));
    };
    return {
      frame,
      handles: ALL_HANDLES,
      uniformScale: false,
      canCopy: false,
      ownsEscape: true,
      centroid: () => c0.clone(),
      box: () => {
        const h = halfExtent(n0);
        return new THREE.Box3(
          c0.clone().sub(new THREE.Vector3(...h)),
          c0.clone().add(new THREE.Vector3(...h)),
        );
      },
      begin: () => {},
      preview: (matrix: THREE.Matrix4) => {
        previewed = true;
        apply(matrix);
        this.changed();
      },
      commit: (r: MoveResult): MoveCommit => {
        previewed = false;
        apply(r.matrix);
        this.changed({ immediate: true });
        return { id: null, rebuild: false };
      },
      end: (restoreIt: boolean) => {
        if (!restoreIt || !previewed) return;
        previewed = false;
        restore();
        this.changed({ immediate: true });
      },
      reopen: () => (this.active && this.node(id) && this.selected === id ? this.target(id) : null),
    };
  }

  // --- drawing ---------------------------------------------------------------

  private clearOverlay() {
    const g = this.overlay;
    if (!g) return;
    for (const c of [...g.children]) {
      g.remove(c);
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    }
  }

  private redraw() {
    const g = this.overlay;
    const w = this.working;
    if (!g || !w) return;
    this.clearOverlay();
    const onTop = { depthTest: false, depthWrite: false, transparent: true };

    const dotGeo = new THREE.SphereGeometry(1, 16, 12);
    for (const n of w.nodes) {
      const picked = n.id === this.selected;
      const dot = new THREE.Mesh(
        dotGeo,
        new THREE.MeshBasicMaterial({ color: picked ? PICKED_COLOR : NODE_COLOR, ...onTop }),
      );
      dot.position.copy(centerOf(n));
      dot.renderOrder = 999;
      dot.userData["dot"] = true;
      g.add(dot);
    }

    const spineMat = new THREE.LineBasicMaterial({ color: NODE_COLOR, opacity: 0.8, ...onTop });
    for (const chain of w.chains) {
      const pts = chain.map((id) => this.node(id)).filter((n): n is NodeValues => !!n).map(centerOf);
      if (pts.length < 2) continue;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), spineMat.clone());
      line.renderOrder = 998;
      g.add(line);
    }
    spineMat.dispose();

    const box = nodesBox(w.nodes);
    if (box) {
      const b = new THREE.Box3(new THREE.Vector3(...(box.min as V3)), new THREE.Vector3(...(box.max as V3)));
      const frame = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(...(b.getSize(new THREE.Vector3()).toArray() as V3))),
        new THREE.LineDashedMaterial({ color: FRAME_COLOR, dashSize: 1, gapSize: 1, opacity: 0.7, transparent: true }),
      );
      frame.position.copy(b.getCenter(new THREE.Vector3()));
      frame.userData["frame"] = true;
      g.add(frame);
    }

    const sel = this.node(this.selected);
    if (sel) {
      const m = rotationMatrix(numOf(sel.rx, 0), numOf(sel.ry, 0), numOf(sel.rz, 0));
      const r = [numOf(sel.sx, 5), numOf(sel.sy, 5), numOf(sel.sz, 5)];
      const axes = [0, 1, 2].map((j) => new THREE.Vector3(m[0]![j]!, m[1]![j]!, m[2]![j]!));
      const c = centerOf(sel);
      const ringMat = new THREE.LineBasicMaterial({ color: PICKED_COLOR, opacity: 0.9, ...onTop });
      for (const [a, b] of [[0, 1], [1, 2], [2, 0]] as const) {
        const pts: THREE.Vector3[] = [];
        for (let k = 0; k <= 64; k++) {
          const t = (k / 64) * Math.PI * 2;
          pts.push(c.clone().addScaledVector(axes[a]!, r[a]! * Math.cos(t)).addScaledVector(axes[b]!, r[b]! * Math.sin(t)));
        }
        const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat.clone());
        ring.renderOrder = 998;
        g.add(ring);
      }
      ringMat.dispose();
    }
    this.e.viewport.requestRender();
  }

  /** Keeps the dots a constant size on screen and the size label on its node. */
  private frame() {
    this.raf = 0;
    if (!this.active || !this.overlay) return;
    const vp = this.e.viewport;
    let moved = false;
    for (const c of this.overlay.children) {
      if (c.userData["dot"]) {
        const k = vp.pixelWorldSize(c.position) * DOT_PX;
        if (Math.abs(c.scale.x - k) > 1e-6 * k) {
          c.scale.setScalar(k);
          moved = true;
        }
      }
      if (c.userData["frame"]) {
        const line = c as THREE.LineSegments;
        const mat = line.material as THREE.LineDashedMaterial;
        const px = vp.pixelWorldSize(c.position);
        mat.dashSize = px * 6;
        mat.gapSize = px * 4;
        line.computeLineDistances();
      }
    }
    const sel = this.node(this.selected);
    if (sel) {
      const s = vp.projectToScreen(centerOf(sel));
      const d = [numOf(sel.sx, 5), numOf(sel.sy, 5), numOf(sel.sz, 5)].map((v) => 2 * v);
      const same = Math.abs(d[0]! - d[1]!) < 1e-6 && Math.abs(d[1]! - d[2]!) < 1e-6;
      const text = same ? `⌀ ${sizeLabel(d[0]!)}` : d.map(sizeLabel).join(" × ");
      const cur = panel.label.value;
      if (!cur || Math.abs(cur.x - s.x) > 0.5 || Math.abs(cur.y - s.y) > 0.5 || cur.text !== text) {
        panel.label.value = { x: s.x, y: s.y, text };
      }
    } else if (panel.label.value) {
      panel.label.value = null;
    }
    if (moved) vp.requestRender();
    this.raf = requestAnimationFrame(this.tick);
  }
}
