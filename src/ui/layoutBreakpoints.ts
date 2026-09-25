// The shell's stage breakpoint. The CSS half, and the window-width phone
// breakpoint that needs no JS, live in styles/_responsive.scss.
//
// Narrow is measured on the STAGE, not the window: the Render dock takes 300px
// beside it, so a 900px window in the Render workspace has the same 600px to
// float cards over as a 600px window in Model. Below this the Items card, the
// rail, the view controls and the History card no longer fit side by side
// (264 + 152 on the left, 48 + 288 on the right, and the gaps).
export const STAGE_NARROW_PX = 820;

export function isNarrowStage(width: number): boolean {
  return width > 0 && width < STAGE_NARROW_PX;
}
