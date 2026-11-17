import * as THREE from "three";
import { GhostLines, type GhostSlot } from "./ghostLines";
import { edgeSelectColor } from "../viewport/highlight";
import { themeColor } from "../viewport/themeColors";
import type { WorldRegion } from "../sketch/overlay";
import type { Polyline, SweepRing, V3 } from "./sweepOutline";

interface Host {
  domElement: HTMLElement;
  addToScene(o: THREE.Object3D): void;
  removeFromScene(o: THREE.Object3D): void;
  requestRender?(): void;
}

export const OUTLINE_PX = 1.8;
export const THROUGH_OPACITY = 0.35;
export const THROUGH_OPACITY_CUT = 0.6;

function signedArea(loop: readonly THREE.Vector2[]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i]!;
    const q = loop[(i + 1) % loop.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** The profile loops in world space, outer ones counter clockwise about the plane normal and holes clockwise, which
 *  is the order sweepPolylines reads a hole by. */
export function regionRings(regions: readonly Pick<WorldRegion, "region" | "plane">[]): SweepRing[] {
  const out: SweepRing[] = [];
  for (const { region, plane } of regions) {
    const ring = (loop: readonly THREE.Vector2[], hole: boolean): SweepRing => {
      const flip = signedArea(loop) < 0 !== hole;
      const ordered = flip ? [...loop].reverse() : loop;
      return {
        points: ordered.map((p): V3 => {
          const q = plane.to3D(p.x, p.y);
          return [q.x, q.y, q.z];
        }),
      };
    };
    out.push(ring(region.loop, false));
    for (const h of region.holes) out.push(ring(h, true));
  }
  return out;
}

/** The outline of what a tool adds or removes, drawn over the opaque body: a full line where the body does not hide
 *  it and a faint one through the body. Never picked, a click lands on what is behind it. */
export class ToolOutline {
  private readonly host: Host;
  private front: GhostLines | null = null;
  private through: GhostLines | null = null;
  private slots: { front: GhostSlot; through: GhostSlot }[] = [];
  private cutMode: boolean | null = null;
  private hex = 0;

  constructor(host: Host) {
    this.host = {
      domElement: host.domElement,
      addToScene: (o) => {
        // Line2 has its own raycast, which would make the outline pickable
        o.raycast = () => {};
        host.addToScene(o);
      },
      removeFromScene: (o) => host.removeFromScene(o),
      ...(host.requestRender ? { requestRender: () => host.requestRender!() } : {}),
    };
  }

  /** Segments in the front pass, 0 while hidden. */
  get segments(): number {
    return this.slots.reduce((n, s) => n + Math.max(0, s.front.points.length - 1), 0);
  }

  get color(): number {
    return this.hex;
  }

  /** The accent for an add, the error colour for a cut. Read again on every call so a theme switch repaints. */
  show(polylines: readonly Polyline[], opts: { cut: boolean }) {
    if (!polylines.length) {
      this.hide();
      return;
    }
    if (this.cutMode !== opts.cut) this.build(opts.cut);
    this.hex = opts.cut ? themeColor("--error", 0xe23b3b) : edgeSelectColor();
    this.clearSlots();
    for (const p of polylines) {
      this.slots.push({ front: this.front!.add(p, this.hex), through: this.through!.add(p, this.hex) });
    }
    this.front!.sync();
    this.through!.sync();
    this.host.requestRender?.();
  }

  hide() {
    if (!this.front) return;
    this.clearSlots();
    this.front.sync();
    this.through!.sync();
    this.host.requestRender?.();
  }

  dispose() {
    this.front?.dispose();
    this.through?.dispose();
    this.front = this.through = null;
    this.slots = [];
    this.cutMode = null;
    this.hex = 0;
  }

  private clearSlots() {
    for (const s of this.slots) {
      this.front!.remove(s.front);
      this.through!.remove(s.through);
    }
    this.slots = [];
  }

  // The through pass has a fixed opacity, so a switch between add and cut builds it again.
  private build(cut: boolean) {
    this.dispose();
    this.front = new GhostLines(this.host, { width: OUTLINE_PX, opacity: 1, depthTest: true });
    this.through = new GhostLines(this.host, {
      width: OUTLINE_PX,
      opacity: cut ? THROUGH_OPACITY_CUT : THROUGH_OPACITY,
      depthTest: false,
    });
    this.cutMode = cut;
  }
}
