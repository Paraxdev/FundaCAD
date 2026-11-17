import { pluginText } from "fundacad";

export const { t, tEnglish } = pluginText<typeof import("./locales/en.json")>(
  "FundaCAD.Onshape",
  import.meta.glob("./locales/*.json", { eager: true, import: "default" }),
);
