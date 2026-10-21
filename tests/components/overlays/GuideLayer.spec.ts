// The guide layer's frame loop. One callback a frame while a step is up or a
// wait is open, none after: a wait used to start a second loop from inside the
// first, so callbacks doubled every frame until the window crashed.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import * as THREE from "three";
import GuideLayer from "../../../src/components/overlays/GuideLayer.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { GuideSession } from "../../../src/ui/guide/guideSession";
import { emptySnapshot, type Snapshot } from "../../../src/ui/guide/wait";

enableAutoUnmount(afterEach);

let queue = new Map<number, FrameRequestCallback>();
let nextId = 1;
const realRaf = globalThis.requestAnimationFrame;
const realCaf = globalThis.cancelAnimationFrame;

beforeEach(() => {
  queue = new Map();
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  };
  globalThis.cancelAnimationFrame = (id: number) => void queue.delete(id);
});
afterEach(() => {
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCaf;
});

/** Run one frame, the callbacks queued before it, and say how many are queued after. */
function frame(): number {
  const now = [...queue.values()];
  queue = new Map();
  for (const cb of now) cb(0);
  return queue.size;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  let snap: Snapshot = emptySnapshot();
  let faceCalls = 0;
  const canvas = document.createElement("canvas");
  const tri = new THREE.Triangle(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0));
  const store = {
    buildState: {
      result: { bodies: [{ id: "body1", name: "Box", faceStart: 0, faceCount: 6 }], edges: [] },
    } as unknown,
  };
  const guide = new GuideSession(() => ({ found: true }), () => snap);
  const engine = {
    guide,
    store,
    viewport: {
      domElement: canvas,
      projectToScreen: (v: THREE.Vector3) => ({ x: v.x * 10, y: v.y * 10 }),
      faceTriangles: () => {
        faceCalls++;
        return [tri.clone()];
      },
    },
  } as unknown as Engine;
  const btn = document.createElement("button");
  btn.id = "guide-spec-target";
  document.body.appendChild(btn);
  mount(GuideLayer, { global: { provide: { [ENGINE as symbol]: engine } } });
  return {
    guide,
    store,
    setTool: (t: string) => (snap = { ...snap, tool: t }),
    faceCalls: () => faceCalls,
  };
}

describe("GuideLayer frame loop", () => {
  it("keeps one callback a frame for a wait with no step on screen, and stops when it is met", async () => {
    const g = setup();
    g.guide.apply([{ kind: "wait", seq: 1, until: "tool" }]);
    await tick();
    for (let i = 0; i < 20; i++) expect(frame()).toBeLessThanOrEqual(1);
    g.setTool("Fillet / Chamfer");
    frame();
    expect(g.guide.state.wait?.done).toBe("met");
    expect(frame()).toBe(0);
  });

  it("keeps one callback a frame while a step is up and a wait is open", async () => {
    const g = setup();
    g.guide.apply([
      { kind: "highlight", seq: 1, target: { ui: "guide-spec-target" }, caption: "Here" },
      { kind: "wait", seq: 2, until: "tool" },
    ]);
    await tick();
    for (let i = 0; i < 20; i++) expect(frame()).toBeLessThanOrEqual(1);
  });

  it("keeps one callback a frame after Next hides the step while the wait stays open", async () => {
    const g = setup();
    g.guide.apply([
      { kind: "highlight", seq: 1, target: { ui: "guide-spec-target" }, caption: "Here" },
      { kind: "wait", seq: 2, until: "tool" },
    ]);
    await tick();
    frame();
    g.guide.next();
    await tick();
    for (let i = 0; i < 20; i++) expect(frame()).toBeLessThanOrEqual(1);
    g.guide.stop();
    await tick();
    frame();
    expect(frame()).toBe(0);
  });
});
