// The surface-texture capability: a tool, a view, and everything the application
// has to know to draw a feature it did not invent.
//
// THIS IS THE ONE THAT PROVED THE CONTRIBUTION TABLE. The other capabilities in
// this repository add to the edges of the window, a panel, a settings block, a
// menu row, colours on a body. A modeling TOOL is not an edge. It is a peer of
// Fillet and Press/Pull: it takes over the pick, holds the window against every
// other command, puts a verb in front of a selection, and leaves a feature in the
// document that outlives the gesture and has to be drawn, named, re-opened and
// edited for the rest of the file's life.
//
// Three contribution points did not exist before this, and each one is a surface
// the application genuinely could not fill:
//
//   tools     what the tool consumes, and whether it is running. Without the
//             first, selecting a face offers Fillet and Delete Face and stays
//             silent about the tool that is the reason a face is selected.
//             Without the second the application thinks it is idle while this
//             owns the pick, and dispatches a second tool over the top of it.
//   features  how a `texture` feature is drawn and edited: its mark and its
//             name in the history, its dropdowns and its switch, which of its
//             value rows a given pattern actually reads, what its shape slider
//             is called, and what a double-click on it does.
//   icons     a mark for a tool the application does not have.
//
// The rest, the ribbon button, the action behind it, the panel on screen, went
// through points that already existed, which is the result worth having: adding
// a tool needed three new points, not eleven.
//
// WHAT STAYED IN THE APPLICATION, and why it is not a hedge. The `texture`
// feature is part of the document format and the geometry that builds it is part
// of the sidecar. A file with a texture in it opens, rebuilds, renders and
// exports on a machine where this was never installed; its numbers stay in the
// value rows and stay parameter-drivable. Uninstalling this costs you the panel
// that makes one. It does not cost you the ones you already made, and a plugin
// boundary that could take those away would be a worse bargain than a checkbox.

import { contribute } from "fundacad";
import type { Engine } from "fundacad";
import { TextureTool } from "./textureTool";
import TextureToolPanel from "./TextureToolPanel.vue";
import * as panel from "./panel";
import {
  TEXTURE_CHOICE_FIELDS,
  TEXTURE_TOGGLE_FIELDS,
  sharpnessLabel,
  textureFieldApplies,
} from "./textureForm";

const ID = "FundaCAD.Texture";

/** The mark, in the application's house style: a 24x24 box with a roughly 20x20
 *  live area, stroke-width 1.4 from the wrapper, round caps and joins, no fill.
 *  A knurl seen face-on, a rounded square with the cross-hatch that is the
 *  first pattern in the list and the one people picture when they read the word.
 *
 *  A compile-time constant, and it has to stay one. This reaches the DOM through
 *  the application's Icon component, which is the single sanctioned v-html in
 *  the window; nothing derived from a document, a file name or a network payload
 *  may ever be interpolated into it. */
const TEXTURE_ICON =
  '<rect x="4" y="4" width="16" height="16" rx="2"/>' +
  '<line x1="4" y1="9.3" x2="20" y2="9.3"/><line x1="4" y1="14.7" x2="20" y2="14.7"/>' +
  '<line x1="9.3" y1="4" x2="9.3" y2="20"/><line x1="14.7" y1="4" x2="14.7" y2="20"/>';

/** Start the capability. Returns the teardown that stops it. */
export async function activate(e: Engine): Promise<() => void> {
  const tool = new TextureTool(e.viewport, e.store);

  /** The verb. Guarded exactly as the application's own starters are: not while
   *  another tool owns the window, and not on an empty document, because a
   *  texture is a thing done TO a surface and there is nothing to do it to. */
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
    tools: [{
      id: "texture",
      label: "Texture",
      iconName: "texture",
      // Faces first, then the whole body. The order is the tool's own preference
      // when a selection holds both, and it matches the panel: Faces is the mode
      // it opens in unless you were already browsing bodies.
      consumes: ["face", "body"],
      source: "selection",
      // Read at event time by app/toolBusy.ts. `active` covers the whole
      // lifetime including the rollback before the panel exists, which is the
      // window a narrower answer would leave open.
      busy: () => tool.active,
    }],

    actions: { texture: start },

    // MODIFY, beside the operations that change a surface rather than add one.
    // The application's own MODIFY group is where this button lived when it was
    // compiled in, and a person who installs this should find it where it was.
    ribbon: [{ group: "MODIFY", items: [{ action: "texture", label: "Texture", iconName: "texture" }] }],

    icons: { texture: TEXTURE_ICON },

    overlays: [TextureToolPanel],

    features: [{
      type: "texture",
      meta: { icon: "texture", label: "Texture" },
      choiceFields: TEXTURE_CHOICE_FIELDS,
      toggleFields: TEXTURE_TOGGLE_FIELDS,
      // Governs the numeric rows too, which is the whole reason this is worth
      // contributing: the application owns `depth`, `scale`, `seed` and the rest
      // because a parameter can drive them, and this decides which of them a
      // given pattern actually reads.
      fieldApplies: textureFieldApplies,
      fieldLabel: (field, values) =>
        field === "sharpness" ? sharpnessLabel(values["profile"]) : null,
      // Double-clicking a committed texture rolls the model back and re-opens
      // the panel on it. False means a parameter drives one of the values, and
      // the application says so in the same words it uses for its own tools.
      edit: (featureId, done) => tool.startEdit(featureId, done),
    }],
  });

  return () => {
    // Switching this off mid-gesture is not a hypothetical: the plugins panel is
    // reachable while a tool is running. Cancel first, so the model comes off
    // the edit preview and the ambient selection is released, otherwise the
    // document is left rolled back to a point in its own history with no panel
    // on screen and no way to get back.
    tool.cancel();
    panel.resetPanel();
    off();
  };
}
