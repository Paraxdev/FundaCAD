// The rooms a model reflects, generated from emissive boxes rather than loaded from HDRs, so start-up fetches nothing.
// Z up, sampled in world directions; three's Y up RoomEnvironment stays the "studio" entry in scene.ts.

import * as THREE from "three";
import type { Environment } from "../ui/renderPrefs";

/** `size` is the panel's full extent: a soft light is a big rectangle, a hard one a small one further away. */
interface Panel {
  pos: [number, number, number];
  size: [number, number, number];
  color: number;
  intensity: number;
}

interface RoomSpec {
  /** The walls' emissive level, which is the ambient: dark walls give deep shading, white walls fill every shadow. */
  wall: number;
  wallIntensity: number;
  panels: Panel[];
}

/** Arbitrary: a cubemap built from the origin records directions, so only the panels' angular size matters. */
const ROOM = 10;

const SPECS: Record<Exclude<Environment, "studio" | "none">, RoomSpec> = {
  // One big soft light high to the left in a black room, the product photography default.
  softbox: {
    wall: 0x0b0d10,
    wallIntensity: 0.35,
    panels: [
      { pos: [-4, -3, 8], size: [10, 10, 0.2], color: 0xffffff, intensity: 9 },
      { pos: [6, 2, 1], size: [0.2, 8, 8], color: 0xdfe7f2, intensity: 1.1 },
      { pos: [0, 0, -8], size: [14, 14, 0.2], color: 0xffffff, intensity: 0.5 },
    ],
  },
  // A warm key against a cool fill, so the lit and shaded sides differ in hue as well as level.
  warm: {
    wall: 0x14120f,
    wallIntensity: 0.5,
    panels: [
      { pos: [4, -4, 7], size: [8, 8, 0.2], color: 0xffd9a0, intensity: 7 },
      { pos: [-6, 3, 2], size: [0.2, 9, 9], color: 0x9dbcff, intensity: 1.8 },
      { pos: [0, 0, -8], size: [14, 14, 0.2], color: 0xffe6c4, intensity: 0.4 },
    ],
  },
  // Nearly black with one hard rim light behind, which keeps a dark plastic housing legible.
  dusk: {
    wall: 0x05060a,
    wallIntensity: 0.25,
    panels: [
      { pos: [0, 8, 3], size: [12, 0.2, 6], color: 0xd8e8ff, intensity: 14 },
      { pos: [-3, -6, 5], size: [5, 0.2, 5], color: 0xffc890, intensity: 1.2 },
    ],
  },
  // White walls and a brighter ceiling, no shadow anywhere: shows the part rather than flattering it.
  bright: {
    wall: 0xf2f4f7,
    wallIntensity: 1.15,
    panels: [
      { pos: [0, 0, 8], size: [14, 14, 0.2], color: 0xffffff, intensity: 3.4 },
      { pos: [-5, -5, 3], size: [6, 6, 0.2], color: 0xffffff, intensity: 1.2 },
    ],
  },
};

/** The caller disposes it once the cubemap is generated. */
export function buildRoom(id: Exclude<Environment, "studio" | "none">): THREE.Scene {
  const spec = SPECS[id];
  const scene = new THREE.Scene();

  // Seen from inside (BackSide) and emissive: there are no lights in this scene, every surface is one.
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(ROOM * 2, ROOM * 2, ROOM * 2),
    new THREE.MeshStandardMaterial({
      side: THREE.BackSide,
      color: 0x000000,
      emissive: spec.wall,
      emissiveIntensity: spec.wallIntensity,
    }),
  );
  scene.add(shell);

  for (const p of spec.panels) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(p.size[0], p.size[1], p.size[2]),
      new THREE.MeshStandardMaterial({
        color: 0x000000,
        emissive: p.color,
        emissiveIntensity: p.intensity,
      }),
    );
    mesh.position.set(p.pos[0], p.pos[1], p.pos[2]);
    scene.add(mesh);
  }
  return scene;
}

/** Every geometry and material in the room is its own, so nothing shared is freed. */
export function disposeRoom(scene: THREE.Scene): void {
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) for (const x of mat) x.dispose();
    else mat.dispose();
  });
}
