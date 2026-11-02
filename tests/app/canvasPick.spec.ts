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
import { edge, land, result, rig, topology } from "./geometryBrowserRig";

vi.mock("../../src/ui/toast", () => ({ toast: () => {}, dismissToast: () => {} }));
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

describe("uninstalling", () => {
  it("leaves no listener behind", async () => {
    const r = await ready();
    off();
    off = () => {};
    expect(key("]").defaultPrevented).toBe(false);
    expect(r.list.cursor).toBeNull();
  });
});
