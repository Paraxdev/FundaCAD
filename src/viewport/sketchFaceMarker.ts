// The face a sketch is being drawn on, marked over the dimmed model.

import * as THREE from "three";
import { themeColor } from "./themeColors";

/** Added white, not an accent wash: a tint made the face and its part one
 *  coloured ghost, and the outline already says which face it is. */
const SKETCH_FACE_LIFT = 0.14;

export function buildFaceMarker(tris: readonly THREE.Triangle[]): THREE.Group {
  const pos = new Float32Array(tris.length * 9);
  let i = 0;
  for (const t of tris) {
    for (const v of [t.a, t.b, t.c]) {
      pos[i++] = v.x;
      pos[i++] = v.y;
      pos[i++] = v.z;
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const group = new THREE.Group();
  group.renderOrder = 2; // over the dimmed model, under the sketch's own glyphs
  // polygonOffset, not a lift along the normal: a lift big enough to beat
  // z-fighting shows as a floating skin at a grazing angle.
  const fill = new THREE.Mesh(
    geom,
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: SKETCH_FACE_LIFT,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    }),
  );
  group.add(fill);
  // A flat face's triangles are coplanar, so the angle threshold leaves only the boundary.
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(geom, 1),
    new THREE.LineBasicMaterial({ color: themeColor("--accent", 0xff7a3c), transparent: true, opacity: 0.85, depthTest: false }),
  );
  outline.renderOrder = 3;
  group.add(outline);
  return group;
}

export function disposeFaceMarker(group: THREE.Group) {
  for (const c of group.children) {
    const o = c as THREE.Mesh | THREE.LineSegments;
    o.geometry.dispose();
    (o.material as THREE.Material).dispose();
  }
}
