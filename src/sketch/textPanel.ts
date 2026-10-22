// Floating panel for the sketch Text tool (DimInput is numeric only), a facade over stores/toolPanels.ts and
// TextToolPanel.vue. The value shape and the form mapping live in textForm.ts.

import { useToolPanelStore } from "../stores/toolPanels";
import type { TextValues } from "./textForm";

export type { TextValues };

export class TextPanel {
  get isActive() {
    return !!useToolPanelStore().text;
  }

  show(
    screen: { x: number; y: number },
    fonts: string[],
    initial: Partial<TextValues>,
    handlers: { onCommit: (v: TextValues) => void; onCancel: () => void; onChange: (v: TextValues) => void },
  ) {
    // openText markRaws the request: the handlers close over SketchMode, the Viewport and the raw document.
    useToolPanelStore().openText({ screen, fonts, initial, ...handlers });
  }

  hide() {
    // Not cancelText(): SketchMode hides on tool switch and exit, where firing onCancel would re-enter the tool it left.
    useToolPanelStore().text = null;
  }
}
