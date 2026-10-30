// The engine's stress warnings and refusals in the panel's plain words. The engine keeps its own wording for MCP
// callers, so a text this does not know still shows, as a sentence.

import { panelMessage } from "./stress";

const FINER = "Stress there grows as the mesh gets finer, so read the colour a little away from it.";
const PICK_FINE = "Choose Fine under Mesh detail in More options.";
const MADE_COARSER = "The mesh was made coarser to keep the analysis small enough to run.";

const RULES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^the peak stress is at a sharp inside corner,/, () => `The peak is at a sharp inside corner. ${FINER}`],
  [/^the peak stress is where a (.+?) ends,/, (m) => `The peak is where a ${m[1]} ends. ${FINER}`],
  [
    /^the largest deflection, .* is more than a tenth of the part's smallest size/,
    () => "The part bends more than a tenth of its smallest size. The numbers are rough for a bend this large.",
  ],
  [
    /^the elements \(.*\) are larger than half the part's typical thickness/,
    () => `The mesh is coarse for the thinnest walls, so they read stiffer than they are. ${PICK_FINE}`,
  ],
  [/^the element size grew from/, () => MADE_COARSER],
  [/^maxElements is capped at/, () => MADE_COARSER],
  [
    /^(\d+) of the (\w+) faces got no elements/,
    (m) => `${m[1]} of the ${m[2]} faces are too narrow for the mesh and hold nothing. ${PICK_FINE}`,
  ],
  [
    /^(spot \d+ of .+?) \(radius [\d.]+ mm\) is smaller than the elements/,
    (m) => `${panelMessage(m[1]!)} is tiny next to the mesh, so the stress right at it is rough. ${PICK_FINE}`,
  ],
  [
    /^the peak stress moved by (\d+)% with the last refinement, so it may not have settled yet, (a fine)?/,
    (m) =>
      `The peak moved by ${m[1]}% with the last pass, so it may not have settled yet.${m[2] ? ` ${PICK_FINE}` : ""}`,
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

const WALLS_FIX = "Thicker walls would let it run.";
const FACE_FIX = "Pick a wider face.";
const SIMPLER_FIX = "Close other programs, or study a simpler part.";

// The last entry is the fix to name when no finer run is offered beside the message.
const REFUSALS: [RegExp, (m: RegExpMatchArray) => string, string?][] = [
  [
    /^the body could not be meshed, parts of the body are thinner than/,
    () => "The mesh comes apart in the thin walls of this body.",
    WALLS_FIX,
  ],
  [
    /^the body could not be meshed, the part is thinner than/,
    () => "This part is too thin for the mesh to fit inside it.",
    WALLS_FIX,
  ],
  [
    /^the body could not be meshed, the part needs more than/,
    () => "This part needs more detail than a run may use.",
    "Study a simpler part.",
  ],
  [/^the fixed face got no elements/, () => "The fixed face is too narrow for the mesh to reach.", FACE_FIX],
  [
    /^none of the fixed faces got any elements/,
    () => "The fixed faces are too narrow for the mesh to reach.",
    FACE_FIX,
  ],
  [
    /^a face of (load \d+ \(loads\[\d+\]\)) got no elements/,
    (m) => `A face of ${panelMessage(m[1]!)} is too narrow for the mesh to reach.`,
    FACE_FIX,
  ],
  [
    /^solving this mesh(?: of \d+ elements)? needs about ([\d.]+) GB of memory, more than the ([\d.]+) GB it may use/,
    (m) => `This study needs about ${m[1]} GB of memory, more than the ${m[2]} GB it may use.`,
    SIMPLER_FIX,
  ],
  [
    /^there is not enough memory to solve this mesh/,
    () => "There is not enough memory to solve this study. Close other programs and run it again.",
  ],
  [
    /^the body is not held and can still move, its stiffness matrix is singular/,
    () => "The body is not held and can still move. Fix more faces.",
  ],
];

const WALL_TAIL = /, the thinnest wall is about ([\d.]+) mm thick, near \(([^)]+)\) mm$/;

export function plainError(message: string, finerOffered = false): string {
  const wall = message.match(WALL_TAIL);
  const body = wall ? message.slice(0, wall.index) : message;
  const where = wall ? ` The thinnest wall is about ${wall[1]} mm thick, near (${wall[2]}) mm.` : "";
  for (const [re, say, fix] of REFUSALS) {
    const m = body.match(re);
    if (m) return `${say(m)}${where}${fix && !finerOffered ? ` ${fix}` : ""}`;
  }
  return sentence(panelMessage(message));
}

export function sentence(text: string): string {
  const t = text.trim();
  if (!t) return "";
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.?!]$/.test(s) ? s : `${s}.`;
}
