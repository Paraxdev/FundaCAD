// The one look a rotation ring has in the app: a thin whole circle, faint until
// the hand is on it. The ring under the cursor lights and thickens and the
// others step back, so a set of rings reads as one ball rather than a tangle,
// and the one being dragged is the only one left standing.
//
// Modelled in pixels in its local XY plane (its axis is local +Z), so a caller
// orients it and scales it by pixelWorldSize like every other gizmo part.

import * as THREE from "three";

const THIN = 1.1;
const THICK = 2.4;
/** The undrawn band a ring is grabbed by, in pixels either side of the line.
 *  Nobody can reliably hit a 1px torus in 3D. */
export const RING_BAND = 8;
export const RING_IDLE_OPACITY = 0.75;
export const RING_BACK_OPACITY = 0.22;
export const RING_DRAG_BACK_OPACITY = 0.1;
/** Lit ring while it is held, the move gizmo's hot colour. */
export const RING_HELD = 0xffe9a8;

export interface RingLook {
  thick: boolean;
  opacity: number;
  held: boolean;
}

/** How ring `me` looks with `hover` under the cursor and `grab` held (either
 *  may be null, or name something that is not a ring at all). */
export function ringLook<T>(me: T, hover: T | null, grab: T | null, rings: readonly T[]): RingLook {
  const held = grab !== null && rings.includes(grab) ? grab : null;
  const on = held ?? (grab === null && hover !== null && rings.includes(hover) ? hover : null);
  if (on === null) return { thick: false, opacity: RING_IDLE_OPACITY, held: false };
  if (on === me) return { thick: true, opacity: 1, held: held !== null };
  return { thick: false, opacity: held !== null ? RING_DRAG_BACK_OPACITY : RING_BACK_OPACITY, held: false };
}

export interface SlimRing {
  readonly group: THREE.Group;
  /** the grab target, a direct child of `group` */
  readonly band: THREE.Mesh;
  /** the line as drawn now, for measuring what the ring covers */
  readonly drawn: () => THREE.Mesh;
  paint(look: RingLook, color: number): void;
  dispose(): void;
}

export function createSlimRing(radius: number, band = RING_BAND): SlimRing {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    transparent: true, opacity: RING_IDLE_OPACITY, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  });
  const thin = new THREE.Mesh(new THREE.TorusGeometry(radius, THIN, 6, 160), mat);
  const thick = new THREE.Mesh(new THREE.TorusGeometry(radius, THICK, 8, 160), mat);
  thin.renderOrder = 999;
  thick.renderOrder = 1000;
  thick.visible = false;
  const grab = new THREE.Mesh(
    new THREE.TorusGeometry(radius, band, 6, 64),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  group.add(thin, thick, grab);
  return {
    group,
    band: grab,
    drawn: () => (thick.visible ? thick : thin),
    paint(look, color) {
      thin.visible = !look.thick;
      thick.visible = look.thick;
      mat.color.set(look.held ? RING_HELD : color);
      mat.opacity = look.opacity;
    },
    dispose() {
      thin.geometry.dispose();
      thick.geometry.dispose();
      grab.geometry.dispose();
      (grab.material as THREE.Material).dispose();
      mat.dispose();
      group.removeFromParent();
    },
  };
}
