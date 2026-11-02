// Enter in a line, rectangle or circle tool opens X and Y for the first point. A fake host and the real value box.

import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real solver pulls a wasm ?url that the DOM project's transform refuses, and nothing here solves.
vi.mock("../../src/sketch/solver", () => ({
  SolverUnavailable: class extends Error {},
  initSolver: async () => false,
  solveSketch: async () => {
    throw new Error("no solver in this test");
  },
}));
vi.mock("../../src/ui/announce", () => ({ announce: vi.fn(), cancelAnnouncement: vi.fn() }));

import { DimInput } from "../../src/sketch/dimInput";
import { EDGE_ON_PROMPT, KeyDrawFlow, type KeyDrawHost, type KeyHit } from "../../src/sketch/keyDrawFlow";
import type { ResolvedEntity, SnapCandidate } from "../../src/sketch/snap";
import { setA11yPref } from "../../src/ui/a11yPrefs";
import { announce } from "../../src/ui/announce";

let dim: DimInput;
let listener: ((e: KeyboardEvent) => void) | null = null;

afterEach(() => {
  if (listener) window.removeEventListener("keydown", listener, true);
  listener = null;
  dim.dispose();
  document.body.innerHTML = "";
});
beforeEach(() => vi.mocked(announce).mockClear());
afterEach(() => setA11yPref("singleKeys", true));

const v = (x: number, y: number) => new THREE.Vector2(x, y);

function rig(tool = "rectangle", over: Partial<KeyDrawHost> = {}) {
  document.body.innerHTML = '<main id="main"><div id="free"></div><button id="rail">r</button></main>';
  dim = new DimInput();
  const state = {
    tool,
    base: null as THREE.Vector2 | null,
    cursor: v(13.5, -7.25),
    edgeOn: false,
    placed: [] as KeyHit[],
    prompts: [] as string[],
    boxAt: [] as THREE.Vector2[],
    candidates: [
      { p: v(0, 0), kind: "center", priority: 95, label: "Origin" },
      { p: v(40, 22.5), kind: "midpoint", priority: 80, ref: { entity: "l2", at: "mid" } },
    ] as SnapCandidate[],
    entities: [
      { type: "line", id: "l1", x1: 0, y1: 0, x2: 4, y2: 0 },
      { type: "line", id: "l2", x1: 30, y1: 20, x2: 50, y2: 25 },
    ] as ResolvedEntity[],
  };
  const host: KeyDrawHost = {
    tool: () => state.tool,
    base: () => state.base,
    cursor: () => state.cursor,
    candidates: () => state.candidates,
    entities: () => state.entities,
    planeTooEdgeOn: () => state.edgeOn,
    dim: () => dim,
    place: (hit) => {
      state.placed.push(hit);
      state.base = hit.p.clone();
      dim.hide();
    },
    positionBox: (p) => state.boxAt.push(p.clone()),
    prompt: (t) => state.prompts.push(t),
    ...over,
  };
  const flow = new KeyDrawFlow(host);
  listener = (e) => void flow.onKey(e);
  window.addEventListener("keydown", listener, true);
  return { flow, state };
}

const field = (name: string) => document.querySelector<HTMLInputElement>(`.dim-field[data-field="${name}"] input`)!;
const boxFields = () => [...document.querySelectorAll<HTMLElement>(".dim-field")].map((f) => f.dataset.field);

function press(target: Element | Window, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

function type(name: string, text: string) {
  const input = field(name);
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const free = () => document.getElementById("free")!;

describe("Enter opens X and Y", () => {
  for (const tool of ["line", "rectangle", "circle"]) {
    it(`in the ${tool} tool, seeded from the cursor and placed where it is typed`, () => {
      const { state } = rig(tool);
      const e = press(free());
      expect(e.defaultPrevented).toBe(true);
      expect(boxFields()).toEqual(["x", "y"]);
      expect([field("x").value, field("y").value]).toEqual(["13.5", "-7.25"]);
      expect(state.boxAt).toEqual([v(13.5, -7.25)]);
      type("x", "25");
      type("y", "3");
      press(field("y"));
      expect(state.placed).toEqual([{ p: v(25, 3), kind: "free", label: undefined, ref: undefined }]);
      expect(state.base).toEqual(v(25, 3));
    });
  }

  it("places the seeded cursor when nothing is typed", () => {
    const { state } = rig("line");
    press(free());
    press(field("x"));
    expect(state.placed.map((h) => h.p)).toEqual([v(13.5, -7.25)]);
  });

  it("takes Enter from the body too", () => {
    rig("circle");
    expect(press(document.body).defaultPrevented).toBe(true);
    expect(boxFields()).toEqual(["x", "y"]);
  });

  it("refocuses an open box instead of seeding it again", () => {
    rig("line");
    press(free());
    type("x", "4");
    (document.activeElement as HTMLElement).blur();
    press(free());
    expect(field("x").value).toBe("4");
    expect(document.activeElement).toBe(field("x"));
  });
});

describe("Enter is left alone", () => {
  it("in other tools", () => {
    for (const tool of ["select", "arc", "polygon", "dimension"]) {
      const { state } = rig(tool);
      expect(press(free()).defaultPrevented, tool).toBe(false);
      expect(dim.isActive, tool).toBe(false);
      expect(state.prompts).toEqual([]);
      dim.dispose();
    }
  });

  it("once a point is placed, where the size box and Enter commit are the tool's", () => {
    const { state } = rig("rectangle");
    state.base = v(1, 2);
    expect(press(free()).defaultPrevented).toBe(false);
    expect(dim.isActive).toBe(false);
  });

  it("on a control, a repeat, or with a modifier", () => {
    rig("line");
    expect(press(document.getElementById("rail")!).defaultPrevented).toBe(false);
    expect(press(free(), { repeat: true }).defaultPrevented).toBe(false);
    expect(press(free(), { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press(free(), { altKey: true }).defaultPrevented).toBe(false);
    expect(press(free(), { metaKey: true }).defaultPrevented).toBe(false);
    expect(dim.isActive).toBe(false);
    expect(press(free()).defaultPrevented).toBe(true);
  });

  it("edge-on: says so and opens nothing", () => {
    const { state } = rig("rectangle");
    state.edgeOn = true;
    const e = press(free());
    expect(e.defaultPrevented).toBe(true);
    expect(state.prompts).toEqual([EDGE_ON_PROMPT]);
    expect(dim.isActive).toBe(false);
    state.edgeOn = false;
    press(free());
    expect(boxFields()).toEqual(["x", "y"]);
  });
});

describe("a typed first point", () => {
  it("on the origin is the origin, 0.01 away is not", () => {
    const { state } = rig("rectangle");
    press(free());
    type("x", "0");
    type("y", "0");
    press(field("y"));
    state.base = null;
    press(free());
    type("x", "0.01");
    type("y", "0");
    press(field("y"));
    expect(state.placed.map((h) => [h.p.x, h.p.y, h.kind, h.label])).toEqual([
      [0, 0, "center", "Origin"],
      [0.01, 0, "free", undefined],
    ]);
  });

  it("on a midpoint carries its ref and says what it snapped to", () => {
    const { state } = rig("line");
    press(free());
    type("x", "40");
    type("y", "22.5");
    press(field("y"));
    expect(state.placed[0]).toMatchObject({ kind: "midpoint", ref: { entity: "l2", at: "mid" } });
    expect(vi.mocked(announce).mock.calls).toEqual([
      ["Point at 40, 22.5, snapped to the midpoint of Line 2", "polite", { key: "sketch-point" }],
    ]);
  });

  it("is spoken plainly with a negative as minus", () => {
    rig("circle");
    press(free());
    type("x", "5");
    type("y", "-7");
    press(field("y"));
    expect(vi.mocked(announce).mock.calls).toEqual([["Point at 5, minus 7", "polite", { key: "sketch-point" }]]);
  });

  it("keeps a refused entry open, marked, focused and spoken, placing nothing", () => {
    const { state } = rig("rectangle");
    press(free());
    type("x", "4");
    type("y", "abc");
    press(field("y"));
    expect(state.placed).toEqual([]);
    expect(document.querySelector(".dim-input")?.classList.contains("dim-bad")).toBe(true);
    expect(document.activeElement).toBe(field("y"));
    const [text, priority] = vi.mocked(announce).mock.calls[0]!;
    expect(text.length).toBeGreaterThan(0);
    expect(priority).toBe("assertive");
    type("y", "9");
    press(field("y"));
    expect(state.placed.map((h) => h.p)).toEqual([v(4, 9)]);
  });

  it("reads @dx,dy from the last placed point, and from 0, 0 after a reset", () => {
    const { flow, state } = rig("rectangle");
    flow.placed(v(11, -4));
    press(free());
    type("x", "@5,3");
    press(field("x"));
    expect(state.placed.map((h) => h.p)).toEqual([v(16, -1)]);

    state.base = null;
    flow.reset();
    press(free());
    type("x", "@5,3");
    press(field("x"));
    expect(state.placed.map((h) => h.p)).toEqual([v(16, -1), v(5, 3)]);
  });

  it("does not read a second Y as typed because Tab passed over it", () => {
    const { flow, state } = rig("line");
    flow.placed(v(11, -4));
    press(free());
    type("x", "@5");
    press(field("x"), { key: "Tab" });
    press(field("y"), { key: "Tab" });
    press(field("y"));
    expect(state.placed.map((h) => h.p)).toEqual([v(16, -4)]);
  });
});

describe("pending", () => {
  it("is true with the box open and nothing placed, for an armed tool only", () => {
    const { flow, state } = rig("line");
    expect(flow.pending()).toBe(false);
    press(free());
    expect(flow.pending()).toBe(true);
    state.base = v(1, 1);
    expect(flow.pending()).toBe(false);
    state.base = null;
    state.tool = "select";
    expect(flow.pending()).toBe(false);
  });
});

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

describe("a character opens the box with it typed in X", () => {
  for (const ch of ["7", "0", "-", ".", "@"]) {
    for (const tool of ["line", "rectangle", "circle"]) {
      it(`${JSON.stringify(ch)} in the ${tool} tool`, async () => {
        const { state } = rig(tool);
        const e = press(free(), { key: ch });
        expect(e.defaultPrevented).toBe(true);
        expect(boxFields()).toEqual(["x", "y"]);
        await frame();
        expect(field("x").value).toBe(ch);
        expect(field("y").value).toBe("-7.25");
        expect(document.activeElement).toBe(field("x"));
        expect(state.boxAt).toEqual([v(13.5, -7.25)]);
        expect(state.placed).toEqual([]);
      });
    }
  }

  it("goes on typing into X, and reads the whole entry on Enter", async () => {
    const { state } = rig("rectangle");
    press(free(), { key: "2" });
    await frame();
    field("x").value += "5";
    field("x").dispatchEvent(new Event("input", { bubbles: true }));
    press(field("x"), { key: "Tab" });
    type("y", "-7");
    press(field("y"));
    expect(state.placed.map((h) => h.p)).toEqual([v(25, -7)]);
  });

  it("types each of two quick characters, the first being a frame before the second", async () => {
    rig("line");
    press(free(), { key: "1" });
    await frame();
    press(free(), { key: "2" });
    expect(field("x").value).toBe("12");
  });

  it("types into an open box when focus has left it", () => {
    rig("circle");
    press(free());
    type("x", "4");
    (document.activeElement as HTMLElement).blur();
    press(free(), { key: "5" });
    expect(field("x").value).toBe("45");
  });

  it("leaves a letter alone", () => {
    rig("line");
    for (const key of ["a", "r", "e", ","]) expect(press(free(), { key }).defaultPrevented, key).toBe(false);
    expect(dim.isActive).toBe(false);
  });

  it("leaves Ctrl, Meta and Alt chords alone, but takes an AltGr @", async () => {
    rig("line");
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(press(free(), { key: "5", ...init }).defaultPrevented, JSON.stringify(init)).toBe(false);
      expect(press(free(), { key: "@", ...init }).defaultPrevented, `@ ${JSON.stringify(init)}`).toBe(false);
    }
    expect(dim.isActive).toBe(false);
    expect(press(free(), { key: "@", ctrlKey: true, altKey: true }).defaultPrevented).toBe(true);
    await frame();
    expect(field("x").value).toBe("@");
  });

  it("takes a shifted character, as an AZERTY digit comes", async () => {
    rig("line");
    expect(press(free(), { key: "4", shiftKey: true }).defaultPrevented).toBe(true);
    await frame();
    expect(field("x").value).toBe("4");
  });

  it("ignores a held key and every opener on a control or inside the own box", () => {
    rig("line");
    expect(press(free(), { key: "5", repeat: true }).defaultPrevented).toBe(false);
    expect(press(document.getElementById("rail")!, { key: "5" }).defaultPrevented).toBe(false);
    expect(dim.isActive).toBe(false);
    press(free());
    expect(press(field("x"), { key: "5" }).defaultPrevented).toBe(false);
    expect(field("x").value).toBe("13.5");
  });

  it("is left alone in other tools and once a point is placed", () => {
    for (const tool of ["select", "arc", "polygon"]) {
      rig(tool);
      expect(press(free(), { key: "5" }).defaultPrevented, tool).toBe(false);
      expect(dim.isActive, tool).toBe(false);
      dim.dispose();
    }
    const { state } = rig("rectangle");
    state.base = v(1, 2);
    expect(press(free(), { key: "5" }).defaultPrevented).toBe(false);
  });

  it("edge-on: says so and opens nothing", () => {
    const { state } = rig("line");
    state.edgeOn = true;
    expect(press(free(), { key: "5" }).defaultPrevented).toBe(true);
    expect(state.prompts).toEqual([EDGE_ON_PROMPT]);
    expect(dim.isActive).toBe(false);
  });

  it("with single key shortcuts off opens nothing and leaves the key alone, Enter still opens", () => {
    rig("line");
    setA11yPref("singleKeys", false);
    for (const key of ["5", "-", ".", "@"]) expect(press(free(), { key }).defaultPrevented, key).toBe(false);
    expect(dim.isActive).toBe(false);
    expect(press(free()).defaultPrevented).toBe(true);
    expect(boxFields()).toEqual(["x", "y"]);
  });
});
