// The datum plane menu's Delete plane goes through the shared delete, not a bare store call.

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createContextMenus, type ContextMenusDeps } from "../../src/ui/contextMenus";
import { useContextMenuStore } from "../../src/stores/contextMenu";

beforeEach(() => setActivePinia(createPinia()));

describe("Delete plane", () => {
  it("deletes only the plane the menu was opened on", () => {
    const deleted: (readonly string[])[] = [];
    const store = { document: { features: [{ id: "d7", type: "datumPlane" }] } };
    const deps = {
      store,
      toolBusy: () => false,
      toolOwnsScreen: () => false,
      dropBodyGizmo: () => {},
      selectFeature: () => {},
      deleteFeatures: (ids: readonly string[]) => deleted.push(ids),
    } as unknown as ContextMenusDeps;
    createContextMenus(deps).openDatumMenu(10, 10, "d7");
    const del = useContextMenuStore().items.find((i) => i.label === "Delete plane")!;
    expect(del.danger).toBe(true);
    del.onClick!();
    expect(deleted).toEqual([["d7"]]);
  });
});
