// The guide layer's frame loop. One callback a frame while a step is up or a
// wait is open, none after: a wait used to start a second loop from inside the
// first, so callbacks doubled every frame until the window crashed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import * as THREE from "three";
import GuideLayer from "../../../src/components/overlays/GuideLayer.vue";
import { ENGINE } from "../../../src/app/engineKey";
import { setLanguage } from "../../../src/i18n";
import type { Engine } from "../../../src/app/engine";
import { GuideSession } from "../../../src/ui/guide/guideSession";
import { emptySnapshot, type Snapshot } from "../../../src/ui/guide/wait";
import { announce } from "../../../src/ui/announce";
import { SketchPlane } from "../../../src/sketch/plane";

vi.mock(import("../../../src/ui/announce"), async (orig) => ({ ...(await orig()), announce: vi.fn() }));

enableAutoUnmount(afterEach);

let queue = new Map<number, FrameRequestCallback>();
let nextId = 1;
const realRaf = globalThis.requestAnimationFrame;
const realCaf = globalThis.cancelAnimationFrame;

beforeEach(() => {
  vi.mocked(announce).mockClear();
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

function setup(props: { session?: GuideSession; hidden?: boolean } = {}) {
  let snap: Snapshot = emptySnapshot();
  let faceCalls = 0;
  /** The body's live pose: the Move tool's ghost sets it on the mesh and never touches the store. */
  const pose = new THREE.Matrix4();
  const canvas = document.createElement("canvas");
  const tri = new THREE.Triangle(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0));
  const store = {
    buildState: {
      result: {
        bodies: [{ id: "body1", name: "Box", faceStart: 0, faceCount: 6 }],
        edges: [
          {
            id: 1,
            body: "body1",
            points: [
              [0, 0, 0],
              [1, 0, 0],
            ],
          },
        ],
      },
    } as unknown,
  };
  const guide = new GuideSession(
    () => ({ found: true }),
    () => snap,
  );
  const sketch = {
    active: false,
    activePlane: new SketchPlane("XY"),
    drawnBounds: (): { minx: number; miny: number; maxx: number; maxy: number } | null => null,
  };
  const engine = {
    guide,
    store,
    sketch,
    viewport: {
      domElement: canvas,
      projectToScreen: (v: THREE.Vector3) => ({ x: v.x * 10, y: v.y * 10 }),
      faceTriangles: () => {
        faceCalls++;
        const t = tri.clone();
        for (const v of [t.a, t.b, t.c]) v.applyMatrix4(pose);
        return [t];
      },
      bodyPose: (id: string) => (id === "body1" ? pose : null),
    },
  } as unknown as Engine;
  const btn = document.createElement("button");
  btn.id = "guide-spec-target";
  document.body.appendChild(btn);
  const wrapper = mount(GuideLayer, { props, global: { provide: { [ENGINE as symbol]: engine } } });
  return {
    wrapper,
    guide,
    store,
    setTool: (t: string) => (snap = { ...snap, tool: t }),
    faceCalls: () => faceCalls,
    pose,
    sketch,
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

  it("reads a model step's faces once per build, not every frame", async () => {
    const g = setup();
    g.guide.apply([{ kind: "highlight", seq: 1, target: { model: "body1:index=0" }, caption: "This face" }]);
    await tick();
    frame();
    const once = g.faceCalls();
    expect(once).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) frame();
    expect(g.faceCalls()).toBe(once);
    g.store.buildState = { ...(g.store.buildState as object) };
    frame();
    expect(g.faceCalls()).toBe(once * 2);
  });

  for (const [kind, model] of [
    ["a face", "body1:index=0"],
    ["a body", "body:body1"],
    ["an edge", "body1:longest"],
  ]) {
    it(`${kind} step's outline follows a body the Move tool drags, and goes back when the move is cancelled`, async () => {
      const g = setup();
      g.guide.apply([{ kind: "highlight", seq: 1, target: { model }, caption: "Here" }]);
      await tick();
      frame();
      await tick();
      const xs = () =>
        [...document.querySelectorAll(".guide-model polyline")].flatMap((l) =>
          (l.getAttribute("points") ?? "").split(" ").map((p) => Number(p.split(",")[0])),
        );
      const rest = xs();
      expect(rest.length).toBeGreaterThan(0);
      const once = g.faceCalls();
      g.pose.makeTranslation(5, 0, 0);
      for (let i = 0; i < 3; i++) frame();
      await tick();
      expect(xs()).toEqual(rest.map((x) => x + 50));
      g.pose.identity();
      for (let i = 0; i < 3; i++) frame();
      await tick();
      expect(xs()).toEqual(rest);
      expect(g.faceCalls()).toBe(once);
    });
  }
});

describe("GuideLayer bubble", () => {
  it("offers Stop and Next as Buttons under the ids the harness clicks", async () => {
    const g = setup();
    g.guide.apply([{ kind: "highlight", seq: 1, target: { ui: "guide-spec-target" }, caption: "Here" }]);
    await tick();
    const next = document.getElementById("guide-next")!;
    const stop = document.getElementById("guide-stop")!;
    expect([next.getAttribute("type"), next.classList.contains("btn-primary"), stop.textContent!.trim()]).toEqual([
      "button",
      true,
      "Stop",
    ]);
    next.click();
    await tick();
    expect(document.querySelector(".guide-bubble")).toBeNull();
  });

  it("shows a step's keys under its caption, labelled in the user's language, and nothing for a step without", async () => {
    const g = setup();
    const keysText = () => document.querySelector("[data-guide-keys]")?.textContent?.replace(/\s+/g, " ").trim();
    g.guide.apply([
      { kind: "highlight", seq: 1, target: { ui: "guide-spec-target" }, caption: "Here", keys: "press F6" },
    ]);
    await tick();
    expect(document.querySelector(".guide-caption")!.nextElementSibling).toBe(
      document.querySelector("[data-guide-keys]"),
    );
    expect(keysText()).toBe("With keys: press F6");

    try {
      await setLanguage("de");
      g.guide.apply([
        { kind: "highlight", seq: 2, target: { ui: "guide-spec-target" }, caption: "Hier", keys: "F6 drücken" },
      ]);
      await tick();
      expect(keysText()).toBe("Mit Tasten: F6 drücken");
    } finally {
      await setLanguage("system");
    }

    g.guide.apply([{ kind: "highlight", seq: 3, target: { ui: "guide-spec-target" }, caption: "There" }]);
    await tick();
    expect(document.querySelector(".guide-caption")!.textContent).toBe("There");
    expect(document.querySelector("[data-guide-keys]")).toBeNull();
  });

  it("says a model part or control is not on screen in the user's language, and keeps the English detail for the assistant", async () => {
    const g = setup();
    const hintText = () => document.querySelector(".guide-hint")?.textContent?.trim();
    try {
      g.guide.apply([{ kind: "highlight", seq: 1, target: { model: "body9:index=0" }, caption: "Here" }]);
      await tick();
      frame();
      await tick();
      expect(hintText()).toBe("That part of the model is not on screen");

      g.guide.apply([{ kind: "highlight", seq: 2, target: { ui: "no-such-control" }, caption: "Here" }]);
      await tick();
      frame();
      await tick();
      expect(hintText()).toBe("That control is not on screen");
      expect(g.guide.state.step?.missing).toMatch(/^no control "no-such-control" on screen/);

      await setLanguage("de");
      g.guide.apply([{ kind: "highlight", seq: 3, target: { ui: "no-such-control" }, caption: "Hier" }]);
      await tick();
      frame();
      await tick();
      expect(hintText()).toBe("Dieses Bedienelement ist gerade nicht zu sehen");
      expect(g.guide.state.step?.missing).toMatch(/^no control "no-such-control" on screen/);

      g.guide.apply([{ kind: "highlight", seq: 4, target: { model: "body9:index=0" }, caption: "Hier" }]);
      await tick();
      frame();
      await tick();
      expect(hintText()).toBe("Dieser Teil des Modells ist gerade nicht zu sehen");
    } finally {
      await setLanguage("system");
    }
  });
});

describe("GuideLayer for a tour", () => {
  const tourSession = () =>
    new GuideSession(
      () => ({ found: true }),
      () => emptySnapshot(),
    );
  const shown = () => [!!document.querySelector(".guide-bubble"), !!document.querySelector(".guide-ring")];

  it("shows its own session's step, not the assistant's", async () => {
    const session = tourSession();
    const g = setup({ session });
    g.guide.apply([{ kind: "highlight", seq: 1, target: { ui: "guide-spec-target" }, caption: "Theirs" }]);
    session.apply([{ kind: "highlight", seq: 1, target: { ui: "guide-spec-target" }, caption: "Ours" }]);
    await tick();
    expect([...document.querySelectorAll(".guide-caption")].map((c) => c.textContent)).toEqual(["Ours"]);
    document.getElementById("guide-next")!.click();
    expect([session.state.step?.next, g.guide.state.step?.next]).toEqual([true, false]);
  });

  it("puts a caption alone at the top centre, with no ring and no hint", async () => {
    const session = tourSession();
    setup({ session });
    session.apply([{ kind: "highlight", seq: 1, step: 2, of: 14, caption: "Click the tile labelled XZ." }]);
    await tick();
    frame();
    await tick();
    const bubble = document.querySelector<HTMLElement>(".guide-bubble")!;
    expect([bubble.style.left, bubble.style.top]).toEqual([`${window.innerWidth / 2 - 140}px`, "72px"]);
    expect([document.querySelector(".guide-ring"), document.querySelector(".guide-hint")]).toEqual([null, null]);
    expect(document.querySelector(".guide-caption")!.textContent).toBe("Click the tile labelled XZ.");
  });

  it("moves a caption off the open sketch, its first 50 mm square and what is drawn past it", async () => {
    const session = tourSession();
    const g = setup({ session });
    g.sketch.active = true;
    session.apply([{ kind: "highlight", seq: 1, step: 4, of: 14, caption: "Draw the L." }]);
    await tick();
    frame();
    await tick();
    const bubble = document.querySelector<HTMLElement>(".guide-bubble")!;
    // The stub projects 1 mm to 10 px, so the square is 0 to 500 px.
    const at = () => [parseFloat(bubble.style.left), parseFloat(bubble.style.top)];
    const [left, top] = at();
    expect(left! >= 504 || top! >= 504).toBe(true);

    g.sketch.drawnBounds = () => ({ minx: 0, miny: 0, maxx: 60, maxy: 20 });
    for (let i = 0; i < 16; i++) frame();
    await tick();
    const [left2, top2] = at();
    expect(left2! >= 604 || top2! >= 504).toBe(true);
  });

  it("shows the tour's hint under the caption", async () => {
    const session = tourSession();
    setup({ session });
    session.apply([{ kind: "highlight", seq: 1, caption: "Draw the L." }]);
    session.setHint("The L is not closed yet, click its first corner again.");
    await tick();
    expect(document.querySelector(".guide-hint")!.textContent).toBe(
      "The L is not closed yet, click its first corner again.",
    );
  });

  it("hides the bubble and ring while hidden and keeps the wait open, then shows them again", async () => {
    const session = tourSession();
    const g = setup({ session, hidden: true });
    session.apply([
      { kind: "highlight", seq: 1, target: { region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }, caption: "Here" },
      { kind: "wait", seq: 2, until: "next" },
    ]);
    await tick();
    for (let i = 0; i < 3; i++) expect(frame()).toBe(1);
    expect(shown()).toEqual([false, false]);
    expect([session.state.wait?.done, session.active]).toEqual([null, true]);
    expect(vi.mocked(announce)).not.toHaveBeenCalled();

    await g.wrapper.setProps({ hidden: false });
    frame();
    await tick();
    expect(shown()).toEqual([true, true]);
    expect(vi.mocked(announce).mock.calls.map((c) => c[0])).toEqual(["Guide. Here."]);
  });
});

function rectOf(el: Element, b: { left: number; top: number; width: number; height: number }): void {
  const r = { ...b, x: b.left, y: b.top, right: b.left + b.width, bottom: b.top + b.height };
  el.getBoundingClientRect = () => ({ ...r, toJSON: () => r }) as DOMRect;
}

describe("GuideLayer over an open menu", () => {
  const bubbleAt = () => {
    const b = document.querySelector<HTMLElement>(".guide-bubble")!;
    return { left: b.style.left, side: b.dataset.side, hidden: b.style.visibility === "hidden" };
  };
  const step = async () => {
    frame();
    await tick();
  };

  it("moves the bubble off a menu the frame it opens, hides it with the ring kept while nothing is clear", async () => {
    const g = setup();
    const btn = document.createElement("button");
    btn.id = "guide-menu-target";
    document.body.appendChild(btn);
    rectOf(btn, { left: 360, top: 40, width: 80, height: 28 });
    g.guide.apply([{ kind: "highlight", seq: 1, target: { ui: "#guide-menu-target" }, caption: "Finish" }]);
    await tick();
    await step();
    expect(bubbleAt()).toEqual({ left: "456px", side: "right", hidden: false });

    const menu = document.createElement("div");
    menu.className = "ui-menu";
    document.body.appendChild(menu);
    rectOf(menu, { left: 430, top: 32, width: 240, height: 300 });
    await step();
    expect(bubbleAt()).toEqual({ left: "64px", side: "left", hidden: false });

    rectOf(menu, { left: 0, top: 80, width: 1024, height: 600 });
    await step();
    expect(bubbleAt().hidden).toBe(true);
    expect(document.querySelector(".guide-ring")).not.toBeNull();

    menu.remove();
    await step();
    expect(bubbleAt()).toEqual({ left: "456px", side: "right", hidden: false });
    btn.remove();
  });
});

describe("GuideLayer in a sketch", () => {
  it("forgets the last sketch's drawing when a sketch opens again", async () => {
    const g = setup();
    g.sketch.active = true;
    g.sketch.drawnBounds = () => ({ minx: 0, miny: 0, maxx: 70, maxy: 20 });
    g.guide.apply([{ kind: "highlight", seq: 1, caption: "Draw the L." }]);
    await tick();
    const left = async () => {
      frame();
      await tick();
      return document.querySelector<HTMLElement>(".guide-bubble")!.style.left;
    };
    // The stub projects 1 mm to 10 px: the 70 mm drawing ends at 700 px, the first 50 mm square at 500.
    expect(await left()).toBe("716px");
    g.sketch.active = false;
    expect(await left()).toBe(`${window.innerWidth / 2 - 140}px`);
    g.sketch.active = true;
    g.sketch.drawnBounds = () => null;
    expect(await left()).toBe("516px");
  });

  it("reads the shell's panels every 15 frames and as a sketch opens, and open menus every frame", async () => {
    const qsa = vi.spyOn(document, "querySelectorAll");
    const reads = (part: string) => qsa.mock.calls.filter(([sel]) => String(sel).includes(part)).length;
    const g = setup();
    g.sketch.active = true;
    g.guide.apply([{ kind: "highlight", seq: 1, caption: "Draw the L." }]);
    await tick();
    for (let i = 0; i < 30; i++) frame();
    expect([reads(".tool-rail"), reads(".ui-menu")]).toEqual([2, 30]);
    g.sketch.active = false;
    frame();
    g.sketch.active = true;
    frame();
    expect([reads(".tool-rail"), reads(".ui-menu")]).toEqual([3, 32]);
    qsa.mockRestore();
  });
});

describe("GuideLayer speech", () => {
  const said = () => vi.mocked(announce).mock.calls;
  const at = { ui: "guide-spec-target" };

  it("says a new step once with its counter, caption and keys, through announce and not a live bubble", async () => {
    const g = setup();
    g.guide.apply([
      { kind: "highlight", seq: 1, step: 1, of: 2, target: at, caption: "Pick the edge", keys: "press F6" },
      { kind: "wait", seq: 2, until: "tool" },
    ]);
    await tick();
    for (let i = 0; i < 5; i++) frame();
    g.setTool("Fillet / Chamfer");
    frame();
    await tick();
    expect(said()).toEqual([["Step 1 of 2. Pick the edge. With keys: press F6", "polite", { key: "guide" }]]);
    expect(document.querySelector(".guide-bubble")!.hasAttribute("aria-live")).toBe(false);
  });

  it("says a step without keys as its caption alone, nothing on Next, and the next step when it comes", async () => {
    const g = setup();
    g.guide.apply([{ kind: "highlight", seq: 1, target: at, caption: "Here" }]);
    await tick();
    g.guide.next();
    await tick();
    g.guide.apply([{ kind: "highlight", seq: 2, step: 2, of: 2, target: at, caption: "Now there." }]);
    await tick();
    expect(said().map((c) => c[0])).toEqual(["Guide. Here.", "Step 2 of 2. Now there."]);
  });

  it("says the first step again when a new guide starts its count over", async () => {
    const g = setup();
    g.guide.apply([{ kind: "highlight", seq: 1, target: at, caption: "Here" }]);
    g.guide.reset();
    g.guide.apply([{ kind: "highlight", seq: 1, target: at, caption: "Again" }]);
    await tick();
    expect(said().map((c) => c[0])).toEqual(["Guide. Here.", "Guide. Again."]);
  });

  it("shows and says the counter and the buttons in the user's language", async () => {
    const g = setup();
    const text = (sel: string) => document.querySelector(sel)!.textContent!.trim();
    try {
      await setLanguage("de");
      g.guide.apply([{ kind: "highlight", seq: 1, step: 1, of: 2, target: at, caption: "Hier", keys: "F6 drücken" }]);
      await tick();
      expect([text(".guide-count"), text("#guide-stop"), text("#guide-next")]).toEqual([
        "Schritt 1 von 2",
        "Beenden",
        "Weiter",
      ]);
      expect(document.querySelector(".guide-bubble")!.getAttribute("aria-label")).toBe("Schritt 1 von 2");
      g.guide.apply([{ kind: "highlight", seq: 2, target: at, caption: "Fertig." }]);
      await tick();
      expect(said().map((c) => c[0])).toEqual(["Schritt 1 von 2. Hier. Mit Tasten: F6 drücken", "Anleitung. Fertig."]);
    } finally {
      await setLanguage("system");
    }
  });

  it("ends a Chinese or Japanese sentence with a full stop of its own script, and the Japanese counter has no slash", async () => {
    const g = setup();
    try {
      await setLanguage("zh-CN");
      g.guide.apply([{ kind: "highlight", seq: 1, step: 1, of: 3, target: at, caption: "选择这条边" }]);
      await tick();
      await setLanguage("ja");
      g.guide.apply([{ kind: "highlight", seq: 2, step: 2, of: 3, target: at, caption: "ここをクリック" }]);
      await tick();
      expect(said().map((c) => c[0])).toEqual([
        "第 1 步，共 3 步。 选择这条边。",
        "ステップ 2（全 3）。 ここをクリック。",
      ]);
    } finally {
      await setLanguage("system");
    }
  });
});
