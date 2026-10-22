// The data lives in the document (ParamDef and paramExtras), since the params engine has to rename and delete
// through it even while this plugin is off. What this owns is every surface that edits it.

import ParametersSection from "./ParametersSection.vue";
import SetupPanel from "./SetupPanel.vue";
import { setupOpen } from "./state";
import { contribute } from "fundacad";
import type { Engine } from "fundacad";

const ID = "FundaCAD.ExtraParameters";

export async function activate(_e: Engine): Promise<() => void> {
  const open = () => {
    setupOpen.value = true;
  };

  const off = contribute(ID, {
    browserSections: [{ key: "parameters", component: ParametersSection }],
    overlays: [SetupPanel],
    menus: [
      {
        menu: "Edit",
        items: [
          { separator: true, label: "" },
          { label: "Parameter Setup…", onClick: open },
        ],
      },
    ],
    actions: { "parameter-setup": open },
  });

  return () => {
    setupOpen.value = false;
    off();
  };
}
