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
const VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uFill;
  uniform float uRim;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    // fresnel: 0 facing the camera, 1 at the grazing silhouette
    float f = pow(1.0 - clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0), 2.4);
    float a = clamp(uFill + uRim * f, 0.0, 1.0);
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

/** Build the overlay mesh for a body: a second draw of its geometry, non-pickable
 *  and shadow-free, in the current theme accent. Not yet added to a parent. */
export function makeSelectionGlow(geometry: THREE.BufferGeometry, kind: GlowKind): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, glowMaterial(kind));
  mesh.name = "selection-glow";
  mesh.raycast = () => {}; // never a pick target
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 3; // over the shaded body, under gizmos and other overlays
  return mesh;
}
