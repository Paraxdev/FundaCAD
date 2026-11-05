// The face a Geometry row lights is drawn again as diagonal stripes in the pick colour, so it never reads as a
// selection, which is a flat tint. The stripes are fixed to the surface, so an orbit carries them with the face.

import * as THREE from "three";
import { markOverlay } from "./overlayKinds";
import { PICK_ALPHA } from "./pickColors";

export const LIT_HATCH_NAME = "face-lit-hatch";

/** `across` stripes span the lit faces' bounding diagonal, each `width` of its period, seen at the select overlay's
 *  opacity so a stripe clears the same contrast floor as a selection. */
export const HATCH = { across: 12, width: 0.3, opacity: PICK_ALPHA.face.select } as const;

// Below about 5px a period would alias into moire, so the stripes fade to their mean cover there.
const FRAGMENT = /* glsl */ `
  float hatchStep = length(vec2(dFdx(vHatch), dFdy(vHatch)));
  float hatchCover = 1.0 - smoothstep(0.5 * HATCH_W - hatchStep, 0.5 * HATCH_W + hatchStep, abs(fract(vHatch) - 0.5));
  diffuseColor.a *= mix(hatchCover, HATCH_W, smoothstep(0.2, 0.33, hatchStep));
  #include <opaque_fragment>`;

let material: THREE.MeshBasicMaterial | null = null;
let clipPlanes: THREE.Plane[] | null = null;

export function clipLitHatch(planes: THREE.Plane[] | null) {
  clipPlanes = planes;
  if (material) material.clippingPlanes = planes;
}

export function litHatchMaterial(): THREE.MeshBasicMaterial {
  if (material) return material;
  const m = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: HATCH.opacity,
    depthTest: true,
    depthWrite: false,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    clippingPlanes: clipPlanes,
  });
  m.name = LIT_HATCH_NAME;
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float hatch;\nvarying float vHatch;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n  vHatch = hatch;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>\nvarying float vHatch;\n#define HATCH_W ${HATCH.width.toFixed(3)}`,
      )
      .replace("#include <opaque_fragment>", FRAGMENT);
  };
  m.customProgramCacheKey = () => LIT_HATCH_NAME;
  return (material = m);
}

/** Each vertex's place across the stripes, in periods. The stripes are the cuts of parallel planes through the surface,
 *  at 45 degrees in the faces' mean plane, which on a curved face still reads as a hatch. */
export function hatchCoords(positions: Float32Array): Float32Array {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const box = new THREE.Box3();
  for (let i = 0; i < positions.length; i += 9) {
    a.fromArray(positions, i);
    b.fromArray(positions, i + 3);
    c.fromArray(positions, i + 6);
    box.expandByPoint(a).expandByPoint(b).expandByPoint(c);
    n.add(b.clone().sub(a).cross(c.clone().sub(a)));
  }
  const dir = new THREE.Vector3(1, 1, 1).normalize();
  // A closed run, a whole cylinder, has no mean plane: any direction cuts it into stripes.
  if (n.lengthSq() > 1e-12) {
    n.normalize();
    const up = Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(n, up).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    dir.copy(u).add(v).normalize();
  }
  const period = Math.max(box.getSize(a).length(), 1e-9) / HATCH.across;
  const out = new Float32Array(positions.length / 3);
  const lo = box.min.dot(dir);
  for (let i = 0; i < out.length; i++) out[i] = (a.fromArray(positions, i * 3).dot(dir) - lo) / period;
  return out;
}

export function makeLitHatchOverlay(positions: Float32Array, colors: Float32Array): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("hatch", new THREE.BufferAttribute(hatchCoords(positions), 1));
  const mesh = new THREE.Mesh(geo, litHatchMaterial());
  mesh.name = LIT_HATCH_NAME;
  mesh.raycast = () => {};
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 5; // above the face overlays' 4
  markOverlay(mesh, "highlight");
  return mesh;
}
