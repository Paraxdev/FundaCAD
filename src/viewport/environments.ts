// The rooms a model reflects, built out of boxes.
//
// A physically-based metal is almost entirely reflection: with nothing around
// it, a copper part renders near black. What it reflects therefore decides most
// of what it looks like, which is why this is a choice and not a constant.
//
// GENERATED, not loaded. The usual way to do this is an HDR photograph of a real
// room, which is a megabyte or two fetched or bundled to make a chamfer shine.
// Everything here is a handful of emissive boxes in a dark room, which is both
// what a photographic studio actually is and about two hundred bytes of code
// per mood. The app fetches nothing at start-up and this keeps that true.
//
// Z-UP, like everything else in this app. The generated cubemap is sampled with
// world-space directions, so a panel placed at +Z lights the model from above.
// (three's own RoomEnvironment is Y-up, which is why the "studio" entry is left
// to it in scene.ts and is not one of these: rebuilding it here to turn it a
// quarter turn would be rewriting a room that already looks right.)
//
// Pure of the app: no store, no settings, no renderer. A caller hands an id and
// gets a scene to run a PMREM pass over.

import * as THREE from "three";
import type { Environment } from "../ui/renderPrefs";

/** One light in a room: where it is, how big, what colour, how bright.
 *  `size` is the panel's full extent, so a big soft light is literally a big
 *  rectangle and a hard one is a small rectangle further away, which is exactly
 *  how it works with real lights. */
interface Panel {
  pos: [number, number, number];
  size: [number, number, number];
  color: number;
  intensity: number;
}

interface RoomSpec {
  /** The walls, as an emissive colour and level. This IS the ambient: a room
   *  with dark walls gives a part a deep, contrasty shading and one with white
   *  walls fills every shadow. */
  wall: number;
  wallIntensity: number;
  panels: Panel[];
}

/** How far the walls are from the origin. Arbitrary, and it has to be: a cubemap
 *  built from the origin records DIRECTIONS, so only the panels' angular size
 *  matters and the absolute scale cancels. Ten is big enough that a panel can be
 *  placed well off-axis without poking through a wall. */
const ROOM = 10;

const SPECS: Record<Exclude<Environment, "studio" | "none">, RoomSpec> = {
  // One big light, high and to the left, in an otherwise black room. The
  // product-photography default: the highlight is a broad soft streak rather
  // than a dot, and every shadow stays dark, so form reads as form.
  softbox: {
    wall: 0x0b0d10,
    wallIntensity: 0.35,
    panels: [
      { pos: [-4, -3, 8], size: [10, 10, 0.2], color: 0xffffff, intensity: 9 },
      { pos: [6, 2, 1], size: [0.2, 8, 8], color: 0xdfe7f2, intensity: 1.1 },
      { pos: [0, 0, -8], size: [14, 14, 0.2], color: 0xffffff, intensity: 0.5 },
    ],
  },
  // A warm key against a cool fill, which is the oldest trick there is for
  // making a grey object look like an object: the lit side and the shaded side
  // differ in hue as well as in level.
  warm: {
    wall: 0x14120f,
    wallIntensity: 0.5,
    panels: [
      { pos: [4, -4, 7], size: [8, 8, 0.2], color: 0xffd9a0, intensity: 7 },
      { pos: [-6, 3, 2], size: [0.2, 9, 9], color: 0x9dbcff, intensity: 1.8 },
      { pos: [0, 0, -8], size: [14, 14, 0.2], color: 0xffe6c4, intensity: 0.4 },
    ],
  },
  // Nearly black, with one hard bright edge behind the part. Everything reads as
  // silhouette and rim, which is what makes a dark plastic housing legible at
  // all: matt black under even light is a hole in the picture.
  dusk: {
    wall: 0x05060a,
    wallIntensity: 0.25,
    panels: [
      { pos: [0, 8, 3], size: [12, 0.2, 6], color: 0xd8e8ff, intensity: 14 },
      { pos: [-3, -6, 5], size: [5, 0.2, 5], color: 0xffc890, intensity: 1.2 },
    ],
  },
  // White walls all round with a brighter ceiling: no shadow anywhere, every
  // face visible. The one to pick when the job is to SHOW the part rather than
  // to flatter it.
  bright: {
    wall: 0xf2f4f7,
    wallIntensity: 1.15,
    panels: [
      { pos: [0, 0, 8], size: [14, 14, 0.2], color: 0xffffff, intensity: 3.4 },
      { pos: [-5, -5, 3], size: [6, 6, 0.2], color: 0xffffff, intensity: 1.2 },
    ],
  },
};

/** Build the room for `id`, ready to run a PMREM pass over.
 *
 *  The caller owns it and should dispose it once the cubemap is generated: the
 *  scene is scaffolding for one render and nothing needs it afterwards. */
export function buildRoom(id: Exclude<Environment, "studio" | "none">): THREE.Scene {
  const spec = SPECS[id];
  const scene = new THREE.Scene();

  // The room itself: a box seen from the inside, which is what BackSide means
  // here. Emissive rather than lit, because there are no lights in this scene at
  // all, every surface in it IS a light and the cubemap simply records them.
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

/** Let go of a room built above. Every geometry and material in it is its own,
 *  so this is exhaustive rather than a best effort. */
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
