// What a round face's size field reads, and the letters typed ahead of a number
// that pick it: r2.5 a radius, ⌀5 or d5 a diameter, +0.5 or -0.5 an offset.
//
// Split from pressPullTool.ts on the house rule: the tool is pointer plumbing,
// these are the functions that can be wrong in a way a user notices.

import { deltaForDiameter, deltaForRadius, radialDrag } from "./radialDrag";

/** A radius and a diameter are absolute sizes; an offset is how far the face
 *  moves from where it is, positive away from the axis, so positive is bigger. */
export type SizeQuantity = "radius" | "diameter" | "offset";

/** A full round reads as a diameter, a partial arc as a radius. */
export function defaultQuantity(full: boolean): SizeQuantity {
  return full ? "diameter" : "radius";
}

export interface SizeText {
  quantity: SizeQuantity;
  /** the number's own text, a minus kept on an offset */
  text: string;
}

// A letter only counts ahead of a number, so a parameter named depth or r_out is
// still read as one.
const LETTER = /^\s*([rRdD])\s*(?=[-+−]?[\d.,])/;
const SYMBOL = /^\s*[⌀øØ∅]\s*/;
const SIGN = /^\s*[-+−]/;

/** The quantity typed ahead of the number, or null when the text names none and
 *  the field's current one stands. */
export function parseSizeText(raw: string): SizeText | null {
  const sym = SYMBOL.exec(raw);
  if (sym) return { quantity: "diameter", text: raw.slice(sym[0].length) };
  const letter = LETTER.exec(raw);
  if (letter) {
    return { quantity: /r/i.test(letter[1]!) ? "radius" : "diameter", text: raw.slice(letter[0].length) };
  }
  // The measure parser takes a minus but not a plus.
  if (SIGN.test(raw)) return { quantity: "offset", text: raw.trim().replace(/^\+\s*/, "") };
  return null;
}

/** What the field shows for a radial drag of `delta` from `radius`. */
export function sizeReadout(quantity: SizeQuantity, radius: number, delta: number, solidInside: boolean, full: boolean): number {
  if (quantity === "offset") return delta;
  const d = radialDrag(radius, delta, solidInside, full);
  return quantity === "diameter" ? d.diameter : d.radius;
}

/** The radial drag a value typed as `quantity` asks for. */
export function deltaForSize(quantity: SizeQuantity, radius: number, value: number): number {
  if (quantity === "offset") return value;
  return quantity === "diameter" ? deltaForDiameter(radius, value) : deltaForRadius(radius, value);
}

/** A size is absolute, so a minus sign on one is a mistake rather than a direction. */
export function isAbsolute(quantity: SizeQuantity): boolean {
  return quantity !== "offset";
}
