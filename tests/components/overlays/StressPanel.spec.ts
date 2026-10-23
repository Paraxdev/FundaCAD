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
import type { StressResultView } from "../../../src/ui/stress";

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
    setStressShape: vi.fn(),
    setStressDeformation: vi.fn(),
    setStressAnimate: vi.fn(),
    pauseStressAnimation: vi.fn(),
    setStressProbe: vi.fn(),
    removeStressProbe: vi.fn(),
    placeStressSpot: vi.fn(),
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

function view(over: Partial<StressResultView> = {}): StressResultView {
  return {
    rows: [
      { k: "Safety factor", v: "3.3" },
      { k: "Peak stress", v: "15 MPa" },
      { k: "Max deflection", v: "0.47 mm" },
    ],
    details: [
      { k: "Material", v: "PLA" },
      { k: "Mesh", v: "4800 elements, 2.5 mm" },
    ],
    warnings: [],
    legend: { min: 0.5, max: 15 },
    yields: false,
    verdict: { safetyFactor: 3.32, peakPlace: null },
    peakAt: [13.5, -7.25, 4.1],
    maxDeflection: 0.47,
    ...over,
  };
}

const tab = (t: "setup" | "results") => q(`.float-tab[data-tab="${t}"]`) as HTMLButtonElement;
const shown = (el: HTMLElement | null) => !!el && el.style.display !== "none";

async function withResult(over: Partial<StressResultView> = {}) {
  const m = await mounted();
  const p = usePanelsStore();
  p.showStress("b1");
  p.stressStarted();
  p.stressFinished({ result: view(over) });
  p.setStressColours("shown");
  await flushPromises();
  return { ...m, p };
}

describe("StressPanel", () => {
  it("renders nothing while closed", async () => {
    await mounted();
    expect(q(".stress-panel")).toBeNull();
  });

  it("shows the setup and hands the face buttons, Run and Close to the facade", async () => {
    const { panels } = await mounted();
    usePanelsStore().showStress("b1");
    await flushPromises();
    expect(q(".stress-panel")?.textContent).toContain("Support 1");
    expect(value(q(".stress-support-type"))).toBe("fixed");
    expect(value(q(".stress-body"))).toBe("b1");
    expect([q(".stress-place-support")?.textContent, q(".stress-set-support")?.textContent]).toEqual([
      "Click on body",
      "Use selected faces",
    ]);
    expect([...document.body.querySelectorAll(".stress-count")].map((e) => e.textContent)).toEqual([
      "No faces yet",
      "No faces yet",
    ]);
    q(".stress-set-support")!.click();
    q(".stress-set-load")!.click();
    expect(panels.setStressFacesFromSelection.mock.calls).toEqual([[{ support: 1 }], [{ load: 1 }]]);
    expect(q(".stress-cancel")).toBeNull();
    q(".stress-run")!.click();
    expect(panels.runStress).toHaveBeenCalledOnce();
    q(".stress-close")!.click();
    expect(panels.closeStress).toHaveBeenCalledOnce();
  });

  it("asks for E, nu and yield only for a custom material, and reads a blank mesh size as automatic", async () => {
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

  it("folds More options with the mesh size, open at once when a size is set", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    await flushPromises();
    const more = q(".stress-more")!;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(shown(q(".stress-more-body"))).toBe(false);
    more.click();
    await flushPromises();
    expect(shown(q(".stress-more-body"))).toBe(true);
    expect(q(".stress-size")?.parentElement?.textContent).toContain("mm");
    p.stress = null;
    await flushPromises();
    p.showStress("b1");
    p.stress!.setup.size = 7.5;
    await flushPromises();
    expect(shown(q(".stress-more-body"))).toBe(true);
    expect((q(".stress-size") as HTMLInputElement).value).toBe("7.5");
  });

  it("keeps the body while a Run is out and swaps Run for Cancel until it settles", async () => {
    const { panels } = await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    p.stressStarted();
    await flushPromises();
    expect((q(".stress-body") as HTMLButtonElement).disabled).toBe(true);
    expect(q(".stress-run")).toBeNull();
    expect(q(".stress-foot")?.textContent).toContain("Analysing");
    q(".stress-cancel")!.click();
    expect(panels.cancelStress).toHaveBeenCalledOnce();
    p.stressFinished({});
    await flushPromises();
    expect(q(".stress-cancel")).toBeNull();
    expect(q(".stress-run")).not.toBeNull();
  });

  it("keeps Results shut until a Run has one, then opens it by itself", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    await flushPromises();
    expect(tab("results").disabled).toBe(true);
    expect(tab("results").title).not.toBe("");
    tab("results").click();
    await flushPromises();
    expect(tab("setup").getAttribute("aria-selected")).toBe("true");
    p.stressStarted();
    p.stressFinished({ result: view() });
    await flushPromises();
    expect(tab("results").disabled).toBe(false);
    expect(tab("results").getAttribute("aria-selected")).toBe("true");
    expect(q(".stress-set-support")).toBeNull();
    expect(q(".stress-run")).toBeNull();
    expect(q(".stress-verdict")).not.toBeNull();
  });

  it("lets the user go back to the setup and to the results again", async () => {
    await withResult();
    tab("setup").click();
    await flushPromises();
    expect(q(".stress-set-support")).not.toBeNull();
    expect(q(".stress-legend")).toBeNull();
    tab("results").click();
    await flushPromises();
    expect(q(".stress-set-support")).toBeNull();
    expect(q(".stress-legend")).not.toBeNull();
  });

  it("shows the setup again when the result goes, a Run is refused, or the panel reopens", async () => {
    const { p } = await withResult();
    p.clearStressResult();
    await flushPromises();
    expect(tab("setup").getAttribute("aria-selected")).toBe("true");
    p.stressFinished({ result: view() });
    await flushPromises();
    expect(tab("results").getAttribute("aria-selected")).toBe("true");
    p.stressFinished({ result: view(), error: "set the faces of the load from a face selection" });
    await flushPromises();
    expect(tab("setup").getAttribute("aria-selected")).toBe("true");
    expect(q(".stress-error")?.textContent).toContain("set the faces of the load");
    tab("results").click();
    await flushPromises();
    p.stress = null;
    await flushPromises();
    p.showStress("b1");
    await flushPromises();
    expect(tab("setup").getAttribute("aria-selected")).toBe("true");
  });

  it("shows the key rows in order, the legend's ends, the folded details and the warnings", async () => {
    await withResult({
      rows: [
        { k: "Safety factor", v: "0.8" },
        { k: "Peak stress", v: "62 MPa" },
        { k: "Max deflection", v: "1.25 mm" },
      ],
      warnings: ["printed parts are weaker across layers"],
      legend: { min: 0.5, max: 62 },
      yields: true,
    });
    const rows = [...document.body.querySelectorAll(".stress-key-row")].map((r) => [
      r.querySelector(".measure-k")?.textContent,
      r.querySelector(".measure-v")?.textContent,
    ]);
    expect(rows).toEqual([
      ["Safety factor", "0.8"],
      ["Peak stress", "62 MPa"],
      ["Max deflection", "1.25 mm"],
    ]);
    const text = q(".stress-panel")!.textContent!;
    expect(text).toContain("0.5 MPa");
    expect(text).toContain("62 MPa");
    expect(q(".stress-warning")?.textContent).toBe("Printed parts are weaker across layers.");
    expect(q(".stress-yields")?.textContent).toBe("0.8");
    expect(q(".stress-legend")?.getAttribute("style")).toContain("linear-gradient");
    const details = q(".stress-details")!;
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(shown(q(".stress-details-body"))).toBe(false);
    expect([...document.body.querySelectorAll(".stress-detail-row .measure-k")].map((e) => e.textContent)).toEqual([
      "Material",
      "Mesh",
    ]);
    details.click();
    await flushPromises();
    expect(shown(q(".stress-details-body"))).toBe(true);
  });

  it("says when the model changed since the Run, hides the deformation, and runs again", async () => {
    const { p, panels } = await withResult();
    p.setStressDeform({ scale: 10, auto: 10, max: 40, animate: false, shown: true });
    await flushPromises();
    expect(q(".stress-stale")).toBeNull();
    expect(q(".stress-deform")).not.toBeNull();
    p.setStressColours("none");
    await flushPromises();
    expect(q(".stress-stale")?.textContent).toContain("model changed");
    expect(q(".stress-deform")).toBeNull();
    q(".stress-rerun")!.click();
    expect(panels.runStress).toHaveBeenCalledOnce();
  });

  it("puts the stale line above the verdict and dims the old reading under it", async () => {
    const { p } = await withResult();
    const step = q(".stress-results")!;
    expect([...step.classList]).toEqual(["stress-step", "stress-results"]);
    expect(step.firstElementChild?.classList.contains("stress-verdict")).toBe(true);
    p.setStressColours("none");
    await flushPromises();
    expect([...step.classList]).toEqual(["stress-step", "stress-results", "stale"]);
    expect(step.firstElementChild?.classList.contains("stress-stale")).toBe(true);
  });

  it("shows the legend only with the colours, titled Stress, with a minimum too small to tell from 0 as 0", async () => {
    const { p } = await withResult({ legend: { min: 0.000656, max: 51.11 } });
    const ends = () => [...document.body.querySelectorAll(".stress-legend-labels > span")].map((e) => e.textContent);
    expect(ends()).toEqual(["0 MPa", "Stress", "51.11 MPa"]);
    p.setStressColours("hidden");
    await flushPromises();
    expect(q(".stress-legend")).toBeNull();
    expect(ends()).toEqual([]);
  });

  it("has a Deformed shape switch beside Colours, the exaggeration only while the shape is drawn", async () => {
    const { p, panels } = await withResult({ maxDeflection: 0.47 });
    const shape = () => q(".stress-shape") as HTMLInputElement | null;
    const bend = () => q(".stress-verdict-bend")?.textContent;
    expect(shape(), "no switch without a deformed shape").toBeNull();
    p.setStressDeform({ scale: 12.5, auto: 12.5, max: 50, animate: false, shown: true });
    await flushPromises();
    expect(shape()!.closest(".stress-view-row")).toBe(q(".stress-colours")!.closest(".stress-view-row"));
    expect({ checked: shape()!.checked, slider: !!q(".stress-deform") }).toEqual({ checked: true, slider: true });
    expect(bend()).toContain("drawn 13x larger");
    p.setStressColours("hidden");
    await flushPromises();
    expect({ checked: shape()!.checked, slider: !!q(".stress-deform") }).toEqual({ checked: true, slider: true });
    p.stress!.deform!.shown = false;
    await flushPromises();
    expect({ checked: shape()!.checked, slider: !!q(".stress-deform") }).toEqual({ checked: false, slider: false });
    expect(bend()).toContain("not drawn");
    shape()!.click();
    expect(panels.setStressShape.mock.calls).toEqual([[true]]);
    p.setStressColours("none");
    await flushPromises();
    expect(shape(), "gone once the model changed").toBeNull();
  });

  it("lets the exaggeration slider rest on any value, so True size sits at 1", async () => {
    const { p } = await withResult();
    p.setStressDeform({ scale: 1, auto: 12.5, max: 50, animate: false, shown: true });
    await flushPromises();
    const slider = q(".stress-deform") as HTMLInputElement;
    expect([slider.step, slider.value]).toEqual(["any", "1"]);
  });

  it("keeps Details and More options open across a switch of tabs", async () => {
    await withResult();
    q(".stress-details")!.click();
    tab("setup").click();
    await flushPromises();
    q(".stress-more")!.click();
    tab("results").click();
    await flushPromises();
    expect(shown(q(".stress-details-body"))).toBe(true);
    tab("setup").click();
    await flushPromises();
    expect(shown(q(".stress-more-body"))).toBe(true);
  });

  it("says when the setup changed since the Run, and not when it is back as it ran", async () => {
    const { p } = await withResult();
    expect(q(".stress-stale")).toBeNull();
    const ran = p.stress!.setup.loads[0]!.force;
    p.stress!.setup.loads[0]!.force = 42.5;
    await flushPromises();
    expect(q(".stress-stale")?.textContent).toContain("setup changed");
    p.stress!.setup.loads[0]!.force = ran;
    await flushPromises();
    expect(q(".stress-stale")).toBeNull();
    p.stress!.setup.loads[0]!.force = 42.5;
    p.setStressColours("none");
    await flushPromises();
    expect(q(".stress-stale")?.textContent).toContain("model changed");
    expect(document.body.querySelectorAll(".stress-stale").length).toBe(1);
  });

  it("names the setup the result ran with, not the one edited since", async () => {
    const { p } = await withResult();
    p.stress!.setup.gravity.on = true;
    await flushPromises();
    expect(q(".stress-ran-with")?.textContent).toBe("1 support, 1 load, PLA");
  });

  it("toggles the colours with a switch", async () => {
    const { p, panels } = await withResult();
    const colours = q(".stress-colours") as HTMLInputElement;
    expect(colours.checked).toBe(true);
    colours.click();
    expect(panels.setStressColours).toHaveBeenCalledWith(false);
    p.setStressColours("hidden");
    await flushPromises();
    expect(colours.checked).toBe(false);
    colours.click();
    expect(panels.setStressColours).toHaveBeenLastCalledWith(true);
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

  it("turns the own weight on with a direction, off by default", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    await flushPromises();
    const on = q(".stress-gravity-on") as HTMLInputElement;
    expect(on.checked).toBe(false);
    expect(q(".stress-gravity-dir")).toBeNull();
    on.click();
    await flushPromises();
    expect(p.stress!.setup.gravity.on).toBe(true);
    await pick(q(".stress-gravity-dir")!, "Back (+Y)");
    expect(p.stress!.setup.gravity).toEqual({ on: true, direction: "+Y" });
  });

  it("shows the deformation with its factor, True size, Read a point and the pinned points", async () => {
    const { p, panels } = await withResult();
    p.setStressDeform({ scale: 120, auto: 120, max: 480, animate: false, shown: true });
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
    q(".stress-probe")!.click();
    expect(panels.setStressProbe).toHaveBeenCalledWith(true);
    expect(q(".stress-pin")?.textContent).toContain("12 MPa, 0.4 mm");
    q(".stress-remove-pin")!.click();
    expect(panels.removeStressProbe).toHaveBeenCalledWith(1);
  });

  it("opens Results with the verdict, marked by how it went, and the bend at the drawn scale", async () => {
    const { p } = await withResult({
      yields: true,
      verdict: { safetyFactor: 0.62, peakPlace: null },
    });
    p.setStressDeform({ scale: 12.5, auto: 12.5, max: 50, animate: false, shown: true });
    await flushPromises();
    const step = q(".stress-results")!;
    const verdict = step.firstElementChild as HTMLElement;
    expect([...verdict.classList]).toEqual(["stress-verdict", "fails"]);
    expect(verdict.textContent).toContain("Likely to fail");
    expect(q(".stress-verdict-bend")?.textContent).toContain("0.47 mm, drawn 13x larger");
    p.stressFinished({ result: view() });
    p.clearStressResult();
    p.stressFinished({ result: view() });
    await flushPromises();
    expect([...q(".stress-verdict")!.classList]).toEqual(["stress-verdict", "holds"]);
    expect(q(".stress-verdict-bend")).toBeNull();
  });

  it("keeps the marked spot with the colours off, and drops it once the model changed", async () => {
    const { p } = await withResult({ verdict: { safetyFactor: 2.94, peakPlace: "corner" } });
    const text = () => q(".stress-verdict")!.textContent;
    expect(q(".stress-verdict-head")!.textContent).toBe("Holds by a rough reading, at least 2.9x safe.");
    expect(text()).toContain("Weakest at the marked sharp corner.");
    p.setStressColours("hidden");
    await flushPromises();
    expect(text()).toContain("Weakest at the marked sharp corner.");
    p.setStressColours("none");
    await flushPromises();
    expect(text()).toContain("Weakest at a sharp inside corner.");
    expect(text()).not.toContain("marked");
  });

  it("plays and pauses the deformation from one button that says which it will do", async () => {
    const { p, panels } = await withResult();
    p.setStressDeform({ scale: 12.5, auto: 12.5, max: 50, animate: false, shown: true });
    await flushPromises();
    const play = q(".stress-animate")!;
    expect({ text: play.textContent?.trim(), pressed: play.getAttribute("aria-pressed") }).toEqual({
      text: "Play",
      pressed: "false",
    });
    play.click();
    p.stress!.deform!.animate = true;
    await flushPromises();
    expect({ text: play.textContent?.trim(), pressed: play.getAttribute("aria-pressed") }).toEqual({
      text: "Pause",
      pressed: "true",
    });
    play.click();
    expect(panels.setStressAnimate.mock.calls).toEqual([[true], [false]]);
  });

  it("pauses the swing on the way to Set up, and does not play it again back in Results", async () => {
    const { p, panels } = await withResult();
    p.setStressDeform({ scale: 12.5, auto: 12.5, max: 50, animate: false, shown: true });
    await flushPromises();
    tab("setup").click();
    await flushPromises();
    expect(panels.pauseStressAnimation).not.toHaveBeenCalled();
    tab("results").click();
    p.stress!.deform!.animate = true;
    await flushPromises();
    tab("setup").click();
    await flushPromises();
    expect(panels.pauseStressAnimation).toHaveBeenCalledOnce();
    tab("results").click();
    await flushPromises();
    expect(panels.setStressAnimate).not.toHaveBeenCalled();
  });

  it("lets the last load go, for a body under its own weight", async () => {
    const { panels } = await mounted();
    usePanelsStore().showStress("b1");
    await flushPromises();
    q(".stress-remove-load")!.click();
    expect(panels.removeStressLoad).toHaveBeenCalledWith(1);
  });

  it("counts loads as it counts supports, 0 included", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    p.addStressLoad();
    await flushPromises();
    const pills = () => [...document.body.querySelectorAll(".stress-caption .tree-count")].map((e) => e.textContent);
    expect(pills()).toEqual(["1", "2"]);
    p.stress!.setup.loads = [];
    await flushPromises();
    expect(pills()).toEqual(["1", "0"]);
  });

  it("says Ready under the setup once it can run, and how to get there until then", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    await flushPromises();
    const hint = () => q(".measure-hint:not(.stress-error)")!.textContent;
    expect(hint()).not.toContain("Ready");
    const sel: Selector = { kind: "face", by: "nearest", point: [12.5, -3, 4.25], body: "b1" };
    const faces = { selectors: [sel], faceIds: [4], normalSum: [5.4, 0, 7.2] as [number, number, number], area: 9 };
    p.setStressSupportFaces(1, faces);
    await flushPromises();
    expect(hint()).not.toContain("Ready");
    p.setStressLoadFaces(1, faces);
    await flushPromises();
    expect(hint()).toBe("Ready, press Run.");
  });

  it("names the directions by the way they point, with the axis", async () => {
    await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    p.stress!.setup.gravity.on = true;
    await flushPromises();
    (q(".stress-gravity-dir") as HTMLElement).click();
    await flushPromises();
    expect(optionLabels()).toEqual(["Down (-Z)", "Up (+Z)", "Right (+X)", "Left (-X)", "Back (+Y)", "Front (-Y)"]);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    (q(".stress-direction") as HTMLElement).click();
    await flushPromises();
    expect(optionLabels()).toEqual([
      "Into the face",
      "Down (-Z)",
      "Up (+Z)",
      "Right (+X)",
      "Left (-X)",
      "Back (+Y)",
      "Front (-Y)",
      "Custom vector",
    ]);
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
    await pick(q(".stress-direction")!, "Right (+X)");
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

  it("keeps Read a point pressable to leave probe mode when the colours have gone", async () => {
    const { p, panels } = await withResult();
    p.setStressColours("none");
    await flushPromises();
    const probe = q(".stress-probe") as HTMLButtonElement;
    expect(probe.disabled).toBe(true);
    p.setStressProbe(true);
    await flushPromises();
    expect(probe.getAttribute("aria-pressed")).toBe("true");
    expect(probe.disabled).toBe(false);
    probe.click();
    expect(panels.setStressProbe).toHaveBeenCalledWith(false);
  });
});

describe("StressPanel Escape", () => {
  const esc = (target: Element = document.body) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

  it("closes the panel on a plain Escape", async () => {
    const { panels } = await mounted();
    usePanelsStore().showStress("b1");
    await flushPromises();
    esc();
    expect(panels.closeStress).toHaveBeenCalledOnce();
    expect(panels.setStressProbe).not.toHaveBeenCalled();
    expect(panels.placeStressSpot).not.toHaveBeenCalled();
  });

  it("closes from the Results step too", async () => {
    const { panels } = await withResult();
    esc(tab("results"));
    expect(panels.closeStress).toHaveBeenCalledOnce();
  });

  it("ends probe mode first, and closes on the next press", async () => {
    const { p, panels } = await withResult();
    p.setStressProbe(true);
    await flushPromises();
    esc();
    expect(panels.setStressProbe).toHaveBeenCalledWith(false);
    expect(panels.closeStress).not.toHaveBeenCalled();
    p.setStressProbe(false);
    esc();
    expect(panels.closeStress).toHaveBeenCalledOnce();
  });

  it("stops placing first, and closes on the next press", async () => {
    const { panels } = await mounted();
    const p = usePanelsStore();
    p.showStress("b1");
    p.setStressPlacing({ support: 1 });
    await flushPromises();
    esc();
    expect(panels.placeStressSpot).toHaveBeenCalledWith({ support: 1 });
    expect(panels.closeStress).not.toHaveBeenCalled();
    p.setStressPlacing(null);
    esc();
    expect(panels.closeStress).toHaveBeenCalledOnce();
  });

  it("lets a focused field give up focus before the panel closes", async () => {
    const { panels } = await mounted();
    usePanelsStore().showStress("b1");
    await flushPromises();
    const field = q(".stress-panel input") as HTMLInputElement;
    field.focus();
    expect(document.activeElement).toBe(field);
    esc(field);
    expect(document.activeElement).not.toBe(field);
    expect(panels.closeStress).not.toHaveBeenCalled();
    esc();
    expect(panels.closeStress).toHaveBeenCalledOnce();
  });

  it("leaves a key a layer in front already took", async () => {
    const { panels } = await mounted();
    usePanelsStore().showStress("b1");
    await flushPromises();
    const take = (e: Event) => e.stopImmediatePropagation();
    window.addEventListener("keydown", take, true);
    esc();
    window.removeEventListener("keydown", take, true);
    expect(panels.closeStress).not.toHaveBeenCalled();
  });

  it("ignores Escape while closed and other keys", async () => {
    const { panels } = await mounted();
    esc();
    usePanelsStore().showStress("b1");
    await flushPromises();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(panels.closeStress).not.toHaveBeenCalled();
  });
});
