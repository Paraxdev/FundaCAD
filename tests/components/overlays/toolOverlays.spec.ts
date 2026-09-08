// The two smallest in-canvas overlays, and the one thing each has that is worth
// pinning.
//
//   ProjectFilterBar, `filter` is TOOL state, not panel state: sketchMode.ts
//   reads it synchronously inside the projection routine, so it has to survive
//   the bar being hidden and shown again.
//
//   MeasureReadout, the rows used to be built with innerHTML and two hand-
//   placed esc() calls. Interpolation escapes on its own now, and a leftover
//   esc() would render a value containing "&" as "&amp;".
//
// Neither panel's PLACEMENT is testable here: the filter bar centres itself over
// the canvas by measuring its own offsetWidth, and happy-dom reports every width
// as 0. That stays manual.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ProjectFilterBar from "../../../src/components/overlays/ProjectFilterBar.vue";
import MeasureReadout from "../../../src/components/overlays/MeasureReadout.vue";
import { useToolPanelStore } from "../../../src/stores/toolPanels";
import { ProjectPanel } from "../../../src/sketch/projectPanel";

enableAutoUnmount(afterEach);

describe("ProjectFilterBar", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
  });

  it("shows one chip per filter and starts on edges & faces", () => {
    const p = new ProjectPanel();
    p.show(document.createElement("div"));
    mount(ProjectFilterBar, { attachTo: document.body });
    const chips = [...document.querySelectorAll("button")].map((b) => b.textContent);
    expect(chips).toEqual(["Edges & faces", "Sketch curves", "Body silhouette"]);
    expect(p.filter).toBe("edges");
  });

  it("publishes the chosen filter to the tool synchronously", async () => {
    const p = new ProjectPanel();
    const onChange = vi.fn();
    p.onChange = onChange; // assigned AFTER construction, as SketchMode does
    p.show(document.createElement("div"));
    mount(ProjectFilterBar, { attachTo: document.body });

    document.querySelectorAll("button")[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // no await: the projection routine reads p.filter in the same turn
    expect(p.filter).toBe("sketchCurves");
    expect(onChange).toHaveBeenCalledWith("sketchCurves");
  });

  it("keeps the filter across hide/show, it belongs to the tool, not the bar", async () => {
    const p = new ProjectPanel();
    p.show(document.createElement("div"));
    mount(ProjectFilterBar, { attachTo: document.body });
    document.querySelectorAll("button")[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    p.hide();
    expect(useToolPanelStore().projectAnchor).toBeNull();
    p.show(document.createElement("div"));
    expect(p.filter).toBe("silhouette");
  });
});

describe("MeasureReadout", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
  });

  it("stays out of the DOM until the tool is running", async () => {
    mount(MeasureReadout, { attachTo: document.body });
    expect(document.querySelector(".measure-panel")).toBeNull();

    useToolPanelStore().measure = [{ k: "", v: "Pick a face or edge" }];
    await nextTick();
    expect(document.querySelector(".measure-panel")).not.toBeNull();
  });

  it("renders each row as a key/value pair inside the shared panel shell", async () => {
    mount(MeasureReadout, { attachTo: document.body });
    useToolPanelStore().measure = [{ k: "Area", v: "50 mm²" }, { k: "At", v: "0, 0, 0" }];
    await nextTick();
    expect([...document.querySelectorAll(".measure-k")].map((e) => e.textContent)).toEqual(["Area", "At"]);
    expect([...document.querySelectorAll(".measure-v")].map((e) => e.textContent)).toEqual(["50 mm²", "0, 0, 0"]);
    expect(document.querySelector(".measure-title")!.textContent).toBe("Measure");
    expect(document.querySelector(".measure-hint")!.textContent).toContain("Esc to exit");
  });

  it("escapes a value exactly once", async () => {
    mount(MeasureReadout, { attachTo: document.body });
    useToolPanelStore().measure = [{ k: "ΔX ΔY ΔZ", v: "1 & 2" }];
    await nextTick();
    const v = document.querySelector(".measure-v")!;
    expect(v.textContent).toBe("1 & 2");
    expect(v.innerHTML).not.toContain("&amp;amp;");
  });
});
