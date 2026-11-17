import { definePluginSettings } from "fundacad";
import { DEFAULTS, DIRECTIONS, LIMITS } from "./look";
import { t } from "./lines";

export const PLUGIN_ID = "FundaCAD.PrintLook";

export const settings = definePluginSettings(PLUGIN_ID, {
  version: 1,
  props: [
    {
      key: "layerLines",
      type: "boolean",
      get label() {
        return t("setting.layerLines");
      },
      default: DEFAULTS.layerLines,
      get description() {
        return t("setting.layerLines.hint");
      },
    },
    {
      key: "layerHeight",
      type: "number",
      get label() {
        return t("setting.layerHeight");
      },
      unit: "length",
      default: DEFAULTS.layerHeight,
      min: LIMITS.layerHeight[0],
      max: LIMITS.layerHeight[1],
      step: 0.05,
    },
    {
      key: "direction",
      type: "enum",
      get label() {
        return t("setting.direction");
      },
      default: DEFAULTS.direction,
      options: DIRECTIONS.map((d) => ({ id: d.id, label: d.label })),
    },
    {
      key: "depth",
      type: "number",
      get label() {
        return t("setting.depth");
      },
      default: DEFAULTS.depth,
      min: LIMITS.depth[0],
      max: LIMITS.depth[1],
      step: 0.05,
      get description() {
        return t("setting.depth.hint");
      },
    },
    {
      key: "variation",
      type: "number",
      get label() {
        return t("setting.variation");
      },
      default: DEFAULTS.variation,
      min: LIMITS.variation[0],
      max: LIMITS.variation[1],
      step: 0.01,
    },
    {
      key: "grooveShading",
      type: "number",
      get label() {
        return t("setting.grooveShading");
      },
      default: DEFAULTS.grooveShading,
      min: LIMITS.grooveShading[0],
      max: LIMITS.grooveShading[1],
      step: 0.05,
    },
  ],
});
