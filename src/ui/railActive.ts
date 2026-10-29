import { SKETCH_MODIFY } from "../app/actionTables";

interface AnalysisSource {
  zebraOn: boolean;
  combsOn: boolean;
  analysis: "none" | "component" | "draft";
}

export function analysisFlags(v: AnalysisSource): Record<string, boolean> {
  return {
    zebra: v.zebraOn,
    curvature: v.combsOn,
    "component-colors": v.analysis === "component",
    "draft-analysis": v.analysis === "draft",
  };
}

// A rail action is not always its sketch tool's name (mirror-sketch arms "mirror").
export function railActive(action: string, mode: string, sketchTool: string, viewOn: Record<string, boolean>): boolean {
  if (mode === "sketch") return sketchTool !== "" && (SKETCH_MODIFY[action] ?? action) === sketchTool;
  return viewOn[action] === true;
}

const VIEW_TOGGLES = new Set(Object.keys(analysisFlags({ zebraOn: false, combsOn: false, analysis: "none" })));

/** Whether a rail tool stays on once picked, so it says pressed: every armed sketch tool and the analysis views. */
export function railToggles(action: string, mode: string): boolean {
  return mode === "sketch" || VIEW_TOGGLES.has(action);
}
