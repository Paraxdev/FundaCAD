// Surface-analysis overlay helpers (display-only, no geometry backend):
//   - a zebra-stripe material for visualizing surface continuity,
//   - curvature combs along edges for visualizing how sharply curves bend,
//   - the interference overlay (translucent overlap solids + clearance lines), and
//   - a small center-of-mass marker.
// All are toggled from the viewport; none touch the document or the kernel.

import * as THREE from "three";
import type { ModelView } from "./render";

/** A reflective zebra material: black/white bands follow the reflected view
 *  vector, so kinks/curvature discontinuities show as broken or bunched stripes.
 *  Uses three's built-in `cameraPosition` uniform, no per-frame updates needed. */
export function makeZebraMaterial(frequency = 7): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uFreq: { value: frequency } },
    side: THREE.DoubleSide,
    // keep edge lines crisp on top, matching the standard model material
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vP;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vP = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uFreq;
      varying vec3 vN;
      varying vec3 vP;
      void main() {
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vP);
        vec3 R = reflect(-V, N);
        float band = step(0.5, fract(R.z * uFreq));
        vec3 col = mix(vec3(0.06), vec3(0.93), band);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

/** Build a curvature-comb overlay for every edge of the model: at each interior
 *  polyline vertex, a "hair" points to the concave side with length proportional
 *  to the discrete (Menger) curvature, and the hair tips are joined into a comb
 *  envelope. Straight edges produce no hairs. Returns null if nothing is curved. */
export function buildCurvatureCombs(view: ModelView, box: THREE.Box3): THREE.LineSegments | null {
  type Hair = { base: THREE.Vector3; dir: THREE.Vector3; k: number };
  const hairsByEdge: Hair[][] = [];
  let maxK = 0;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();

  for (const line of view.edges) {
    const pts = line.points as [number, number, number][] | undefined;
    if (!pts || pts.length < 3) continue;
    const hairs: Hair[] = [];
    for (let i = 1; i < pts.length - 1; i++) {
      const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
      if (!p0 || !p1 || !p2) continue;
      a.set(...p0);
      b.set(...p1);
      c.set(...p2);
      const la = e1.subVectors(b, a).length();
      const lc = e2.subVectors(c, b).length();
      const lb = a.distanceTo(c);
      if (la < 1e-6 || lc < 1e-6 || lb < 1e-6) continue;
      // Menger curvature κ = 4·Area / (la·lb·lc)
      const area = 0.5 * e1.subVectors(b, a).cross(e2.subVectors(c, a)).length();
      const k = (4 * area) / (la * lb * lc);
      if (!isFinite(k) || k < 1e-5) continue;
      // concave direction ≈ from the vertex toward the chord midpoint
      const mid = a.clone().add(c).multiplyScalar(0.5);
      const dir = mid.sub(b).normalize();
      hairs.push({ base: b.clone(), dir, k });
      if (k > maxK) maxK = k;
    }
    if (hairs.length) hairsByEdge.push(hairs);
  }

  if (!hairsByEdge.length || maxK <= 0) return null;

  // scale so the sharpest hair is ~12% of the model's diagonal
  const diag = box.getSize(new THREE.Vector3()).length() || 1;
  const scale = (0.12 * diag) / maxK;

  const positions: number[] = [];
  for (const hairs of hairsByEdge) {
    let prevTip: THREE.Vector3 | null = null;
    for (const h of hairs) {
      const tip = h.base.clone().addScaledVector(h.dir, h.k * scale);
      positions.push(h.base.x, h.base.y, h.base.z, tip.x, tip.y, tip.z); // the hair
      if (prevTip) positions.push(prevTip.x, prevTip.y, prevTip.z, tip.x, tip.y, tip.z); // envelope
      prevTip = tip;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0xff4fd8, depthTest: true, transparent: true, opacity: 0.9 });
  const seg = new THREE.LineSegments(geo, mat);
  seg.renderOrder = 3;
  return seg;
}

/** One overlap solid's mesh, red and translucent so it reads as "this volume
 *  clashes" while the parts around it stay visible. `depthWrite: false` is
 *  what keeps two overlapping overlays (or the overlay over the model) from
 *  fighting the z-buffer into a flicker. */
export function buildClashMesh(positions: number[], indices: number[]): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff2d2d,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 500;
  return mesh;
}

/** The short marker line between a clearance pair's two nearest points. */
export function buildClearanceLine(pointA: THREE.Vector3, pointB: THREE.Vector3): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints([pointA, pointB]);
  const mat = new THREE.LineBasicMaterial({ color: 0xffc24a, depthTest: false, transparent: true, opacity: 0.95 });
  const line = new THREE.Line(geo, mat);
  line.renderOrder = 999;
  return line;
}

/** A small sphere at a body's center of mass. Sized off the model diagonal so
 *  it reads at any part scale instead of vanishing on a tiny print or
 *  swallowing a huge one. */
export function buildComMarker(point: THREE.Vector3, modelDiag: number): THREE.Mesh {
  const r = Math.max(modelDiag * 0.012, 0.4);
  const geo = new THREE.SphereGeometry(r, 16, 12);
  const mat = new THREE.MeshBasicMaterial({ color: 0x4ac6ff, depthTest: false, transparent: true, opacity: 0.9 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(point);
  mesh.renderOrder = 999;
  return mesh;
}

/** Dispose + detach a list of overlay Object3Ds built by the helpers above. */
export function clearOverlayObjects(objs: THREE.Object3D[]) {
  for (const o of objs) {
    o.removeFromParent();
    const mesh = o as THREE.Mesh | THREE.Line;
    mesh.geometry?.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  }
}
