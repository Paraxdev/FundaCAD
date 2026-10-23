// The CSS half and the phone breakpoint live in styles/_responsive.scss. Measured on the stage, not the window, as the
// Render dock takes 300px. Below it the cards no longer fit side by side (264 + 152 left, 48 + 288 right, plus gaps).
export const STAGE_NARROW_PX = 820;

export function isNarrowStage(width: number): boolean {
  return width > 0 && width < STAGE_NARROW_PX;
}
