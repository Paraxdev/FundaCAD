// Reference images: a photo or a drawing on a plane to sketch over. The app
// carries the list and its blobs through save and reopen; what an entry means,
// the quads that draw it and every tool that changes it live here.

import { contribute } from "fundacad";
import type { Engine } from "fundacad";
import ImagePanel from "./ImagePanel.vue";
import ItemsSection from "./ItemsSection.vue";
import { ImageLayer } from "./quads";
import { calibrating, missingTick, selected, tool } from "./state";
import { RefImageTool } from "./tool";

const ID = "FundaCAD.ReferenceImages";

const IMAGE_ICON =
  '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><circle cx="9" cy="10" r="1.6"/>' +
  '<path d="M4 17.5l5-4.5 3.5 3 3-2.5 4.5 4"/>';
const LOCKED_ICON = '<rect x="5.5" y="11" width="13" height="9" rx="1.5"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>';
const UNLOCKED_ICON = '<rect x="5.5" y="11" width="13" height="9" rx="1.5"/><path d="M8.5 11V8a3.5 3.5 0 0 1 6.8-1.2"/>';

export async function activate(e: Engine): Promise<() => void> {
  const layer = new ImageLayer(e);
  const t = new RefImageTool(e, layer);
  layer.onMissing = () => { missingTick.value++; };
  layer.start();
  tool.value = t;
  e.viewport.domElement.addEventListener("pointerdown", t.onDragDown, true);

  const off = contribute(ID, {
    tools: [{
      id: "referenceImage",
      label: "Reference image",
      iconName: "ref-image",
      consumes: [],
      source: "selection",
      busy: () => t.active,
      cancel: () => t.cancel(),
    }],
    actions: { referenceImage: () => t.insert() },
    ribbon: [{ group: "INSERT", items: [{ action: "referenceImage", label: "Reference Image", iconName: "ref-image" }] }],
    icons: { "ref-image": IMAGE_ICON, "ref-locked": LOCKED_ICON, "ref-unlocked": UNLOCKED_ICON },
    browserSections: [{ key: "referenceImages", component: ItemsSection }],
    overlays: [ImagePanel],
  });

  return () => {
    t.cancel();
    e.viewport.domElement.removeEventListener("pointerdown", t.onDragDown, true);
    off();
    layer.stop();
    tool.value = null;
    selected.value = null;
    calibrating.value = null;
  };
}
