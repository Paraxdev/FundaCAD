// The stress overlay's colours and its deformed shape are separate: plain and still leaves the body on show to pick.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Viewport } from "../../src/viewport/viewport";

const POSITIONS = [13.5, -7.25, 4.1, 100, 0, 0, 2, 10, 0.5];
const BASE = {
  bodyId: "b1",
  positions: POSITIONS,
  indices: [0, 1, 2],
  values: [1, 4, 2],
  range: { min: 1, max: 4 },
};
const BENT = { displacement: [0, 0, 0, 0.25, 0, -2, 0, 0.5, -1], scale: 2 };
const W: [number, number, number] = [0.2, 0.3, 0.5];

function view() {
  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.8, 0.4, 0.2, "srgb") });
  const body = { id: "b1", mesh: new THREE.Mesh(new THREE.BufferGeometry(), material), edges: { setBodyVisible() {} } };
  const vp = Object.create(Viewport.prototype) as Viewport;
  Object.assign(vp, {
    model: { bodies: [body] },
    scene: { scene },
    stressMesh: null,
    stressRest: null,
    stressShape: null,
    stressHidden: null,
    stressBody: null,
    stressListeners: new Set(),
    requestRender: () => {},
  });
  const drawn = () => scene.children.filter((o) => o instanceof THREE.Mesh) as THREE.Mesh[];
  const state = () => {
    const mesh = drawn()[0];
    const mat = mesh?.material as THREE.MeshStandardMaterial | undefined;
    const c = mat?.vertexColors ? mesh!.geometry.getAttribute("color") : null;
    const point = vp.stressOverlayPoint(0, W);
    return {
      meshes: drawn().length,
      bodyShown: body.mesh.visible,
      set: vp.hasStressOverlay(),
      standsIn: vp.stressOverlayBody(),
      firstColour: c ? [0, 1, 2].map((k) => Number(c.getComponent(0, k).toFixed(4))) : null,
      own: mat && !mat.vertexColors ? { hex: mat.color.getHexString(), copy: mat !== body.mesh.material } : null,
      point: point && point.map((x) => Number(x.toFixed(6))),
    };
  };
  return { vp, body, state };
}

const at = (pos: number[]) =>
  [0, 1, 2].map((k) => Number((W[0] * pos[k]! + W[1] * pos[3 + k]! + W[2] * pos[6 + k]!).toFixed(6)));
const BENT_POS = POSITIONS.map((x, i) => x + BENT.scale * BENT.displacement[i]!);

describe("the stress overlay with its colours and shape apart", () => {
  it("draws each combination, and only plain and still leaves the body itself on show", () => {
    const { vp, state } = view();
    vp.setStressOverlay({ ...BASE, ...BENT });
    expect({ ...state(), firstColour: null }).toEqual({
      meshes: 1,
      bodyShown: false,
      set: true,
      standsIn: "b1",
      firstColour: null,
      own: null,
      point: at(BENT_POS),
    });
    vp.setStressOverlay({ ...BASE, ...BENT, colours: false });
    expect(state()).toEqual({
      meshes: 1,
      bodyShown: false,
      set: true,
      standsIn: "b1",
      firstColour: null,
      own: { hex: "cc6633", copy: true },
      point: at(BENT_POS),
    });
    vp.setStressOverlay({ ...BASE, colours: false });
    expect(state()).toEqual({
      meshes: 0,
      bodyShown: true,
      set: true,
      standsIn: null,
      firstColour: null,
      own: null,
      point: at(POSITIONS),
    });
    vp.setStressOverlay({ ...BASE, colours: true });
    expect({ ...state(), firstColour: null }).toEqual({
      meshes: 1,
      bodyShown: false,
      set: true,
      standsIn: "b1",
      firstColour: null,
      own: null,
      point: at(POSITIONS),
    });
    vp.setStressOverlay(null);
    expect(state()).toEqual({
      meshes: 0,
      bodyShown: true,
      set: false,
      standsIn: null,
      firstColour: null,
      own: null,
      point: null,
    });
  });

  it("a plain overlay keeps a body the user hid hidden", () => {
    const { vp, body, state } = view();
    body.mesh.visible = false;
    vp.setStressOverlay({ ...BASE, ...BENT, colours: false });
    vp.setStressOverlay({ ...BASE, colours: false });
    expect({ shown: state().bodyShown, meshes: state().meshes }).toEqual({ shown: false, meshes: 0 });
  });

  it("colours the plain shape grey for a body with no colour, and refuses a surface whose values do not fit", () => {
    const { vp, body, state } = view();
    (body.mesh as THREE.Mesh).material = [];
    vp.setStressOverlay({ ...BASE, ...BENT, colours: false });
    expect(state().firstColour).toEqual([0.5225, 0.5225, 0.5225]);
    vp.setStressOverlay({ ...BASE, values: [1, 4], colours: false });
    expect({ set: state().set, bodyShown: state().bodyShown }).toEqual({ set: false, bodyShown: true });
  });
});
