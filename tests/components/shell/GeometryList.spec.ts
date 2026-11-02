// The Geometry list on a real store and controller, with real Listbox, ListRow, Select and NumberField. Only the engine
// and the viewport behind the controller are fake.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import GeometryList from "../../../src/components/shell/GeometryList.vue";
import NumberField from "../../../src/components/ui/NumberField.vue";
import { ENGINE } from "../../../src/app/engineKey";
import { announce } from "../../../src/ui/announce";
import { setUnit } from "../../../src/ui/units";
import { renderPrefs, setRenderPref } from "../../../src/ui/renderPrefs";
import { DOC, edge, land, result, rig, settle, topology } from "../../app/geometryBrowserRig";
import type { TopologyFace, TopologyReply } from "../../../src/types";

vi.mock("../../../src/ui/toast", () => ({ toast: () => {}, dismissToast: () => {} }));
vi.mock("../../../src/ui/announce", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/ui/announce")>()),
  announce: vi.fn(),
}));

enableAutoUnmount(afterEach);

const slanted = (i: number): TopologyFace => ({
  i,
  surface: "plane",
  area: 2400 + i,
  normal: [0, 0, 1],
  size: [60 + i, 40],
  centroid: [113.5 + i, -41.25, 37],
});

function reply(body: string, n: number): TopologyReply {
  return { body, faceCount: n, faces: Array.from({ length: n }, (_, i) => slanted(i)) };
}

/** Mounts on a built document, faces listed once `faces` is given. */
async function open(faces?: number | TopologyReply) {
  const count = typeof faces === "number" ? faces : (faces?.faces.length ?? 3);
  const r = rig(result([{ id: "body1", etag: "e1", faceCount: count, faceStart: 40 }]));
  await r.build();
  const setStatus = vi.fn();
  const engine = { geometryBrowser: r.browser, setStatus };
  const w = mount(GeometryList, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: engine } } });
  await nextTick();
  if (faces !== undefined) {
    await land(r.asks[0]!, typeof faces === "number" ? reply("body1", faces) : faces);
    await nextTick();
  }
  return { r, w, setStatus };
}

type W = Awaited<ReturnType<typeof open>>["w"];
const options = (w: W) => w.findAll("[role=option]");
const labels = (w: W) => options(w).map((o) => o.find(".ui-list-row-label").text());
const selects = (w: W) => w.findAllComponents({ name: "Select" });
const selectOf = (w: W, label: string) => {
  const row = w.findAll(".ui-field-row").find((x) => x.find(".ui-field-label").text() === label)!;
  return selects(w).find((s) => row.element.contains(s.element))!;
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(announce).mockClear();
  setUnit("mm");
});

describe("rows", () => {
  it("draws each row with its label and hint, and speaks its full words as its name", async () => {
    const { w } = await open(2);
    expect(labels(w)).toEqual(["Flat face 1", "Flat face 2"]);
    const first = options(w)[0]!;
    expect(first.find(".ui-list-row-hint").text()).toContain("60 by 40 mm");
    expect(first.find(".ui-list-row-hint").text()).toContain("facing up");
    const name = first.attributes("aria-label")!;
    expect(name).toContain("60 by 40 millimetres");
    expect(name).toContain("facing up");
    expect(name).toContain("BODY1");
    expect(name).not.toContain("mm");
  });

  it("names the list by its kind and its body", async () => {
    const { w } = await open(1);
    expect(w.get("[role=listbox]").attributes("aria-label")).toBe("Faces of BODY1");
    expect(w.get("[role=listbox]").attributes("aria-multiselectable")).toBe("true");
  });

  it("is one Tab stop whose options keep the Listbox's attrs over ListRow's own", async () => {
    const { w } = await open(3);
    expect(options(w).map((o) => o.attributes("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(options(w).map((o) => o.attributes("role"))).toEqual(["option", "option", "option"]);
    expect(options(w).every((o) => o.attributes("data-roving") === "")).toBe(true);
  });

  it("marks the row a canvas pick selected, and only that row", async () => {
    const { r, w } = await open(3);
    r.selection.faces = [41];
    r.browser.selectionChanged();
    await nextTick();
    expect(options(w).map((o) => o.attributes("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(options(w).map((o) => o.classes("is-selected"))).toEqual([false, true, false]);
    r.selection.faces = [];
    r.browser.selectionChanged();
    await nextTick();
    expect(options(w).map((o) => o.attributes("aria-selected"))).toEqual(["false", "false", "false"]);
  });

  it("says a row's lengths in the display unit, and follows a change of it", async () => {
    const { w } = await open(1);
    setUnit("cm");
    await nextTick();
    expect(options(w)[0]!.find(".ui-list-row-hint").text()).toContain("6 by 4 cm");
    expect(options(w)[0]!.attributes("aria-label")).toContain("6 by 4 centimetres");
  });

  it("lists a body's edges once Edges is chosen, with no Facing filter", async () => {
    const { r, w } = await open(2);
    r.wires.set("body1", [edge("body1", 0, 2), edge("body1", 1, 2)]);
    expect(selectOf(w, "Facing")).toBeDefined();
    await w.getComponent({ name: "Segmented" }).vm.$emit("update:modelValue", "edges");
    await nextTick();
    expect(labels(w)).toEqual(["Straight edge 1", "Straight edge 2"]);
    expect(w.get("[role=listbox]").attributes("aria-label")).toBe("Edges of BODY1");
    expect(w.findAll(".ui-field-label").map((x) => x.text())).toEqual(["Body", "Type", "Size at least"]);
  });

  it("switches the body by its field and lists that one", async () => {
    const r = rig();
    await r.build();
    const engine = { geometryBrowser: r.browser, setStatus: vi.fn() };
    const w = mount(GeometryList, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: engine } } });
    await land(r.asks[0]!, topology("body1"));
    await selectOf(w, "Body").vm.$emit("update:modelValue", "body2");
    await nextTick();
    expect(r.asks.map((a) => a.body)).toEqual(["body1", "body2"]);
    expect(selectOf(w, "Body").props("modelValue")).toBe("body2");
    expect(selectOf(w, "Body").props("options")).toEqual([
      { value: "body1", label: "BODY1" },
      { value: "body2", label: "BODY2" },
    ]);
  });

  it("stops wanting rows once it unmounts, the next build asks nothing", async () => {
    const { r, w } = await open(1);
    w.unmount();
    await r.build(result([{ id: "body1", etag: "e2", faceCount: 1 }]));
    expect(r.asks.length).toBe(1);
  });
});

describe("states", () => {
  it("says there is no body yet, with the field off", async () => {
    const r = rig(result([]));
    await r.build();
    const engine = { geometryBrowser: r.browser, setStatus: vi.fn() };
    const w = mount(GeometryList, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: engine } } });
    await nextTick();
    expect(w.get("[role=status]").text()).toContain("No body");
    expect(w.find("[role=listbox]").exists()).toBe(false);
    expect(w.find(".geometry-pager").exists()).toBe(false);
    expect(selects(w)[0]!.props("disabled")).toBe(true);
  });

  it("says it is listing while the first reply is out, then shows the rows", async () => {
    const { r, w } = await open();
    expect(w.get("[role=status]").text()).toContain("Listing the faces");
    expect(w.get(".geometry-rows").attributes("aria-busy")).toBe("true");
    await land(r.asks[0]!, reply("body1", 2));
    expect(w.find("[role=status]").exists()).toBe(false);
    expect(w.get(".geometry-rows").attributes("aria-busy")).toBeUndefined();
    expect(options(w).length).toBe(2);
  });

  it("keeps the old rows, marked busy, while a new build's reply is out", async () => {
    const { r, w } = await open(2);
    await r.build(result([{ id: "body1", etag: "e2", faceCount: 2 }]));
    await nextTick();
    expect(w.get(".geometry-rows").attributes("aria-busy")).toBe("true");
    expect(labels(w)).toEqual(["Flat face 1", "Flat face 2"]);
  });

  it("says when a body has no faces", async () => {
    const { w } = await open({ body: "body1", faceCount: 0, faces: [] });
    expect(w.get("[role=status]").text()).toContain("no faces");
    expect(w.find("[role=listbox]").exists()).toBe(false);
  });

  it("shows an error with a retry that asks again and clears it", async () => {
    const { r, w } = await open();
    await land(r.asks[0]!, null);
    expect(w.get("[role=alert]").text()).toContain("could not list");
    expect(w.find("[role=status]").exists()).toBe(false);
    await w.get("[role=alert] button").trigger("click");
    expect(r.asks.length).toBe(2);
    await land(r.asks[1]!, reply("body1", 1));
    expect(w.find("[role=alert]").exists()).toBe(false);
    expect(labels(w)).toEqual(["Flat face 1"]);
  });

  it("keeps edge rows on show beside the error when the engine fails", async () => {
    const { r, w } = await open();
    r.wires.set("body1", [edge("body1", 0, 1)]);
    await w.getComponent({ name: "Segmented" }).vm.$emit("update:modelValue", "edges");
    await settle();
    await land(r.asks[r.asks.length - 1]!, null);
    expect(w.find("[role=alert]").exists()).toBe(true);
    expect(labels(w)).toEqual(["Straight edge 1"]);
  });

  it("notes faces the engine's cap left out", async () => {
    const { w } = await open({ ...reply("body1", 2), truncated: { faces: 1234 } });
    expect(w.get(".geometry-pager").text()).toContain("1,234 more faces");
  });

  it("nothing of the first document stays once a second one is open", async () => {
    const { r, w } = await open(3);
    await selectOf(w, "Type").vm.$emit("update:modelValue", "cylinder");
    await nextTick();
    expect(w.get("[role=status]").text()).toContain("No faces match");
    r.store.newDocument();
    await nextTick();
    expect(w.find("[role=listbox]").exists()).toBe(false);
    expect(w.get("[role=status]").text()).toContain("No body");
    expect(selectOf(w, "Type").props("modelValue")).toBe("any");
    r.state.result = result([{ id: "body1", etag: "e1", faceCount: 2 }]);
    r.store.load(JSON.stringify(DOC));
    await r.build();
    await land(r.asks[r.asks.length - 1]!, reply("body1", 2));
    expect(labels(w)).toEqual(["Flat face 1", "Flat face 2"]);
  });
});

describe("filters", () => {
  const mixed: TopologyReply = {
    body: "body1",
    faceCount: 4,
    faces: [
      { i: 0, surface: "plane", area: 2400, normal: [0, 0, 1], size: [60, 40], centroid: [113.5, -41.25, 37] },
      { i: 1, surface: "plane", area: 900, normal: [0, 0, -1], size: [30, 30], centroid: [113.5, -41.25, 17] },
      { i: 2, surface: "cylinder", area: 628, axis: [0, 0, 1], radius: 5, length: 20, wraps: true, concave: true },
      { i: 3, surface: "bspline", area: 412, centroid: [113.5, -41.25, 30] },
    ],
  };

  it("narrows by type and tells the new count", async () => {
    const { w } = await open(mixed);
    await selectOf(w, "Type").vm.$emit("update:modelValue", "flat");
    await nextTick();
    expect(labels(w)).toEqual(["Flat face 1", "Flat face 2"]);
    expect(vi.mocked(announce).mock.lastCall?.[0]).toBe("2 faces");
    await selectOf(w, "Type").vm.$emit("update:modelValue", "cylinder");
    expect(vi.mocked(announce).mock.lastCall?.[0]).toBe("1 face");
    await selectOf(w, "Type").vm.$emit("update:modelValue", "any");
    await nextTick();
    expect(options(w).length).toBe(4);
  });

  it("narrows by facing", async () => {
    const { w } = await open(mixed);
    await selectOf(w, "Facing").vm.$emit("update:modelValue", "down");
    await nextTick();
    expect(labels(w)).toEqual(["Flat face 2"]);
    expect(selectOf(w, "Facing").props("modelValue")).toBe("down");
  });

  it("narrows by a size, keeping a row exactly at it and dropping one just under", async () => {
    const { w } = await open(mixed);
    const size = w.getComponent(NumberField);
    await size.vm.$emit("update:modelValue", 30);
    await nextTick();
    expect(labels(w)).toEqual(["Flat face 1", "Flat face 2"]);
    await size.vm.$emit("update:modelValue", 30.01);
    await nextTick();
    expect(labels(w)).toEqual(["Flat face 1"]);
    await size.vm.$emit("update:modelValue", null);
    await nextTick();
    expect(options(w).length).toBe(4);
  });

  it("says none match, and Clear filters brings every row back", async () => {
    const { w } = await open(mixed);
    await w.getComponent(NumberField).vm.$emit("update:modelValue", 500);
    await nextTick();
    expect(w.get("[role=status]").text()).toContain("No faces match");
    expect(vi.mocked(announce).mock.lastCall?.[0]).toBe("No faces");
    expect(w.find("[role=listbox]").exists()).toBe(false);
    expect(w.find(".geometry-pager").exists()).toBe(false);
    await w.get(".geometry-note button").trigger("click");
    await nextTick();
    expect(options(w).length).toBe(4);
    expect(w.getComponent(NumberField).props("modelValue")).toBeNull();
  });
});

describe("pages", () => {
  const pagerButtons = (w: W) => w.findAll(".geometry-pager button");
  const range = (w: W) => w.get(".geometry-range").text();

  it("shows one row with no page buttons", async () => {
    const { w } = await open(1);
    expect(range(w)).toBe("1 to 1 of 1");
    expect(pagerButtons(w).length).toBe(0);
  });

  it("holds exactly 100 rows on one page, the 101st starts a second", async () => {
    const whole = await open(100);
    expect(options(whole.w).length).toBe(100);
    expect(pagerButtons(whole.w).length).toBe(0);
    whole.w.unmount();
    setActivePinia(createPinia());
    const over = await open(101);
    expect(options(over.w).length).toBe(100);
    expect(pagerButtons(over.w).length).toBe(2);
  });

  it("turns pages with Previous and Next, saying each row's true place", async () => {
    const { w } = await open(250);
    expect(range(w)).toBe("1 to 100 of 250");
    expect(pagerButtons(w).map((b) => b.attributes("aria-disabled"))).toEqual(["true", undefined]);
    expect(options(w)[0]!.attributes("aria-posinset")).toBe("1");
    expect(options(w)[0]!.attributes("aria-setsize")).toBe("250");

    await pagerButtons(w)[1]!.trigger("click");
    await pagerButtons(w)[1]!.trigger("click");
    await nextTick();
    expect(range(w)).toBe("201 to 250 of 250");
    expect(options(w).length).toBe(50);
    expect(options(w)[0]!.attributes("aria-posinset")).toBe("201");
    expect(options(w)[49]!.attributes("aria-posinset")).toBe("250");
    expect(labels(w)[0]).toBe("Flat face 201");
    expect(pagerButtons(w).map((b) => b.attributes("aria-disabled"))).toEqual([undefined, "true"]);

    await pagerButtons(w)[0]!.trigger("click");
    await nextTick();
    expect(range(w)).toBe("101 to 200 of 250");
  });

  it("stays on the turned page through a build", async () => {
    const { r, w } = await open(250);
    await pagerButtons(w)[1]!.trigger("click");
    await nextTick();
    await r.build(result([{ id: "body1", etag: "e2", faceCount: 250 }]));
    await land(r.asks[r.asks.length - 1]!, reply("body1", 250));
    expect(range(w)).toBe("101 to 200 of 250");
  });

  it("writes large counts with a separator", async () => {
    const { w } = await open(2004);
    expect(range(w)).toBe("1 to 100 of 2,004");
  });

  it("keeps the turned page's row on show through a filter that still holds it", async () => {
    const { w } = await open(250);
    await pagerButtons(w)[1]!.trigger("click");
    await selectOf(w, "Type").vm.$emit("update:modelValue", "flat");
    await nextTick();
    expect(range(w)).toBe("101 to 200 of 250");
  });

  it("falls back to a page that exists when a filter leaves fewer rows", async () => {
    const { w } = await open(250);
    await pagerButtons(w)[1]!.trigger("click");
    await w.getComponent(NumberField).vm.$emit("update:modelValue", 60 + 150);
    await nextTick();
    expect(range(w)).toBe("1 to 100 of 100");
  });
});

describe("edge rows and the tangent edge setting", () => {
  it("makes the rows again when the setting changes, not on another setting", async () => {
    const { r, w } = await open(1);
    await w.getComponent({ name: "Segmented" }).vm.$emit("update:modelValue", "edges");
    await nextTick();
    expect(options(w).length).toBe(0);
    r.wires.set("body1", [edge("body1", 0, 1)]);
    setRenderPref("zebraWidth", renderPrefs().zebraWidth + 1);
    await nextTick();
    expect(options(w).length).toBe(0);
    setRenderPref("tangentEdges", renderPrefs().tangentEdges === "hide" ? "show" : "hide");
    await nextTick();
    expect(labels(w)).toEqual(["Straight edge 1"]);
  });
});

// Listbox measures columns by offsetTop, which happy-dom leaves at 0.
const realOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      return [...(this.parentElement?.children ?? [])].indexOf(this) * 40;
    },
  });
});
afterAll(() => {
  if (realOffsetTop) Object.defineProperty(HTMLElement.prototype, "offsetTop", realOffsetTop);
  else delete (HTMLElement.prototype as { offsetTop?: number }).offsetTop;
});

const row = (w: W, i: number) => options(w)[i]!;
const focusRow = (w: W, i: number) => (row(w, i).element as HTMLElement).focus();
const press = (w: W, i: number, key: string, mods: KeyboardEventInit = {}) =>
  row(w, i).trigger("keydown", { key, ...mods });
const face = (faceId: number) => ({ kind: "face", faceId });
const select = (r: ReturnType<typeof rig>, ...faces: number[]) => {
  r.selection.faces = faces;
  r.browser.selectionChanged();
};

describe("picking", () => {
  it("Enter selects only this row and leaves the rest of the list alone", async () => {
    const { r, w } = await open(3);
    select(r, 40, 42);
    await nextTick();
    await press(w, 1, "Enter");
    expect(r.viewport.applyPicks.mock.calls).toEqual([[[face(41)], { additive: false }]]);
  });

  it("Space adds a row, and takes a selected one back out", async () => {
    const { r, w } = await open(3);
    await press(w, 2, " ");
    expect(r.viewport.applyPicks).toHaveBeenLastCalledWith([face(42)], { additive: true });
    select(r, 42);
    await nextTick();
    await press(w, 2, " ");
    expect(r.viewport.applyPicks).toHaveBeenCalledTimes(2);
    expect(r.viewport.applyPicks).toHaveBeenLastCalledWith([face(42)], { additive: true });
  });

  it("a plain click takes only that row, Ctrl adds it", async () => {
    const { r, w } = await open(3);
    select(r, 40);
    await nextTick();
    await row(w, 1).trigger("click", { ctrlKey: true });
    expect(r.viewport.applyPicks).toHaveBeenLastCalledWith([face(41)], { additive: true });
    await row(w, 2).trigger("click");
    expect(r.viewport.applyPicks).toHaveBeenLastCalledWith([face(42)], { additive: false });
    expect(r.viewport.applyPicks).toHaveBeenCalledTimes(2);
  });

  it("Shift and an arrow grows a run from the row, as one change", async () => {
    const { r, w } = await open(4);
    focusRow(w, 1);
    await press(w, 1, "ArrowDown", { shiftKey: true });
    expect(r.viewport.applyPicks.mock.calls).toEqual([[[face(41), face(42)], { additive: true }]]);
    expect(document.activeElement).toBe(row(w, 2).element);
  });

  it("a run that shrinks takes only the row it lost out", async () => {
    const { r, w } = await open(4);
    await press(w, 1, "Enter");
    select(r, 41, 42, 43);
    await nextTick();
    focusRow(w, 3);
    r.viewport.applyPicks.mockClear();
    await press(w, 3, "ArrowUp", { shiftKey: true });
    expect(r.viewport.applyPicks.mock.calls).toEqual([[[face(43)], { additive: true }]]);
  });

  it("a run that gains and loses replaces the selection, a selected body goes with it", async () => {
    const { r, w } = await open(4);
    r.selection.bodies = ["body1"];
    r.browser.selectionChanged();
    await nextTick();
    focusRow(w, 0);
    await press(w, 0, "ArrowDown", { shiftKey: true });
    expect(r.viewport.applyPicks.mock.calls).toEqual([[[face(40), face(41)], { additive: false }]]);
  });

  it("Ctrl+A takes this page's rows as one change, not other pages", async () => {
    const { r, w } = await open(150);
    focusRow(w, 0);
    await press(w, 0, "a", { ctrlKey: true });
    expect(r.viewport.applyPicks).toHaveBeenCalledTimes(1);
    const [refs, how] = r.viewport.applyPicks.mock.calls[0] as unknown as [unknown[], unknown];
    expect(refs.length).toBe(100);
    expect(refs[99]).toEqual(face(139));
    expect(how).toEqual({ additive: true });
  });

  it("a picked edge row goes by its edge", async () => {
    const { r, w } = await open(1);
    const wire = edge("body1", 0, 1);
    r.wires.set("body1", [wire]);
    await w.getComponent({ name: "Segmented" }).vm.$emit("update:modelValue", "edges");
    await nextTick();
    await press(w, 0, "Enter");
    expect(r.viewport.applyPicks).toHaveBeenLastCalledWith([{ kind: "edge", edge: wire }], { additive: false });
  });

  it.each([
    ["a sketch is open", (r: ReturnType<typeof rig>) => (r.host.sketch.active = true), "sketch"],
    ["a tool owns the screen", (r: ReturnType<typeof rig>) => r.host.toolOwnsScreen.mockReturnValue(true), "tool"],
    ["the model is building", (r: ReturnType<typeof rig>) => (r.viewport.picksSuspended = true), "building"],
  ])("refuses in words while %s", async (_why, block, word) => {
    const { r, w, setStatus } = await open(2);
    block(r);
    await press(w, 0, "Enter");
    await press(w, 1, " ");
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(setStatus.mock.calls[0]![0]).toContain(word);
    expect(setStatus.mock.calls[0]![1]).toBe("");
  });

  it("refuses a row from before a build until the new rows land", async () => {
    const { r, w, setStatus } = await open(2);
    await r.build(result([{ id: "body1", etag: "e2", faceCount: 2, faceStart: 40 }]));
    await nextTick();
    await press(w, 0, "Enter");
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
    expect(setStatus.mock.calls[0]![0]).toContain("changed");
    await land(r.asks[1]!, reply("body1", 2));
    await press(w, 0, "Enter");
    expect(r.viewport.applyPicks).toHaveBeenCalledTimes(1);
  });

  it("types ahead on a row's first word", async () => {
    const { w } = await open({
      body: "body1",
      faceCount: 3,
      faces: [
        slanted(0),
        { i: 1, surface: "cylinder", area: 628, axis: [0, 0, 1], radius: 5, length: 20, wraps: true, concave: true },
        slanted(2),
      ],
    });
    focusRow(w, 0);
    await press(w, 0, "h");
    expect(document.activeElement).toBe(row(w, 1).element);
  });
});

describe("lighting a row in the view", () => {
  it("lights the focused row, and nothing once focus leaves", async () => {
    const { r, w } = await open(2);
    focusRow(w, 1);
    expect(r.viewport.hoverPick).toHaveBeenLastCalledWith(face(41));
    expect(r.list.cursor).toBe("f:body1:1");
    (row(w, 1).element as HTMLElement).blur();
    expect(r.viewport.hoverPick).toHaveBeenLastCalledWith(null);
  });

  it("lights the row under the pointer, then goes back to the focused one", async () => {
    const { r, w } = await open(3);
    focusRow(w, 0);
    await row(w, 2).trigger("pointerenter");
    expect(r.viewport.hoverPick).toHaveBeenLastCalledWith(face(42));
    await row(w, 2).trigger("pointerleave");
    expect(r.viewport.hoverPick).toHaveBeenLastCalledWith(face(40));
  });

  it("lights nothing after the pointer leaves with no row focused", async () => {
    const { r, w } = await open(3);
    await row(w, 2).trigger("pointerenter");
    await row(w, 2).trigger("pointerleave");
    expect(r.viewport.hoverPick).toHaveBeenLastCalledWith(null);
  });

  it("touches no light while a tool runs, its own hover shares it", async () => {
    const { r, w } = await open(2);
    r.host.toolOwnsScreen.mockReturnValue(true);
    r.viewport.hoverPick.mockClear();
    focusRow(w, 1);
    (row(w, 1).element as HTMLElement).blur();
    await row(w, 0).trigger("pointerenter");
    expect(r.viewport.hoverPick).not.toHaveBeenCalled();
  });

  it("puts the light out when the list goes", async () => {
    const { r, w } = await open(2);
    focusRow(w, 1);
    w.unmount();
    expect(r.viewport.hoverPick).toHaveBeenLastCalledWith(null);
  });
});

const focusedLabel = () => document.activeElement?.querySelector(".ui-list-row-label")?.textContent ?? null;

describe("arrows at a page's end", () => {
  it("Down from a page's last row turns the page and lands on its first", async () => {
    const { r, w } = await open(250);
    focusRow(w, 99);
    await press(w, 99, "ArrowDown");
    await nextTick();
    expect(labels(w)[0]).toBe("Flat face 101");
    expect(focusedLabel()).toBe("Flat face 101");
    expect(document.activeElement?.getAttribute("aria-posinset")).toBe("101");
    expect(r.list.cursor).toBe("f:body1:100");
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
  });

  it("Up from a page's first row turns back and lands on the last", async () => {
    const { w } = await open(250);
    focusRow(w, 99);
    await press(w, 99, "ArrowDown");
    await nextTick();
    await press(w, 0, "ArrowUp");
    await nextTick();
    expect(focusedLabel()).toBe("Flat face 100");
    expect(labels(w)[0]).toBe("Flat face 1");
  });

  it("stops at the list's two ends, it does not wrap", async () => {
    const { r, w } = await open(150);
    focusRow(w, 0);
    await press(w, 0, "ArrowUp");
    await nextTick();
    expect(focusedLabel()).toBe("Flat face 1");
    r.list.setPage(1);
    await nextTick();
    focusRow(w, 49);
    await press(w, 49, "ArrowDown");
    await nextTick();
    expect(focusedLabel()).toBe("Flat face 150");
  });

  it("walks within a page as a plain list", async () => {
    const { r, w } = await open(250);
    focusRow(w, 98);
    await press(w, 98, "ArrowDown");
    await nextTick();
    expect(focusedLabel()).toBe("Flat face 100");
    expect(r.list.page).toBe(0);
  });

  it("a run stays within its page", async () => {
    const { r, w } = await open(250);
    focusRow(w, 99);
    await press(w, 99, "ArrowDown", { shiftKey: true });
    await nextTick();
    expect(r.list.page).toBe(0);
    expect(focusedLabel()).toBe("Flat face 100");
  });

  it("PageDown and PageUp turn pages from any row", async () => {
    const { r, w } = await open(250);
    focusRow(w, 40);
    await press(w, 40, "PageDown");
    await nextTick();
    expect(focusedLabel()).toBe("Flat face 101");
    await press(w, 0, "PageDown");
    await nextTick();
    expect(focusedLabel()).toBe("Flat face 201");
    expect(r.list.page).toBe(2);
    await press(w, 0, "PageUp");
    await nextTick();
    expect(focusedLabel()).toBe("Flat face 101");
    expect(r.list.page).toBe(1);
  });

  it("PageDown on the last page lands on the last row, PageUp on the first on the first", async () => {
    const { w } = await open(50);
    focusRow(w, 10);
    await press(w, 10, "PageDown");
    await nextTick();
    expect(focusedLabel()).toBe("Flat face 50");
    await press(w, 49, "PageUp");
    await nextTick();
    expect(focusedLabel()).toBe("Flat face 1");
  });

  it("keeps a page key from the window", async () => {
    const { w } = await open(2);
    const heard = vi.fn();
    window.addEventListener("keydown", heard);
    focusRow(w, 0);
    await press(w, 0, "PageDown");
    window.removeEventListener("keydown", heard);
    expect(heard).not.toHaveBeenCalled();
  });
});

describe("focus through a build", () => {
  const landFaces = async (r: ReturnType<typeof rig>, etag: string, faces: TopologyFace[]) => {
    await r.build(result([{ id: "body1", etag, faceCount: Math.max(3, faces.length), faceStart: 40 }]));
    await land(r.asks[r.asks.length - 1]!, { body: "body1", faceCount: faces.length, faces });
    await nextTick();
  };

  it("keeps focus on the row when it survives", async () => {
    const { r, w } = await open(3);
    focusRow(w, 2);
    const el = document.activeElement;
    await landFaces(r, "e2", [slanted(1), slanted(2)]);
    expect(document.activeElement).toBe(el);
    expect(focusedLabel()).toBe("Flat face 3");
  });

  it("hands focus to the row now in its place when the build removed it", async () => {
    const { r, w } = await open(3);
    focusRow(w, 1);
    await landFaces(r, "e2", [slanted(0), slanted(2)]);
    expect(focusedLabel()).toBe("Flat face 3");
    expect(r.list.cursor).toBe("f:body1:2");
  });

  it("hands focus to the new last row when the last one went", async () => {
    const { r, w } = await open(3);
    focusRow(w, 2);
    await landFaces(r, "e2", [slanted(0), slanted(1)]);
    expect(focusedLabel()).toBe("Flat face 2");
  });

  it("puts focus on the words when no row is left, and back on a row when they return", async () => {
    const { r, w } = await open(3);
    focusRow(w, 1);
    await landFaces(r, "e2", []);
    expect(document.activeElement?.getAttribute("role")).toBe("status");
    await landFaces(r, "e3", [slanted(0), slanted(1)]);
    expect(focusedLabel()).toBe("Flat face 1");
  });

  it("takes no focus when it was elsewhere", async () => {
    const { r, w } = await open(3);
    const trigger = selects(w)[0]!.element as HTMLElement;
    trigger.focus();
    await landFaces(r, "e2", [slanted(0)]);
    expect(document.activeElement).toBe(trigger);
  });

  it("a filter that drops the focused row hands focus on", async () => {
    const { r, w } = await open(3);
    focusRow(w, 0);
    r.list.setFilters({ minSize: 61 });
    await nextTick();
    expect(focusedLabel()).toBe("Flat face 2");
  });
});

describe("the one Tab stop", () => {
  const stops = (w: W) => options(w).flatMap((o) => (o.attributes("tabindex") === "0" ? [o.element] : []));

  it("stays on the focused row when the first picked row changes", async () => {
    const { r, w } = await open(4);
    select(r, 41, 43);
    await nextTick();
    focusRow(w, 1);
    await nextTick();
    expect(stops(w)).toEqual([row(w, 1).element]);
    select(r, 43);
    await nextTick();
    await nextTick();
    expect(stops(w)).toEqual([row(w, 1).element]);
  });

  it("stays on the focused row when a filter moves it up the list", async () => {
    const { r, w } = await open(4);
    focusRow(w, 3);
    await nextTick();
    r.list.setFilters({ minSize: 62 });
    await nextTick();
    await nextTick();
    expect(labels(w)).toEqual(["Flat face 3", "Flat face 4"]);
    expect(focusedLabel()).toBe("Flat face 4");
    expect(stops(w)).toEqual([row(w, 1).element]);
  });

  it("leaves the stop on the first picked row while focus is elsewhere", async () => {
    const { r, w } = await open(4);
    select(r, 42);
    await nextTick();
    expect(stops(w)).toEqual([row(w, 2).element]);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("a press outside", () => {
  it("blurs a focused row, so the arrows go back to the model", async () => {
    const { w } = await open(2);
    focusRow(w, 1);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves it on a press inside the list", async () => {
    const { w } = await open(2);
    focusRow(w, 1);
    row(w, 0).element.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(document.activeElement).toBe(row(w, 1).element);
  });

  it("leaves focus outside the list alone", async () => {
    const { w } = await open(2);
    const trigger = selects(w)[0]!.element as HTMLElement;
    trigger.focus();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(document.activeElement).toBe(trigger);
  });

  it("stops listening once the list goes", async () => {
    const { w } = await open(2);
    const off = vi.spyOn(document, "removeEventListener");
    w.unmount();
    expect(off.mock.calls.some((c) => c[0] === "pointerdown" && c[2] === true)).toBe(true);
    off.mockRestore();
  });
});

describe("keys that must not reach the model", () => {
  it.each(["Delete", "Backspace"])("%s stops at the list", async (key) => {
    const { r, w } = await open(2);
    select(r, 40);
    await nextTick();
    const heard = vi.fn();
    window.addEventListener("keydown", heard);
    focusRow(w, 1);
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    row(w, 1).element.dispatchEvent(e);
    window.removeEventListener("keydown", heard);
    expect(heard).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
  });

  it("Escape goes on to the window, which clears the selection, and focus stays", async () => {
    const { w } = await open(2);
    const heard = vi.fn();
    window.addEventListener("keydown", heard);
    focusRow(w, 1);
    await press(w, 1, "Escape");
    window.removeEventListener("keydown", heard);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(row(w, 1).element);
  });

  it("a letter no row starts goes on too", async () => {
    const { w } = await open(2);
    const heard = vi.fn();
    window.addEventListener("keydown", heard);
    focusRow(w, 1);
    await press(w, 1, "z");
    window.removeEventListener("keydown", heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
