// The CSS halves live in styles/_responsive.scss. STAGE_NARROW_PX is measured on the stage, not the window, as the
// Render dock takes 300px. Below it the cards no longer fit side by side (264 + 152 left, 48 + 288 right, plus gaps).
export const STAGE_NARROW_PX = 820;

export function isNarrowStage(width: number): boolean {
  return width > 0 && width < STAGE_NARROW_PX;
}

// A window width, as max-width matches it: at and under it _responsive.scss hides the document name and the
// workspace toggle, and TitleBar.vue puts them in the File menu. 200 percent of the 800px minimum window lands here.
export const TITLEBAR_FOLD_PX = 560;
export const TITLEBAR_FOLD_QUERY = `(max-width: ${TITLEBAR_FOLD_PX}px)`;

export function isTitleBarFolded(width: number): boolean {
  return width > 0 && width <= TITLEBAR_FOLD_PX;
}
