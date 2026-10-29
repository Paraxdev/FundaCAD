// Past a few thousand edges a fillet or chamfer asks first, past the cap it refuses with the reason, and no tool
// starts before the answer. Every entry is gated: the commands, the selection handle and the face route, which all
// count through edgeFeature.seedCount().

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import * as THREE from "three";

import { createFeatureStarters, type FeatureStartersDeps } from "../../src/features/featureStarters";
import { useModalStore, type ChooseReq } from "../../src/stores/modals";
import { EDGE_CAP, EDGE_WARN, edgeGate } from "../../src/features/edgeCountGate";
import ModalHost from "../../src/components/overlays/ModalHost.vue";

function rig(count: number) {
  const start = vi.fn();
  const seedCount = vi.fn(() => count);
  const deps = {
    store: { document: { parameters: {}, features: [] } },
    canvas: document.createElement("canvas"),
    edgeFeature: { start, seedCount },
    toolBusy: () => false,
    hasBody: () => true,
    setStatus: vi.fn(),
    selectFeature: vi.fn(),
    noteCommitted: vi.fn(),
  } as unknown as FeatureStartersDeps;
  return { starters: createFeatureStarters(deps), start, seedCount };
}

const question = () => useModalStore().current as (ChooseReq & { id: number }) | null;
const flush = () => new Promise((r) => setTimeout(r, 0));
const text = (q: ChooseReq | null) => `${q?.title ?? ""} ${q?.message ?? ""}`;

describe("edge count gate", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("goes, asks and refuses on each side of the warning at 3,000 and the cap at 5,000", () => {
    expect([EDGE_WARN, EDGE_CAP]).toEqual([3000, 5000]);
    expect([0, EDGE_WARN, EDGE_WARN + 1, EDGE_CAP, EDGE_CAP + 1].map(edgeGate)).toEqual([
      "go",
      "go",
      "warn",
      "warn",
      "refuse",
    ]);
  });

  it("starts a fillet on 3,000 edges at once", () => {
    const { starters, start } = rig(3000);
    starters.startFillet();
    expect(start).toHaveBeenCalledTimes(1);
    expect(question()).toBeNull();
  });

  it.each([
    ["startFillet", "fillet", "Fillet"],
    ["startChamfer", "chamfer", "Chamfer"],
  ] as const)("%s on 3,001 edges asks first and starts only on confirm", async (entry, kind, label) => {
    const { starters, start } = rig(3001);
    starters[entry]();
    expect(start).not.toHaveBeenCalled();
    const q = question();
    expect(q?.kind).toBe("choose");
    expect(text(q)).toContain("3,001 edges");
    expect(text(q)).toContain(label);
    expect(text(q)).toMatch(/long time/);
    const go = q!.options.find((o) => o.primary);
    expect(go?.label).toContain("3,001 edges");
    q!.resolve(go!.value);
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0]).toBe(kind);
  });

  it("cancelling the question starts nothing", async () => {
    const { starters, start } = rig(5000);
    starters.startFillet();
    question()!.resolve(null);
    await flush();
    expect(start).not.toHaveBeenCalled();
  });

  it("asks first on exactly 5,000 edges, the cap itself", () => {
    const { starters, start } = rig(5000);
    starters.startFillet();
    const q = question();
    expect(start).not.toHaveBeenCalled();
    expect(q!.options.map((o) => [o.label, !!o.primary])).toEqual([
      ["Cancel", false],
      ["Fillet 5,000 edges", true],
    ]);
  });

  it("refuses 5,001 edges with the count, the cap and the reason, and starts nothing", async () => {
    const { starters, start } = rig(5001);
    starters.startFillet();
    const q = question();
    expect(text(q)).toContain("5,001 edges");
    expect(text(q)).toContain("at most 5,000");
    expect(text(q)).toMatch(/memory/);
    expect(q!.options.map((o) => o.label)).toEqual(["OK"]);
    q!.resolve("ok");
    await flush();
    expect(start).not.toHaveBeenCalled();
  });

  it("the selection handle on a big selection asks too, then opens the tool on its arrow without a grab", async () => {
    const { starters, start } = rig(4000);
    const tangent = new THREE.Vector3(1, 0, 0);
    const anchor = new THREE.Vector3(1, 2, 3);
    starters.grabEdgeHandle(10, 20, tangent, anchor);
    expect(start).not.toHaveBeenCalled();
    const q = question()!;
    q.resolve(q.options.find((o) => o.primary)!.value);
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![2]).toEqual({ tangent, anchor });
  });

  it("asks the tool for the count of its fillet or chamfer, so the face route is counted the same way", () => {
    const { starters, seedCount } = rig(10);
    starters.startChamfer();
    expect(seedCount).toHaveBeenCalledWith("chamfer");
  });

  it("the question shows its message in the base ConfirmDialog", async () => {
    const host = mount(ModalHost, { attachTo: document.body });
    rig(3001).starters.startFillet();
    await nextTick();
    expect(document.querySelector(".ui-confirm-message")?.textContent).toContain("3,001 edges");
    expect(document.querySelector(".ui-confirm-primary")?.textContent).toContain("3,001 edges");
    host.unmount();
  });

  it.each([
    [3001, "3,001 edges"],
    [5001, "5,001 edges"],
  ])(
    "a screen reader hears the count and the reason for %i edges, with focus on the primary button",
    async (n, count) => {
      const host = mount(ModalHost, { attachTo: document.body });
      rig(n).starters.startFillet();
      await nextTick();
      await flush();
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      const read = (attr: string) => document.getElementById(dialog.getAttribute(attr) ?? "")?.textContent ?? "";
      expect(read("aria-labelledby")).toBe(question()!.title);
      expect(read("aria-describedby")).toBe(question()!.message);
      expect(read("aria-describedby")).toContain(count);
      expect(read("aria-describedby")).toMatch(/minutes/);
      expect(document.activeElement).toBe(document.querySelector(".ui-confirm-primary"));
      host.unmount();
    },
  );
});
