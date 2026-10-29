import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { Viewport } from "../../src/viewport/viewport";
import { useRibbonStore } from "../../src/stores/ribbon";
import { analysisFlags, railActive } from "../../src/ui/railActive";

// A viewport with no model: the setters only store the flag and fire the hook, which is what the rail reads.
function bare() {
  const v = Object.create(Viewport.prototype) as Viewport;
  return v;
}

describe("the rail's analysis on state follows the viewport", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("updates the ribbon store on every toggle, from any caller", () => {
    const ribbon = useRibbonStore();
    const v = bare();
    v.onAnalysisChange = () => (ribbon.viewOn = analysisFlags(v));
    const on = (a: string) => railActive(a, "model", "", ribbon.viewOn);

    v.setZebra(true);
    expect([on("zebra"), on("curvature"), on("component-colors"), on("draft-analysis")]).toEqual([
      true,
      false,
      false,
      false,
    ]);
    v.setCurvatureCombs(true);
    v.setAnalysis("draft");
    expect([on("zebra"), on("curvature"), on("component-colors"), on("draft-analysis")]).toEqual([
      true,
      true,
      false,
      true,
    ]);
    v.setAnalysis("component");
    v.setZebra(false);
    expect([on("zebra"), on("curvature"), on("component-colors"), on("draft-analysis")]).toEqual([
      false,
      true,
      true,
      false,
    ]);
    v.setCurvatureCombs(false);
    v.setAnalysis("none");
    expect(ribbon.viewOn).toEqual({
      zebra: false,
      curvature: false,
      "component-colors": false,
      "draft-analysis": false,
    });
  });
});
