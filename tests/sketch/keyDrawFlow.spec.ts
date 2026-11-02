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

import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import Select from "../../src/components/ui/Select.vue";
import Slider from "../../src/components/ui/Slider.vue";
import Toolbar from "../../src/components/ui/Toolbar.vue";
import { DimInput } from "../../src/sketch/dimInput";
import { EDGE_ON_PROMPT, KeyDrawFlow, type Drawn, type KeyDrawHost, type KeyHit } from "../../src/sketch/keyDrawFlow";
import type { ResolvedEntity, SnapCandidate } from "../../src/sketch/snap";
import { setA11yPref } from "../../src/ui/a11yPrefs";
import { announce, cancelAnnouncement } from "../../src/ui/announce";
import { claimEscape } from "../../src/ui/escapeClaim";

let dim: DimInput;
let listener: ((e: KeyboardEvent) => void) | null = null;

afterEach(() => {
  if (listener) window.removeEventListener("keydown", listener, true);
  listener = null;
  dim.dispose();
  document.body.innerHTML = "";
});
beforeEach(() => {
  vi.mocked(announce).mockClear();
  vi.mocked(cancelAnnouncement).mockClear();
});
afterEach(() => setA11yPref("singleKeys", true));
// A closed menu or popover releases its Escape claim on the next tick, which a synchronous test would carry over.
afterEach(() => new Promise((r) => setTimeout(r, 0)));

let flowOf: KeyDrawFlow | null = null;
const v = (x: number, y: number) => new THREE.Vector2(x, y);

function rig(tool = "rectangle", over: Partial<KeyDrawHost> = {}) {
  if (listener) window.removeEventListener("keydown", listener, true);
  dim?.dispose();
  document.body.innerHTML = '<main id="main"><div id="free"></div><button id="rail">r</button></main>';
  dim = new DimInput();
  const state = {
    tool,
    base: null as THREE.Vector2 | null,
    cursor: v(13.5, -7.25),
    step: 5,
    moved: [] as KeyHit[],
    edgeOn: false,
    placed: [] as KeyHit[],
    drawn: null as Drawn | null,
    prompts: [] as string[],
    boxAt: [] as THREE.Vector2[],
    surfaced: 0,
    changed: 0,
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
    step: () => state.step,
    moveTo: (hit) => {
      state.moved.push(hit);
      state.cursor = hit.p.clone();
    },
    dim: () => dim,
    place: (hit) => {
      state.placed.push(hit);
      flowOf?.placed(hit.p);
      state.base = hit.p.clone();
      dim.hide();
      return state.drawn;
    },
    positionBox: (p) => state.boxAt.push(p.clone()),
    prompt: (t) => state.prompts.push(t),
    focusSurface: () => {
      state.surfaced++;
      return true;
    },
    changed: () => {
      state.changed++;
    },
    ...over,
  };
  const flow = new KeyDrawFlow(host);
  flowOf = flow;
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
    expect(press(document.getElementById("rail")!, { repeat: true }).defaultPrevented).toBe(false);
    press(free(), { repeat: true });
    expect(dim.isActive).toBe(false);
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

describe("a held Enter", () => {
  it("opens the box once and does not go on to place a point", () => {
    const { state } = rig("line");
    press(free());
    expect(dim.hasField("x")).toBe(true);
    press(field("x"), { repeat: true });
    press(field("x"), { repeat: true });
    expect(state.placed).toEqual([]);
    expect(dim.hasField("x")).toBe(true);
    press(field("x"));
    expect(state.placed).toHaveLength(1);
  });

  it("does not reach the box's own Enter, which every other tool's box still has", () => {
    rig("select");
    const done = vi.fn();
    dim.show([{ name: "width", label: "W" }], done);
    type("width", "5");
    press(field("width"), { repeat: true });
    expect(done).toHaveBeenCalledTimes(1);
    rig("line");
    const held = vi.fn();
    dim.show([{ name: "width", label: "W" }], held);
    type("width", "5");
    expect(press(field("width"), { repeat: true }).defaultPrevented).toBe(true);
    expect(held).not.toHaveBeenCalled();
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

  it("refuses a point too far out in the box, spoken, with nothing placed", () => {
    const { state } = rig("line");
    press(free());
    type("x", "1e18");
    press(field("x"));
    expect(state.placed).toEqual([]);
    expect(dim.isActive).toBe(true);
    expect(document.activeElement).toBe(field("x"));
    expect(document.querySelector(".dim-input")?.textContent).toContain("X is too far out");
    expect(announce).toHaveBeenCalledWith("X is too far out, a point stays within 1 km of the origin", "assertive");
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

describe("a field of the X and Y box left alone", () => {
  const anchor = { p: v(60.1234, 10.5678), kind: "endpoint", priority: 90, ref: { entity: "l2", at: 1 } } as SnapCandidate;
  const opened = () => {
    const r = rig("line");
    r.state.candidates.push(anchor);
    r.state.cursor = anchor.p.clone();
    press(free(), { shiftKey: true });
    expect(field("x").value).toBe("60.12");
    return r;
  };

  it("places the snap the cursor stood on, with its ref, though the box shows it rounded", () => {
    const { state } = opened();
    press(field("x"));
    expect(state.placed).toEqual([{ p: v(60.1234, 10.5678), kind: "endpoint", label: undefined, ref: anchor.ref }]);
  });

  it("keeps Y's own value with X typed, and X's own with Y typed", () => {
    const a = opened();
    type("x", "20");
    press(field("x"));
    expect(a.state.placed.map((h) => h.p)).toEqual([v(20, 10.5678)]);
    const b = opened();
    type("y", "-4");
    press(field("y"));
    expect(b.state.placed.map((h) => h.p)).toEqual([v(60.1234, -4)]);
  });

  it("follows an arrow in the open box, and not a pointer that moved under it", () => {
    const a = opened();
    press(field("x"), { key: "ArrowRight" });
    expect(a.state.cursor).toEqual(v(65, 10.5678));
    press(field("x"));
    expect(a.state.placed.map((h) => h.p)).toEqual([v(65, 10.5678)]);
    const b = opened();
    b.state.cursor = v(-31, 44);
    press(field("x"));
    expect(b.state.placed.map((h) => h.p)).toEqual([v(60.1234, 10.5678)]);
  });
});

describe("what is said when a shape is finished", () => {
  const said = () => vi.mocked(announce).mock.calls;

  it("joins the point and the shape a typed second point finished, in one sentence", () => {
    const { flow, state } = rig("rectangle");
    flow.placed(v(11, -4));
    state.drawn = { entity: { type: "rectangle", id: "r1", width: 40, height: 20.5, x: 31, y: 6.25 }, closed: false };
    state.entities.push(state.drawn.entity);
    press(free());
    type("x", "@40,20.5");
    press(field("x"));
    expect(said()).toEqual([["Point at 51, 16.5. Rectangle 1, 40 by 20.5", "polite", { key: "sketch-point" }]]);
  });

  it("says the point alone while no shape came of it", () => {
    const { state } = rig("line");
    press(free());
    type("x", "5");
    type("y", "-7");
    press(field("y"));
    expect(state.drawn).toBeNull();
    expect(said()).toEqual([["Point at 5, minus 7", "polite", { key: "sketch-point" }]]);
  });

  it("says a shape finished from the size box by its own sentence, closed or not", () => {
    const { flow, state } = rig("line");
    flow.drawn({ entity: { type: "line", id: "l1", x1: 0, y1: 0, x2: 3, y2: 4 }, closed: false });
    flow.drawn({ entity: { type: "line", id: "l2", x1: 30, y1: 20, x2: 30, y2: 26 }, closed: true });
    expect(state.placed).toEqual([]);
    expect(said()).toEqual([
      ["Line 1, length 5", "polite", { key: "sketch-point" }],
      ["Line 2, length 6, loop closed", "polite", { key: "sketch-point" }],
    ]);
  });
});

describe("what the size box's Enter says of the end the cursor stands on", () => {
  const showSize = () =>
    dim.show(
      [
        { name: "width", label: "W" },
        { name: "height", label: "H" },
      ],
      () => {},
    );
  const arrow = (k: string, target: Element | Window = free()) => press(target, { key: k });

  it("names the point and its snap once Tab walked the cursor onto one", () => {
    const { flow, state } = rig("rectangle");
    state.base = v(10, 3);
    showSize();
    arrow("ArrowRight", field("width"));
    press(field("width"), { key: "Tab" });
    press(field("width"), { key: "Tab" });
    expect([state.cursor.x, state.cursor.y]).toEqual([40, 22.5]);
    expect(flow.boxEnd()).toEqual({
      hit: { p: v(40, 22.5), kind: "midpoint", label: undefined, ref: { entity: "l2", at: "mid" } },
      said: "Point at 40, 22.5, snapped to the midpoint of Line 2",
    });
  });

  it("names a bare point after an arrow alone, a negative as minus", () => {
    const { flow, state } = rig("rectangle");
    state.base = v(10, 3);
    showSize();
    arrow("ArrowRight", field("width"));
    arrow("ArrowDown", field("width"));
    expect(flow.boxEnd()).toEqual({
      hit: { p: v(15, -10), kind: "free", label: undefined, ref: undefined },
      said: "Point at 15, minus 10",
    });
  });

  it("is null before any key moved the cursor, once the pointer moved it, and with nothing armed", () => {
    const { flow, state } = rig("rectangle");
    state.base = v(10, 3);
    showSize();
    expect(flow.boxEnd()).toBeNull();
    arrow("ArrowRight", field("width"));
    expect(flow.boxEnd()).not.toBeNull();
    flow.pointerMoved();
    expect(flow.boxEnd()).toBeNull();
    arrow("ArrowRight", field("width"));
    state.tool = "polygon";
    expect(flow.boxEnd()).toBeNull();
  });

  it("is null when a size was typed, since the end is then not where the cursor is", () => {
    const { flow, state } = rig("rectangle");
    state.base = v(10, 3);
    showSize();
    arrow("ArrowRight", field("width"));
    type("height", "7");
    expect(flow.boxEnd()).toBeNull();
  });

  it("is joined to the shape's own sentence, and a shape without it is said alone", () => {
    const { flow } = rig("line");
    const done = { entity: { type: "line", id: "l1", x1: 10, y1: 3, x2: 40, y2: 22.5 }, closed: false } as const;
    flow.drawn(done, { hit: { p: v(40, 22.5), kind: "midpoint" }, said: "Point at 40, 22.5, snapped to the midpoint of Line 2" });
    flow.drawn(done, null);
    flow.drawn(done);
    expect(vi.mocked(announce).mock.calls.map((c) => c[0])).toEqual([
      "Point at 40, 22.5, snapped to the midpoint of Line 2. Line 1, length 35.781",
      "Line 1, length 35.781",
      "Line 1, length 35.781",
    ]);
  });
});

describe("focus and prompt of a keys session", () => {
  const showSize = () =>
    dim.show(
      [
        { name: "width", label: "W" },
        { name: "height", label: "H" },
      ],
      () => {},
    );

  it("armed by keys moves focus to the surface once and asks for the prompt again", () => {
    const { flow, state } = rig("rectangle");
    flow.armedByKeys();
    expect([state.surfaced, state.changed]).toEqual([1, 1]);
    expect(flow.keyPrompt()).toMatch(/Enter or a digit types X and Y/);
  });

  it("armed by keys in a tool that is not a key tool changes nothing", () => {
    for (const tool of ["select", "arc", "polygon"]) {
      const { flow, state } = rig(tool);
      flow.armedByKeys();
      expect([tool, state.surfaced, state.changed, flow.keyPrompt()]).toEqual([tool, 0, 0, null]);
    }
  });

  it("speaks the pointer's prompt until keys arm or open something", () => {
    const { flow, state } = rig("circle");
    expect(flow.keyPrompt()).toBeNull();
    press(free());
    expect(flow.keyPrompt()).toMatch(/X and Y/);
    expect(state.changed).toBeGreaterThan(0);
  });

  it("reads the X and Y line while the box has X, the size line once a point is placed, X and Y again after @", () => {
    const { flow, state } = rig("line");
    flow.armedByKeys();
    press(free());
    expect(flow.keyPrompt()).toMatch(/Type X and Y/);
    type("x", "25");
    type("y", "3");
    press(field("y"));
    state.base = v(25, 3);
    showSize();
    expect(flow.keyPrompt()).toMatch(/size/);
    expect(flow.keyPrompt()).not.toMatch(/X and Y/);
    field("width").focus();
    press(field("width"), { key: "@" });
    expect(boxFields()).toEqual(["x", "y"]);
    expect(flow.keyPrompt()).toMatch(/Type X and Y/);
  });

  it("is null when the tool is changed away or after the pointer pressed, and says so once", () => {
    const { flow, state } = rig("line");
    flow.armedByKeys();
    state.changed = 0;
    flow.pointerPressed();
    expect([flow.keyPrompt(), state.changed]).toEqual([null, 1]);
    flow.pointerPressed();
    expect(state.changed).toBe(1);
    flow.armedByKeys();
    flow.disarm();
    expect(flow.keyPrompt()).toBeNull();
    flow.armedByKeys();
    state.tool = "select";
    expect(flow.keyPrompt()).toBeNull();
  });

  it("is a pointer session again after reset, with nothing leaking into the next sketch", () => {
    const { flow } = rig("rectangle");
    flow.armedByKeys();
    flow.reset();
    expect(flow.keyPrompt()).toBeNull();
  });

  it("brings focus back to the surface when a placed point closed the box onto the body", () => {
    const { flow, state } = rig("line");
    press(free());
    type("x", "25");
    type("y", "3");
    press(field("y"));
    expect(document.activeElement).toBe(document.body);
    expect(state.surfaced).toBe(1);
    expect(flow.keyPrompt()).toMatch(/size/);
  });

  it("leaves focus alone when it is on a control, when a box is still open and when no keys session runs", () => {
    const { flow, state } = rig("line");
    flow.armedByKeys();
    state.surfaced = 0;
    document.getElementById("rail")!.focus();
    flow.settleFocus();
    expect(state.surfaced).toBe(0);
    (document.activeElement as HTMLElement).blur();
    showSize();
    (document.activeElement as HTMLElement).blur();
    flow.settleFocus();
    expect(state.surfaced).toBe(0);
    dim.hide();
    flow.settleFocus();
    expect(state.surfaced).toBe(1);
    flow.pointerPressed();
    flow.settleFocus();
    expect(state.surfaced).toBe(1);
  });

  it("takes focus back after Escape dropped an open box, and says nothing outside a keys session", () => {
    const { flow, state } = rig("rectangle");
    press(free());
    dim.hide();
    state.changed = 0;
    flow.cancelled();
    expect([state.surfaced, state.changed]).toEqual([1, 1]);
    flow.pointerPressed();
    state.changed = 0;
    flow.cancelled();
    expect([state.surfaced, state.changed]).toEqual([1, 0]);
  });

  it("takes focus back after a finished shape closed the size box", () => {
    const { flow, state } = rig("circle");
    flow.armedByKeys();
    state.surfaced = 0;
    state.base = v(1, 2);
    showSize();
    dim.hide();
    flow.drawn({ entity: { type: "circle", id: "c1", x: 1, y: 2, radius: 5 }, closed: false });
    expect(state.surfaced).toBe(1);
  });
});

describe("arrows move the cursor", () => {
  const arrow = (key: string, target: Element | Window = free(), init: KeyboardEventInit = {}) =>
    press(target, { key, ...init });
  const hit = (x: number, y: number) => ({ p: v(x, y), kind: "free", label: undefined, ref: undefined });

  it("takes each arrow one step along one axis, Up and Right being plus", () => {
    const { state } = rig("rectangle");
    for (const [key, to] of [
      ["ArrowRight", [15, -7.25]],
      ["ArrowUp", [15, -5]],
      ["ArrowLeft", [10, -5]],
      ["ArrowDown", [10, -10]],
    ] as const) {
      const e = arrow(key);
      expect(e.defaultPrevented).toBe(true);
      expect(state.cursor).toEqual(v(to[0], to[1]));
    }
    expect(state.moved).toEqual([hit(15, -7.25), hit(15, -5), hit(10, -5), hit(10, -10)]);
  });

  it("works for the three draw tools only", () => {
    for (const tool of ["line", "circle"]) {
      const { state } = rig(tool);
      expect(arrow("ArrowRight").defaultPrevented).toBe(true);
      expect(state.cursor).toEqual(v(15, -7.25));
    }
    for (const tool of ["select", "arc", "polygon"]) {
      const { state } = rig(tool);
      expect(arrow("ArrowRight").defaultPrevented).toBe(false);
      expect(state.moved).toEqual([]);
    }
  });

  it("goes a finer step with Shift and a coarser one with Alt, Shift winning when both are down", () => {
    const { state } = rig("rectangle");
    arrow("ArrowRight", free(), { shiftKey: true });
    expect(state.cursor).toEqual(v(14, -7.25));
    arrow("ArrowUp", free(), { altKey: true });
    expect(state.cursor).toEqual(v(14, 0));
    arrow("ArrowLeft", free(), { altKey: true, shiftKey: true });
    expect(state.cursor).toEqual(v(13, 0));
  });

  it("reports the snap candidate it lands on and none one lattice line short", () => {
    const { state } = rig("line");
    state.cursor = v(35, 22.5);
    arrow("ArrowRight");
    expect(state.moved.at(-1)).toEqual({
      p: v(40, 22.5),
      kind: "midpoint",
      label: undefined,
      ref: { entity: "l2", at: "mid" },
    });
    arrow("ArrowRight");
    expect(state.moved.at(-1)).toEqual(hit(45, 22.5));
    state.cursor = v(5, 0);
    arrow("ArrowLeft");
    expect(state.moved.at(-1)).toEqual({ p: v(0, 0), kind: "center", label: "Origin", ref: undefined });
  });

  it("steps from off the lattice and by a fraction", () => {
    const { state } = rig("rectangle");
    state.step = 0.1;
    state.cursor = v(0.3, 0.45);
    arrow("ArrowRight");
    arrow("ArrowUp");
    expect(state.cursor).toEqual(v(0.4, 0.5));
  });

  it("moves from the page body and from a plain place of the model area alike", () => {
    const { state } = rig("rectangle");
    arrow("ArrowRight", document.body);
    arrow("ArrowRight", free());
    expect(state.cursor).toEqual(v(20, -7.25));
  });

  it("is told to the screen as one sentence, with the step only when it changed", () => {
    const { flow } = rig("rectangle");
    const said = () => vi.mocked(announce).mock.calls.map((c) => c[0]);
    arrow("ArrowRight");
    arrow("ArrowRight");
    arrow("ArrowRight", free(), { shiftKey: true });
    arrow("ArrowRight", free(), { shiftKey: true });
    arrow("ArrowUp");
    expect(said()).toEqual([
      "Grid step 5 mm. Cursor at 15, minus 7.25",
      "Cursor at 20, minus 7.25",
      "Grid step 1 mm. Cursor at 21, minus 7.25",
      "Cursor at 22, minus 7.25",
      "Grid step 5 mm. Cursor at 22, minus 5",
    ]);
    expect(
      vi
        .mocked(announce)
        .mock.calls.every((c) => c[1] === "polite" && c[2]?.key === "sketch-cursor" && c[2].delay === 150),
    ).toBe(true);
    flow.reset();
    arrow("ArrowUp");
    expect(said().at(-1)).toMatch(/^Grid step 5 mm\./);
  });

  it("names the snap it stands on in the sentence", () => {
    const { state } = rig("line");
    state.cursor = v(35, 22.5);
    arrow("ArrowRight");
    expect(vi.mocked(announce).mock.calls.at(-1)?.[0]).toMatch(
      /Cursor at 40, 22\.5, snapped to the midpoint of Line 2/,
    );
  });

  it("is left to the view edge-on, under an open overlay, with Ctrl or Meta, or once a key handler took it", async () => {
    const { state } = rig("rectangle");
    state.edgeOn = true;
    expect(arrow("ArrowRight").defaultPrevented).toBe(false);
    state.edgeOn = false;
    const release = claimEscape();
    expect(arrow("ArrowRight").defaultPrevented).toBe(false);
    release();
    // The claim lapses on the next tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(arrow("ArrowRight", free(), { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(arrow("ArrowRight", free(), { metaKey: true }).defaultPrevented).toBe(false);
    const taken = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true, bubbles: true });
    taken.preventDefault();
    free().dispatchEvent(taken);
    expect(state.moved).toEqual([]);
  });

  it("is not taken from a tree, a slider, a menu or a text field, and none of them loses its arrows", () => {
    const { state } = rig("rectangle");
    const main = document.getElementById("main")!;
    main.insertAdjacentHTML(
      "beforeend",
      '<div role="tree"><div role="treeitem" tabindex="0" id="row">r</div></div><input type="range" id="range"><div role="menu"><button role="menuitem" id="item">m</button></div><input type="text" id="text">',
    );
    for (const id of ["row", "range", "item", "text"]) {
      const el = document.getElementById(id)!;
      expect(arrow("ArrowRight", el).defaultPrevented, id).toBe(false);
      expect(arrow("ArrowDown", el, { altKey: true }).defaultPrevented, id).toBe(false);
    }
    expect(state.moved).toEqual([]);
  });

  it("stops only the view step on a plain control, and moves nothing", () => {
    const { state } = rig("rectangle");
    document.getElementById("main")!.insertAdjacentHTML("beforeend", '<button id="panel">p</button>');
    const e = arrow("ArrowLeft", document.getElementById("panel")!);
    expect(e.defaultPrevented).toBe(true);
    expect(state.moved).toEqual([]);
    expect(arrow("ArrowLeft", document.getElementById("panel")!, { altKey: true }).defaultPrevented).toBe(false);
  });

  describe("on the real widgets that move by arrows, a draw tool armed", () => {
    const untouched = (state: { moved: KeyHit[]; surfaced: number }) => {
      expect(state.moved).toEqual([]);
      expect(state.surfaced).toBe(0);
    };

    it("leaves a rail's vertical Toolbar its walk", () => {
      const { state } = rig("rectangle");
      const w = mount(Toolbar, {
        attachTo: document.body,
        props: { label: "Tools", orientation: "vertical" },
        slots: { default: '<button id="a">a</button><button id="b">b</button><button id="c">c</button>' },
      });
      const a = document.getElementById("a")!;
      a.focus();
      arrow("ArrowDown", a);
      expect(document.activeElement?.id).toBe("b");
      arrow("ArrowDown", document.activeElement!);
      expect(document.activeElement?.id).toBe("c");
      arrow("ArrowUp", document.activeElement!);
      expect(document.activeElement?.id).toBe("b");
      untouched(state);
      w.unmount();
    });

    it("leaves a Select its list", async () => {
      const { state } = rig("rectangle");
      const w = mount(Select, {
        attachTo: document.body,
        props: {
          modelValue: "a",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
          "aria-label": "Pick",
        },
      });
      const trigger = w.get('[role="combobox"]').element as HTMLElement;
      trigger.focus();
      arrow("ArrowDown", trigger);
      await nextTick();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      untouched(state);
      w.unmount();
    });

    it("leaves a Slider its value", () => {
      const { state } = rig("rectangle");
      const w = mount(Slider, { attachTo: document.body, props: { modelValue: 5, min: 0, max: 10, step: 1, label: "S" } });
      const thumb = w.get('[role="slider"], input[type="range"]').element as HTMLElement;
      thumb.focus();
      const e = arrow("ArrowRight", thumb);
      expect(e.defaultPrevented).toBe(true);
      expect(w.emitted("update:modelValue")?.[0]).toEqual([6]);
      untouched(state);
      w.unmount();
    });

    it.each([
      ["a listbox option", '<div role="listbox"><div role="option" id="t" tabindex="0">o</div></div>'],
      ["a menu row", '<div class="ui-menu"><button role="menuitem" id="t">m</button></div>'],
      ["a tab", '<div role="tablist"><button role="tab" id="t">t</button></div>'],
      ["a radio", '<div role="radiogroup"><button role="radio" id="t">r</button></div>'],
      ["a tree row", '<div role="tree"><div role="treeitem" id="t" tabindex="0">r</div></div>'],
      ["a timeline step", '<div role="list"><div role="listitem"><div role="button" id="t" tabindex="0">s</div></div></div>'],
      ["a text field", '<input type="text" id="t">'],
      ["a number field", '<input type="number" id="t">'],
      ["a text area", '<textarea id="t"></textarea>'],
    ])("takes nothing from %s", (_, html) => {
      for (const parent of ["main", "body"]) {
        const { state } = rig("rectangle");
        (parent === "main" ? document.getElementById("main")! : document.body).insertAdjacentHTML("beforeend", html);
        for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
          expect(arrow(key, document.getElementById("t")!).defaultPrevented, key).toBe(false);
          expect(arrow(key, document.getElementById("t")!, { shiftKey: true }).defaultPrevented, key).toBe(false);
        }
        untouched(state);
      }
    });
  });

  describe("in the value box", () => {
    const showSize = () =>
      dim.show(
        [
          { name: "width", label: "W" },
          { name: "height", label: "H" },
        ],
        () => {},
      );

    it("moves the cursor from a field nothing was typed in", () => {
      const { state } = rig("rectangle");
      state.base = v(10, 3);
      showSize();
      const e = arrow("ArrowRight", field("width"));
      expect(e.defaultPrevented).toBe(true);
      expect(state.cursor).toEqual(v(15, -7.25));
    });

    it("is the caret's once something is typed in any field, and Alt+Down is the unit list's", () => {
      const { state } = rig("rectangle");
      state.base = v(10, 3);
      showSize();
      arrow("ArrowDown", field("width"), { altKey: true });
      expect(state.moved).toEqual([]);
      type("height", "8");
      expect(arrow("ArrowRight", field("width")).defaultPrevented).toBe(false);
      expect(arrow("ArrowLeft", field("height")).defaultPrevented).toBe(false);
      expect(state.moved).toEqual([]);
    });

    it("leaves a button of the box to the box", () => {
      const { state } = rig("rectangle");
      state.base = v(10, 3);
      showSize();
      const button = document.querySelector<HTMLElement>(".dim-input button")!;
      expect(arrow("ArrowRight", button).defaultPrevented).toBe(false);
      expect(state.moved).toEqual([]);
    });

    it("carries the X and Y fields and the box along with the cursor", () => {
      const { state } = rig("line");
      press(free());
      state.boxAt.length = 0;
      arrow("ArrowRight", field("x"));
      arrow("ArrowUp", field("y"));
      expect([field("x").value, field("y").value]).toEqual(["15", "-5"]);
      expect(state.boxAt).toEqual([v(15, -7.25), v(15, -5)]);
    });
  });
});

describe("Enter places at the cursor an arrow moved", () => {
  const arrow = (key: string, init: KeyboardEventInit = {}) => press(free(), { key, ...init });
  const showSize = () =>
    dim.show(
      [
        { name: "width", label: "W" },
        { name: "height", label: "H" },
      ],
      () => {},
    );

  it("places there after an arrow and opens X and Y before one", () => {
    const { state } = rig("rectangle");
    arrow("ArrowRight");
    arrow("ArrowUp");
    const e = press(free());
    expect(e.defaultPrevented).toBe(true);
    expect(state.placed).toEqual([{ p: v(15, -5), kind: "free", label: undefined, ref: undefined }]);
    expect(state.base).toEqual(v(15, -5));
    expect(boxFields()).toEqual([]);
    expect(vi.mocked(announce).mock.calls.at(-1)).toEqual(["Point at 15, minus 5", "polite", { key: "sketch-point" }]);
  });

  it("carries a snap the cursor stands on", () => {
    const { state } = rig("line");
    state.cursor = v(35, 22.5);
    arrow("ArrowRight");
    press(free());
    expect(state.placed).toEqual([
      { p: v(40, 22.5), kind: "midpoint", label: undefined, ref: { entity: "l2", at: "mid" } },
    ]);
    expect(vi.mocked(announce).mock.calls.at(-1)?.[0]).toBe("Point at 40, 22.5, snapped to the midpoint of Line 2");
  });

  it("drops an arrow's sentence still waiting when a point is placed", () => {
    const { flow } = rig("rectangle");
    arrow("ArrowRight");
    flow.placed(v(15, -7.25));
    expect(cancelAnnouncement).toHaveBeenCalledWith("sketch-cursor");
  });

  it("places the next point from the surface, a second one needing another arrow", () => {
    const { state } = rig("rectangle");
    arrow("ArrowRight");
    press(free());
    showSize();
    arrow("ArrowUp");
    arrow("ArrowUp");
    state.placed.length = 0;
    press(free());
    expect(state.placed.map((h) => h.p)).toEqual([v(15, 0)]);
    state.placed.length = 0;
    press(free());
    expect(state.placed).toEqual([]);
  });

  it("leaves a box with typed text to the box", () => {
    const { state } = rig("rectangle");
    arrow("ArrowRight");
    press(free());
    showSize();
    arrow("ArrowUp");
    type("width", "40");
    const e = press(free());
    expect(e.defaultPrevented).toBe(false);
    expect(state.placed).toHaveLength(1);
  });

  it("opens X and Y again once the pointer moved the cursor, or the tool was changed away", () => {
    const { flow, state } = rig("rectangle");
    arrow("ArrowRight");
    flow.pointerMoved();
    press(free());
    expect(boxFields()).toEqual(["x", "y"]);
    expect(state.placed).toEqual([]);
    dim.hide();
    arrow("ArrowRight");
    flow.disarm();
    press(free());
    expect(boxFields()).toEqual(["x", "y"]);
    expect(state.placed).toEqual([]);
  });

  it("opens X and Y with Shift+Enter whether or not an arrow moved the cursor", () => {
    const { state } = rig("rectangle");
    expect(press(free(), { shiftKey: true }).defaultPrevented).toBe(true);
    expect(boxFields()).toEqual(["x", "y"]);
    dim.hide();
    arrow("ArrowRight");
    press(free(), { shiftKey: true });
    expect(boxFields()).toEqual(["x", "y"]);
    expect([field("x").value, field("y").value]).toEqual(["15", "-7.25"]);
    expect(state.placed).toEqual([]);
  });

  it("opens the box for a second point with Shift+Enter from the size box, without committing it", () => {
    const { state } = rig("rectangle");
    state.base = v(10, 3);
    showSize();
    field("width").focus();
    const e = press(field("width"), { shiftKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(boxFields()).toEqual(["x", "y"]);
    expect(state.placed).toEqual([]);
  });

  it("opens with Shift+Enter when single key shortcuts are off, and leaves a control's Enter alone", () => {
    setA11yPref("singleKeys", false);
    const { state } = rig("rectangle");
    press(free(), { shiftKey: true });
    expect(boxFields()).toEqual(["x", "y"]);
    dim.hide();
    const e = press(document.getElementById("rail")!, { shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(state.placed).toEqual([]);
  });

  it("places nothing edge-on and says why", () => {
    const { state } = rig("rectangle");
    arrow("ArrowRight");
    state.edgeOn = true;
    expect(press(free()).defaultPrevented).toBe(true);
    expect(state.placed).toEqual([]);
    expect(state.prompts).toEqual([EDGE_ON_PROMPT]);
  });
});

describe("the prompt follows the cursor", () => {
  it("says the cursor can be placed once an arrow moved it, and the size line after a point", () => {
    const { flow, state } = rig("circle");
    flow.armedByKeys();
    expect(flow.keyPrompt()).toMatch(/arrows move the cursor/);
    press(free(), { key: "ArrowLeft" });
    expect(flow.keyPrompt()).toMatch(/Enter places/);
    press(free());
    expect(state.base).not.toBeNull();
    expect(flow.keyPrompt()).toMatch(/size/);
    expect(flow.keyPrompt()).toMatch(/arrows move/);
  });
});

describe("Tab cycles the snaps", () => {
  const key = (k: string, target: Element | Window = free(), init: KeyboardEventInit = {}) =>
    press(target, { key: k, ...init });
  const tab = (init: KeyboardEventInit = {}, target: Element | Window = free()) => key("Tab", target, init);
  const hit = (x: number, y: number, c: SnapCandidate) => ({ p: v(x, y), kind: c.kind, label: c.label, ref: c.ref });
  const xy = (s: { cursor: THREE.Vector2 }) => [s.cursor.x, s.cursor.y];
  // After one arrow the cursor is at (15, -7.25), so they lie in this order.
  const near: SnapCandidate = { p: v(20, 6), kind: "endpoint", priority: 100, ref: { entity: "l1", at: 1 } };
  const mid: SnapCandidate = { p: v(40, 22.5), kind: "midpoint", priority: 80, ref: { entity: "l2", at: "mid" } };
  const far: SnapCandidate = { p: v(-30, -25), kind: "center", priority: 95, label: "Origin" };
  const withRing = (tool = "rectangle") => {
    const r = rig(tool);
    r.state.candidates = [mid, far, near];
    return r;
  };

  it("is left to the page before an arrow, with no snap to offer, and in other tools", () => {
    const { state } = withRing();
    expect(tab().defaultPrevented).toBe(false);
    key("ArrowRight");
    state.candidates = [];
    expect(tab().defaultPrevented).toBe(false);
    expect(state.moved).toHaveLength(1);
    const other = withRing("polygon");
    key("ArrowRight");
    expect(tab().defaultPrevented).toBe(false);
    expect(other.state.moved).toEqual([]);
  });

  it("leaves a candidate that is only under the cursor to the page", () => {
    const { state } = rig("line");
    state.candidates = [{ p: v(15, -7.25), kind: "endpoint", priority: 100 }];
    key("ArrowRight");
    expect(tab().defaultPrevented).toBe(false);
  });

  it("walks the snaps nearest first and back to where it started", () => {
    const { state } = withRing();
    key("ArrowRight");
    state.moved.length = 0;
    const seen: number[][] = [];
    for (let k = 0; k < 5; k++) {
      expect(tab().defaultPrevented).toBe(true);
      seen.push(xy(state));
    }
    expect(seen).toEqual([
      [20, 6],
      [40, 22.5],
      [-30, -25],
      [15, -7.25],
      [20, 6],
    ]);
    expect(state.moved).toEqual([
      hit(20, 6, near),
      hit(40, 22.5, mid),
      hit(-30, -25, far),
      { p: v(15, -7.25), kind: "free", label: undefined, ref: undefined },
      hit(20, 6, near),
    ]);
  });

  it("walks it back with Shift+Tab, from the start to the last", () => {
    const { state } = withRing();
    key("ArrowRight");
    tab({ shiftKey: true });
    expect(xy(state)).toEqual([-30, -25]);
    tab({ shiftKey: true });
    expect(xy(state)).toEqual([40, 22.5]);
    tab({ shiftKey: true });
    tab({ shiftKey: true });
    expect(xy(state)).toEqual([15, -7.25]);
    tab();
    expect(xy(state)).toEqual([20, 6]);
  });

  it("skips the point already placed", () => {
    const { state } = withRing("line");
    state.base = v(20, 6);
    key("ArrowRight");
    tab();
    expect(xy(state)).toEqual([40, 22.5]);
  });

  it("drops the walk on an arrow, a pointer move and a placed point", () => {
    const { flow, state } = withRing();
    key("ArrowRight");
    tab();
    tab();
    key("ArrowUp");
    expect(xy(state)).toEqual([40, 25]);
    tab();
    expect(xy(state)).toEqual([40, 22.5]);
    flow.pointerMoved();
    expect(tab().defaultPrevented).toBe(false);
    key("ArrowLeft");
    tab();
    expect(state.moved.at(-1)).toEqual(hit(40, 22.5, mid));
    key("Enter");
    expect(state.placed).toEqual([hit(40, 22.5, mid)]);
    key("ArrowRight");
    tab();
    expect(xy(state)).toEqual([20, 6]);
  });

  it("says each stop with what it is", () => {
    withRing();
    key("ArrowRight");
    vi.mocked(announce).mockClear();
    tab();
    tab();
    tab();
    expect(vi.mocked(announce).mock.calls.map((c) => c[0])).toEqual([
      "Cursor at 20, 6, snapped to the end of Line 1",
      "Cursor at 40, 22.5, snapped to the midpoint of Line 2",
      "Cursor at minus 30, minus 25, snapped to the origin",
    ]);
  });

  it("places the picked midpoint with its ref and says it", () => {
    const { state } = withRing();
    key("ArrowRight");
    tab();
    tab();
    key("Enter");
    expect(state.placed).toEqual([hit(40, 22.5, mid)]);
    expect(vi.mocked(announce).mock.calls.at(-1)![0]).toBe("Point at 40, 22.5, snapped to the midpoint of Line 2");
  });

  it("keeps the Tab of a control and of a chord", () => {
    withRing();
    key("ArrowRight");
    const rail = document.getElementById("rail")!;
    expect(tab({}, rail).defaultPrevented).toBe(false);
    expect(tab({ ctrlKey: true }).defaultPrevented).toBe(false);
    expect(tab({ altKey: true }).defaultPrevented).toBe(false);
  });

  it("stands aside for an open overlay and an edge-on plane", () => {
    const { state } = withRing();
    key("ArrowRight");
    const release = claimEscape();
    expect(tab().defaultPrevented).toBe(false);
    release();
    state.edgeOn = true;
    expect(tab().defaultPrevented).toBe(false);
  });

  describe("in a size box", () => {
    const showSize = () =>
      dim.show(
        [
          { name: "width", label: "W" },
          { name: "height", label: "H" },
        ],
        () => {},
      );

    it("cycles while nothing is typed and moves on once something is", () => {
      const { state } = withRing("rectangle");
      state.base = v(10, 3);
      showSize();
      key("ArrowRight", field("width"));
      expect(tab({}, field("width")).defaultPrevented).toBe(true);
      expect(xy(state)).toEqual([20, 6]);
      type("width", "40");
      const before = state.moved.length;
      tab({}, field("width"));
      expect(state.moved).toHaveLength(before);
      expect(xy(state)).toEqual([20, 6]);
    });

    it("leaves the Tab of the X and Y box to its fields", () => {
      const { state } = withRing("line");
      key("ArrowRight");
      key("Enter", free(), { shiftKey: true });
      expect(boxFields()).toEqual(["x", "y"]);
      tab({}, field("x"));
      expect(state.moved).toHaveLength(1);
      expect(document.activeElement).toBe(field("y"));
    });
  });

  it("names Tab in the prompt only when a snap is there to reach", () => {
    const { flow, state } = withRing("circle");
    flow.armedByKeys();
    key("ArrowRight");
    expect(flow.keyPrompt()).toMatch(/Tab next snap/);
    state.candidates = [];
    expect(flow.keyPrompt()).toMatch(/Enter places/);
    expect(flow.keyPrompt()).not.toMatch(/Tab/);
  });
});
