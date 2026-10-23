// The stress overlay's colours and its deformed shape are separate: plain and still leaves the body on show to pick.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Viewport } from "../../src/viewport/viewport";
import { getPatch, setPatch } from "../../src/viewport/shaderPatches";

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
const rgb = (hex: number | string) => new THREE.Color(hex).toArray().map((x) => Number(x.toFixed(4)));

function view() {
  const scene = new THREE.Scene();
  // As render.ts makes a body: white, its albedo in its vertex colours, a finish patch and the glass one.
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  setPatch(material, { name: "surface", key: "s1", after: { color_fragment: "diffuseColor.rgb *= 0.9;" } });
  setPatch(material, { name: "glassAuto", key: "g1", after: { transmission_fragment: "" } });
  const body = { id: "b1", mesh: new THREE.Mesh(new THREE.BufferGeometry(), material), edges: { setBodyVisible() {} } };
  const vp = Object.create(Viewport.prototype) as Viewport;
  Object.assign(vp, {
    model: { bodies: [body] },
    finish: { bodyPaint: {} as Record<string, string> },
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
      own:
        mat && getPatch(mat, "surface")
          ? {
              copy: mat !== body.mesh.material,
              glass: !!getPatch(mat, "glassAuto"),
              white: mat.color.getHex() === 0xffffff,
            }
          : null,
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
      firstColour: rgb(0x9aa7b4),
      own: { copy: true, glass: false, white: true },
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

  it("paints the plain shape the body's paint, a scan its sand, one with no lit material still its colour", () => {
    const { vp, body, state } = view();
    (vp as unknown as { finish: { bodyPaint: Record<string, string> } }).finish.bodyPaint = {
      b1: "#c0392b",
      b2: "#00ff00",
    };
    vp.setStressOverlay({ ...BASE, ...BENT, colours: false });
    expect({ firstColour: state().firstColour, own: state().own }).toEqual({
      firstColour: rgb("#c0392b"),
      own: { copy: true, glass: false, white: true },
    });
    (vp as unknown as { finish: { bodyPaint: Record<string, string> } }).finish.bodyPaint = {};
    Object.assign(body, { scan: true });
    vp.setStressOverlay({ ...BASE, ...BENT, colours: false });
    expect(state().firstColour).toEqual(rgb(0xc9b48f));
    (body.mesh as THREE.Mesh).material = [];
    vp.setStressOverlay({ ...BASE, ...BENT, colours: false });
    expect({ firstColour: state().firstColour, own: state().own }).toEqual({ firstColour: rgb(0xc9b48f), own: null });
  });

  it("refuses a surface whose values do not fit", () => {
    const { vp, state } = view();
    vp.setStressOverlay({ ...BASE, values: [1, 4], colours: false });
    expect({ set: state().set, bodyShown: state().bodyShown }).toEqual({ set: false, bodyShown: true });
  });
});
