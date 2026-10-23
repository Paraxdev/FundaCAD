import type { SketchTool } from "./sketchMode";

export interface ToolKey {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** A key with a modifier is left to the global keymap, where Shift+P, Shift+L and Shift+C are constraints. */
export function sketchToolKey(e: ToolKey, tool: SketchTool): SketchTool | "tangent-arc" | null {
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key.toLowerCase()) {
    case "l":
      return "line";
    case "r":
      return "rectangle";
    case "c":
      return "circle";
    case "a":
      return tool === "arc" ? "tangent-arc" : "arc";
    case "t":
      return "trim";
    case "o":
      return "offset";
    case "p":
      return "project";
    default:
      return null;
  }
}
