import { pluginText } from "fundacad";

export const { t } = pluginText<typeof import("./locales/en.json")>(
  "FundaCAD.SpaceMouse",
  import.meta.glob("./locales/*.json", { eager: true, import: "default" }),
);
