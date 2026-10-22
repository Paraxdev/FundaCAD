// Import from an Onshape link. Everything that knows Onshape is in this
// directory: the link format, the request signing, the STEP translation and its
// polling. The app lends it three generic things, an https request to the hosts
// in manifest.json, the system's credential store, and the ordinary import.

import { contribute } from "fundacad";
import type { Engine } from "fundacad";
import LinkHost from "./LinkHost.vue";
import KeysSection from "./KeysSection.vue";
import { PLUGIN_ID } from "./native";

export async function activate(e: Engine): Promise<() => void> {
  const run = () => void import("./flow").then((m) => m.importFromOnshape(e.store, e.geometry));
  return contribute(PLUGIN_ID, {
    menus: [
      {
        menu: "File",
        items: [
          { separator: true, label: "" },
          { label: "Import from Onshape link\u2026", onClick: run },
        ],
      },
    ],
    overlays: [LinkHost],
    settings: [{ key: "onshape", component: KeysSection }],
  });
}
