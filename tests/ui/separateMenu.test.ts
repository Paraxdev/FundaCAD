// "Separate" on the body menu and in the ribbon, beside Split Body.

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createContextMenus, type ContextMenusDeps } from "../../src/ui/contextMenus";
import { useContextMenuStore } from "../../src/stores/contextMenu";
import { MODEL, leavesOf } from "../../src/ui/ribbonDefs";

beforeEach(() => setActivePinia(createPinia()));

function setup() {
  const actions: string[] = [];
  const viewport = { getSelectedBodies: () => ["body1"], setSelectedBodies: () => {} };
  const store = {
    materialLibrary: [],
    bodyElements: [],
    bodyMaterialId: () => undefined,
    faceMaterialCount: () => 0,
    bodyElementOf: () => undefined,
  };
  const deps = {
    store, viewport,
    toolBusy: () => false,
    dropBodyGizmo: () => {},
    setStatus: () => {},
    handleAction: (a: string) => { actions.push(a); },
    getLastAction: () => null,
  } as unknown as ContextMenusDeps;
  return { menus: createContextMenus(deps), actions };
}

describe("Separate", () => {
  it("is on the body menu and runs the separate action", () => {
    const s = setup();
    s.menus.openBodyMenu(10, 10, "body1");
    const item = useContextMenuStore().items.find((i) => i.label === "Separate");
    expect(item).toBeDefined();
    item?.onClick?.();
    expect(s.actions).toEqual(["separate"]);
  });

  it("is in the ribbon right after Split Body", () => {
    const actions = MODEL.flatMap((g) => g.items).flatMap(leavesOf).map((t) => t.action);
    expect(actions[actions.indexOf("split") + 1]).toBe("separate");
  });
});
