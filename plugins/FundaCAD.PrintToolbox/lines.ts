import { pluginText } from "fundacad";

export const { t } = pluginText<typeof import("./locales/en.json")>(
  "FundaCAD.PrintToolbox",
  import.meta.glob("./locales/*.json", { eager: true, import: "default" }),
);

export const groupLabel = () => t("group.print");

export function toolLabel(id: string): string {
  switch (id) {
    case "print-teardrop":
      return t("tool.teardrop");
    case "print-roof-bridge":
      return t("tool.roofBridge");
    case "print-counterbore-bridge":
      return t("tool.counterboreBridge");
    case "print-sacrificial-layer":
      return t("tool.sacrificialLayer");
    case "print-thread-ribs":
      return t("tool.threadRibs");
    case "print-zip-tie-channel":
      return t("tool.zipTieChannel");
    case "print-elephant-foot-chamfer":
      return t("tool.elephantFootChamfer");
    case "print-vertical-fillet":
      return t("tool.verticalFillet");
    case "print-bed-fit-check":
      return t("tool.bedFit");
    case "print-printability":
      return t("tool.printability");
    default:
      return id;
  }
}
