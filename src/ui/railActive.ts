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
export function railActive(
  action: string,
  mode: string,
  sketchTool: string,
  viewOn: Record<string, boolean>,
): boolean {
  if (mode === "sketch") return sketchTool !== "" && (SKETCH_MODIFY[action] ?? action) === sketchTool;
  return viewOn[action] === true;
}
