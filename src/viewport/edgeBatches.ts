// Idle bodies' edges drawn as a few merged batches for one render (edgeMotion.ts says when), grouped in space so a
// zoomed view still culls. The real BodyEdges are hidden and put back, so picking and highlighting keep using them.

import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { BodyEdges } from "./edgeLines";
import { mirror } from "./potato";

const TARGET_BATCHES = 32;
const MIN_BATCH_SEGMENTS = 4096;

export interface EdgeFrame {
  /** Every body's edges, the candidates. */
  members: readonly BodyEdges[];
  /** Draw the 1px set. */
  thin: boolean;
  /** The fat set's opacity share, 0 draws none of it. */
  weight: number;
  /** Edges that draw themselves: selected, hovered, failing. */
  keep: (e: BodyEdges) => boolean;
}

interface Member {
  edges: BodyEdges;
  included: boolean;
  pos: THREE.InterleavedBuffer | null;
  col: THREE.InterleavedBuffer | null;
  colVersion: number;
  offset: number;
  segments: number;
}

interface Batch {
  members: Member[];
  pos: Float32Array;
  col: Float32Array;
  segments: number;
  fat: LineSegments2 | null;
  thin: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null;
}

function instanceData(e: BodyEdges, name: string): THREE.InterleavedBuffer | null {
  const a = e.object.geometry.getAttribute(name) as THREE.InterleavedBufferAttribute | undefined;
  return a?.data ?? null;
}

function liveSegments(e: BodyEdges): number {
  const geo = e.object.geometry;
  const start = geo.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute | undefined;
  return start ? Math.min(start.count, geo.instanceCount ?? Infinity) : 0;
}

function untransformed(o: THREE.Object3D): boolean {
  const p = o.position,
    q = o.quaternion,
    s = o.scale;
  return (
    p.x === 0 &&
    p.y === 0 &&
    p.z === 0 &&
    q.x === 0 &&
    q.y === 0 &&
    q.z === 0 &&
    q.w === 1 &&
    s.x === 1 &&
    s.y === 1 &&
    s.z === 1
  );
}

function samePlanes(a: THREE.Plane[] | null, b: THREE.Plane[] | null): boolean {
  if (a === b) return true;
  const la = a?.length ?? 0,
    lb = b?.length ?? 0;
  if (la !== lb) return false;
  for (let i = 0; i < la; i++) if (a![i] !== b![i] && !a![i]!.equals(b![i]!)) return false;
  return true;
}

function sameLook(a: BodyEdges, b: BodyEdges): boolean {
  const m = a.material,
    n = b.material;
  return (
    m.linewidth === n.linewidth &&
    m.opacity === n.opacity &&
    m.transparent === n.transparent &&
    m.depthTest === n.depthTest &&
    m.depthWrite === n.depthWrite &&
    m.visible === n.visible &&
    m.color.equals(n.color) &&
    samePlanes(m.clippingPlanes, n.clippingPlanes) &&
    a.object.layers.mask === b.object.layers.mask &&
    a.object.renderOrder === b.object.renderOrder &&
    a.object.parent === b.object.parent
  );
}

/** A 3 x 10 bit Morton code of a point in the unit cube. */
function morton(x: number, y: number, z: number): number {
  const spread = (v: number) => {
    let n = Math.min(1023, Math.max(0, Math.floor(v * 1024)));
    n = (n | (n << 16)) & 0x030000ff;
    n = (n | (n << 8)) & 0x0300f00f;
    n = (n | (n << 4)) & 0x030c30c3;
    n = (n | (n << 2)) & 0x09249249;
    return n;
  };
  return spread(x) | (spread(y) << 1) | (spread(z) << 2);
}

export class EdgeBatches {
  private source: BodyEdges[] = [];
  private batches: Batch[] = [];
  private group = new THREE.Group();
  private hidden: THREE.Object3D[] = [];
  private fatMaterial = new LineMaterial({ color: 0xffffff, vertexColors: true, worldUnits: false });
  private thinMaterial = new THREE.LineBasicMaterial({ vertexColors: true });
  /** Milliseconds the last begin spent building batches. */
  builtMs = 0;
  /** Segments and members the last begin drew merged. */
  drawn = { segments: 0, members: 0, batches: 0 };

  constructor() {
    this.group.name = "edge-batches";
    this.group.matrixAutoUpdate = false;
  }

  begin(f: EdgeFrame) {
    this.end();
    this.drawn = { segments: 0, members: 0, batches: 0 };
    const t0 = performance.now();
    if (this.changedSource(f.members)) this.regroup(f.members);
    const ref = f.members.find((e) => this.eligible(e, f));
    if (!ref) {
      this.builtMs = performance.now() - t0;
      return;
    }
    for (const b of this.batches) this.refresh(b, ref, f);
    this.builtMs = performance.now() - t0;

    this.mirrorLook(ref, f.weight);
    for (const b of this.batches) {
      if (b.segments === 0) continue;
      for (const m of b.members) {
        if (!m.included) continue;
        m.edges.object.visible = false;
        this.hidden.push(m.edges.object);
        this.drawn.members++;
      }
      this.drawn.segments += b.segments;
      this.drawn.batches++;
      if (f.weight > 0) {
        b.fat ??= this.fatObject(b);
        b.fat.renderOrder = ref.object.renderOrder;
        b.fat.layers.mask = ref.object.layers.mask;
        this.group.add(b.fat);
      }
      if (f.thin) {
        b.thin ??= this.thinObject(b);
        b.thin.renderOrder = ref.object.renderOrder;
        b.thin.layers.mask = ref.object.layers.mask;
        this.group.add(b.thin);
      }
    }
    ref.object.parent?.add(this.group);
  }

  end() {
    this.group.parent?.remove(this.group);
    this.group.clear();
    for (const o of this.hidden) o.visible = true;
    this.hidden.length = 0;
  }

  dispose() {
    this.end();
    for (const b of this.batches) this.dropObjects(b);
    this.batches = [];
    this.source = [];
    this.fatMaterial.dispose();
    this.thinMaterial.dispose();
    this.fatMaterial = new LineMaterial({ color: 0xffffff, vertexColors: true, worldUnits: false });
    this.thinMaterial = new THREE.LineBasicMaterial({ vertexColors: true });
  }

  /** Whether any batch is held, for releasing an old model's copy. */
  get held(): boolean {
    return this.batches.length > 0;
  }

  private eligible(e: BodyEdges, f: EdgeFrame): boolean {
    return e.object.visible && e.object.parent !== null && untransformed(e.object) && !f.keep(e);
  }

  private changedSource(members: readonly BodyEdges[]): boolean {
    if (members.length !== this.source.length) return true;
    for (let i = 0; i < members.length; i++) if (members[i] !== this.source[i]) return true;
    return false;
  }

  private regroup(members: readonly BodyEdges[]) {
    for (const b of this.batches) this.dropObjects(b);
    this.source = [...members];
    const box = new THREE.Box3();
    const centres = members.map((e) => {
      const g = e.object.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const c = g.boundingSphere!.center;
      box.expandByPoint(c);
      return c;
    });
    const size = box.getSize(new THREE.Vector3());
    const key = centres.map((c) =>
      morton(
        size.x > 0 ? (c.x - box.min.x) / size.x : 0,
        size.y > 0 ? (c.y - box.min.y) / size.y : 0,
        size.z > 0 ? (c.z - box.min.z) / size.z : 0,
      ),
    );
    const order = members.map((_, i) => i).sort((a, b) => key[a]! - key[b]!);
    const total = members.reduce((n, e) => n + liveSegments(e), 0);
    const per = Math.max(MIN_BATCH_SEGMENTS, Math.ceil(total / TARGET_BATCHES));
    this.batches = [];
    let cur: Member[] = [];
    let segs = 0;
    for (const i of order) {
      const e = members[i]!;
      cur.push({ edges: e, included: false, pos: null, col: null, colVersion: -1, offset: 0, segments: 0 });
      segs += liveSegments(e);
      if (segs >= per) {
        this.batches.push(this.emptyBatch(cur));
        cur = [];
        segs = 0;
      }
    }
    if (cur.length) this.batches.push(this.emptyBatch(cur));
  }

  private emptyBatch(members: Member[]): Batch {
    return { members, pos: new Float32Array(0), col: new Float32Array(0), segments: 0, fat: null, thin: null };
  }

  /** Rebuild a batch whose members came, went or were rebuilt, recolour one
   *  whose members were only recoloured. */
  private refresh(b: Batch, ref: BodyEdges, f: EdgeFrame) {
    let rebuild = false;
    for (const m of b.members) {
      const inc = this.eligible(m.edges, f) && sameLook(m.edges, ref);
      if (inc !== m.included || (inc && instanceData(m.edges, "instanceStart") !== m.pos)) rebuild = true;
      m.included = inc;
    }
    if (rebuild) {
      this.build(b);
      return;
    }
    let recoloured = false;
    for (const m of b.members) {
      if (!m.included) continue;
      const col = instanceData(m.edges, "instanceColorStart");
      if (col !== m.col) {
        this.build(b);
        return;
      }
      if (col && col.version !== m.colVersion) {
        b.col.set((col.array as Float32Array).subarray(0, m.segments * 6), m.offset * 6);
        m.colVersion = col.version;
        recoloured = true;
      }
    }
    if (recoloured) {
      const fatCol = b.fat?.geometry.getAttribute("instanceColorStart") as THREE.InterleavedBufferAttribute | undefined;
      if (fatCol) fatCol.data.needsUpdate = true;
      const thinCol = b.thin?.geometry.getAttribute("color");
      if (thinCol) thinCol.needsUpdate = true;
    }
  }

  private build(b: Batch) {
    this.dropObjects(b);
    let segs = 0;
    for (const m of b.members) {
      m.segments = m.included ? liveSegments(m.edges) : 0;
      m.offset = segs;
      segs += m.segments;
    }
    b.segments = segs;
    b.pos = new Float32Array(segs * 6);
    b.col = new Float32Array(segs * 6);
    for (const m of b.members) {
      m.pos = m.included ? instanceData(m.edges, "instanceStart") : null;
      m.col = m.included ? instanceData(m.edges, "instanceColorStart") : null;
      m.colVersion = m.col?.version ?? -1;
      if (!m.included || m.segments === 0) continue;
      b.pos.set((m.pos!.array as Float32Array).subarray(0, m.segments * 6), m.offset * 6);
      if (m.col) b.col.set((m.col.array as Float32Array).subarray(0, m.segments * 6), m.offset * 6);
    }
  }

  private fatObject(b: Batch): LineSegments2 {
    const g = new LineSegmentsGeometry();
    g.setPositions(b.pos);
    g.setColors(b.col);
    const o = new LineSegments2(g, this.fatMaterial);
    o.name = "edge-batch";
    o.matrixAutoUpdate = false;
    return o;
  }

  private thinObject(b: Batch): THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(b.pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(b.col, 3));
    g.computeBoundingSphere();
    const o = new THREE.LineSegments(g, this.thinMaterial);
    o.name = "edge-batch-thin";
    o.matrixAutoUpdate = false;
    return o;
  }

  private dropObjects(b: Batch) {
    b.fat?.geometry.dispose();
    b.thin?.geometry.dispose();
    b.fat = null;
    b.thin = null;
  }

  private mirrorLook(ref: BodyEdges, weight: number) {
    const src = ref.material;
    const fat = this.fatMaterial;
    mirror(fat, src);
    fat.linewidth = src.linewidth;
    fat.resolution.copy(src.resolution);
    fat.color.copy(src.color);
    fat.opacity = src.opacity * weight;
    const thin = this.thinMaterial;
    mirror(thin, src);
    thin.color.copy(src.color);
  }
}
