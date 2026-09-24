// The world origin marker: three thin axis lines and a neutral dot, held at a
// constant size on screen.
//
// A reference, never a handle. It used to be three shaded arrows with cones in
// the same red, green and blue as the Move gizmo, and a user took it for a Move
// gizmo left behind. So nothing here looks grabbable: hairlines that fade out
// towards their ends rather than pointing, colours pulled towards grey, all of
// it translucent and drawn below every manipulator. Nothing raycasts it except
// Revolve's axis pick (features/featureStarters.ts), which asks for it by name.

import * as THREE from "three";
import { glyphWorldScale } from "./gizmoScale";
import { EDGE_HOVER_COLOR } from "./highlight";
import { themeColor } from "./themeColors";
import type { Axis3 } from "../types";

/** The one axis-to-colour table in the scene. RGB for XYZ is the convention
 *  every CAD package draws, so it is hard-coded rather than themed: a theme that
 *  recoloured the axes would be lying about which one is which. */
export const AXIS_COLOR = { x: 0xff5a5a, y: 0x46d97a, z: 0x4d8dff } as const;

/** Arm length in screen pixels, scaled by the world size of a pixel every frame
 *  like every manipulator in features/. */
export const TRIAD_LENGTH_PX = 64;

/** How far the marker may shrink when the model itself is small on screen. */
export const MIN_TRIAD_SCALE = 0.3;

const LINE_RADIUS_PX = 0.85;
const DOT_RADIUS_PX = 2.6;
/** Revolve's axis pick still aims at the arms, and a 1px line is not aimable,
 *  so each arm carries an undrawn sleeve. */
const SLEEVE_RADIUS_PX = 6.5;

export const TRIAD_OPACITY = 0.8;
/** The part of an arm inside the model, faint but there, so the origin is still
 *  findable inside a primitive centred on it. */
export const TRIAD_OCCLUDED_OPACITY = 0.2;
/** Alpha at an arm's far end, as a share of its root's. */
const TIP_FADE = 0.2;
/** How far an axis colour is pulled towards its own grey. */
export const AXIS_MUTE = 0.3;

/** Above the model (0) so the ghost pass paints over it, below the manipulators
 *  at 998-999 so the marker never covers a handle. */
const GHOST_ORDER = 1;
const SOLID_ORDER = 2;

/** `hex` pulled `amount` of the way to the grey of the same luminance. */
export function mutedAxisColor(hex: number, amount = AXIS_MUTE): number {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const mix = (c: number) => Math.round(c + (y - c) * amount);
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

/** A thin cylinder along +Y from 0 to `len`, its alpha falling from 1 at the
 *  root to TIP_FADE at the end. */
function fadingLine(len: number): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(LINE_RADIUS_PX, LINE_RADIUS_PX, len, 8, 6, true);
  geo.translate(0, len / 2, 0);
  const pos = geo.getAttribute("position");
  const rgba = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / len;
    rgba.set([1, 1, 1, 1 - (1 - TIP_FADE) * t], i * 4);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(rgba, 4));
  return geo;
}

export class OriginTriad {
  readonly group = new THREE.Group();
  /** The three arms, each tagged with the axis it stands for, for Revolve's
   *  axis pick to raycast and read `userData.axis` from. */
  readonly arms: THREE.Object3D[] = [];
  private readonly dotMats: THREE.MeshBasicMaterial[] = [];
  private materials: THREE.Material[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private repaint: ((hot: boolean) => void)[] = [];

  constructor(scene: THREE.Scene) {
    const len = TRIAD_LENGTH_PX;
    const dirs: [THREE.Vector3, number, Axis3][] = [
      [new THREE.Vector3(1, 0, 0), AXIS_COLOR.x, "X"],
      [new THREE.Vector3(0, 1, 0), AXIS_COLOR.y, "Y"],
      [new THREE.Vector3(0, 0, 1), AXIS_COLOR.z, "Z"],
    ];
    const lineGeo = fadingLine(len);
    const sleeveGeo = new THREE.CylinderGeometry(SLEEVE_RADIUS_PX, SLEEVE_RADIUS_PX, len, 8);
    const dotGeo = new THREE.SphereGeometry(DOT_RADIUS_PX, 12, 8);
    this.geometries.push(lineGeo, sleeveGeo, dotGeo);
    // `material.visible = false` keeps the sleeve out of the render list but in
    // the raycast, which `object.visible` would not.
    const sleeveMat = new THREE.MeshBasicMaterial({ visible: false });
    this.materials.push(sleeveMat);
    for (const [dir, axisColor, axis] of dirs) {
      const color = mutedAxisColor(axisColor);
      const solid = new THREE.MeshBasicMaterial({
        color, vertexColors: true, transparent: true, opacity: TRIAD_OPACITY, depthWrite: false,
      });
      const ghost = new THREE.MeshBasicMaterial({
        color, vertexColors: true, transparent: true, opacity: TRIAD_OCCLUDED_OPACITY,
        depthTest: false, depthWrite: false,
      });
      this.materials.push(solid, ghost);
      const arm = new THREE.Group();
      for (const [mat, order] of [[ghost, GHOST_ORDER], [solid, SOLID_ORDER]] as const) {
        const line = new THREE.Mesh(lineGeo, mat);
        line.renderOrder = order;
        arm.add(line);
      }
      const sleeve = new THREE.Mesh(sleeveGeo, sleeveMat);
      sleeve.position.y = len / 2;
      arm.add(sleeve);
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      arm.userData.axis = axis;
      this.group.add(arm);
      this.arms.push(arm);
      this.repaint.push((hot) => {
        solid.color.setHex(hot ? EDGE_HOVER_COLOR : color);
        ghost.color.setHex(hot ? EDGE_HOVER_COLOR : color);
        solid.opacity = hot ? 1 : TRIAD_OPACITY;
      });
    }
    for (const [depthTest, opacity, order] of [
      [false, TRIAD_OCCLUDED_OPACITY, GHOST_ORDER],
      [true, TRIAD_OPACITY, SOLID_ORDER],
    ] as const) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity, depthTest, depthWrite: false });
      const dot = new THREE.Mesh(dotGeo, mat);
      dot.renderOrder = order;
      this.dotMats.push(mat);
      this.materials.push(mat);
      this.group.add(dot);
    }
    this.applyTheme();
    scene.add(this.group);
  }

  /** The dot is the one themed part, the axis colours are fixed on purpose. */
  applyTheme() {
    const c = themeColor("--text-mute", 0x7d7590);
    for (const m of this.dotMats) m.color.setHex(c);
  }

  /** Light the arm standing for `axis`, or put all three back. Only Revolve's
   *  axis pick calls this, in the colour an edge takes under the cursor, since
   *  an arm and an edge are the two things that pick can take. */
  highlight(axis: Axis3 | null) {
    this.arms.forEach((arm, i) => this.repaint[i]?.(arm.userData.axis === axis));
  }

  /** `pixelWorldSize` is the world size of one screen pixel AT THE ORIGIN. */
  update(pixelWorldSize: number | null, modelDiagonal: number | null) {
    this.group.scale.setScalar(
      glyphWorldScale(TRIAD_LENGTH_PX, modelDiagonal, pixelWorldSize, MIN_TRIAD_SCALE),
    );
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
