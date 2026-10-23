// The surface texture tool. A document with a texture needs this plugin: without it the app carries the feature's values
// untouched and the build names the plugin (src/document/missingPlugins.ts).

import { contribute } from "fundacad";
import type { Engine } from "fundacad";
import { TextureTool } from "./textureTool";
import TextureToolPanel from "./TextureToolPanel.vue";
import * as panel from "./panel";
import {
  TEXTURE_CHOICE_FIELDS,
  TEXTURE_FILE_FIELDS,
  TEXTURE_NUM_FIELDS,
  TEXTURE_TARGETS,
  TEXTURE_TOGGLE_FIELDS,
  sharpnessLabel,
  textureFieldApplies,
} from "./textureForm";

const ID = "FundaCAD.Texture";

/** A knurl seen face-on, in the 24x24 house style. Must stay a compile-time constant: it reaches the DOM through the
 *  Icon component's v-html, so nothing from a document, a file name or the network may go into it. */
const TEXTURE_ICON =
  '<rect x="4" y="4" width="16" height="16" rx="2"/>' +
  '<line x1="4" y1="9.3" x2="20" y2="9.3"/><line x1="4" y1="14.7" x2="20" y2="14.7"/>' +
  '<line x1="9.3" y1="4" x2="9.3" y2="20"/><line x1="14.7" y1="4" x2="14.7" y2="20"/>';

export async function activate(e: Engine): Promise<() => void> {
  const tool = new TextureTool(e.viewport, e.store);

  /** Guarded like the app's own starters: not while another tool owns the window, and not on an empty document. */
  function start() {
    if (e.toolBusy()) return;
    if (!e.hasBody()) {
      e.setStatus("Texture: create or import a body first", "");
      return;
    }
    tool.start((id) => {
      e.noteCommitted(id);
      if (id) e.selectFeature(id);
    });
  }

  const off = contribute(ID, {
    tools: [
      {
        id: "texture",
        label: "Texture",
        iconName: "texture",
        // Faces first: the tool's preference when a selection holds both, and the mode the panel opens in.
        consumes: ["face", "body"],
        source: "selection",
        // Read at event time by app/toolBusy.ts. `active` also covers the rollback before the panel exists.
        busy: () => tool.active,
        cancel: () => tool.cancel(),
      },
    ],

    actions: { texture: start },

    // The application's MODIFY group, beside the operations that change a surface rather than add one.
    ribbon: [{ group: "MODIFY", items: [{ action: "texture", label: "Texture", iconName: "texture" }] }],

    icons: { texture: TEXTURE_ICON },

    overlays: [TextureToolPanel],

    features: [
      {
        type: "texture",
        meta: { icon: "texture", label: "Texture" },
        choiceFields: TEXTURE_CHOICE_FIELDS,
        fileFields: TEXTURE_FILE_FIELDS,
        toggleFields: TEXTURE_TOGGLE_FIELDS,
        // Nothing in the app knows a texture has a Depth, so its rows are labelled here.
        numFields: TEXTURE_NUM_FIELDS,
        targets: TEXTURE_TARGETS,
        // Every row stays parameter-drivable but only some are drawn: a voronoi has a Seed, a knurl does not.
        fieldApplies: textureFieldApplies,
        fieldLabel: (field, values) => (field === "sharpness" ? sharpnessLabel(values["profile"]) : null),
        // Double-click rolls the model back and reopens the panel. False means a parameter drives one of the values, and
        // the app says so in its own words.
        edit: (featureId, done) => tool.startEdit(featureId, done),
      },
    ],
  });

  return () => {
    // The plugins panel is reachable mid-gesture, so cancel first, or the document stays rolled back with no panel on
    // screen and no way back.
    tool.cancel();
    panel.resetPanel();
    off();
  };
}
