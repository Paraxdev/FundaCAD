// The keys on the focused 3D view, over the real Geometry list controller and store: stepping, picking, every guard
// that stands them down, and what the next document never sees.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { installCanvasPick, type CanvasPickHost } from "../../src/app/canvasPick";
import { setMacForTest } from "../../src/input/platform";
import { useModalStore } from "../../src/stores/modals";
import { useSelectionStore } from "../../src/stores/selection";
import { setA11yPref } from "../../src/ui/a11yPrefs";
import { announce } from "../../src/ui/announce";
import { describePick } from "../../src/ui/describePick";
import {
  awaitTreePick,
  endRewoundPick,
  resetTreePicks,
  type TreePick,
  type TreePickAnswer,
} from "../../src/ui/treePick";
import { edge, land, previewOnScreen, result, rig, topology } from "./geometryBrowserRig";
import { t } from "../../src/i18n";

vi.mock("../../src/ui/toast", () => ({ toast: () => {}, dismissToast: () => {}, dismissToastsSaying: () => {} }));
vi.mock("../../src/ui/announce", async (actual) => ({
  ...(await actual<typeof import("../../src/ui/announce")>()),
  announce: vi.fn(),
}));

const said = () => vi.mocked(announce).mock.calls.map((c) => c[0]);
const lastSaid = () => said().at(-1);

let canvas: HTMLCanvasElement;
let off: () => void = () => {};

function install(r: ReturnType<typeof rig>) {
  const host = { ...r.host, geometryBrowser: r.browser, viewport: { domElement: canvas } };
  off = installCanvasPick(host as unknown as CanvasPickHost);
}

async function ready(faces = 3) {
  const r = rig();
  install(r);
  await r.build();
  r.browser.show(true);
  await land(r.asks[0]!, topology("body1", faces));
  r.browser.show(false);
  r.viewport.hoverPick.mockClear();
  return r;
}

function key(k: string, init: KeyboardEventInit & { altGraph?: boolean } = {}, target: EventTarget = canvas) {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  // happy-dom answers AltGraph with altKey, a browser keeps them apart.
  ev.getModifierState = (m) => m === "AltGraph" && !!init.altGraph;
  target.dispatchEvent(ev);
  return ev;
}

const face = (faceId: number) => ({ kind: "face", faceId });

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(announce).mockClear();
  canvas = document.createElement("canvas");
  document.body.replaceChildren(canvas);
});
afterEach(() => {
  resetTreePicks();
  off();
  off = () => {};
  setA11yPref("singleKeys", true);
  setMacForTest(null);
  document.body.replaceChildren();
});

describe("stepping", () => {
  it("lights the next row, says it under one key and selects nothing", async () => {
    const r = await ready();
    const ev = key("]");
    expect(ev.defaultPrevented).toBe(true);
    expect(r.list.cursor).toBe("f:body1:0");
    expect(r.viewport.hoverPick.mock.calls).toEqual([[face(0)]]);
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
    const words = describePick(r.list.rows[0]!.facts).spoken;
    expect(vi.mocked(announce).mock.calls).toEqual([[words, "polite", { key: "pick-step", delay: 120 }]]);
  });

  it("a held key says every row under the same key, so a newer row replaces one still waiting", async () => {
    await ready();
    key("]");
    key("]", { repeat: true });
    key("]", { repeat: true });
    const calls = vi.mocked(announce).mock.calls;
    expect(calls.map((c) => c[2])).toEqual(Array(3).fill({ key: "pick-step", delay: 120 }));
    expect(new Set(calls.map((c) => c[0])).size).toBe(3);
  });

  it("walks forward and back and wraps at both ends of many rows", async () => {
    const r = await ready();
    const walk = (k: string) => {
      key(k);
      return r.list.cursor;
    };
    expect([walk("]"), walk("]"), walk("]"), walk("]")]).toEqual(["f:body1:0", "f:body1:1", "f:body1:2", "f:body1:0"]);
    expect(walk("[")).toBe("f:body1:2");
  });

  it("starts from the last row on a first [", async () => {
    const r = await ready();
    key("[");
    expect(r.list.cursor).toBe("f:body1:2");
  });

  it("stays on a lone row and says it again", async () => {
    const r = await ready(1);
    key("]");
    key("]");
    expect(r.list.cursor).toBe("f:body1:0");
    expect(r.list.litRow?.key).toBe("f:body1:0");
    expect(said()).toHaveLength(2);
    expect(said()[0]).toBe(said()[1]);
  });

  it("says there is nothing when the body has no rows", async () => {
    const r = await ready(0);
    const ev = key("]");
    expect(ev.defaultPrevented).toBe(true);
    expect(r.list.litRow).toBeNull();
    expect(r.viewport.hoverPick).not.toHaveBeenCalled();
    expect(lastSaid()).toContain("No faces");
  });

  it("says there is no body when the model has none, planes still step", async () => {
    const r = rig(result([]));
    install(r);
    await r.build();
    key("]");
    expect(r.list.litRow).toBeNull();
    expect(lastSaid()).toContain("No body");
    key("{");
    expect(r.list.kind).toBe("planes");
    key("]");
    expect(r.list.litRow?.kind).toBe("plane");
  });

  it("steps only the filtered rows and says so", async () => {
    const r = await ready();
    r.list.setFilters({ minSize: r.list.rows[1]!.size });
    key("]");
    expect(r.list.cursor).toBe("f:body1:1");
    key("]");
    expect(r.list.cursor).toBe("f:body1:2");
    key("]");
    expect(r.list.cursor).toBe("f:body1:1");
    expect(lastSaid()).toMatch(/Filtered$/);
  });

  it("says a filter hid every row", async () => {
    const r = await ready();
    r.list.setFilters({ minSize: 100000 });
    key("]");
    expect(r.list.litRow).toBeNull();
    expect(lastSaid()).toContain("filter");
  });

  it("keeps the row by its key through a build and lights it again in the new build", async () => {
    const r = await ready();
    key("]");
    key("]");
    r.viewport.hoverPick.mockClear();
    await r.build(
      result([
        { id: "body0", etag: "e0", faceCount: 4 },
        { id: "body1", etag: "e7" },
      ]),
    );
    expect(r.asks.at(-1)!.body).toBe("body1");
    await land(r.asks.at(-1)!, topology("body1"));
    expect(r.list.cursor).toBe("f:body1:1");
    expect(r.list.litRow?.key).toBe("f:body1:1");
    expect(r.viewport.hoverPick.mock.calls.at(-1)).toEqual([face(5)]);
  });

  it("hands over to the row now in its place when a build removed it", async () => {
    const r = await ready();
    key("[");
    await r.build(
      result([
        { id: "body1", etag: "e7", faceCount: 2 },
        { id: "body2", etag: "e2" },
      ]),
    );
    await land(r.asks.at(-1)!, topology("body1", 2));
    expect(r.list.litRow?.key).toBe("f:body1:1");
    expect(r.viewport.hoverPick.mock.calls.at(-1)).toEqual([face(1)]);
  });

  it("says the list waits on the open tool for a body with no rows under its preview, and none without it", async () => {
    const r = await ready(0);
    const back = previewOnScreen(r.store);
    key("]");
    expect(lastSaid()).toBe(t("geometry.list.waitsOnTool"));
    back();
    key("]");
    expect(lastSaid()).toContain("No faces");
  });

  it("says the list waits on the open tool from the first step once its preview moved the listed body", async () => {
    const r = await ready();
    const real = r.store.buildState;
    const held = (over: object) =>
      Object.defineProperty(r.store, "buildState", {
        configurable: true,
        get: () => ({ ...real, previewBuilt: [{ id: "x9", type: "press-pull" }], ...over }),
      });
    held({ result: result([{ id: "body1", etag: "e7" }]) });
    key("]");
    expect([lastSaid(), r.list.litRow]).toEqual([t("geometry.list.waitsOnTool"), null]);
    held({});
    key("]");
    expect(r.list.litRow?.key).toBe("f:body1:0");
  });

  it("refuses in words while the model is building and leaves the cursor", async () => {
    const r = await ready();
    key("]");
    Object.assign(r.viewport, { picksSuspended: true });
    const ev = key("]");
    expect(ev.defaultPrevented).toBe(true);
    expect(r.list.cursor).toBe("f:body1:0");
    expect(lastSaid()).toContain("building");
  });
});

describe("the first step before the list is there", () => {
  it("waits for the reply and then steps once, however many presses came", async () => {
    const r = rig();
    install(r);
    await r.build();
    key("]");
    key("]");
    expect(r.asks).toHaveLength(1);
    expect(r.list.litRow).toBeNull();
    expect(lastSaid()).toContain("Listing faces");
    await land(r.asks[0]!, topology("body1"));
    expect(r.list.cursor).toBe("f:body1:0");
    expect(r.viewport.hoverPick.mock.calls).toEqual([[face(0)]]);
    expect(lastSaid()).toBe(describePick(r.list.rows[0]!.facts).spoken);
  });

  it("says a failed fetch in the list's words", async () => {
    const r = rig();
    install(r);
    await r.build();
    key("]");
    await land(r.asks[0]!, null);
    expect(r.list.litRow).toBeNull();
    expect(r.list.error).toBeTruthy();
    expect(lastSaid()).toBe(r.list.error);
  });

  it("says the list waits on the open tool instead of listing while a preview holds it", async () => {
    const r = rig();
    install(r);
    await r.build();
    previewOnScreen(r.store);
    key("]");
    expect(lastSaid()).toBe(t("geometry.list.waitsOnTool"));
    expect(r.list.litRow).toBeNull();
  });

  it("drops the wait when a tool took the screen before the reply", async () => {
    const r = rig();
    install(r);
    await r.build();
    key("]");
    r.host.toolOwnsScreen.mockReturnValue(true);
    await land(r.asks[0]!, topology("body1"));
    expect(r.list.cursor).toBeNull();
    expect(r.viewport.hoverPick).not.toHaveBeenCalled();
  });

  it("drops the wait when Escape came before the reply", async () => {
    const r = rig();
    install(r);
    await r.build();
    key("]");
    key("Escape");
    await land(r.asks[0]!, topology("body1"));
    expect(r.list.cursor).toBeNull();
  });
});

describe("Enter and Space", () => {
  it("Enter selects the lit row alone, Space adds it", async () => {
    const r = await ready();
    key("]");
    expect(key("Enter").defaultPrevented).toBe(true);
    key("]");
    expect(key(" ").defaultPrevented).toBe(true);
    expect(r.viewport.applyPicks.mock.calls).toEqual([
      [[face(0)], { additive: false }],
      [[face(1)], { additive: true }],
    ]);
    expect(r.list.litRow?.key).toBe("f:body1:1");
  });

  it.each(["Enter", " "])("%s with nothing lit is left alone", async (k) => {
    const r = await ready();
    expect(key(k).defaultPrevented).toBe(false);
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
  });

  it.each(["Enter", " "])("a held %s picks once", async (k) => {
    const r = await ready();
    key("]");
    key(k);
    expect(key(k, { repeat: true }).defaultPrevented).toBe(true);
    expect(r.viewport.applyPicks).toHaveBeenCalledTimes(1);
  });

  it.each([{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }])(
    "a chord %o is not a pick",
    async (mods) => {
      const r = await ready();
      key("]");
      expect(key("Enter", mods).defaultPrevented).toBe(false);
      expect(key(" ", mods).defaultPrevented).toBe(false);
      expect(r.viewport.applyPicks).not.toHaveBeenCalled();
    },
  );

  it("reports a refused pick on the status line and in speech", async () => {
    const r = await ready();
    key("]");
    Object.assign(r.viewport, { picksSuspended: true });
    key("Enter");
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
    expect(r.host.setStatus.mock.calls.at(-1)![0]).toContain("building");
    expect(lastSaid()).toBe(r.host.setStatus.mock.calls.at(-1)![0]);
  });

  it("Enter on a lit plane starts a sketch and puts the light out", async () => {
    const r = await ready();
    key("{");
    expect(r.list.kind).toBe("planes");
    key("]");
    expect(r.list.litRow?.kind).toBe("plane");
    key("Enter");
    expect(r.host.sketch.enter).toHaveBeenCalledTimes(1);
    expect(r.list.litRow).toBeNull();
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
  });

  it("Space on a lit plane adds it as a selected row and starts no sketch", async () => {
    const r = await ready();
    key("{");
    key("]");
    key(" ");
    expect(useSelectionStore().rows.keys).toEqual([r.list.litRow!.key.slice(2)]);
    expect(r.host.sketch.enter).not.toHaveBeenCalled();
    expect(r.list.litRow?.kind).toBe("plane");
  });
});

describe("switching kind", () => {
  it("} goes faces, edges, planes, faces and { the other way, each said with the light out", async () => {
    const r = await ready();
    r.wires.set("body1", [edge("body1", 0, 4)]);
    key("]");
    const seen: string[] = [];
    for (const k of ["}", "}", "}", "{", "{", "{"]) {
      expect(key(k).defaultPrevented).toBe(true);
      expect(r.list.litRow).toBeNull();
      seen.push(r.list.kind);
      expect(lastSaid()!.toLowerCase()).toContain(r.list.kind);
    }
    expect(seen).toEqual(["edges", "planes", "faces", "planes", "edges", "faces"]);
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
  });

  it("puts out a lit face when going to planes, and a lit plane when going on", async () => {
    const r = await ready();
    key("]");
    expect(r.viewport.hoverPick.mock.calls.at(-1)).toEqual([face(0)]);
    key("{");
    expect(r.viewport.hoverPick.mock.calls.at(-1)).toEqual([null]);
    key("]");
    expect(r.viewport.hoverPlane.mock.calls.at(-1)).toEqual(["XY"]);
    key("}");
    expect(r.viewport.hoverPlane.mock.calls.at(-1)).toEqual([null]);
  });

  it("fetches for the new kind with the tab closed", async () => {
    const r = rig();
    install(r);
    await r.build();
    r.wires.set("body1", [edge("body1", 0, 4), edge("body1", 1, 4)]);
    key("}");
    expect(r.asks.map((a) => a.body)).toEqual(["body1"]);
    await land(r.asks[0]!, topology("body1"));
    key("]");
    expect(r.list.cursor).toBe("e:body1:0");
    expect(r.viewport.hoverPick.mock.calls.at(-1)![0]).toMatchObject({ kind: "edge" });
  });

  it("reads the shifted key of a non Latin layout by its place", async () => {
    const r = await ready();
    expect(key("Ъ", { code: "BracketRight", shiftKey: true }).defaultPrevented).toBe(true);
    expect(r.list.kind).toBe("edges");
    key("ъ", { code: "BracketRight" });
    expect(r.list.kind).toBe("edges");
  });
});

describe("modifiers", () => {
  it.each([
    ["Windows AltGr as Ctrl and Alt", { ctrlKey: true, altKey: true }],
    ["a reported AltGraph", { altGraph: true }],
  ])("%s still steps", async (_name, mods) => {
    const r = await ready();
    expect(key("]", mods).defaultPrevented).toBe(true);
    expect(r.list.cursor).toBe("f:body1:0");
  });

  it("AltGr types the shifted bracket on a layout that needs it", async () => {
    const r = await ready();
    key("}", { ctrlKey: true, altKey: true });
    expect(r.list.kind).toBe("edges");
  });

  it("a Mac's Option types the bracket", async () => {
    setMacForTest(true);
    const r = await ready();
    expect(key("]", { altKey: true }).defaultPrevented).toBe(true);
    expect(r.list.cursor).toBe("f:body1:0");
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }],
    ["Alt off a Mac", { altKey: true }],
  ])("%s with a bracket is left for its chord", async (_name, mods) => {
    const r = await ready();
    expect(key("]", mods).defaultPrevented).toBe(false);
    expect(r.list.cursor).toBeNull();
  });

  it("a bracket a layout types with Shift still steps", async () => {
    const r = await ready();
    key("]", { shiftKey: true });
    expect(r.list.kind).toBe("faces");
    expect(r.list.cursor).toBe("f:body1:0");
  });
});

describe("standing down", () => {
  const ALL_KEYS = ["]", "[", "}", "{", "Enter", " "];

  function untouched(r: ReturnType<typeof rig>) {
    expect({ kind: r.list.kind, lit: r.list.litRow?.key, cursor: r.list.cursor }).toEqual({
      kind: "faces",
      lit: "f:body1:0",
      cursor: "f:body1:0",
    });
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
  }

  async function litThen(prepare: (r: ReturnType<typeof rig>) => void) {
    const r = await ready();
    key("]");
    vi.mocked(announce).mockClear();
    prepare(r);
    return r;
  }

  it.each(ALL_KEYS)("%s stands down while a tool owns the screen", async (k) => {
    const r = await litThen((x) => x.host.toolOwnsScreen.mockReturnValue(true));
    expect(key(k).defaultPrevented).toBe(false);
    untouched(r);
    expect(announce).not.toHaveBeenCalled();
  });

  it.each(ALL_KEYS)("%s stands down in a sketch", async (k) => {
    const r = await litThen((x) => (x.host.sketch.active = true));
    expect(key(k).defaultPrevented).toBe(false);
    untouched(r);
    expect(announce).not.toHaveBeenCalled();
  });

  it.each(ALL_KEYS)("%s stands down under a choice menu", async (k) => {
    const r = await litThen(() => (useModalStore().depth = 1));
    expect(key(k).defaultPrevented).toBe(false);
    untouched(r);
    expect(announce).not.toHaveBeenCalled();
  });

  it.each(ALL_KEYS)("%s stands down when a handler already took it", async (k) => {
    const r = await litThen(() => {});
    canvas.addEventListener("keydown", (ev) => ev.preventDefault());
    key(k);
    untouched(r);
    expect(announce).not.toHaveBeenCalled();
  });

  it.each(ALL_KEYS)("%s in a field is typing", async (k) => {
    const r = await litThen(() => {});
    const field = document.createElement("input");
    document.body.append(field);
    expect(key(k, {}, field).defaultPrevented).toBe(false);
    untouched(r);
  });

  it.each(ALL_KEYS)("%s on another control is that control's", async (k) => {
    const r = await litThen(() => {});
    const button = document.createElement("button");
    document.body.append(button);
    expect(key(k, {}, button).defaultPrevented).toBe(false);
    untouched(r);
  });

  it("works on the body with Single key shortcuts on", async () => {
    const r = await ready();
    expect(key("]", {}, document.body).defaultPrevented).toBe(true);
    expect(r.list.cursor).toBe("f:body1:0");
    expect(key("Enter", {}, document.body).defaultPrevented).toBe(true);
    expect(r.viewport.applyPicks).toHaveBeenCalledTimes(1);
  });

  it.each(ALL_KEYS)("%s stands down on the body with Single key shortcuts off", async (k) => {
    const r = await litThen(() => setA11yPref("singleKeys", false));
    expect(key(k, {}, document.body).defaultPrevented).toBe(false);
    untouched(r);
  });

  it("all still work on the focused canvas with Single key shortcuts off", async () => {
    setA11yPref("singleKeys", false);
    const r = await ready();
    key("]");
    expect(r.list.cursor).toBe("f:body1:0");
    key("Enter");
    key(" ");
    expect(r.viewport.applyPicks).toHaveBeenCalledTimes(2);
    key("}");
    expect(r.list.kind).toBe("edges");
  });
});

describe("putting the light out", () => {
  it("Escape drops the light, keeps the place and leaves the key for the keymap to clear", async () => {
    const r = await ready();
    key("]");
    r.viewport.hoverPick.mockClear();
    expect(key("Escape").defaultPrevented).toBe(false);
    expect(r.list.litRow).toBeNull();
    expect(r.viewport.hoverPick.mock.calls).toEqual([[null]]);
    key("]");
    expect(r.list.cursor).toBe("f:body1:1");
  });

  it("Escape with no light does nothing to the view", async () => {
    const r = await ready();
    expect(key("Escape").defaultPrevented).toBe(false);
    expect(r.viewport.hoverPick).not.toHaveBeenCalled();
  });

  it("a press on the view drops it", async () => {
    const r = await ready();
    key("]");
    canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(r.list.litRow).toBeNull();
  });

  const move = (x: number, y: number) =>
    canvas.dispatchEvent(
      Object.assign(new MouseEvent("pointermove", { bubbles: true }), { movementX: x, movementY: y }),
    );

  it("a moving pointer drops it, the zero move a browser sends after a layout does not", async () => {
    const r = await ready();
    key("]");
    move(0, 0);
    expect(r.list.litRow?.key).toBe("f:body1:0");
    move(3, -1);
    expect(r.list.litRow).toBeNull();
  });

  it("focus going to another control drops it, focus on the canvas does not", async () => {
    const r = await ready();
    const button = document.createElement("button");
    document.body.append(button);
    canvas.tabIndex = 0;
    key("]");
    canvas.focus();
    expect(document.activeElement).toBe(canvas);
    expect(r.list.litRow?.key).toBe("f:body1:0");
    button.focus();
    expect(r.list.litRow).toBeNull();
  });

  it("is out before a list row's own focus handler lights that row", async () => {
    const r = await ready();
    key("]");
    const row = document.createElement("div");
    row.tabIndex = 0;
    row.addEventListener("focus", () => r.browser.hover(r.list.rows[2]!));
    document.body.append(row);
    r.viewport.hoverPick.mockClear();
    row.focus();
    expect(r.viewport.hoverPick.mock.calls).toEqual([[null], [face(2)]]);
  });
});

describe("the next document", () => {
  it("drops the cursor, the light and the kind, and steps its own rows", async () => {
    const r = await ready();
    r.wires.set("body1", [edge("body1", 0, 4)]);
    key("}");
    key("]");
    expect(r.list.cursor).toBe("e:body1:0");
    r.store.sessions.begin("open");
    expect(r.list.litRow).toBeNull();
    expect(r.list.cursor).toBeNull();
    expect(r.list.kind).toBe("faces");
    await r.build(result([{ id: "body1", etag: "other" }]));
    vi.mocked(announce).mockClear();
    r.viewport.hoverPick.mockClear();
    key("]");
    await land(r.asks.at(-1)!, topology("body1", 2));
    expect(r.list.rows.map((x) => x.key)).toEqual(["f:body1:0", "f:body1:1"]);
    expect(r.list.cursor).toBe("f:body1:0");
    expect(r.viewport.hoverPick.mock.calls).toEqual([[face(0)]]);
    expect(said()).toEqual(["Listing faces", describePick(r.list.rows[0]!.facts).spoken]);
  });
});

describe("a tool waiting for a pick", () => {
  type Waiting = Awaited<ReturnType<typeof waiting>>;
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  async function waiting(answer: (n: number, pick: TreePick) => TreePickAnswer = () => true) {
    const r = await ready();
    r.host.toolOwnsScreen.mockReturnValue(true);
    r.host.toolBusy.mockReturnValue(true);
    const taken: TreePick[] = [];
    awaitTreePick(
      (pick) => answer(taken.push(pick), pick),
      () => {},
    );
    // A tool's own Enter and Escape listen in window capture, added after the install.
    const heard: string[] = [];
    const toolKeys = (ev: KeyboardEvent) => {
      if (ev.key.length > 1 || ev.key === " ") heard.push(ev.key);
      if (ev.key === "Escape") ev.stopImmediatePropagation();
    };
    window.addEventListener("keydown", toolKeys, true);
    cleanups.push(() => window.removeEventListener("keydown", toolKeys, true));
    return { ...r, taken, heard };
  }

  it("steps and says the row under the step key, as with no tool", async () => {
    const r = await waiting();
    const ev = key("]");
    expect(ev.defaultPrevented).toBe(true);
    expect(r.list.cursor).toBe("f:body1:0");
    expect(r.list.litRow?.key).toBe("f:body1:0");
    expect(vi.mocked(announce).mock.calls).toEqual([
      [describePick(r.list.rows[0]!.facts).spoken, "polite", { key: "pick-step", delay: 120 }],
    ]);
    key("[");
    expect(r.list.cursor).toBe("f:body1:2");
    expect(r.taken).toEqual([]);
  });

  it("Enter gives the lit row to the tool, puts the light out and goes on from that row", async () => {
    const r = await waiting();
    key("]");
    key("]");
    vi.mocked(announce).mockClear();
    const ev = key("Enter");
    expect(ev.defaultPrevented).toBe(true);
    expect(r.taken).toEqual([face(1)]);
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
    expect(r.list.litRow).toBeNull();
    expect(r.list.cursor).toBe("f:body1:1");
    expect(said()).toEqual([
      `${describePick(r.list.rows[1]!.facts).label} of ${r.list.bodies.find((b) => b.id === "body1")!.name} picked`,
    ]);
    key("]");
    expect(r.list.cursor).toBe("f:body1:2");
    expect(r.list.litRow?.key).toBe("f:body1:2");
  });

  it("Space gives the lit row the same way", async () => {
    const r = await waiting();
    key("[");
    expect(key(" ").defaultPrevented).toBe(true);
    expect(r.taken).toEqual([face(2)]);
    expect(r.list.litRow).toBeNull();
  });

  it.each(["Enter", " "])("a held %s offers once and its repeats never reach the tool", async (k) => {
    const r = await waiting();
    key("]");
    expect(key(k).defaultPrevented).toBe(true);
    for (let i = 0; i < 3; i++) expect(key(k, { repeat: true }).defaultPrevented).toBe(true);
    expect(r.taken).toEqual([face(0)]);
    expect(r.heard).toEqual([]);
    key(k);
    expect(r.heard).toEqual([k]);
    expect(key(k, { repeat: true }).defaultPrevented).toBe(false);
  });

  it.each([{ ctrlKey: true }, { altKey: true }, { shiftKey: true }, { metaKey: true }])(
    "Enter with %o is left to the tool and the light stays",
    async (mod) => {
      const r = await waiting();
      key("]");
      expect(key("Enter", mod).defaultPrevented).toBe(false);
      expect(r.taken).toEqual([]);
      expect(r.heard).toEqual(["Enter"]);
      expect(r.list.litRow?.key).toBe("f:body1:0");
    },
  );

  it("the tool's own Enter is claimed while a row is lit and heard again once the light is out", async () => {
    const r = await waiting();
    key("]");
    key("Enter");
    expect(r.heard).toEqual([]);
    expect(key("Enter").defaultPrevented).toBe(false);
    expect(r.heard).toEqual(["Enter"]);
    expect(r.taken).toEqual([face(0)]);
  });

  it("with no light the tool's own Enter is heard from the start", async () => {
    const r = await waiting();
    key("Enter");
    expect(r.heard).toEqual(["Enter"]);
    expect(r.taken).toEqual([]);
  });

  it("a refused row puts the light out and the refusal is said under the selection key", async () => {
    const r = await waiting(() => "That row is a face, this step needs an edge");
    key("]");
    vi.mocked(announce).mockClear();
    key("Enter");
    expect(r.list.litRow).toBeNull();
    expect(vi.mocked(announce).mock.calls).toEqual([
      ["That row is a face, this step needs an edge", "polite", { key: "selection", delay: 250 }],
    ]);
    expect(r.host.setStatus).toHaveBeenCalledTimes(1);
  });

  it("a plane row is offered as that plane, no sketch starts", async () => {
    const r = await waiting();
    key("{");
    key("]");
    expect(r.list.litRow?.kind).toBe("plane");
    const plane = r.list.litRow!.plane;
    key("Enter");
    expect(r.taken).toEqual([plane]);
    expect(r.host.sketch.enter).not.toHaveBeenCalled();
    expect(r.list.litRow).toBeNull();
  });

  it("the kind switch works while a tool waits", async () => {
    const r = await waiting();
    key("}");
    expect(r.list.kind).toBe("edges");
    expect(lastSaid()).toBe("Edges");
  });

  it("a row gone stale is refused in words and nothing reaches the tool", async () => {
    const r = await waiting();
    key("]");
    await r.build(result([{ id: "body1", etag: "changed" }]));
    vi.mocked(announce).mockClear();
    key("Enter");
    expect(r.taken).toEqual([]);
    expect(said()).toHaveLength(1);
    expect(r.list.litRow).toBeNull();
  });

  describe("stands down", () => {
    async function litUnder(prepare: (r: Waiting) => void) {
      const r = await waiting();
      key("]");
      prepare(r);
      vi.mocked(announce).mockClear();
      return r;
    }
    const quiet = (r: Waiting) => {
      expect(r.taken).toEqual([]);
      expect(r.list.litRow?.key).toBe("f:body1:0");
      expect(announce).not.toHaveBeenCalled();
    };

    it.each(["]", "Enter", " "])("%s in a sketch", async (k) => {
      const r = await litUnder((x) => (x.host.sketch.active = true));
      expect(key(k).defaultPrevented).toBe(false);
      quiet(r);
    });

    it.each(["]", "Enter", " "])("%s under a choice menu", async (k) => {
      const r = await litUnder(() => (useModalStore().depth = 1));
      expect(key(k).defaultPrevented).toBe(false);
      quiet(r);
    });

    it.each(["]", "Enter", " "])("%s on another control", async (k) => {
      const r = await litUnder(() => {});
      const button = document.createElement("button");
      document.body.append(button);
      expect(key(k, {}, button).defaultPrevented).toBe(false);
      quiet(r);
    });

    it.each(["]", "Enter", " "])("%s on the body with single key shortcuts off", async (k) => {
      const r = await litUnder(() => setA11yPref("singleKeys", false));
      expect(key(k, {}, document.body).defaultPrevented).toBe(false);
      quiet(r);
    });

    it("Enter on the body with single key shortcuts on offers the row", async () => {
      const r = await litUnder(() => {});
      key("Enter", {}, document.body);
      expect(r.taken).toEqual([face(0)]);
    });

    it("a tool that takes no rows keeps the keys down", async () => {
      const r = await litUnder(() => resetTreePicks());
      expect(key("Enter").defaultPrevented).toBe(false);
      expect(key("]").defaultPrevented).toBe(false);
      expect(r.taken).toEqual([]);
    });
  });

  it("a build in progress refuses the step in words, a suspended pick does not", async () => {
    const r = await waiting();
    r.viewport.picksSuspended = true;
    key("]");
    expect(r.list.litRow?.key).toBe("f:body1:0");
    r.viewport.picksSuspended = false;
    r.viewport.modelUnsettled = true;
    vi.mocked(announce).mockClear();
    key("]");
    expect(r.list.cursor).toBe("f:body1:0");
    expect(said()).toEqual(["The model is still building"]);
    r.viewport.modelUnsettled = false;
    key("]");
    expect(r.list.cursor).toBe("f:body1:1");
  });

  it("Esc puts the light out even when the tool's own Escape stops the key", async () => {
    const r = await waiting();
    key("]");
    const ev = key("Escape");
    expect(r.heard).toEqual(["Escape"]);
    expect(ev.defaultPrevented).toBe(false);
    expect(r.list.litRow).toBeNull();
    expect(r.list.cursor).toBe("f:body1:0");
  });

  it("the next document ends the pick, drops the light and hands nothing to the old taker", async () => {
    const r = await waiting();
    r.store.onRewind(endRewoundPick);
    key("]");
    r.store.newDocument();
    expect(r.list.litRow).toBeNull();
    key("Enter");
    key("]");
    expect(r.taken).toEqual([]);
    r.host.toolOwnsScreen.mockReturnValue(false);
    await r.build(result([{ id: "body1", etag: "other" }]));
    key("]");
    await land(r.asks.at(-1)!, topology("body1", 2));
    key("Enter");
    expect(r.taken).toEqual([]);
  });
});

describe("uninstalling", () => {
  it("leaves no listener behind", async () => {
    const r = await ready();
    off();
    off = () => {};
    expect(key("]").defaultPrevented).toBe(false);
    expect(r.list.cursor).toBeNull();
  });

  it("leaves no session listener behind, a pick begun after keeps the light", async () => {
    const r = await ready();
    key("]");
    off();
    off = () => {};
    awaitTreePick(() => true, vi.fn());
    expect(r.list.litRow?.key).toBe("f:body1:0");
  });

  it("leaves no capture listener behind either", async () => {
    const r = await ready();
    const taken: TreePick[] = [];
    awaitTreePick(
      (pick) => (taken.push(pick), true),
      () => {},
    );
    key("]");
    off();
    off = () => {};
    expect(key("Enter").defaultPrevented).toBe(false);
    expect(taken).toEqual([]);
    expect(r.list.litRow?.key).toBe("f:body1:0");
  });
});
