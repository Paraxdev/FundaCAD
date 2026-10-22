import { markRaw } from "vue";
import { useToolPanelStore, type MirrorPanelView } from "../stores/toolPanels";

export function showMirrorPanel(view: MirrorPanelView | null): void {
  useToolPanelStore().mirror = view ? markRaw(view) : null;
}
