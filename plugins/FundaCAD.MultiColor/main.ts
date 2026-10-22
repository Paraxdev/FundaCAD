// The palette and bodyColors live in the document as file format, so colours survive while this is off. TypeScript, not
// Python, because `paint` answers per body and per load chunk inside the render path, within a frame.

import { bodyColorMenu, nearestPaletteSlot, paintFrom } from "./palette";
import PaletteSection from "./PaletteSection.vue";
import { contribute } from "fundacad";
import type { Engine } from "fundacad";

const ID = "FundaCAD.MultiColor";

export async function activate(e: Engine): Promise<() => void> {
  const store = e.store;

  const off = contribute(ID, {
    // Asked at every rebuild and every chunk of a progressive load, so bodies arrive in their colour rather than
    // popping from grey when the build commits.
    paint: () => paintFrom(store),

    // Read by the texture tool's inlay row and by the printer capability, which asks the app rather than this plugin
    // by name whether it prepares a one-filament print.
    palette: () => store.colorPalette,

    // "Color >" on a body, in the browser tree and in the viewport alike.
    bodyMenu: (bodyId) => bodyColorMenu(store, bodyId),

    browserSections: [{ key: "palette", component: PaletteSection, filter: "palette" }],

    // An imported mesh's own colour goes on the nearest slot. This writes, so it must only run while the capability
    // does: a slot set behind a hidden palette is an edit nobody can see. Body ids are positional, so wait for the
    // build and match via faceOwners; setBodyColorSlot is a display-only overlay write, so no second undo step.
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
    // The assignments stay in the document, so turning this back on finds the work still there.
    off();
  };
}
