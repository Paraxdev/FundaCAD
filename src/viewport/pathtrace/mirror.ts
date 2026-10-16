// The traced copy of the visible bodies. Each mirror mesh shares the viewport's
// position and normal buffers but owns its index: the tracer's BVH build
// reorders the index in place and hangs `boundsTree` on the geometry, and
// neither may land on the geometry the viewport draws and picks with.

import * as THREE from "three";

/** setScene is synchronous on the main thread (58 ms for 25k triangles), so
 *  P1 refuses past this and says so. */
export const TRIANGLE_BUDGET = 2_000_000;

interface Owned { baseColors?: Float32Array }

export function isTracedBody(o: THREE.Object3D): o is THREE.Mesh {
  return (o as THREE.Mesh).isMesh === true && !!o.userData.owner && o.visible;
}

function physicalFrom(src: THREE.Material, vertexColors: boolean): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({ vertexColors });
  const s = src as Partial<THREE.MeshPhysicalMaterial>;
  if (s.color) m.color.copy(s.color);
  if (s.emissive) m.emissive.copy(s.emissive);
  m.emissiveIntensity = s.emissiveIntensity ?? 1;
  m.metalness = s.metalness ?? 0;
  m.roughness = s.roughness ?? 0.5;
  m.transmission = s.transmission ?? 0;
  m.ior = s.ior ?? 1.5;
  m.thickness = s.thickness ?? 0;
  m.clearcoat = s.clearcoat ?? 0;
  m.clearcoatRoughness = s.clearcoatRoughness ?? 0;
  m.opacity = src.opacity;
  m.transparent = src.transparent;
  m.side = src.side;
  return m;
}

export function mirrorBody(src: THREE.Mesh): THREE.Mesh {
  const g = src.geometry;
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", g.getAttribute("position"));
  const normal = g.getAttribute("normal");
  if (normal) out.setAttribute("normal", normal);
  if (g.index) out.setIndex(new THREE.BufferAttribute((g.index.array as Uint32Array).slice(), 1));
  for (const gr of g.groups) out.addGroup(gr.start, gr.count, gr.materialIndex);
  const base = (src.userData.owner as Owned).baseColors;
  const count = g.getAttribute("position").count;
  const colors = !!base && base.length === count * 3;
  if (colors) out.setAttribute("color", new THREE.BufferAttribute(base.slice(), 3));
  const mat = Array.isArray(src.material)
    ? src.material.map((m) => physicalFrom(m, colors))
    : physicalFrom(src.material, colors);
  const m = new THREE.Mesh(out, mat);
  src.updateWorldMatrix(true, false);
  m.matrixAutoUpdate = false;
  m.matrix.copy(src.matrixWorld);
  m.matrixWorld.copy(src.matrixWorld);
  return m;
}

export function countTriangles(bodies: THREE.Mesh[]): number {
  let n = 0;
  for (const m of bodies) {
    const g = m.geometry;
    n += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
  }
  return n;
}

export function collectBodies(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverseVisible((o) => {
    if (isTracedBody(o)) out.push(o);
  });
  return out;
}

export function mirrorBodies(bodies: THREE.Mesh[]): THREE.Mesh[] {
  return bodies.map(mirrorBody);
}

function sampleSum(a: ArrayLike<number> | undefined): number {
  if (!a || a.length === 0) return 0;
  let s = a.length;
  const step = Math.max(1, Math.floor(a.length / 64));
  for (let i = 0; i < a.length; i += step) s = (s * 31 + a[i]! * 1000) % 1e9;
  return s;
}

function materialKey(m: THREE.Material): string {
  const s = m as Partial<THREE.MeshPhysicalMaterial>;
  return [
    m.uuid, m.version, s.color?.getHex(), s.emissive?.getHex(), s.emissiveIntensity, s.metalness, s.roughness,
    s.transmission, s.clearcoat, m.opacity,
  ].join(".");
}

/** Changes when what the tracer would see changes, and not on a hover: hover
 *  tints the vertex colour buffer, the mirror reads the base colours. */
export function sceneSignature(bodies: THREE.Mesh[]): string {
  const parts: string[] = [];
  for (const b of bodies) {
    const g = b.geometry;
    const mats = Array.isArray(b.material) ? b.material : [b.material];
    b.updateWorldMatrix(true, false);
    parts.push([
      b.id, g.id, (g.getAttribute("position") as THREE.BufferAttribute).version ?? 0, g.index?.version ?? -1,
      mats.map(materialKey).join("+"),
      sampleSum(b.matrixWorld.elements),
      sampleSum((b.userData.owner as Owned).baseColors),
    ].join(":"));
  }
  return parts.join("|");
}
