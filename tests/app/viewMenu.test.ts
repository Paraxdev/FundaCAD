import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { buildMenubar } from "../../src/app/menubarDef";
import { contribute, resetContributions } from "../../src/plugins/contrib";
import { allCommands } from "../../src/ui/commands";
import { railActive, analysisFlags } from "../../src/ui/railActive";
import type { Engine } from "../../src/app/engine";

afterEach(() => resetContributions());

function engine(viewport: object = {}) {
  setActivePinia(createPinia());
  const handleAction = vi.fn();
  const e = { sketch: { active: false }, store: {}, viewport, ui: {}, handleAction } as unknown as Engine;
  return { e, handleAction };
}

describe("the core View menu", () => {
  it("lists the View commands, then the four analysis toggles, each running its action", () => {
    const { e, handleAction } = engine({ zebraOn: true, combsOn: false, analysis: "draft" });
    const view = buildMenubar(e).find((m) => m.label === "View")!;
    const core = allCommands().filter((c) => c.group === "View");
    expect(core.length).toBeGreaterThan(5);
    expect(view.items.slice(0, core.length).map((i) => i.label)).toEqual(core.map((c) => c.label));
    const toggles = view.items.slice(core.length + 1);
    expect(toggles.map((i) => i.label)).toEqual(["Overhang", "Zebra", "Curvature", "Body Colors"]);
    expect(toggles.map((i) => i.checked?.())).toEqual([true, true, false, false]);
    view.items[0]!.onClick?.();
    toggles[1]!.onClick?.();
    expect(handleAction.mock.calls).toEqual([[core[0]!.id], ["zebra"]]);
  });

  it("takes a plugin's rows into the same menu instead of a second one", () => {
    contribute("A.One", { menus: [{ menu: "View", before: "Help", items: [{ label: "Tumble" }] }] });
    const menus = buildMenubar(engine({}).e);
    expect(menus.filter((m) => m.label === "View")).toHaveLength(1);
    expect(menus.map((m) => m.label)).toEqual(["File", "Edit", "View", "Help"]);
    expect(menus[2]!.items.at(-1)!.label).toBe("Tumble");
  });
});

describe("the rail's on state", () => {
  const flags = analysisFlags({ zebraOn: true, combsOn: false, analysis: "component" });

  it("reads the analysis toggles from the viewport", () => {
    expect(flags).toEqual({ zebra: true, curvature: false, "component-colors": true, "draft-analysis": false });
    expect(railActive("zebra", "model", "", flags)).toBe(true);
    expect(railActive("curvature", "selection", "", flags)).toBe(false);
    expect(railActive("component-colors", "model", "", flags)).toBe(true);
    expect(railActive("draft-analysis", "model", "", flags)).toBe(false);
    expect(railActive("extrude", "model", "", flags)).toBe(false);
  });

  it("lights the Mirror button while its tool is armed and not once the select tool is back", () => {
    expect(railActive("mirror-sketch", "sketch", "mirror", {})).toBe(true);
    expect(railActive("mirror-sketch", "sketch", "select", {})).toBe(false);
    expect(railActive("fillet-sketch", "sketch", "fillet", {})).toBe(true);
    expect(railActive("line", "sketch", "line", {})).toBe(true);
    expect(railActive("line", "sketch", "", {})).toBe(false);
    expect(railActive("zebra", "sketch", "line", flags)).toBe(false);
  });
});
