// An overlay child of the body, never a vertex tint: tinting the shared colour buffer left a deselected body half
// coloured after a partial restore. Removed whole on deselect, so nothing is left behind.

import * as THREE from "three";
import { themeColor } from "./themeColors";
import { DISPLAY_COLOR_GLSL, displayColorUniforms, followComposer } from "./composerColor";
import { markOverlay } from "./overlayKinds";
import { PICK_ALPHA, type PickKind } from "./pickColors";

// ShaderMaterial prepends cameraPosition, modelMatrix, normal and position. The view vector is per fragment: per
// vertex it bent toward a large plate's far corners, so the plate read as grazing and the rim washed the screen.
const VERT = /* glsl */ `
  #include <clipping_planes_pars_vertex>
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vW = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uFill;
  uniform float uRim;
  uniform float uFade;
  varying vec3 vN;
  varying vec3 vW;
  #include <clipping_planes_pars_fragment>
  void main() {
    #include <clipping_planes_fragment>
    // fresnel: 0 facing the camera, 1 at the grazing silhouette
    vec3 v = isOrthographic
      ? vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2])
      : normalize(cameraPosition - vW);
    float f = pow(1.0 - clamp(dot(normalize(vN), v), 0.0, 1.0), 2.4);
    float a = clamp((uFill + uRim * f) * uFade, 0.0, 1.0);
    gl_FragColor = vec4(displayColor(uColor), a);
  }
`;

/** How hard the two intensities read. Select is the picked one; hover is the
 *  fainter "this is the one under the cursor" that a plain hover shows. */
const INTENSITY = {
  select: { fill: 0.14, rim: 0.85 },
  hover: { fill: 0.06, rim: 0.5 },
} as const;

export type GlowKind = keyof typeof INTENSITY;

// Shared and never disposed by the highlighter: disposing the last material on a program deletes the program, so a
// material per hovered body relinked the shader on every part crossed and made drags stutter on a large assembly.
const GLOW_NAME = "selection-glow";
const materials = new Map<GlowKind, THREE.ShaderMaterial>();
let clipPlanes: THREE.Plane[] | null = null;

/** Clips every glow and the face hover to the section cut (the viewport's own plane array), null for none. */
export function clipSelectionOverlays(planes: THREE.Plane[] | null) {
  clipPlanes = planes;
  for (const mat of materials.values()) mat.clippingPlanes = planes;
  for (const mat of faceMaterials.values()) mat.clippingPlanes = planes;
}

function glowMaterial(kind: GlowKind): THREE.ShaderMaterial {
  let mat = materials.get(kind);
  if (!mat) {
    const { fill, rim } = INTENSITY[kind];
    mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color() },
        uFill: { value: fill },
        uRim: { value: rim },
        uFade: { value: 1 },
        ...displayColorUniforms(),
      },
      vertexShader: VERT,
      fragmentShader: DISPLAY_COLOR_GLSL + FRAG,
      transparent: true,
      // Draw on top of the shaded body without writing depth, so the coincident
      // overlay never z-fights and never occludes the edge lines that sit above it.
      depthWrite: false,
      side: THREE.FrontSide,
      blending: THREE.NormalBlending,
      clipping: true,
      clippingPlanes: clipPlanes,
    });
    mat.name = GLOW_NAME;
    followComposer(mat);
    materials.set(kind, mat);
  }
  (mat.uniforms.uColor!.value as THREE.Color).set(themeColor("--accent", 0x51d6a8));
  return mat;
}

const FACE_OVERLAY_NAME: Record<PickKind, string> = { hover: "face-hover-overlay", select: "face-select-overlay" };
const FACE_OVERLAY_NAMES = new Set(Object.values(FACE_OVERLAY_NAME));

let warmup: THREE.Group | null = null;

/** An off scene mesh per glow kind for linking the glow programs ahead: the low power motion draw goes straight to
 *  the canvas, so a glow first drawn there linked its srgb variant at motion stop (50 to 120 ms on SwiftShader). */
export function selectionGlowWarmup(): THREE.Object3D {
  if (!warmup) {
    warmup = new THREE.Group();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(9), 3));
    for (const kind of Object.keys(INTENSITY) as GlowKind[]) warmup.add(new THREE.Mesh(geo, glowMaterial(kind)));
  }
  return warmup;
}

/** A rebuild reuses an unchanged body's mesh but makes a new Highlighter with no record of the old overlays,
 *  so without this they stay lit. */
export function removeSelectionGlows(mesh: THREE.Object3D) {
  for (let i = mesh.children.length - 1; i >= 0; i--) {
    const c = mesh.children[i]!;
    if (c.name === GLOW_NAME) c.removeFromParent();
    else if (FACE_OVERLAY_NAMES.has(c.name)) disposeFaceHoverOverlay(c as THREE.Mesh);
  }
}

const faceMaterials = new Map<PickKind, THREE.MeshBasicMaterial>();

/** The overlay's geometry is its own copy of the picked triangles; the material is shared and stays. */
export function disposeFaceHoverOverlay(mesh: THREE.Mesh) {
  mesh.removeFromParent();
  mesh.geometry.dispose();
}

/** The picked faces drawn again over the shaded body in their pick colours (pickColors.ts). Path traced draws bodies
 *  as depth only and glass shows little of a vertex tint, so this is what makes a face pick read there. */
export function makeFaceHoverOverlay(positions: Float32Array, colors: Float32Array, kind: PickKind): THREE.Mesh {
  let mat = faceMaterials.get(kind);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: PICK_ALPHA.face[kind],
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      clippingPlanes: clipPlanes,
    });
    faceMaterials.set(kind, mat);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = FACE_OVERLAY_NAME[kind];
  mesh.raycast = () => {};
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 4; // above the glow's 3
  markOverlay(mesh, "highlight");
  return mesh;
}

/** From the projected corners clipped to the screen. A corner behind the camera means the camera is in among
 *  the box, which is the whole view. */
export function screenCoverage(box: THREE.Box3, matrixWorld: THREE.Matrix4, camera: THREE.Camera): number {
  if (box.isEmpty()) return 0;
  const toClip = new THREE.Matrix4()
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    .multiply(matrixWorld);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const p = new THREE.Vector4();
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z, 1).applyMatrix4(
      toClip,
    );
    if (p.w <= 1e-9) return 1;
    minX = Math.min(minX, p.x / p.w);
    maxX = Math.max(maxX, p.x / p.w);
    minY = Math.min(minY, p.y / p.w);
    maxY = Math.max(maxY, p.y / p.w);
  }
  const w = Math.max(0, Math.min(1, maxX) - Math.max(-1, minX));
  const h = Math.max(0, Math.min(1, maxY) - Math.max(-1, minY));
  return (w * h) / 4;
}

/** A body filling the screen is already the one looked at, and at full strength its tint washed the viewport
 *  and every glass panel, hiding the gizmo's handles. */
export function glowFade(coverage: number): number {
  const t = Math.min(1, Math.max(0, (coverage - 0.4) / 0.5));
  return 1 - 0.75 * t * t * (3 - 2 * t);
}

/** Build the overlay mesh for a body: a second draw of its geometry, non-pickable
 *  and shadow-free, in the current theme accent. Not yet added to a parent. */
export function makeSelectionGlow(geometry: THREE.BufferGeometry, kind: GlowKind): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, glowMaterial(kind));
  mesh.name = GLOW_NAME;
  mesh.raycast = () => {}; // never a pick target
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 3; // over the shaded body, under gizmos and other overlays
  markOverlay(mesh, "highlight");
  // Per draw, because the material is shared. Note: three passes the scene's override material during a depth
  // pass, which has no glow uniforms, so that draw is skipped.
  mesh.onBeforeRender = (_r, _s, camera, geo, mat) => {
    if (mat !== mesh.material) return;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const m = mat as THREE.ShaderMaterial;
    m.uniforms.uFade!.value = glowFade(screenCoverage(geo.boundingBox!, mesh.matrixWorld, camera));
    m.uniformsNeedUpdate = true;
  };
  return mesh;
}
