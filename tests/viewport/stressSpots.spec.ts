// The Stress panel's spots against a real camera and canvas: in place mode an
// orb follows the cursor over the body and a click puts a spot there without
// reaching the view's own selection, and a drag of an orb's rim sizes it.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { StressGlyphs, type StressGlyphHandlers, type StressGlyphHost, type StressGlyphModel } from "../../src/viewport/stressGlyphs";

// A 100 x 100 px canvas showing world x and y from -50 to 50, looking down -Z:
// one pixel is one millimetre and screen (50, 50) is the origin. The body is
// the plane z = 0 wherever x is above -40.
function rig() {
  const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const scene = new THREE.Scene();
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const raycaster = new THREE.Raycaster();
  const host = {
    camera,
    domElement: canvas,
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    rayFrom: (x: number, y: number) => {
      raycaster.setFromCamera(new THREE.Vector2(x / 50 - 1, 1 - y / 50), camera);
      return raycaster;
    },
    pixelWorldSize: () => 1,
    projectToScreen: (v: THREE.Vector3) => ({ x: v.x + 50, y: 50 - v.y }),
    requestRender: () => {},
    pickStressOverlay: () => null,
    stressOverlayPoint: () => null,
    pickFaceForPressPull: (x: number, y: number) => x - 50 <= -40 ? null : {
      anchor: new THREE.Vector3(x - 50, 50 - y, 0), normal: new THREE.Vector3(0, 0, 1), bodyId: "body1",
    },
  } as unknown as StressGlyphHost;
  const handlers = {
    forceDrag: vi.fn(),
    forceDragEnd: vi.fn(),
    probeLabel: vi.fn(() => null),
    pinProbe: vi.fn(),
    leaveProbe: vi.fn(),
    placeSpot: vi.fn(),
    leavePlacing: vi.fn(),
    spotRadius: vi.fn(),
    spotRadiusEnd: vi.fn(),
  } satisfies StressGlyphHandlers;
  const glyphs = new StressGlyphs(host, handlers);
  live.push(glyphs);
  return { glyphs, handlers, scene, canvas };
}

const spotted = (radius = 10): StressGlyphModel => ({
  forces: [], pressures: [], gravity: null, pins: [],
  spots: [{ target: { load: 3 }, index: 0, at: [0, 0, 0], radius, color: 0xff9a2e }],
});

function pointer(el: EventTarget, type: string, x: number, y: number, shiftKey = false) {
  const e = new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, shiftKey });
  el.dispatchEvent(e);
  return e;
}

const live: StressGlyphs[] = [];
afterEach(() => {
  for (const g of live.splice(0)) g.dispose();
  document.body.innerHTML = "";
});

describe("stress spots in the view", () => {
  it("shows an orb under the cursor in place mode and places on a click, which the view never sees", () => {
    const { glyphs, handlers, scene, canvas } = rig();
    const view = vi.fn();
    canvas.addEventListener("pointerdown", view);
    glyphs.setPlacing({ color: 0xff9a2e, radius: 4 });
    pointer(canvas, "pointermove", 70, 50);
    // A dome, its faint whole and its ring, and no handle before it is placed.
    expect(scene.children).toHaveLength(3);
    expect(scene.children[0]!.position.toArray()).toEqual([20, 0, 0]);
    expect(scene.children[0]!.scale.x).toBe(4);
    pointer(canvas, "pointerdown", 70, 50);
    pointer(canvas, "pointerup", 71, 50);
    expect(view).not.toHaveBeenCalled();
    expect(handlers.placeSpot).toHaveBeenCalledWith({ at: [21, 0, 0], normal: [0, 0, 1], body: "body1" }, false);
    pointer(canvas, "pointerdown", 70, 50, true);
    pointer(canvas, "pointerup", 70, 50, true);
    expect(handlers.placeSpot).toHaveBeenLastCalledWith({ at: [20, 0, 0], normal: [0, 0, 1], body: "body1" }, true);
  });

  it("places nothing off the body or at the end of a drag, and drops the orb when placing ends", () => {
    const { glyphs, handlers, scene, canvas } = rig();
    glyphs.setPlacing({ color: 0xff9a2e, radius: 4 });
    pointer(canvas, "pointermove", 70, 50);
    pointer(canvas, "pointermove", 5, 50);
    expect(scene.children).toHaveLength(0);
    pointer(canvas, "pointerdown", 5, 50);
    pointer(canvas, "pointerup", 5, 50);
    pointer(canvas, "pointerdown", 70, 50);
    pointer(canvas, "pointerup", 90, 50);
    expect(handlers.placeSpot).not.toHaveBeenCalled();
    pointer(canvas, "pointermove", 70, 50);
    glyphs.setPlacing(null);
    expect(scene.children).toHaveLength(0);
    pointer(canvas, "pointerdown", 70, 50);
    pointer(canvas, "pointerup", 70, 50);
    expect(handlers.placeSpot).not.toHaveBeenCalled();
  });

  it("leaves place mode on Esc and keeps the key from anything after it", () => {
    const { glyphs, handlers } = rig();
    glyphs.setPlacing({ color: 0xff9a2e, radius: 4 });
    const later = vi.fn();
    window.addEventListener("keydown", later, true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(handlers.leavePlacing).toHaveBeenCalledOnce();
    expect(later).not.toHaveBeenCalled();
    window.removeEventListener("keydown", later, true);
  });

  it("sizes a spot by a drag of its rim, and puts it back on Esc", () => {
    const { glyphs, handlers, scene, canvas } = rig();
    glyphs.setModel(spotted(10));
    // The dome, its faint whole, the ring, the handle and its grab ball.
    expect(scene.children).toHaveLength(5);
    // The handle stands on the rim to the camera's right, screen (60, 50).
    expect(pointer(canvas, "pointerdown", 60, 50).defaultPrevented).toBe(true);
    pointer(canvas, "pointermove", 61, 50);
    expect(handlers.spotRadius).not.toHaveBeenCalled();
    pointer(canvas, "pointermove", 70, 50);
    expect(handlers.spotRadius).toHaveBeenLastCalledWith({ load: 3 }, 0, 20);
    expect(document.body.querySelector(".stress-cursor-label")?.textContent).toBe("radius 20 mm");
    // The panel redraws with the new radius, and the drag carries on.
    glyphs.setModel(spotted(20));
    pointer(canvas, "pointermove", 50, 80);
    expect(handlers.spotRadius).toHaveBeenLastCalledWith({ load: 3 }, 0, 30);
    pointer(canvas, "pointerup", 50, 80);
    expect(handlers.spotRadiusEnd).toHaveBeenCalledWith({ load: 3 }, 0, false);

    glyphs.setModel(spotted(10));
    pointer(canvas, "pointerdown", 60, 50);
    pointer(canvas, "pointermove", 70, 50);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(handlers.spotRadiusEnd).toHaveBeenLastCalledWith({ load: 3 }, 0, true);
  });

  it("leaves a press off the rim to the view, and takes the orbs away on dispose", () => {
    const { glyphs, scene, canvas } = rig();
    glyphs.setModel(spotted(10));
    expect(pointer(canvas, "pointerdown", 30, 50).defaultPrevented).toBe(false);
    pointer(canvas, "pointerup", 30, 50);
    glyphs.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
