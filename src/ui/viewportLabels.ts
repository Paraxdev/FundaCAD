// Viewport label size scales the names drawn over the model. The sketch dimension and glyph styles read
// --vp-label-scale on the root, the view cube and the plane names read viewportLabelScale() when they draw.

import { a11yPrefs, onA11yPrefsChange, type ViewportLabels } from "./a11yPrefs";

export { VIEWPORT_LABELS } from "./a11yPrefs";

export const VIEWPORT_LABEL_SCALE: Readonly<Record<ViewportLabels, number>> = { s: 0.85, m: 1, l: 1.25, xl: 1.5 };

export function viewportLabelScale(): number {
  return VIEWPORT_LABEL_SCALE[a11yPrefs().viewportLabels];
}

export function applyViewportLabels(size: ViewportLabels) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--vp-label-scale", String(VIEWPORT_LABEL_SCALE[size]));
}

let installed = false;

/** Applies the stored choice at boot and every later change, Reset to defaults included. */
export function installViewportLabels() {
  if (installed) return;
  installed = true;
  applyViewportLabels(a11yPrefs().viewportLabels);
  onA11yPrefsChange(() => applyViewportLabels(a11yPrefs().viewportLabels));
}
