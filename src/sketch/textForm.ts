// The sketch Text tool's panel minus the panel: value shape, form mapping and the on-screen clamp, all pure so a
// headless test can reach them (happy-dom has no layout).

import { fieldError, fieldNumber } from "../ui/measure";

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

/** Strings, because an input can legitimately hold unparseable mid-edit text. */
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
  // `style` is two checkboxes on the form and "bolditalic" lights both, hence includes().
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

export function textFormErrors(f: TextForm): Partial<Record<"height" | "angle" | "boxWidth", string>> {
  const out: Partial<Record<"height" | "angle" | "boxWidth", string>> = {};
  for (const k of ["height", "angle", "boxWidth"] as const) {
    const e = fieldError(f[k]);
    if (e) out[k] = e;
  }
  return out;
}

export function toTextValues(f: TextForm): TextValues {
  const box = fieldNumber(f.boxWidth);
  return {
    text: f.text,
    ...(f.font ? { font: f.font } : {}),
    // `|| 10` and `|| 0` are empty-field fallbacks: NaN would reach the engine as null and fail the build.
    height: fieldNumber(f.height) || 10,
    style: styleOf(f.bold, f.italic),
    align: f.align,
    angle: fieldNumber(f.angle) || 0,
    ...(box > 0 ? { boxWidth: box } : {}),
  };
}

/** The 300px by ~240px panel is anchored to the click, so near the right or bottom edge it is pulled back inside the
 *  window, with an 8px minimum inset on the other two edges. */
export function textPanelPos(
  screen: { x: number; y: number },
  win: { innerWidth: number; innerHeight: number },
): { left: number; top: number } {
  return {
    left: Math.max(8, Math.min(screen.x, win.innerWidth - 316)),
    top: Math.max(8, Math.min(screen.y, win.innerHeight - 240)),
  };
}
