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

const row = (index: number | null): RelationRow => ({
  index,
  icon: "horizontal",
  name: "Horizontal",
  detail: "Line 1",
  entities: ["l1"],
  state: null,
});

describe("Sketch palette", () => {
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

  it("deletes a constraint from its icon button without selecting the row", async () => {
    const rel = useSketchRelationsStore();
    const del = vi.fn();
    const select = vi.fn();
    rel.hooks = { del, select, hover: vi.fn() } as unknown as typeof rel.hooks;
    rel.show([row(3), row(null)], "2 relations", false);
    const w = mount(SketchPalette);
    await nextTick();
    const x = w.findAll(".rel-del");
    expect(x).toHaveLength(1);
    expect([x[0]!.attributes("type"), x[0]!.attributes("aria-label")]).toEqual(["button", "Delete this constraint"]);
    await x[0]!.trigger("click");
    expect(del).toHaveBeenCalledWith(3);
    expect(select).not.toHaveBeenCalled();
  });
});
