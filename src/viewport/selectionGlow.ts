// A selection highlight drawn as a fresnel overlay, not a vertex tint.
//
// The old whole-body highlight overwrote the body's shared vertex-colour buffer
// with an accent. A later partial restore (a face hover-out repainting only its
// own vertices) could leave the rest of the buffer stuck on the accent: the
// "deselected body that stays half-coloured, one face restored and the rest not"
// bug. An overlay never touches the buffer. It is a second, non-pickable draw of
// the body's own geometry with its own material, added as a CHILD of the body
// mesh so it follows every transform (a move gizmo's live drag included), and
// removed whole on deselect. There is nothing to restore, so nothing is left
// behind.
//
// The look is a rim-lit shell: a faint fill over the visible surface and a bright
// fresnel edge at the silhouette, in the theme accent. It reads as "this one is
// picked" the way a selected part does in a modern modeller, and stays legible
// against a lit grey face and a dark panel alike.

import * as THREE from "three";
import { themeColor } from "./themeColors";

// cameraPosition / modelMatrix / normal / position are all built into a
// THREE.ShaderMaterial (prepended for us), so they are used here undeclared.
// The view vector is formed per fragment from the interpolated world position.
// Normalised per vertex and interpolated, it bent toward the grazing directions
// of a large face's far corners, so a plate filling the view read as grazing
// everywhere and the rim washed the whole screen in the accent.
const VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uFill;
  uniform float uRim;
  uniform float uFade;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    // fresnel: 0 facing the camera, 1 at the grazing silhouette
    vec3 v = isOrthographic
      ? vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2])
      : normalize(cameraPosition - vW);
    float f = pow(1.0 - clamp(dot(normalize(vN), v), 0.0, 1.0), 2.4);
    float a = clamp((uFill + uRim * f) * uFade, 0.0, 1.0);
    gl_FragColor = vec4(uColor, a);
  }
`;

/** How hard the two intensities read. Select is the picked one; hover is the
 *  fainter "this is the one under the cursor" that a plain hover shows. */
const INTENSITY = {
  select: { fill: 0.14, rim: 0.85 },
  hover: { fill: 0.06, rim: 0.5 },
} as const;

export type GlowKind = keyof typeof INTENSITY;

// One material per intensity, shared by every glow and never disposed by the
// highlighter. Disposing the last material that uses a program makes three
// delete the program, so a fresh material per hovered body relinked the shader
// each time the cursor crossed into another part, which is what made a body
// scope material drag stutter on a large assembly. A disposer that does free a
// shared one on teardown is harmless: three re-initialises it on its next use.
const materials = new Map<GlowKind, THREE.ShaderMaterial>();

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
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      // Draw on top of the shaded body without writing depth, so the coincident
      // overlay never z-fights and never occludes the edge lines that sit above it.
      depthWrite: false,
      side: THREE.FrontSide,
      blending: THREE.NormalBlending,
    });
    materials.set(kind, mat);
  }
  (mat.uniforms.uColor!.value as THREE.Color).set(themeColor("--accent", 0x4bf9bc));
  return mat;
}

const GLOW_NAME = "selection-glow";
const FACE_HOVER_NAME = "face-hover-overlay";

/** Take every glow and face hover overlay off a body mesh. A rebuild reuses an
 *  unchanged body's mesh but makes a new Highlighter, which has no record of
 *  the overlays the old one parented there, so without this they stay lit. */
export function removeSelectionGlows(mesh: THREE.Object3D) {
  for (let i = mesh.children.length - 1; i >= 0; i--) {
    const c = mesh.children[i]!;
    if (c.name === GLOW_NAME) c.removeFromParent();
    else if (c.name === FACE_HOVER_NAME) disposeFaceHoverOverlay(c as THREE.Mesh);
  }
}

let faceHoverMaterial: THREE.MeshBasicMaterial | null = null;

/** The face under the cursor on a body that already glows. The vertex tint a
 *  face hover normally paints sits under the glow and barely reads through it,
 *  so the face is drawn again above the glow, opaque enough to be unmistakable. */
/** Take a face hover overlay down for good. Its geometry is its own, a copy of
 *  the hovered triangles; the material is shared and stays. */
export function disposeFaceHoverOverlay(mesh: THREE.Mesh) {
  mesh.removeFromParent();
  mesh.geometry.dispose();
}

export function makeFaceHoverOverlay(positions: Float32Array, color: THREE.Color): THREE.Mesh {
  faceHoverMaterial ??= new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  faceHoverMaterial.color.copy(color);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geo, faceHoverMaterial);
  mesh.name = FACE_HOVER_NAME;
  mesh.raycast = () => {};
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 4; // above the glow's 3
  return mesh;
}

/** How much of the view a box covers, 0 to 1, from its projected corners
 *  clipped to the screen. A corner behind the camera means the camera is in
 *  among it, which is the whole view. */
export function screenCoverage(box: THREE.Box3, matrixWorld: THREE.Matrix4, camera: THREE.Camera): number {
  if (box.isEmpty()) return 0;
  const toClip = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(matrixWorld);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const p = new THREE.Vector4();
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z, 1).applyMatrix4(toClip);
    if (p.w <= 1e-9) return 1;
    minX = Math.min(minX, p.x / p.w); maxX = Math.max(maxX, p.x / p.w);
    minY = Math.min(minY, p.y / p.w); maxY = Math.max(maxY, p.y / p.w);
  }
  const w = Math.max(0, Math.min(1, maxX) - Math.max(-1, minX));
  const h = Math.max(0, Math.min(1, maxY) - Math.max(-1, minY));
  return (w * h) / 4;
}

/** The glow's strength for a body covering `coverage` of the view. A body that
 *  fills the screen is the one being looked at already, and at full strength
 *  its tint was the whole viewport and every glass panel over it, a mint wash
 *  the gizmo's handles disappeared into. */
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
  // Per draw, because the material is shared by every glowing body.
  mesh.onBeforeRender = (_r, _s, camera, geo, mat) => {
    if (!geo.boundingBox) geo.computeBoundingBox();
    const m = mat as THREE.ShaderMaterial;
    m.uniforms.uFade!.value = glowFade(screenCoverage(geo.boundingBox!, mesh.matrixWorld, camera));
    m.uniformsNeedUpdate = true;
  };
  return mesh;
}
