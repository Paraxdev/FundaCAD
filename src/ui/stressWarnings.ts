// The engine's stress warnings in the panel's plain words. The engine keeps its own wording for MCP callers, so a
// warning this does not know still shows, as a sentence.

import { panelMessage } from "./stress";

const FINER = "Stress there grows as the mesh gets finer, so read the colour a little away from it.";
const SMALLER_MESH = "Set a smaller Mesh size under More options.";

const RULES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^the peak stress is at a sharp inside corner,/, () => `The peak is at a sharp inside corner. ${FINER}`],
  [/^the peak stress is where a (.+?) ends,/, (m) => `The peak is where a ${m[1]} ends. ${FINER}`],
  [
    /^the largest deflection, .* is more than a tenth of the part's smallest size/,
    () => "The part bends more than a tenth of its smallest size. The numbers are rough for a bend this large.",
  ],
  [
    /^the elements \(.*\) are larger than half the part's typical thickness/,
    () => `The mesh is coarse for the thinnest walls, so they read stiffer than they are. ${SMALLER_MESH}`,
  ],
  [/^the element size grew from/, () => "The mesh was made coarser to keep the analysis small enough to run."],
  [
    /^(\d+) of the (\w+) faces got no elements/,
    (m) => `${m[1]} of the ${m[2]} faces are narrower than the mesh and hold nothing. ${SMALLER_MESH}`,
  ],
  [
    /^(spot \d+ of .+?) \(radius [\d.]+ mm\) is smaller than the elements/,
    (m) =>
      `${panelMessage(m[1]!)} is smaller than the mesh, so the stress right at it is rough. Make it larger, or set a smaller Mesh size.`,
  ],
  [
    /^printed parts are weaker across their layers/,
    () =>
      "A printed part is weaker across its layers, often by half. Keep a margin when the load pulls the layers apart.",
  ],
  [
    /^(load \d+ \(loads\[\d+\]\)) is only on fixed faces/,
    (m) => `${panelMessage(m[1]!)} is only on fixed faces, so it does nothing to the part.`,
  ],
];

export function plainWarning(w: string): string {
  for (const [re, say] of RULES) {
    const m = w.match(re);
    if (m) return say(m);
  }
  return sentence(panelMessage(w));
}

export function sentence(text: string): string {
  const t = text.trim();
  if (!t) return "";
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.?!]$/.test(s) ? s : `${s}.`;
}
