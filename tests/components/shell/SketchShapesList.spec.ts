// The Shapes disclosure in the sketch palette: closed until opened, rows that read with their freedom, light and select.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SketchShapesList from "../../../src/components/shell/SketchShapesList.vue";
import { useSketchPaletteStore } from "../../../src/stores/sketchPalette";
import { useSketchRelationsStore } from "../../../src/stores/sketchRelations";
import type { Freedom } from "../../../src/sketch/freedom";
import type { ResolvedEntity } from "../../../src/sketch/snap";

enableAutoUnmount(afterEach);

const L1: ResolvedEntity = { type: "line", id: "a", x1: 3.5, y1: -2, x2: 11, y2: 7.25 };
const L2: ResolvedEntity = { type: "line", id: "b", x1: 11, y1: 7.25, x2: 14.5, y2: 1, construction: true };
const C1: ResolvedEntity = { type: "circle", id: "c", x: 41, y: -7, radius: 3.5 };
const P1: ResolvedEntity = { type: "polygon", id: "p", x: 8, y: 3.5, radius: 4, sides: 5, angle: 0.3 };

const free = (x: boolean, y: boolean, size: boolean): Freedom => ({ x, y, size });

let hooks: {
  del: ReturnType<typeof vi.fn>;
  hover: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  shapes: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = "";
  hooks = { del: vi.fn(), hover: vi.fn(), select: vi.fn(), shapes: vi.fn() };
  useSketchRelationsStore().hooks = hooks as unknown as ReturnType<typeof useSketchRelationsStore>["hooks"];
});

async function open(ents: ResolvedEntity[], map: Map<string, Freedom> | null = null, opened = true) {
  const rel = useSketchRelationsStore();
  rel.setShapes(ents);
  rel.setFreedom(map);
  useSketchPaletteStore().shapesOpen = opened;
  const w = mount(SketchShapesList, { attachTo: document.body });
  await nextTick();
  return w;
}

const toggle = (w: ReturnType<typeof mount>) => w.get("button.palette-btn");
const rowButtons = (w: ReturnType<typeof mount>) => w.findAll("li.rel-row .ui-list-row");
const names = (w: ReturnType<typeof mount>) => rowButtons(w).map((b) => b.attributes("aria-label"));

describe("Shapes list", () => {
  it("is closed by default, a disclosure that counts the shapes and opens on a click", async () => {
    const w = await open([L1, L2, C1], null, false);
    expect(toggle(w).text()).toBe("Shapes (3)");
    expect(toggle(w).attributes("aria-expanded")).toBe("false");
    expect(toggle(w).attributes("aria-haspopup")).toBeUndefined();
    expect(rowButtons(w)).toHaveLength(0);

    await toggle(w).trigger("click");
    expect(hooks.shapes.mock.calls).toEqual([[true]]);
    expect(toggle(w).attributes("aria-expanded")).toBe("true");
    expect(toggle(w).attributes("aria-controls")).toBe(w.get("ul").attributes("id"));
    expect(rowButtons(w)).toHaveLength(3);

    await toggle(w).trigger("click");
    expect(hooks.shapes.mock.calls).toEqual([[true], [false]]);
    expect(rowButtons(w)).toHaveLength(0);
  });

  it("reads each shape with its freedom, and construction before it", async () => {
    const w = await open(
      [L1, L2, C1, P1],
      new Map([
        ["a", free(true, false, false)],
        ["b", free(true, true, false)],
        ["c", free(true, true, true)],
      ]),
    );
    expect(names(w)).toEqual([
      "Line 1, free in X",
      "Line 2, construction, free in X and Y",
      "Circle 1, free in X, Y and size",
      "Polygon 1",
    ]);
    expect(
      rowButtons(w).map((b) => (b.find(".ui-list-row-hint").exists() ? b.get(".ui-list-row-hint").text() : null)),
    ).toEqual(["free in X", "construction · free in X and Y", "free in X, Y and size", null]);
  });

  it("says fixed for a shape that cannot move, and nothing while the freedom is unknown", async () => {
    const w = await open([L1, L2], new Map([["a", free(false, false, false)]]));
    expect(names(w)).toEqual(["Line 1, fixed", "Line 2, construction"]);
    useSketchRelationsStore().setFreedom(null);
    await nextTick();
    expect(names(w)).toEqual(["Line 1", "Line 2, construction"]);
  });

  it("drops the words while constraints conflict, and brings them back after", async () => {
    const w = await open([L1], new Map([["a", free(true, true, false)]]));
    const rel = useSketchRelationsStore();
    rel.show([], "Conflicting constraints", true);
    await nextTick();
    expect(names(w)).toEqual(["Line 1"]);
    rel.show([], "2 degrees of freedom", false);
    await nextTick();
    expect(names(w)).toEqual(["Line 1, free in X and Y"]);
  });

  it("says there is nothing drawn instead of an empty list", async () => {
    const w = await open([]);
    expect(toggle(w).text()).toBe("Shapes (0)");
    expect(w.find("ul").exists()).toBe(false);
    expect(w.text()).toContain("Nothing is drawn yet");
  });

  it("lights a shape on hover and focus, falls back from one to the other, and clears on leaving both", async () => {
    const w = await open([L1, L2]);
    const lis = w.findAll("li.rel-row");
    await lis[0]!.trigger("pointerenter");
    expect(hooks.hover).toHaveBeenLastCalledWith(["a"]);
    await lis[1]!.trigger("focusin");
    expect(hooks.hover).toHaveBeenLastCalledWith(["b"]);
    await lis[1]!.trigger("focusout");
    expect(hooks.hover).toHaveBeenLastCalledWith(["a"]);
    await lis[0]!.trigger("pointerleave");
    expect(hooks.hover).toHaveBeenLastCalledWith(null);
  });

  it("selects the shape on a click", async () => {
    const w = await open([L1, L2, C1]);
    await rowButtons(w)[2]!.trigger("click");
    expect(hooks.select.mock.calls).toEqual([[["c"]]]);
  });

  it("shows a second sketch's shapes with none of the first's rows or freedom", async () => {
    const w = await open(
      [L1, L2],
      new Map([
        ["a", free(true, true, false)],
        ["b", free(false, false, false)],
      ]),
    );
    expect(names(w)).toEqual(["Line 1, free in X and Y", "Line 2, construction, fixed"]);
    const rel = useSketchRelationsStore();
    rel.hide();
    await nextTick();
    expect(rowButtons(w)).toHaveLength(0);
    rel.hooks = hooks as unknown as typeof rel.hooks;
    rel.setShapes([C1]);
    await nextTick();
    expect(names(w)).toEqual(["Circle 1"]);
    expect(rel.freedom).toBeNull();
  });
});
