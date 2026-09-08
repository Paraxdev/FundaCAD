// The multi-colour capability: filament slots, the colour a body prints in, and
// the two-tone inlay a texture leaves behind.
//
// This directory used to hold a manifest and a README and nothing else, while
// the capability itself was eight `if (multiMaterialEnabled())` checks scattered
// through the app: in the render bridge that turns a build into pixels, in the
// browser panel, in the body context menu, in the import path, in the texture
// tool, in the exporters. Every one of those was a piece of the core that knew
// what a palette was and knew which switch decided whether it counted.
//
// None of them are there now. What is left in the app is the DOCUMENT, which
// keeps its `palette` and its `bodyColors` whether or not this is running,
// because those are the file format: a file saved with colours has to open, save
// and export unchanged on a machine where this capability is switched off, and a
// format that lost data when a plugin was absent would be a much worse bargain
// than a checkbox that hides a panel.
//
// WHY THIS ONE IS TYPESCRIPT AND NOT PYTHON. It answers per rebuild, per body,
// per face, synchronously, inside the render path, `paint` below is asked
// again for every chunk of a progressive load. A process on a socket cannot
// serve that. It is the "a view and some TS" case rather than the "drive it from
// Python" case, and the difference is not preference: it is whether the answer
// has to arrive within a frame.

import { bodyColorMenu, nearestPaletteSlot, paintFrom } from "./palette";
import PaletteSection from "./PaletteSection.vue";
import { contribute } from "fundacad";
import type { Engine } from "fundacad";

const ID = "FundaCAD.MultiColor";

/** Start the capability. Returns the teardown that stops it. */
export async function activate(e: Engine): Promise<() => void> {
  const store = e.store;

  const off = contribute(ID, {
    // The colours on the model. Asked fresh at every rebuild and every chunk of
    // a progressive load, so bodies arrive already wearing the colour they were
    // assigned rather than popping from grey when the build commits.
    paint: () => paintFrom(store),

    // What colours this document has, for anything that offers a choice of one.
    // The texture tool's inlay row reads this; so does the printer capability,
    // which needs to know whether it is preparing a one-filament print, and
    // which asks the app rather than asking about this plugin by name.
    palette: () => store.colorPalette,

    // "Color >" on a body, in the browser tree and in the viewport alike.
    bodyMenu: (bodyId) => bodyColorMenu(store, bodyId),

    browserSections: [{ key: "palette", component: PaletteSection, filter: "palette" }],

    // An imported mesh carried a colour of its own: put it on the nearest slot.
    //
    // This WRITES, unlike everything else here, which is why it is worth being
    // careful that it only happens while the capability is running. A slot
    // assigned behind a hidden palette would be an edit nobody could see, could
    // not undo from any visible control, and would meet later as a colour they
    // never chose. With this off, the app announces the import and nobody
    // listens.
    //
    // The bodies do not exist until the rebuild runs and their ids are
    // positional, so wait for the build and find the ones this feature owns via
    // faceOwners. setBodyColorSlot is a display-only overlay write, so this adds
    // no second undo step.
    importedBody: async (featureId, color) => {
      const slot = nearestPaletteSlot(color, store.colorPalette);
      if (slot === null) return;
      await store.rebuildNow();
      for (const b of store.buildState.result?.bodies ?? []) {
        if (b.faceOwners?.some((owner) => owner === featureId)) store.setBodyColorSlot(b.id, slot);
      }
    },
  });

  return () => {
    // The assignments stay in the document. Turning this off hides the palette,
    // the slot menus and the paint they produce; it deletes none of them, so
    // turning it back on finds the work still there. A toggle that ate data
    // would not be a toggle.
    off();
  };
}
