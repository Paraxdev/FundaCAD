// The engine's stress warnings and refusals in the panel's plain words. The engine keeps its own English wording for
// MCP callers, so each rule matches that text and names a line and its arguments; a text no rule knows still shows,
// as a sentence.

import { decimalMark, t, type MessageArgs, type MessageKey } from "../i18n";
import { listJoin } from "./measure";
import { panelMessage } from "./stress";

/** The engine's digits spelled with the language's mark, by text so English keeps them exactly as sent. */
export function markDigits(digits: string): string {
  return decimalMark() === "," ? digits.replace(/\./g, ",") : digits;
}

type Said = [MessageKey, MessageArgs?];
type Rule = [RegExp, (m: RegExpMatchArray, pick: string) => Said];

const EDGES: Record<string, string> = {
  "fixed spot": "fixedSpot",
  "fixed face": "fixed",
  "pinned face": "pinned",
  "slider face": "slider",
};

const SPOT = /^spot (\d+) of (support|load) (\d+) \((?:supports|loads)\[\d+\]\)$/;

function spotOwner(label: string): MessageArgs {
  const s = label.match(SPOT);
  return s ? { owner: s[2]!, k: Number(s[1]), i: Number(s[3]) } : { owner: "other", what: panelMessage(label) };
}

const RULES: Rule[] = [
  [/^the peak stress is at a sharp inside corner,/, () => ["stress.warn.corner"]],
  [
    /^the peak stress is where a (.+?) ends,/,
    (m) => ["stress.warn.supportEnd", EDGES[m[1]!] ? { edge: EDGES[m[1]!]! } : { edge: "other", what: m[1]! }],
  ],
  [/^the largest deflection, .* is more than a tenth of the part's smallest size/, () => ["stress.warn.bigBend"]],
  [
    /^the elements \(.*\) are larger than half the part's typical thickness/,
    (_m, pick) => ["stress.warn.thinWalls", { pick }],
  ],
  [/^the element size grew from/, () => ["stress.warn.coarser"]],
  [/^maxElements is capped at/, () => ["stress.warn.coarser"]],
  [
    /^(\d+) of the (\w+) faces got no elements/,
    (m, pick) => ["stress.warn.narrowFaces", { n: Number(m[1]), which: m[2]!, pick }],
  ],
  [
    /^(spot \d+ of .+?) \(radius [\d.]+ mm\) is smaller than the elements/,
    (m, pick) => ["stress.warn.smallSpot", { ...spotOwner(m[1]!), pick }],
  ],
  [
    /^the peak stress moved by (\d+)% with the last refinement, so it may not have settled yet, (a fine)?/,
    (m, pick) => ["stress.warn.unsettled", { pct: Number(m[1]), pick: m[2] ? pick : "" }],
  ],
  [/^printed parts are weaker across their layers/, () => ["stress.warn.printed"]],
  [/^load (\d+) \(loads\[\d+\]\) is only on fixed faces/, (m) => ["stress.warn.deadLoad", { i: Number(m[1]) }]],
];

/** A Fine run has no finer choice left, so the advice to pick Fine goes. */
export function plainWarningFor(w: string, fine: boolean): string {
  for (const [re, say] of RULES) {
    const m = w.match(re);
    if (m) {
      const [key, args] = say(m, fine ? "" : "fine");
      return t(key, args);
    }
  }
  return sentence(panelMessage(w));
}

export const plainWarning = (w: string): string => plainWarningFor(w, false);

// `fix` is set when the refusal has a fix to name when no finer run is offered beside the message.
const REFUSALS: { re: RegExp; key: MessageKey; args?: (m: RegExpMatchArray) => MessageArgs; fix?: true }[] = [
  {
    re: /^the body could not be meshed, parts of the body are thinner than/,
    key: "stress.refuse.thinWalls",
    fix: true,
  },
  { re: /^the body could not be meshed, the part is thinner than/, key: "stress.refuse.tooThin", fix: true },
  { re: /^the body could not be meshed, the part needs more than/, key: "stress.refuse.tooBig", fix: true },
  { re: /^the fixed face got no elements/, key: "stress.refuse.fixedFace", fix: true },
  { re: /^none of the fixed faces got any elements/, key: "stress.refuse.fixedFaces", fix: true },
  {
    re: /^a face of load (\d+) \(loads\[\d+\]\) got no elements/,
    key: "stress.refuse.loadFace",
    args: (m) => ({ i: Number(m[1]) }),
    fix: true,
  },
  {
    re: /^solving this mesh(?: of \d+ elements)? needs about ([\d.]+) GB of memory, more than the ([\d.]+) GB it may use/,
    key: "stress.refuse.memory",
    args: (m) => ({ need: markDigits(m[1]!), may: markDigits(m[2]!) }),
    fix: true,
  },
  { re: /^there is not enough memory to solve this mesh/, key: "stress.refuse.noMemory" },
  { re: /^the body is not held and can still move, its stiffness matrix is singular/, key: "stress.refuse.notHeld" },
];

const WALL_TAIL = /, the thinnest wall is about ([\d.]+) mm thick, near \(([^)]+)\) mm$/;

export function plainError(message: string, finerOffered = false): string {
  const wall = message.match(WALL_TAIL);
  const body = wall ? message.slice(0, wall.index) : message;
  const where: MessageArgs = wall
    ? { wall: "yes", thickness: markDigits(wall[1]!), at: listJoin(wall[2]!.split(", ").map(markDigits)) }
    : { wall: "no" };
  for (const { re, key, args, fix } of REFUSALS) {
    const m = body.match(re);
    if (m) return t(key, { ...args?.(m), ...where, fix: fix && !finerOffered ? "yes" : "no" });
  }
  return sentence(panelMessage(message));
}

export function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const s = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.?!]$/.test(s) ? s : `${s}.`;
}
