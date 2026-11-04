import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SketchPalette from "../../../src/components/shell/SketchPalette.vue";
import { useSketchPaletteStore, PALETTE_TOGGLES } from "../../../src/stores/sketchPalette";
import { useSketchRelationsStore } from "../../../src/stores/sketchRelations";
import type { RelationRow } from "../../../src/sketch/relations";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));

const row = (index: number | null, over: Partial<RelationRow> = {}): RelationRow => ({
  key: index === null ? "implied:l1,l2" : String(index),
  spoken: index === null ? "Coincident, Line 1 and Line 2, implied" : `Horizontal, Line ${index + 1}`,
  index,
  icon: "horizontal",
  name: "Horizontal",
  detail: `Line ${(index ?? 0) + 1}`,
  entities: [`l${(index ?? 0) + 1}`],
  state: null,
  ...over,
});

function hooks() {
  const h = { del: vi.fn(), select: vi.fn(), hover: vi.fn() };
  useSketchRelationsStore().hooks = h as unknown as ReturnType<typeof useSketchRelationsStore>["hooks"];
  return h;
}

async function relations(rows: RelationRow[], summary = "2 degrees of freedom") {
  useSketchRelationsStore().show(rows, summary, false);
  const w = mount(SketchPalette, { attachTo: document.body });
  await nextTick();
  return w;
}

const lis = (w: ReturnType<typeof mount>) => w.findAll("li.rel-row");
const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

describe("Sketch palette", () => {
  it("is a complementary region named by its heading", () => {
    const w = mount(SketchPalette);
    const aside = w.get("aside#palette");
    const h = w.get("h2.palette-title");
    expect(h.text()).toBe("Sketch palette");
    expect(aside.attributes("aria-labelledby")).toBe(h.attributes("id"));
  });

  it("squares the view from a base button", async () => {
    const palette = useSketchPaletteStore();
    const lookAt = vi.spyOn(palette, "lookAt").mockImplementation(() => {});
    const w = mount(SketchPalette);
    const b = w.get(".palette-btn");
    expect([b.element.tagName, b.attributes("type"), b.attributes("title"), b.text()]).toEqual([
      "BUTTON",
      "button",
      "Square the view to the sketch plane",
      "Look At",
    ]);
    await b.trigger("click");
    expect(lookAt).toHaveBeenCalledTimes(1);
  });

  it("flips an option through its base checkbox, labelled by the row", async () => {
    const palette = useSketchPaletteStore();
    const w = mount(SketchPalette);
    const rows = w.findAll(".palette-row");
    expect(rows).toHaveLength(PALETTE_TOGGLES.length);
    const t = PALETTE_TOGGLES[0]!;
    expect(rows[0]!.text()).toBe(t.label);
    const before = palette.state[t.key];
    await rows[0]!.get("input").trigger("change");
    expect(palette.state[t.key]).toBe(!before);
    await nextTick();
    expect(rows[0]!.classes("is-on")).toBe(!before);
  });

  it("is a region whose keys the sketch leaves alone", () => {
    const w = mount(SketchPalette);
    expect(w.get("aside#palette").attributes("data-keeps-delete")).toBeDefined();
  });
});

describe("Relations rows", () => {
  it("are buttons named by what they say, each with its own Delete button", async () => {
    const h = hooks();
    const w = await relations([
      row(0, {
        name: "Distance",
        value: "12.5 mm",
        detail: "Line 1 and Line 3",
        spoken: "Distance 12.5 mm, Line 1 and Line 3, conflicting",
        state: "conflict",
        stateWord: "conflicting",
      }),
      row(1),
      row(null),
    ]);
    const items = lis(w);
    expect(items).toHaveLength(3);
    const names = items.map((li) => li.get(".ui-list-row").attributes("aria-label"));
    expect(names).toEqual([
      "Distance 12.5 mm, Line 1 and Line 3, conflicting",
      "Horizontal, Line 2",
      "Coincident, Line 1 and Line 2, implied",
    ]);
    expect(items.map((li) => li.get(".ui-list-row").element.tagName)).toEqual(["BUTTON", "BUTTON", "BUTTON"]);
    expect(items[0]!.get(".ui-list-row-label").text()).toBe("Distance 12.5 mm");
    expect(items[0]!.get(".ui-list-row-hint").text()).toBe("Line 1 and Line 3 · conflicting");
    const del = items.map((li) => li.find(".rel-del"));
    expect(del.map((d) => d.exists())).toEqual([true, true, false]);
    expect(del[0]!.attributes("aria-label")).toBe("Delete Distance 12.5 mm, Line 1 and Line 3, conflicting");
    expect(del[1]!.attributes("aria-label")).toBe("Delete Horizontal, Line 2");
    expect(del[0]!.attributes("tabindex")).toBeUndefined();
    expect(h.del).not.toHaveBeenCalled();
  });

  it("delete from the button without selecting the row", async () => {
    const h = hooks();
    const w = await relations([row(3), row(7)]);
    await lis(w)[1]!.get(".rel-del").trigger("click");
    expect(h.del).toHaveBeenCalledExactlyOnceWith(7);
    expect(h.select).not.toHaveBeenCalled();
  });

  it("select what they act on from a click", async () => {
    const h = hooks();
    const w = await relations([row(0), row(1)]);
    await lis(w)[1]!.get(".ui-list-row").trigger("click");
    expect(h.select).toHaveBeenCalledExactlyOnceWith(["l2"]);
    expect(h.del).not.toHaveBeenCalled();
  });

  it("delete on the Delete key and Backspace, never on an implied row", async () => {
    const h = hooks();
    const w = await relations([row(4), row(9), row(null)]);
    const rows = lis(w).map((li) => li.get(".ui-list-row").element);
    key(rows[0]!, "Delete");
    key(rows[1]!, "Backspace");
    key(rows[2]!, "Delete");
    key(rows[0]!, "a");
    expect(h.del.mock.calls).toEqual([[4], [9]]);
    expect(h.select).not.toHaveBeenCalled();
  });

  it("light what the row holds on focus and fall back to the pointer's row on blur", async () => {
    const h = hooks();
    const w = await relations([row(0), row(1), row(2)]);
    const items = lis(w);
    await items[0]!.trigger("focusin");
    expect(h.hover).toHaveBeenLastCalledWith(["l1"]);
    await items[1]!.trigger("focusin");
    expect(h.hover).toHaveBeenLastCalledWith(["l2"]);
    await items[2]!.trigger("pointerenter");
    expect(h.hover).toHaveBeenLastCalledWith(["l3"]);
    await items[1]!.trigger("focusout");
    expect(h.hover).toHaveBeenLastCalledWith(["l3"]);
    await items[2]!.trigger("pointerleave");
    expect(h.hover).toHaveBeenLastCalledWith(null);
  });

  it("keep the light when focus moves between a row and its own Delete button", async () => {
    const h = hooks();
    const w = await relations([row(0)]);
    const li = lis(w)[0]!;
    await li.trigger("focusin");
    h.hover.mockClear();
    li.element.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: li.get(".rel-del").element }));
    expect(h.hover).not.toHaveBeenCalled();
  });

  it("leak no focus or hover into the next sketch", async () => {
    const first = hooks();
    const rel = useSketchRelationsStore();
    const w = await relations([row(0), row(1), row(2)]);
    await lis(w)[2]!.trigger("pointerenter");
    await lis(w)[1]!.trigger("focusin");
    expect(first.hover).toHaveBeenLastCalledWith(["l2"]);
    rel.hide();
    const next = hooks();
    rel.show([row(0, { entities: ["z9"] }), row(1)], "Fully defined", false);
    await nextTick();
    await nextTick();
    await lis(w)[0]!.trigger("pointerenter");
    await lis(w)[0]!.trigger("pointerleave");
    expect(next.hover.mock.calls).toEqual([[["z9"]], [null]]);
  });

  it("move focus to the row that took the place, else the one above, else the summary", async () => {
    const h = hooks();
    const rel = useSketchRelationsStore();
    const w = await relations([row(0), row(1), row(2)]);
    const at = () => lis(w).findIndex((li) => li.element.contains(document.activeElement));
    const settle = async () => {
      await nextTick();
      await nextTick();
    };
    (lis(w)[1]!.get(".rel-del").element as HTMLElement).focus();
    await lis(w)[1]!.get(".rel-del").trigger("click");
    rel.show([row(0), row(2)], "x", false);
    await settle();
    expect(h.del).toHaveBeenLastCalledWith(1);
    expect(at()).toBe(1);
    expect(document.activeElement?.classList.contains("ui-list-row")).toBe(true);
    key(lis(w)[1]!.get(".ui-list-row").element, "Delete");
    rel.show([row(0)], "x", false);
    await settle();
    expect(at()).toBe(0);
    key(lis(w)[0]!.get(".ui-list-row").element, "Backspace");
    rel.show([], "Not constrained", false);
    await settle();
    expect(document.activeElement).toBe(w.get(".rel-summary").element);
  });

  it("leaves focus alone when the rows change without a delete", async () => {
    hooks();
    const rel = useSketchRelationsStore();
    const w = await relations([row(0), row(1)]);
    (lis(w)[1]!.get(".ui-list-row").element as HTMLElement).focus();
    rel.show([row(0), row(1)], "1 degree of freedom", false);
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(lis(w)[1]!.get(".ui-list-row").element);
  });
});
