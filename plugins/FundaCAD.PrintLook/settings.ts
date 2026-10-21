import { definePluginSettings } from "fundacad";
import { DEFAULTS, DIRECTIONS, LIMITS } from "./look";

export const PLUGIN_ID = "FundaCAD.PrintLook";

export const settings = definePluginSettings(PLUGIN_ID, {
  version: 1,
  props: [
    {
      key: "layerLines", type: "boolean", label: "Layer lines", default: DEFAULTS.layerLines,
      description: "Draw the fine ridges a printed part shows. Display only, the model is unchanged.",
    },
    {
      key: "layerHeight", type: "number", label: "Layer height", unit: "length", default: DEFAULTS.layerHeight,
      min: LIMITS.layerHeight[0], max: LIMITS.layerHeight[1], step: 0.05,
    },
    {
      key: "direction", type: "enum", label: "Build direction", default: DEFAULTS.direction,
      options: DIRECTIONS.map((d) => ({ id: d.id, label: d.label })),
    },
    {
      key: "depth", type: "number", label: "Depth", default: DEFAULTS.depth,
      min: LIMITS.depth[0], max: LIMITS.depth[1], step: 0.05,
      description: "How deep a ridge is, as a share of the layer height.",
    },
    {
      key: "variation", type: "number", label: "Colour variation", default: DEFAULTS.variation,
      min: LIMITS.variation[0], max: LIMITS.variation[1], step: 0.01,
    },
    {
      key: "grooveShading", type: "number", label: "Groove shading", default: DEFAULTS.grooveShading,
      min: LIMITS.grooveShading[0], max: LIMITS.grooveShading[1], step: 0.05,
    },
  ],
});
