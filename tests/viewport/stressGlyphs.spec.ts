// The Stress panel's glyphs against a real camera and canvas: a press on a
// force arrow's tip is claimed and becomes a drag that patches the load, a
// press anywhere else is left to the view, and probe mode reads the body under
// the cursor, pins a click and leaves on Esc.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { StressGlyphs, type StressGlyphHandlers, type StressGlyphHost, type StressGlyphModel } from "../../src/viewport/stressGlyphs";
import { dragForce, forceDragStart, forceToArrowPx } from "../../src/ui/stress";

// A 100 x 100 px canvas showing world x and y from -50 to 50, looking down -Z:
// one pixel is one millimetre and screen (50, 50) is the origin.
function rig() {
  const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const scene = new THREE.Scene();
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const raycaster = new THREE.Raycaster();
  const pick = vi.fn<StressGlyphHost["pickStressOverlay"]>(() => null);
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
    pickStressOverlay: pick,
    stressOverlayPoint: () => [1, 2, 0] as [number, number, number],
  } as unknown as StressGlyphHost;
  const handlers = {
    forceDrag: vi.fn(),
    forceDragEnd: vi.fn(),
    probeLabel: vi.fn(() => "7 MPa, 0.1 mm"),
    pinProbe: vi.fn(),
    leaveProbe: vi.fn(),
  } satisfies StressGlyphHandlers;
  const glyphs = new StressGlyphs(host, handlers);
  live.push(glyphs);
  return { glyphs, handlers, scene, canvas, pick };
}

const model = (force = 1, into: [number, number, number] | null = null): StressGlyphModel => ({
  forces: [{ loadId: 1, anchor: [0, 0, 0], dir: [1, 0, 0], force, direction: into ? "into" : "+X", into }],
  pressures: [],
  gravity: null,
  pins: [],
});

function pointer(el: EventTarget, type: string, x: number, y: number) {
  const e = new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

// Disposed after each test even when it fails, so its key listener cannot
// swallow the next test's Esc.
const live: StressGlyphs[] = [];
afterEach(() => {
  for (const g of live.splice(0)) g.dispose();
  document.body.innerHTML = "";
});

describe("StressGlyphs", () => {
  it("claims a press on a force arrow's tip and turns the drag into a patch", () => {
    const { glyphs, handlers, canvas } = rig();
    glyphs.setModel(model(1));
    const tipX = 50 + forceToArrowPx(1) - 6;
    const after = vi.fn();
    canvas.addEventListener("pointerdown", after);
    const down = pointer(canvas, "pointerdown", tipX, 50);
    expect(down.defaultPrevented).toBe(true);
    expect(after).not.toHaveBeenCalled();
    // Measured from the press, 6 px behind the tip.
    const start = forceDragStart(1, tipX - 50);
    expect(start.offsetPx).toBeCloseTo(6, 9);
    // Out along +X to 80 px: snapped to the axis, sized from the length.
    pointer(canvas, "pointermove", 130, 51);
    const out = dragForce(start, 80 + start.offsetPx);
    expect(handlers.forceDrag).toHaveBeenLastCalledWith(1, { direction: "+X", custom: null, force: out });
    expect(document.body.querySelector(".stress-cursor-label")?.textContent).toBe(`${out} N, +x`);
    // Swung round to straight down the screen: -Y.
    pointer(canvas, "pointermove", 50, 100);
    expect(handlers.forceDrag).toHaveBeenLastCalledWith(1, { direction: "-Y", custom: null, force: dragForce(start, 50 + start.offsetPx) });
    pointer(canvas, "pointerup", 50, 100);
    expect(handlers.forceDragEnd).toHaveBeenCalledWith(1, false);
    glyphs.dispose();
  });

  it("leaves the load as it is for a press on the tip that hardly moves", () => {
    const { glyphs, handlers, canvas } = rig();
    glyphs.setModel(model(30));
    // Pressed on the grab ball's centre, half a head behind the tip.
    const x = 50 + forceToArrowPx(30) - 6.5;
    pointer(canvas, "pointerdown", x, 50);
    pointer(canvas, "pointermove", x + 2, 51);
    expect(handlers.forceDrag).not.toHaveBeenCalled();
    // Past the slop, the size follows the hand from 30 N, not from the
    // length the press point stands for (about 22 N).
    pointer(canvas, "pointermove", x + 4, 50);
    const start = forceDragStart(30, x - 50);
    expect(handlers.forceDrag).toHaveBeenLastCalledWith(1, { direction: "+X", custom: null, force: dragForce(start, x + 4 - 50 + start.offsetPx) });
    expect(handlers.forceDrag.mock.calls.at(-1)![1].force).toBe(36);
    pointer(canvas, "pointerup", x + 4, 50);
    glyphs.dispose();
  });

  it("keeps \"into the face\" on a drag along an arrow that is also an axis", () => {
    const { glyphs, handlers, canvas } = rig();
    glyphs.setModel(model(1, [1, 0, 0]));
    pointer(canvas, "pointerdown", 50 + forceToArrowPx(1) - 6, 50);
    pointer(canvas, "pointermove", 120, 50);
    expect(handlers.forceDrag.mock.calls.at(-1)![1].direction).toBe("into");
    glyphs.dispose();
  });

  it("leaves a press away from the tip to the view", () => {
    const { glyphs, handlers, canvas } = rig();
    glyphs.setModel(model(1));
    const down = pointer(canvas, "pointerdown", 10, 10);
    expect(down.defaultPrevented).toBe(false);
    pointer(canvas, "pointermove", 20, 20);
    expect(handlers.forceDrag).not.toHaveBeenCalled();
    glyphs.dispose();
  });

  it("puts a dragged load back on Esc", () => {
    const { glyphs, handlers, canvas } = rig();
    glyphs.setModel(model(1));
    pointer(canvas, "pointerdown", 50 + forceToArrowPx(1) - 6, 50);
    pointer(canvas, "pointermove", 120, 50);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(handlers.forceDragEnd).toHaveBeenCalledWith(1, true);
    glyphs.dispose();
  });

  it("reads the body under the cursor in probe mode, pins a click, and not an orbit", () => {
    const { glyphs, handlers, canvas, pick } = rig();
    const hit = { tri: 4, weights: [0.2, 0.3, 0.5] as [number, number, number], point: [0, 0, 0] as [number, number, number] };
    pick.mockReturnValue(hit);
    glyphs.setProbe(true);
    pointer(canvas, "pointermove", 30, 30);
    expect(handlers.probeLabel).toHaveBeenCalledWith(hit);
    expect(document.body.querySelector(".stress-cursor-label")?.textContent).toBe("7 MPa, 0.1 mm");
    pointer(canvas, "pointerdown", 30, 30);
    pointer(canvas, "pointerup", 31, 30);
    expect(handlers.pinProbe).toHaveBeenCalledWith(hit);
    pointer(canvas, "pointerdown", 30, 30);
    pointer(canvas, "pointerup", 60, 30);
    expect(handlers.pinProbe).toHaveBeenCalledOnce();
    glyphs.dispose();
  });

  it("leaves probe mode on Esc and keeps the key from anything after it", () => {
    const { glyphs, handlers } = rig();
    glyphs.setProbe(true);
    const later = vi.fn();
    window.addEventListener("keydown", later, true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(handlers.leaveProbe).toHaveBeenCalledOnce();
    expect(later).not.toHaveBeenCalled();
    window.removeEventListener("keydown", later, true);
    glyphs.dispose();
  });

  it("draws pinned probes with their readouts, and takes everything away on dispose", () => {
    const { glyphs, scene } = rig();
    glyphs.setModel({ ...model(10), pressures: [{ at: [0, 0, 0], dir: [0, 0, -1] }], gravity: { at: [0, 0, 0], dir: [0, 0, -1] }, pins: [{ from: [0, 0, 0], to: [0, 0, 10] }] });
    glyphs.setProbePins([{ tri: 0, weights: [1, 0, 0], label: "3 MPa" }]);
    // Three arrows, one axis line, one probe ball.
    expect(scene.children).toHaveLength(5);
    // Every arrow has its dark rim behind it.
    const arrow = scene.children[0] as THREE.Group;
    expect(arrow.children.filter((c) => c.renderOrder === 998)).toHaveLength(2);
    const pin = document.body.querySelector(".stress-probe-pin") as HTMLElement;
    expect(pin.textContent).toBe("3 MPa");
    expect(pin.style.left).toBe("59px");
    glyphs.dispose();
    expect(scene.children).toHaveLength(0);
    expect(document.body.querySelector(".stress-glyph-label")).toBeNull();
  });
});
