// The 3D Printing Toolbox: print-friendly hole shapes and layer tricks, each a feature type this
// plugin owns, geometry included (geometry/register.py).
//
// Adding a tool: describe it in printForm.ts, add it to PRINT_TOOLS, give it an icon below, and
// register its handler in geometry/register.py with its type in manifest.json's featureTypes.

import { contribute } from "fundacad";
import type { Engine } from "fundacad";
import { FaceTool } from "./faceTool";
import { FACES_TARGET, PRINT_TOOLS, type PrintTool } from "./printForm";

const ID = "FundaCAD.PrintToolbox";

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
};

export async function activate(e: Engine): Promise<() => void> {
  const faceTool = new FaceTool(e.viewport, e.store);

  function start(tool: PrintTool) {
    if (e.toolBusy()) return;
    if (!e.hasBody()) {
      e.setStatus(`${tool.label}: create or import a body first`, "");
      return;
    }
    faceTool.start(tool, (id) => {
      e.noteCommitted(id);
      if (id) e.selectFeature(id);
    });
  }

  const off = contribute(ID, {
    tools: PRINT_TOOLS.map((t) => ({
      id: t.id,
      label: t.label,
      iconName: t.icon,
      consumes: ["face"],
      source: "selection",
      busy: () => faceTool.active,
    })),
    actions: Object.fromEntries(PRINT_TOOLS.map((t) => [t.id, () => start(t)])),
    ribbon: [{ group: "PRINT", items: PRINT_TOOLS.map((t) => ({ action: t.id, label: t.label, iconName: t.icon })) }],
    icons: ICONS,
    features: PRINT_TOOLS.map((t) => ({
      type: t.type,
      meta: { icon: t.icon, label: t.label },
      numFields: t.numFields,
      choiceFields: t.choiceFields,
      targets: FACES_TARGET,
      ...(t.fieldApplies ? { fieldApplies: t.fieldApplies } : {}),
    })),
  });

  return () => {
    faceTool.cancel();
    off();
  };
}
