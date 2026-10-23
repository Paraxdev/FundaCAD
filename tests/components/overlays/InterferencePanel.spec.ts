// A row click puts the pair forward without selecting it, as a selection brings up the Move gizmo.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import InterferencePanel from "../../../src/components/overlays/InterferencePanel.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { usePanelsStore } from "../../../src/stores/panels";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));

describe("InterferencePanel", () => {
  it("highlights the clicked pair through the panel controller and leaves the selection alone", async () => {
    const highlighted: [string, string][] = [];
    const viewportCalls: string[] = [];
    const engine = {
      ui: {
        panels: {
          highlightInterference: (a: string, b: string) => highlighted.push([a, b]),
          closeInterference: () => {},
          showInterference: async () => {},
        },
      },
      viewport: {
        policy: "faces",
        setSelectedBodies: () => viewportCalls.push("select"),
        setSelectPolicy: () => viewportCalls.push("policy"),
      },
    } as unknown as Engine;
    mount(InterferencePanel, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
    usePanelsStore().showInterference({
      title: "Interference, 2 clashes",
      clashes: [
        { k: "Box ∩ Box 2", v: "2.5 mm³", a: "body3", b: "body7" },
        { k: "Box 2 ∩ Lid", v: "0.4 mm³", a: "body7", b: "body2" },
      ],
      clearances: [],
      unchecked: [],
    });
    await flushPromises();
    const rows = [...document.body.querySelectorAll<HTMLElement>(".clash-row")];
    expect(rows.length).toBe(2);
    rows[1]!.click();
    rows[0]!.click();
    expect(highlighted).toEqual([
      ["body7", "body2"],
      ["body3", "body7"],
    ]);
    expect(viewportCalls).toEqual([]);
  });
});
