// Display only analysis overlays, none touch the document or the kernel.

import * as THREE from "three";
import type { ModelView } from "./render";
import { copyPatches } from "./shaderPatches";
import { DISPLAY_COLOR_GLSL, displayColorUniforms, followComposer } from "./composerColor";
import { ZEBRA_LAMBDA, type ZebraDirection, zebraFrame } from "./zebraStripes";

export interface ZebraSettings {
  direction: ZebraDirection;
  width: number;
}

/** Stripes from zebraStripeCoord in view space, so they stay fixed to the view while the model turns
 *  and bend with curvature. fitZebraMaterial sets the frame from the model box. */
export function makeZebraMaterial(): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uDirection: { value: 0 },
      uPeriod: { value: 1 },
      uReach: { value: 1 },
      uCenter: { value: new THREE.Vector3() },
      ...displayColorUniforms(),
    },
    side: THREE.DoubleSide,
    // keep edge lines crisp on top, matching the standard model material
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    vertexShader: /* glsl */ `
      uniform vec3 uCenter;
      varying vec3 vN;
      varying vec3 vD;
      void main() {
        vN = normalMatrix * normal;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vD = mat3(viewMatrix) * (wp.xyz - uCenter);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader:
      DISPLAY_COLOR_GLSL +
      /* glsl */ `
      uniform float uDirection;
      uniform float uPeriod;
      uniform float uReach;
      varying vec3 vN;
      varying vec3 vD;
      float bandIntegral(float x) {
        return floor(x) * 0.5 + max(fract(x) - 0.5, 0.0);
      }
      void main() {
        vec3 N = normalize(vN);
        vec3 R = reflect(vec3(0.0, 0.0, -1.0), N);
        vec3 a = uDirection > 0.5 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
        float u = dot(vD, a) + dot(R, a) * (uReach - ${ZEBRA_LAMBDA.toFixed(4)} * dot(vD, R));
        float s = u / uPeriod;
        float w = max(fwidth(s), 1e-4);
        float band = (bandIntegral(s + 0.5 * w) - bandIntegral(s - 0.5 * w)) / w;
        // under about 2 px a stripe can only alias, so it fades to the mean
        band = mix(band, 0.5, smoothstep(0.2, 0.45, w));
        vec3 col = mix(vec3(0.06), vec3(0.93), band);
        gl_FragColor = vec4(displayColor(col), 1.0);
      }`,
  });
  followComposer(mat);
  return mat;
}

export function fitZebraMaterial(mat: THREE.ShaderMaterial, box: THREE.Box3, settings: ZebraSettings): void {
  const u = mat.uniforms as Record<"uDirection" | "uPeriod" | "uReach" | "uCenter", THREE.IUniform>;
  u.uDirection.value = settings.direction === "vertical" ? 1 : 0;
  if (box.isEmpty()) return;
  const f = zebraFrame(box.min.toArray(), box.max.toArray(), settings.width);
  (u.uCenter.value as THREE.Vector3).set(...f.centre);
  u.uReach.value = f.reach;
  u.uPeriod.value = f.period;
}

/** At each interior polyline vertex a hair points to the concave side, as long as the Menger
 *  curvature, and the tips are joined into a comb. Null if nothing is curved. */
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
      const p0 = pts[i - 1],
        p1 = pts[i],
        p2 = pts[i + 1];
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

/** `depthWrite: false` keeps two overlapping overlays, or the overlay over the model, from
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

/** The stress result's surface, one sRGB colour per vertex (`colors`, three
 *  per vertex). Lit and flat shaded, so the part keeps its shape under the
 *  colours; it stands in for the body, which the viewport hides meanwhile. */
export function buildStressMesh(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  colors: Float32Array,
): THREE.Mesh {
  const geo = stressSurfaceGeometry(positions, indices);
  // The ramp is authored in sRGB; vertex colours are read as linear.
  const lin = new Float32Array(colors.length);
  const c = new THREE.Color();
  for (let i = 0; i + 2 < colors.length; i += 3) {
    c.setRGB(colors[i]!, colors[i + 1]!, colors[i + 2]!, THREE.SRGBColorSpace);
    lin[i] = c.r;
    lin[i + 1] = c.g;
    lin[i + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(lin, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.85,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.raycast = () => {};
  return mesh;
}

/** `count` vertex colours of `c` in sRGB, as buildStressMesh takes them. */
export function solidColors(count: number, c: THREE.Color): Float32Array {
  const { r, g, b } = c.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) out.set([r, g, b], i * 3);
  return out;
}

export function stressSurfaceGeometry(positions: ArrayLike<number>, indices: ArrayLike<number>): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  // Shared with the drawn surface, which nothing writes after it is made.
  geo.setIndex(indices instanceof Uint32Array ? new THREE.BufferAttribute(indices, 1) : Array.from(indices));
  return geo;
}

/** The body's own material for the stress surface drawn without its colours, a copy since the overlay disposes it;
 *  null when the body has no lit material to copy. */
export function plainStressMaterial(material: THREE.Material | THREE.Material[] | undefined): THREE.Material | null {
  const m = Array.isArray(material) ? material[0] : material;
  if (!(m instanceof THREE.MeshStandardMaterial)) return null;
  const copy = m.clone();
  // The glass patch reads a thickness drawn for the body's own mesh.
  copyPatches(m, copy, (p) => p.name !== "glassAuto");
  copy.side = THREE.DoubleSide;
  // The surface shares its vertices across sharp edges, so smooth normals would bend the light over every face.
  copy.flatShading = true;
  return copy;
}

/** A translucent tint over a set of faces (world-space triangles, nine numbers
 *  each), for the faces an analysis holds or loads. */
export function buildFaceMarkMesh(positions: Float32Array, color: number): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.raycast = () => {};
  mesh.renderOrder = 6;
  return mesh;
}

export function buildClearanceLine(pointA: THREE.Vector3, pointB: THREE.Vector3): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints([pointA, pointB]);
  const mat = new THREE.LineBasicMaterial({ color: 0xffc24a, depthTest: false, transparent: true, opacity: 0.95 });
  const line = new THREE.Line(geo, mat);
  line.renderOrder = 999;
  return line;
}

/** Sized off the model diagonal so it reads at any part scale. */
export function buildComMarker(point: THREE.Vector3, modelDiag: number): THREE.Mesh {
  const r = Math.max(modelDiag * 0.012, 0.4);
  const geo = new THREE.SphereGeometry(r, 16, 12);
  const mat = new THREE.MeshBasicMaterial({ color: 0x4ac6ff, depthTest: false, transparent: true, opacity: 0.9 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(point);
  mesh.renderOrder = 999;
  return mesh;
}

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
