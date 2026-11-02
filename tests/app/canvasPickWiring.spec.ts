// What sits around the canvas keys: an action puts the light out before a tool can start, and the shortcuts help lists
// the keys.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createActions } from "../../src/app/actions";
import { shortcutHudGroups } from "../../src/input/shortcuts";
import { useGeometryBrowserStore } from "../../src/stores/geometryBrowser";
import { setA11yPref } from "../../src/ui/a11yPrefs";
import type { GeometryRow } from "../../src/ui/geometryRows";
import type { Engine } from "../../src/app/engine";

const row = (i: number) => ({ key: `f:body1:${i}`, kind: "face", bodyId: "body1", index: i }) as unknown as GeometryRow;

function lit(i: number) {
  const list = useGeometryBrowserStore();
  list.setRows([row(0), row(1), row(2)]);
  list.setCursor(row(i).key);
  list.setLit(true);
  return list;
}

beforeEach(() => {
  setActivePinia(createPinia());
});
afterEach(() => {
  setA11yPref("singleKeys", true);
});

describe("an action and the light", () => {
  const e = () =>
    ({
      sketch: { active: false, finish: vi.fn() },
      toolBusy: () => false,
      viewport: { stepView: vi.fn() },
      lastAction: null,
    }) as unknown as Engine;

  it("an action that may start a tool puts it out and keeps the place", () => {
    const list = lit(1);
    createActions(e())("palette");
    expect(list.litRow).toBeNull();
    expect(list.cursor).toBe("f:body1:1");
  });

  it("turning the view keeps it, that is how to see a far face", () => {
    const list = lit(1);
    const host = e();
    createActions(host)("view-step-left");
    expect(host.viewport.stepView).toHaveBeenCalledWith("left", false);
    expect(list.litRow?.key).toBe("f:body1:1");
  });

  it("a view action on the list that keeps a waiting pick keeps it too", () => {
    const list = lit(2);
    createActions(e())("shortcut-help");
    expect(list.litRow?.key).toBe("f:body1:2");
  });
});

describe("the shortcuts help", () => {
  it("lists every canvas key once, with Single key shortcuts on and off", () => {
    const keysOf = () => shortcutHudGroups().find((g) => g.name === "3D view focused")!.rows.map((r) => r.key);
    const want = ["] / [", "Shift+] / Shift+[", "Enter", "Space", "Esc"];
    expect(keysOf()).toEqual(want);
    setA11yPref("singleKeys", false);
    expect(keysOf()).toEqual(want);
  });
});
