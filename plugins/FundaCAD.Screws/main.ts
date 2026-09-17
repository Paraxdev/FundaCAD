// Fasteners: a standards catalogue of screws, bolts, nuts, washers and inserts, and the ones a
// person defines, previewed, specified and dropped into the model.
//
// A fastener arrives the way an imported STEP part does. Its solid is generated once
// (geometry/register.py) and stored as an `import` feature's blob (insert.ts), so a document with
// fasteners in it opens and builds where this plugin was never installed.

import { contribute } from "fundacad";
import type { Engine } from "fundacad";
import LibraryPanel from "./LibraryPanel.vue";
import { insertFastener, placementAt, specOfBody } from "./insert";
import { DRAG_MIME, PLUGIN_ID, dragging, open, resetState, selection, tab } from "./state";

// Compile-time constant only: it reaches the DOM through the app's Icon component.
const FASTENER_ICON =
  '<path d="M7 3.5h10v3.2H7z"/><path d="M10.2 6.7h3.6V20.5h-3.6z"/>' +
  '<line x1="10.2" y1="10" x2="13.8" y2="11.4"/><line x1="10.2" y1="13" x2="13.8" y2="14.4"/>' +
  '<line x1="10.2" y1="16" x2="13.8" y2="17.4"/>';

export async function activate(e: Engine): Promise<() => void> {
  const canvas = e.viewport.domElement;

  function carrying(ev: DragEvent): boolean {
    return !!dragging.value && (ev.dataTransfer?.types.includes(DRAG_MIME) ?? false);
  }

  function onDragOver(ev: DragEvent) {
    if (!carrying(ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
  }

  function onDrop(ev: DragEvent) {
    if (!carrying(ev)) return;
    ev.preventDefault();
    const spec = dragging.value!;
    dragging.value = null;
    void insertFastener(e, spec, placementAt(e, ev.clientX, ev.clientY));
  }

  canvas.addEventListener("dragover", onDragOver);
  canvas.addEventListener("drop", onDrop);

  const off = contribute(PLUGIN_ID, {
    actions: {
      fasteners: () => {
        open.value = !open.value;
      },
    },
    ribbon: [{ group: "INSERT", items: [{ action: "fasteners", label: "Fasteners", iconName: "fasteners" }] }],
    icons: { fasteners: FASTENER_ICON },
    overlays: [LibraryPanel],
    bodyMenu: (bodyId) => {
      const spec = specOfBody(e, bodyId);
      if (!spec) return [];
      return [{
        label: "Fastener Specs...",
        onClick: () => {
          selection.value = { source: "document", spec };
          tab.value = "catalogue";
          open.value = true;
        },
      }];
    },
  });

  return () => {
    canvas.removeEventListener("dragover", onDragOver);
    canvas.removeEventListener("drop", onDrop);
    resetState();
    off();
  };
}
