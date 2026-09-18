// Floating panel for the sketch Text tool. DimInput is numeric-only, so text
// gets its own small panel: a multi-line string, a system-font picker (fonts come
// from the engine's listFonts op), size, bold/italic, alignment and rotation. On
// every edit it fires onChange for a live preview; Add/Enter commits, Cancel/Esc cancels.
//
// This is now a FACADE over stores/toolPanels.ts +
// components/overlays/TextToolPanel.vue. show()/hide()/isActive keep their
// signatures, so sketchMode.ts:1601 and :470/:527 did not move. The value shape
// and the form<->value mapping live in textForm.ts, which is pure and tested.

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
    // openText markRaws the request: the three handlers close over SketchMode,
    // which closes over the Viewport and the raw document.
    useToolPanelStore().openText({ screen, fonts, initial, ...handlers });
  }

  hide() {
    // Deliberately NOT cancelText(): the class's hide() dropped the callbacks
    // without firing onCancel, and SketchMode calls it on tool switch and on
    // exit, where firing a cancel would re-enter the tool it just left.
    useToolPanelStore().text = null;
  }
}
