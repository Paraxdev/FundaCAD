// The sketch palette and the fillet card read in the chosen language and follow a live switch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SketchPalette from "../../../src/components/shell/SketchPalette.vue";
import FilletMembers from "../../../src/components/overlays/FilletMembers.vue";
import { PALETTE_TOGGLES } from "../../../src/stores/sketchPalette";
import { useSketchRelationsStore } from "../../../src/stores/sketchRelations";
import { setLanguage } from "../../../src/i18n";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import type { EdgeMemberRow } from "../../../src/features/edgeFeatureTool";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));
afterEach(async () => {
  await setLanguage("system");
  document.body.innerHTML = "";
});

const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/;

describe("the sketch palette", () => {
  it("labels its switches and its title in German and Japanese, on the same table", async () => {
    const same = PALETTE_TOGGLES;
    const ids = PALETTE_TOGGLES.map((d) => d.key);
    expect(PALETTE_TOGGLES.find((d) => d.key === "grid")!.label).toBe("Sketch Grid");
    const w = mount(SketchPalette, { attachTo: document.body });
    await nextTick();
    expect(w.text()).toContain("Sketch palette");
    await setLanguage("de");
    await nextTick();
    expect(PALETTE_TOGGLES.find((d) => d.key === "grid")!.label).toBe("Skizzenraster");
    expect(w.text()).toContain("Skizzenraster");
    expect(w.text()).not.toContain("Sketch palette");
    await setLanguage("ja");
    await nextTick();
    expect(PALETTE_TOGGLES.map((d) => d.label).every((l) => JAPANESE.test(l))).toBe(true);
    expect(w.text()).toMatch(JAPANESE);
    expect(PALETTE_TOGGLES).toBe(same);
    expect(PALETTE_TOGGLES.map((d) => d.key)).toEqual(ids);
  });

  it("says nothing is constrained yet and counts the shapes in the chosen language", async () => {
    useSketchRelationsStore().show([], "", false);
    const w = mount(SketchPalette, { attachTo: document.body });
    await nextTick();
    expect(w.text()).toContain("Nothing is constrained yet");
    await setLanguage("de");
    await nextTick();
    expect(w.text()).not.toContain("Nothing is constrained yet");
    expect(w.text()).toContain("Noch ist nichts festgelegt");
    await setLanguage("ja");
    await nextTick();
    expect(w.text()).not.toContain("Nothing is constrained yet");
  });
});

describe("the fillet card", () => {
  it("follows a switch in its title, its counts and its buttons", async () => {
    const rows = [
      { key: "a", label: "Edge 3", resolved: true },
      { key: "b", label: "Edge 7", resolved: false },
    ] as EdgeMemberRow[];
    const tool = {
      editingMembers: vi.fn(() => true),
      memberRows: vi.fn(() => rows),
      blendKind: () => "chamfer" as const,
      removeMemberByKey: vi.fn(),
      promptAddMember: vi.fn(),
      includesTangentEdges: vi.fn(() => true),
      setIncludeTangentEdges: vi.fn(),
    };
    const engine = {
      tools: { edgeFeature: tool },
      store: { onBuild: () => () => {}, onDocChange: () => () => {} },
    } as unknown as Engine;
    mount(FilletMembers, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: engine } } });
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const text = () => document.body.querySelector(".fm-card")!.textContent!;
    expect(document.body.querySelector(".fm-card .float-card-title")!.textContent).toBe("Chamfer");
    expect(text()).toContain("Add edge");
    await setLanguage("de");
    await nextTick();
    expect(document.body.querySelector(".fm-card .float-card-title")!.textContent).toBe("Fase");
    expect(text()).toContain("Kante");
    expect(text()).not.toContain("Add edge");
    expect(document.body.querySelector(".fm-x")!.getAttribute("aria-label")).not.toBe("Remove Edge 3");
    await setLanguage("ja");
    await nextTick();
    expect(document.body.querySelector(".fm-card .float-card-title")!.textContent).toBe("面取り");
  });
});
