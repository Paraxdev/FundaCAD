import { pluginText } from "fundacad";

export const { t } = pluginText<typeof import("./locales/en.json")>(
  "FundaCAD.Screws",
  import.meta.glob("./locales/*.json", { eager: true, import: "default" }),
);
