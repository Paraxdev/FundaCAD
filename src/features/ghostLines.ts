import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

type Vec3 = readonly [number, number, number];

export interface GhostSlot {
  readonly points: readonly Vec3[];
  color: number;
  /** first segment in the drawn buffer, -1 while not drawn */
  offset: number;
}

interface Host {
  domElement: HTMLElement;
  addToScene(o: THREE.Object3D): void;
  removeFromScene(o: THREE.Object3D): void;
}

const scratch = new THREE.Color();

/** The members of an edge tool drawn as one wide line in one draw call. One Line2 per member made each frame of a
 *  5,000 member preview twice as slow. Adds and removes take effect on sync(), colours at once. */
export class GhostLines {
  private slots = new Set<GhostSlot>();
  private line: LineSegments2 | null = null;
  private colors: Float32Array | null = null;
  private dirty = false;
  private readonly material = new LineMaterial({
    color: 0xffffff,
    vertexColors: true,
    linewidth: 3.5,
    worldUnits: false,
    depthTest: false,
    transparent: true,
  });

  constructor(private readonly host: Host) {}

  add(points: readonly Vec3[], color: number): GhostSlot {
    const slot: GhostSlot = { points, color, offset: -1 };
    this.slots.add(slot);
    this.dirty = true;
    return slot;
  }

  remove(slot: GhostSlot) {
    if (this.slots.delete(slot)) this.dirty = true;
    slot.offset = -1;
  }

  setColor(slot: GhostSlot, color: number) {
    slot.color = color;
    if (this.dirty || slot.offset < 0 || !this.line) return;
    this.paint(slot);
    const attr = this.line.geometry.getAttribute("instanceColorStart") as THREE.InterleavedBufferAttribute;
    attr.data.needsUpdate = true;
  }

  sync() {
    if (!this.dirty) return;
    this.dirty = false;
    this.detach();
    let segs = 0;
    for (const s of this.slots) segs += Math.max(0, s.points.length - 1);
    if (!segs) {
      for (const s of this.slots) s.offset = -1;
      return;
    }
    const pos = new Float32Array(segs * 6);
    this.colors = new Float32Array(segs * 6);
    let k = 0;
    for (const s of this.slots) {
      s.offset = k;
      const p = s.points;
      for (let i = 1; i < p.length; i++, k++) {
        pos.set(p[i - 1]!, k * 6);
        pos.set(p[i]!, k * 6 + 3);
      }
      this.paint(s);
    }
    const geo = new LineSegmentsGeometry();
    geo.setPositions(pos);
    geo.setColors(this.colors);
    const el = this.host.domElement;
    this.material.resolution.set(el.clientWidth, el.clientHeight);
    this.line = new LineSegments2(geo, this.material);
    this.line.renderOrder = 998;
    this.host.addToScene(this.line);
  }

  dispose() {
    this.detach();
    this.material.dispose();
    for (const s of this.slots) s.offset = -1;
    this.slots.clear();
    this.dirty = false;
  }

  private detach() {
    if (!this.line) return;
    this.host.removeFromScene(this.line);
    this.line.geometry.dispose();
    this.line = null;
    this.colors = null;
  }

  private paint(s: GhostSlot) {
    const col = this.colors!;
    scratch.setHex(s.color);
    const end = s.offset + s.points.length - 1;
    for (let j = s.offset; j < end; j++) {
      col[j * 6] = col[j * 6 + 3] = scratch.r;
      col[j * 6 + 1] = col[j * 6 + 4] = scratch.g;
      col[j * 6 + 2] = col[j * 6 + 5] = scratch.b;
    }
  }
}
