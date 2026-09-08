// The three contribution points a modeling TOOL needed, at the table itself.
//
// tests/plugins/contrib.test.ts covers the points that were already there. These
// are the ones added so that a tool could leave the application: what it
// consumes and whether it is running (`tools`), how the feature it makes is
// drawn and edited (`features`), and the mark for a verb the application does
// not have (`icons`).
//
// Everything here is about the TABLE, not about a surface reading it: order,
// collisions, and, the case worth most of the file, that all of it goes away
// when the contribution does. A plugin that can be switched off but whose tool
// stays in the selection toolbar is a plugin that cannot be switched off.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anyToolBusy,
  contribute,
  contributedFeature,
  contributedFeatureTypes,
  contributedIcons,
  contributedTools,
  resetContributions,
} from "../../src/plugins/contrib";

afterEach(() => resetContributions());

const tool = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  iconName: id,
  consumes: ["face"] as const,
  source: "selection" as const,
  ...extra,
});

describe("tools", () => {
  it("has none until something contributes one", () => {
    expect(contributedTools()).toEqual([]);
  });

  it("keeps registration order across plugins", () => {
    contribute("A", { tools: [tool("a1"), tool("a2")] });
    contribute("B", { tools: [tool("b1")] });
    expect(contributedTools().map((t) => t.id)).toEqual(["a1", "a2", "b1"]);
  });

  it("takes the tool away with the plugin", () => {
    const off = contribute("A", { tools: [tool("a1")] });
    expect(contributedTools()).toHaveLength(1);
    off();
    expect(contributedTools()).toEqual([]);
  });

  it("carries every field a capability row needs, including the optional ones", () => {
    contribute("A", { tools: [tool("a1", { min: 2 })] });
    const t = contributedTools()[0]!;
    expect(t).toMatchObject({
      id: "a1", label: "a1", iconName: "a1", consumes: ["face"], source: "selection", min: 2,
    });
  });
});

describe("anyToolBusy", () => {
  it("is false with nothing contributed", () => {
    expect(anyToolBusy()).toBe(false);
  });

  // The safe default, and it is a decision rather than an omission: a tool that
  // cannot say counts as idle, because one stuck saying busy would freeze every
  // command in the application.
  it("counts a tool that does not answer as idle", () => {
    contribute("A", { tools: [tool("a1")] });
    expect(anyToolBusy()).toBe(false);
  });

  it("is true while any one tool says so, and false again after", () => {
    let running = false;
    contribute("A", { tools: [tool("a1"), tool("a2", { busy: () => running })] });
    expect(anyToolBusy()).toBe(false);
    running = true;
    expect(anyToolBusy()).toBe(true);
    running = false;
    expect(anyToolBusy()).toBe(false);
  });

  // Asked at event time, not cached. A cached answer taken at contribute() would
  // be the value the tool had before it ever ran.
  it("asks again on every call", () => {
    const busy = vi.fn(() => false);
    contribute("A", { tools: [tool("a1", { busy })] });
    anyToolBusy();
    anyToolBusy();
    expect(busy).toHaveBeenCalledTimes(2);
  });

  // The teardown case that matters most: a plugin switched off mid-gesture must
  // not leave the application believing a tool it can no longer reach is
  // holding the window. Nothing could then dispatch anything, ever again.
  it("stops being true when the plugin whose tool was running goes away", () => {
    const off = contribute("A", { tools: [tool("a1", { busy: () => true })] });
    expect(anyToolBusy()).toBe(true);
    off();
    expect(anyToolBusy()).toBe(false);
  });
});

describe("features", () => {
  const feature = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });

  it("is null for a type nobody described", () => {
    expect(contributedFeature("texture")).toBeNull();
  });

  it("finds a described type, and lists them", () => {
    contribute("A", { features: [feature("texture", { meta: { icon: "t", label: "Texture" } })] });
    expect(contributedFeature("texture")?.meta).toEqual({ icon: "t", label: "Texture" });
    expect(contributedFeatureTypes()).toEqual(["texture"]);
  });

  // First claim wins, the same rule contributedAction uses. Two plugins
  // describing one type is a mistake here and a confusing properties panel
  // elsewhere, and the second is not improved by throwing mid-render.
  it("gives a contested type to whoever claimed it first", () => {
    contribute("A", { features: [feature("texture", { meta: { icon: "a", label: "A" } })] });
    contribute("B", { features: [feature("texture", { meta: { icon: "b", label: "B" } })] });
    expect(contributedFeature("texture")?.meta?.label).toBe("A");
  });

  it("hands the type back to the second plugin when the first is switched off", () => {
    const off = contribute("A", { features: [feature("texture", { meta: { icon: "a", label: "A" } })] });
    contribute("B", { features: [feature("texture", { meta: { icon: "b", label: "B" } })] });
    off();
    expect(contributedFeature("texture")?.meta?.label).toBe("B");
  });

  it("carries the four behaviours, not just the labels", () => {
    contribute("A", {
      features: [feature("texture", {
        fieldApplies: (field: string) => field !== "seed",
        fieldLabel: (field: string) => (field === "sharpness" ? { text: "Land" } : null),
        edit: () => false,
        choiceFields: [{ field: "kind", label: "Pattern", options: [], fallback: "knurl" }],
        toggleFields: [{ field: "invert", label: "Invert", fallback: false }],
      })],
    });
    const f = contributedFeature("texture")!;
    expect(f.fieldApplies!("seed", {})).toBe(false);
    expect(f.fieldApplies!("depth", {})).toBe(true);
    expect(f.fieldLabel!("sharpness", {})).toEqual({ text: "Land" });
    expect(f.fieldLabel!("depth", {})).toBeNull();
    expect(f.edit!("t1", () => {})).toBe(false);
    expect(f.choiceFields).toHaveLength(1);
    expect(f.toggleFields).toHaveLength(1);
  });
});

describe("icons", () => {
  it("is empty with nothing contributed", () => {
    expect(contributedIcons()).toEqual({});
  });

  it("merges across plugins", () => {
    contribute("A", { icons: { texture: "<rect/>" } });
    contribute("B", { icons: { moonraker: "<circle/>" } });
    expect(contributedIcons()).toEqual({ texture: "<rect/>", moonraker: "<circle/>" });
  });

  // A plugin loading second must not be able to redraw a mark the first one
  // contributed. Otherwise a plugin can quietly restyle another one's button by
  // naming it, which is a thing nobody would ever look for.
  it("gives a contested name to whoever contributed it first", () => {
    contribute("A", { icons: { texture: "<rect/>" } });
    contribute("B", { icons: { texture: "<circle/>" } });
    expect(contributedIcons()["texture"]).toBe("<rect/>");
  });

  it("takes the mark away with the plugin", () => {
    const off = contribute("A", { icons: { texture: "<rect/>" } });
    off();
    expect(contributedIcons()).toEqual({});
  });
});
