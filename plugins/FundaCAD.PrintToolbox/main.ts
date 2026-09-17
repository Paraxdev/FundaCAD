// The 3D Printing Toolbox: print-friendly hole shapes and layer tricks, each a feature type this
// plugin owns, geometry included (geometry/register.py).
//
// Adding a tool: describe it in printForm.ts, add it to PRINT_TOOLS, give it an icon below, and
// register its handler in geometry/register.py with its type in manifest.json's featureTypes.

import { choose, contribute, toast } from "fundacad";
import type { Engine } from "fundacad";
import { bedFitMessage, bedSizeOf, loadBedFitSetting, saveBedFitSetting, BED_PRESETS } from "./bedFit";
import { openCustomBedDialog } from "./customBedDialog";
import CustomBedHost from "./CustomBedHost.vue";
import { BodyTool } from "./bodyTool";
import { FaceTool } from "./faceTool";
import { PRINT_TOOLS, type PrintTool } from "./printForm";

const ID = "FundaCAD.PrintToolbox";
const BED_FIT_ACTION = "print-bed-fit-check";

// Compile-time constants only: these reach the DOM through the app's Icon component.
const ICONS: Record<string, string> = {
  printTeardrop: '<path d="M12 4.5L16.24 8.76A6 6 0 1 1 7.76 8.76Z"/>',
  printRoofBridge: '<path d="M6 13V7H18V13A6 6 0 0 1 6 13Z"/>',
  printCounterboreBridge:
    '<circle cx="12" cy="12" r="8"/><line x1="4.25" y1="10" x2="19.75" y2="10"/>' +
    '<line x1="4.25" y1="14" x2="19.75" y2="14"/><rect x="10" y="10" width="4" height="4"/>',
  printSacrificialLayer:
    '<rect x="4" y="4" width="16" height="16" rx="1.5"/><line x1="10" y1="4" x2="10" y2="20"/>' +
    '<line x1="14" y1="4" x2="14" y2="20"/><line x1="10" y1="16.5" x2="14" y2="16.5"/>',
  printThreadRibs:
    '<circle cx="12" cy="12" r="7.5"/><line x1="12" y1="4.8" x2="12" y2="9"/>' +
    '<line x1="18.2" y1="14.5" x2="14.6" y2="12.4"/><line x1="5.8" y1="14.5" x2="9.4" y2="12.4"/>',
  printZipTieChannel:
    '<path d="M5 8V12A7 7 0 0 0 19 12V8"/><line x1="5" y1="4.5" x2="5" y2="8"/>' +
    '<line x1="19" y1="4.5" x2="19" y2="8"/>',
  printElephantFootChamfer: '<path d="M6 4V15H10.5L18 20V4Z"/>',
  printVerticalFillet:
    '<path d="M14 4H8A4 4 0 0 0 4 8V20"/><line x1="14" y1="4" x2="14" y2="20"/>' +
    '<line x1="4" y1="20" x2="14" y2="20"/>',
};

export async function activate(e: Engine): Promise<() => void> {
  const faceTool = new FaceTool(e.viewport, e.store);
  const bodyTool = new BodyTool(e.viewport, e.store);

  function start(tool: PrintTool) {
    if (e.toolBusy()) return;
    if (!e.hasBody()) {
      e.setStatus(`${tool.label}: create or import a body first`, "");
      return;
    }
    const done = (id: string | null) => {
      e.noteCommitted(id);
      if (id) e.selectFeature(id);
    };
    if (tool.pick === "bodies") bodyTool.run(tool, done);
    else faceTool.start(tool, done);
  }

  async function checkBedFit() {
    const bbox = e.store.buildState.result?.bbox;
    if (!bbox) {
      e.setStatus("Bed Fit Check: build the model first", "");
      return;
    }
    const size: readonly [number, number, number] = [
      bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2],
    ];
    const setting = loadBedFitSetting();
    const picked = await choose("Bed size", BED_PRESETS.map((p) => ({ value: p.id, label: p.label })));
    if (!picked) return;
    if (picked === "custom") {
      const customSize = await openCustomBedDialog(setting.customSize);
      if (!customSize) return;
      const next = { presetId: "custom", customSize };
      saveBedFitSetting(next);
      toast(bedFitMessage(size, customSize));
      return;
    }
    const next = { ...setting, presetId: picked };
    saveBedFitSetting(next);
    toast(bedFitMessage(size, bedSizeOf(next)));
  }

  const off = contribute(ID, {
    tools: PRINT_TOOLS.map((t) => ({
      id: t.id,
      label: t.label,
      iconName: t.icon,
      consumes: t.pick === "bodies" ? ["body"] : ["face"],
      source: "selection",
      busy: () => (t.pick === "bodies" ? bodyTool.active : faceTool.active),
    })),
    actions: {
      ...Object.fromEntries(PRINT_TOOLS.map((t) => [t.id, () => start(t)])),
      [BED_FIT_ACTION]: () => void checkBedFit(),
    },
    ribbon: [{
      group: "PRINT",
      items: [
        ...PRINT_TOOLS.map((t) => ({ action: t.id, label: t.label, iconName: t.icon })),
        { action: BED_FIT_ACTION, label: "Bed Fit Check", iconName: "printBedFit" },
      ],
    }],
    icons: { ...ICONS, printBedFit: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 15L9 10L13 14L20 7"/>' },
    overlays: [CustomBedHost],
    features: PRINT_TOOLS.map((t) => ({
      type: t.type,
      meta: { icon: t.icon, label: t.label },
      numFields: t.numFields,
      choiceFields: t.choiceFields,
      ...(t.toggleFields ? { toggleFields: t.toggleFields } : {}),
      targets: t.targets,
      ...(t.fieldApplies ? { fieldApplies: t.fieldApplies } : {}),
    })),
  });

  return () => {
    faceTool.cancel();
    bodyTool.cancel();
    off();
  };
}
