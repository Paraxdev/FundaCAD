// The Stress panel's view: it reads and writes the store's setup, hands its
// buttons to the facade, and shows the result with its legend.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import StressPanel from "../../../src/components/overlays/StressPanel.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { usePanelsStore } from "../../../src/stores/panels";
import type { Selector } from "../../../src/types";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));

function makeEngine() {
  const panels = {
    stressBodies: () => [{ id: "b1", name: "Bracket" }],
    setStressBody: vi.fn(),
    setStressFacesFromSelection: vi.fn(),
    addStressSupport: vi.fn(),
    removeStressSupport: vi.fn(),
    setStressSupportType: vi.fn(),
    addStressLoad: vi.fn(),
    removeStressLoad: vi.fn(),
    runStress: vi.fn(),
    cancelStress: vi.fn(),
    closeStress: vi.fn(),
    setStressColours: vi.fn(),
    setStressDeformation: vi.fn(),
    setStressAnimate: vi.fn(),
    setStressProbe: vi.fn(),
    removeStressProbe: vi.fn(),
  };
  const store = {
    onBuild: (fn: () => void) => {
      fn();
      return () => {};
    },
  };
  return { engine: { store, ui: { panels } } as unknown as Engine, panels };
}

async function mounted() {
  const { engine, panels } = makeEngine();
  const w = mount(StressPanel, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
  await flushPromises();
  return { w, panels };
}

const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const value = (el: Element | null) => el?.getAttribute("data-value");

/** Opens a Select and clicks the option with this label. */
async function pick(trigger: Element, label: string) {
  (trigger as HTMLElement).click();
  await flushPromises();
  const row = [...document.body.querySelectorAll<HTMLElement>(".select-pop .opt-row")].find(
    (r) => r.querySelector(".opt-label")?.textContent === label,
  );
  if (!row) throw new Error(`no option ${label}`);
  row.click();
  await flushPromises();
}

function optionLabels(): string[] {
  return [...document.body.querySelectorAll(".select-pop .opt-label")].map((e) => e.textContent ?? "");
}

describe("StressPanel", () => {
  it("renders nothing while closed", async () => {
    await mounted();
    expect(q(".stress-panel")).toBeNull();
  });

  it("shows the setup and hands the face buttons to the facade", async () => {
    const { panels } = await mounted();
    usePanelsStore().showStress("b1");
    await flushPromises();
    expect(q(".stress-panel")?.textContent).toContain("Support 1");
    expect(value(q(".stress-support-type"))).toBe("fixed");
    expect(value(q(".stress-body"))).toBe("b1");
    q(".stress-set-support")!.click();
    q(".stress-set-load")!.click();
    expect(panels.setStressFacesFromSelection.mock.calls).toEqual([[{ support: 1 }], [{ load: 1 }]]);
    q(".stress-run")!.click();
    expect(panels.runStress).toHaveBeenCalledOnce();
    expect((q(".stress-cancel") as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks for E, nu and yield only for a custom material, and reads a blank size as automatic", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    await flushPromises();
    expect(q(".stress-panel")?.textContent).toContain("yield 50 MPa, 1.24 g/cm³");
    p.stress!.setup.material = "Custom";
    await flushPromises();
    expect(q(".stress-panel")?.textContent).toContain("Poisson's ratio");
    const density = q(".stress-density") as HTMLInputElement;
    density.value = "1.5";
    density.dispatchEvent(new Event("input"));
    expect(p.stress!.setup.custom.density).toBe(1.5);
    const size = q(".stress-size") as HTMLInputElement;
    size.value = "1.5";
    size.dispatchEvent(new Event("input"));
    expect(p.stress!.setup.size).toBe(1.5);
    size.value = "";
    size.dispatchEvent(new Event("input"));
    expect(p.stress!.setup.size).toBeNull();
  });

  it("reads arithmetic into the number boxes and flags text that is not a value", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    await flushPromises();
    p.stress!.setup.material = "Custom";
    await flushPromises();
    const density = q(".stress-density") as HTMLInputElement;
    density.value = "3/2";
    density.dispatchEvent(new Event("input"));
    expect(p.stress!.setup.custom.density).toBe(1.5);
    density.value = "3/";
    density.dispatchEvent(new Event("input"));
    await flushPromises();
    expect(p.stress!.setup.custom.density).toBe(1.5);
    expect(density.classList.contains("input-error")).toBe(true);
    expect(density.title).not.toBe("");
  });

  it("keeps the body while a Run is out, sizes in mm, and toggles the colours", async () => {
    const { panels } = await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    await flushPromises();
    expect(q(".stress-colours")).toBeNull();
    expect(q(".stress-size")?.parentElement?.textContent).toContain("mm");
    p.stressStarted();
    await flushPromises();
    expect((q(".stress-body") as HTMLButtonElement).disabled).toBe(true);
    p.stressFinished({});
    p.setStressColours("shown");
    await flushPromises();
    expect(q(".stress-colours")?.textContent).toBe("Hide colours");
    q(".stress-colours")!.click();
    expect(panels.setStressColours).toHaveBeenCalledWith(false);
    p.setStressColours("hidden");
    await flushPromises();
    q(".stress-colours")!.click();
    expect(panels.setStressColours).toHaveBeenLastCalledWith(true);
  });

  it("shows the result rows, the legend's ends and the warnings", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    p.stressFinished({
      result: {
        rows: [{ k: "Safety factor", v: "0.8" }],
        warnings: ["printed parts are weaker across layers"],
        legend: { min: 0.5, max: 62 },
        yields: true,
      },
    });
    await flushPromises();
    const text = q(".stress-panel")!.textContent!;
    expect(text).toContain("0.5 MPa");
    expect(text).toContain("62 MPa");
    expect(text).toContain("printed parts are weaker across layers");
    expect(q(".stress-yields")?.textContent).toBe("0.8");
    expect(q(".stress-legend")?.getAttribute("style")).toContain("linear-gradient");
  });

  it("lists supports with their kinds, and hands kind, add and remove to the facade", async () => {
    const { panels } = await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    p.addStressSupport("pinned");
    await flushPromises();
    const kinds = document.body.querySelectorAll(".stress-support-type");
    expect([...kinds].map(value)).toEqual(["fixed", "pinned"]);
    await pick(kinds[1]!, "Slider");
    expect(panels.setStressSupportType.mock.calls).toEqual([[2, "slider"]]);
    q(".stress-add-support")!.click();
    expect(panels.addStressSupport).toHaveBeenCalledOnce();
    document.body.querySelectorAll<HTMLButtonElement>(".stress-remove-support")[1]!.click();
    expect(panels.removeStressSupport).toHaveBeenCalledWith(2);
  });

  it("turns gravity on with a direction, off by default", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    await flushPromises();
    const on = q(".stress-gravity-on") as HTMLInputElement;
    const dir = q(".stress-gravity-dir") as HTMLButtonElement;
    expect(on.checked).toBe(false);
    expect(dir.disabled).toBe(true);
    on.click();
    await flushPromises();
    expect(p.stress!.setup.gravity.on).toBe(true);
    expect(dir.disabled).toBe(false);
    await pick(dir, "+Y");
    expect(p.stress!.setup.gravity).toEqual({ on: true, direction: "+Y" });
  });

  it("shows the deformation with its factor, 1x, Animate, Probe and the pinned probes", async () => {
    const { panels } = await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    p.stressFinished({ result: { rows: [], warnings: [], legend: { min: 0, max: 1 }, yields: false } });
    p.setStressColours("shown");
    p.setStressDeform({ scale: 120, auto: 120, max: 480, animate: false });
    p.addStressPin({ tri: 3, weights: [1, 0, 0], label: "12 MPa, 0.4 mm" });
    await flushPromises();
    expect(q(".stress-deform-label")?.textContent).toBe("120x");
    const slider = q(".stress-deform") as HTMLInputElement;
    expect(slider.max).toBe("480");
    slider.value = "60";
    slider.dispatchEvent(new Event("input"));
    expect(panels.setStressDeformation).toHaveBeenCalledWith(60);
    q(".stress-true-scale")!.click();
    expect(panels.setStressDeformation).toHaveBeenLastCalledWith(1);
    q(".stress-animate")!.click();
    expect(panels.setStressAnimate).toHaveBeenCalledWith(true);
    q(".stress-probe")!.click();
    expect(panels.setStressProbe).toHaveBeenCalledWith(true);
    expect(q(".stress-pin")?.textContent).toContain("12 MPa, 0.4 mm");
    q(".stress-remove-pin")!.click();
    expect(panels.removeStressProbe).toHaveBeenCalledWith(1);
  });

  it("folds the setup once a Run has a result, and opens it again on request or when the result goes", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    p.stress!.setup.gravity.on = true;
    await flushPromises();
    expect(q(".stress-set-support")).not.toBeNull();
    p.stressFinished({
      result: { rows: [{ k: "Peak von Mises", v: "4 MPa" }], warnings: [], legend: { min: 0, max: 4 }, yields: false },
    });
    p.setStressColours("shown");
    p.setStressDeform({ scale: 10, auto: 10, max: 40, animate: false });
    await flushPromises();
    expect(q(".stress-set-support")).toBeNull();
    expect(q(".stress-setup-folded")?.textContent).toContain("1 support, 1 load, gravity -Z, PLA");
    // The result's controls come before its rows.
    const panel = q(".stress-panel")!;
    const order = [".stress-deform", ".stress-probe", ".stress-legend"].map((c) =>
      [...panel.querySelectorAll("*")].indexOf(q(c)!),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    q(".stress-setup-toggle")!.click();
    await flushPromises();
    expect(q(".stress-set-support")).not.toBeNull();
    q(".stress-setup-toggle")!.click();
    await flushPromises();
    expect(q(".stress-set-support")).toBeNull();
    // A new Run keeps it folded while it replaces the result.
    p.stressStarted();
    p.clearStressResult();
    await flushPromises();
    expect(q(".stress-set-support")).toBeNull();
    // A refused one opens it, where what is in the way usually is.
    p.stressFinished({ error: "set the faces of the load from a face selection" });
    await flushPromises();
    expect(q(".stress-set-support")).not.toBeNull();
  });

  it("lets the last load go, for a body under its own weight", async () => {
    const { panels } = await mounted();
    usePanelsStore().showStress("b1");
    await flushPromises();
    q(".stress-remove-load")!.click();
    expect(panels.removeStressLoad).toHaveBeenCalledWith(1);
  });

  it("counts the faces a Run sends, saying which the view cannot show or the model lacks", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    const sel: Selector = { kind: "face", by: "match", fp: { centroid: [0, 0, 0], normal: [1, 0, 0] }, body: "b1" };
    p.setStressLoadFaces(1, { selectors: [sel], faceIds: [], normalSum: [0, 0, 0], area: 0, unshown: 1, missing: 0 });
    p.setStressSupportFaces(1, {
      selectors: [sel],
      faceIds: [],
      normalSum: [0, 0, 0],
      area: 0,
      unshown: 0,
      missing: 1,
    });
    await flushPromises();
    const counts = [...document.body.querySelectorAll(".stress-count")].map((e) => e.textContent);
    expect(counts).toEqual(["1 face, not found on the current model", "1 face (not shown in the view)"]);
  });

  it("names a body the current model lacks rather than showing none", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showStress("b7");
    await flushPromises();
    const body = q(".stress-body")!;
    expect(value(body)).toBe("b7");
    expect(body.textContent?.trim()).toBe("b7 (not on the current model)");
  });

  it("lists the missing body without letting it be chosen, and hands a real body to the facade", async () => {
    const { panels } = await mounted();
    const p = usePanelsStore();
    p.showStress("b7");
    await flushPromises();
    q(".stress-body")!.click();
    await flushPromises();
    expect(optionLabels()).toEqual(["Choose…", "Bracket", "b7 (not on the current model)"]);
    const missing = [...document.body.querySelectorAll<HTMLElement>(".select-pop .opt-row")][2]!;
    expect(missing.getAttribute("aria-disabled")).toBe("true");
    missing.click();
    await flushPromises();
    expect(panels.setStressBody).not.toHaveBeenCalled();
    q(".stress-body")!.click();
    await flushPromises();
    await pick(q(".stress-body")!, "Bracket");
    expect(panels.setStressBody.mock.calls).toEqual([["b1"]]);
  });

  it("sets the load kind, the force direction and the material through the app's selects", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    await flushPromises();
    expect(q(".stress-panel select")).toBeNull();
    await pick(q(".stress-direction")!, "+X");
    await pick(q(".stress-material")!, "PETG");
    expect(q(".stress-panel")?.textContent).toContain("E 2100 MPa");
    await pick(q(".stress-load-kind")!, "Pressure");
    const l = p.stress!.setup.loads[0]!;
    expect({ kind: l.kind, direction: l.direction, material: p.stress!.setup.material }).toEqual({
      kind: "pressure",
      direction: "+X",
      material: "PETG",
    });
    expect(q(".stress-direction")).toBeNull();
    expect(q(".stress-pressure")).not.toBeNull();
  });

  it("keeps Stop probing pressable when the colours have gone", async () => {
    const { panels } = await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    p.stressFinished({ result: { rows: [], warnings: [], legend: { min: 0, max: 1 }, yields: false } });
    p.setStressProbe(true);
    await flushPromises();
    const probe = q(".stress-probe") as HTMLButtonElement;
    expect(probe.textContent).toBe("Stop probing");
    expect(probe.disabled).toBe(false);
    probe.click();
    expect(panels.setStressProbe).toHaveBeenCalledWith(false);
  });
});
