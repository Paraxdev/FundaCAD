// The sketch Text tool's panel, minus the panel: the value shape, the mapping
// between it and the eight form fields, and the on-screen clamp.
//
// Split out of textPanel.ts when that became a facade over
// components/overlays/TextToolPanel.vue. Everything here is a pure function of
// its inputs, which is the only part of a floating panel a headless test can
// reach, happy-dom has no layout, so the panel's measured placement is not
// testable, but the clamp that decides where it is ASKED to go is.

export interface TextValues {
  text: string;
  font?: string;
  height: number;
  style: "regular" | "bold" | "italic" | "bolditalic";
  align: "left" | "center" | "right";
  angle: number;
  boxWidth?: number; // wrap width (mm), text fits inside this box
}

export function styleOf(bold: boolean, italic: boolean): TextValues["style"] {
  return bold && italic ? "bolditalic" : bold ? "bold" : italic ? "italic" : "regular";
}

/** The panel's live form state, strings, because that is what the <input>s
 *  hold and half of them are legitimately mid-edit and unparseable. */
export interface TextForm {
  text: string;
  font: string; // "" = the default font
  height: string;
  bold: boolean;
  italic: boolean;
  align: TextValues["align"];
  angle: string;
  boxWidth: string; // "" or 0 = no wrap box
}

export function initialTextForm(initial: Partial<TextValues>): TextForm {
  // `style` is one field on the value and two checkboxes on the form, and
  // "bolditalic" has to light both, hence includes() rather than equality.
  const style = String(initial.style ?? "regular");
  return {
    text: initial.text ?? "",
    font: initial.font ?? "",
    height: String(initial.height ?? 10),
    bold: style.includes("bold"),
    italic: style.includes("italic"),
    align: initial.align ?? "left",
    angle: String(initial.angle ?? 0),
    boxWidth: initial.boxWidth ? String(initial.boxWidth) : "",
  };
}

export function toTextValues(f: TextForm): TextValues {
  const box = parseFloat(f.boxWidth);
  return {
    text: f.text,
    ...(f.font ? { font: f.font } : {}),
    // `|| 10` and `|| 0` are the empty-field fallbacks, not defaults: NaN would
    // reach the sidecar as null and fail the build.
    height: parseFloat(f.height) || 10,
    style: styleOf(f.bold, f.italic),
    align: f.align,
    angle: parseFloat(f.angle) || 0,
    ...(box > 0 ? { boxWidth: box } : {}),
  };
}

/** The panel is 300px wide with a ~240px natural height and is anchored to the
 *  click, so near the right or bottom edge it has to be pulled back inside the
 *  window. 8px is the minimum inset on the other two edges. */
export function textPanelPos(
  screen: { x: number; y: number },
  win: { innerWidth: number; innerHeight: number },
): { left: number; top: number } {
  return {
    left: Math.max(8, Math.min(screen.x, win.innerWidth - 316)),
    top: Math.max(8, Math.min(screen.y, win.innerHeight - 240)),
  };
}
