// Extra parameters: the controls, groups, configurations and checks over a
// document's parameter table.
//
// The data is not here. A control, a group, a configuration and a check are all
// part of the document (ParamDef and paramExtras in src/types.ts), because every
// one of them names parameters and the params engine has to rename and delete
// through them whether or not this is installed. A plugin that owned the data
// would leave a configuration pointing at a parameter that was renamed while it
// was switched off. What this owns is every surface that edits it.

import ParametersSection from "./ParametersSection.vue";
import SetupPanel from "./SetupPanel.vue";
import { setupOpen } from "./state";
import { contribute } from "fundacad";
import type { Engine } from "fundacad";

const ID = "FundaCAD.ExtraParameters";

export async function activate(_e: Engine): Promise<() => void> {
  const open = () => { setupOpen.value = true; };

  const off = contribute(ID, {
    browserSections: [{ key: "parameters", component: ParametersSection }],
    overlays: [SetupPanel],
    menus: [{ menu: "Edit", items: [{ separator: true, label: "" }, { label: "Parameter Setup…", onClick: open }] }],
    actions: { "parameter-setup": open },
  });

  return () => {
    setupOpen.value = false;
    off();
  };
}
