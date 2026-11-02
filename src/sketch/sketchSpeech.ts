// The sentences a sketch says by keys, in the display unit. Pure, so the wording is tested without a canvas.

import { displayRound, fmtGridStep, toDisplay } from "../ui/units";
import { entityLabel } from "./relations";
import { snapLabel, type ResolvedEntity, type SnapCandidate } from "./snap";

// Screen readers disagree on whether a hyphen is spoken, so a negative number is written out.
function numberWords(mm: number): string {
  const v = displayRound(Math.round(toDisplay(mm) * 1000) / 1000);
  if (v === 0) return "0";
  return v < 0 ? `minus ${-v}` : `${v}`;
}

/** The coordinates for the tag beside the cursor, which is read by eye and so keeps the minus sign. */
export function coordLabel(x: number, y: number): string {
  const v = (mm: number) => displayRound(Math.round(toDisplay(mm) * 1000) / 1000) || 0;
  return `${v(x)}, ${v(y)}`;
}

export function coordWords(x: number, y: number): string {
  return `${numberWords(x)}, ${numberWords(y)}`;
}

function ownerKind(ents: ResolvedEntity[], id: string): ResolvedEntity["type"] | null {
  const base = id.split("~")[0]!;
  return ents.find((e) => e.id === base)?.type ?? null;
}

export function snapWords(c: SnapCandidate, ents: ResolvedEntity[]): string {
  const plain = `the ${(snapLabel(c) ?? c.kind).toLowerCase()}`;
  const ref = c.ref;
  if (!ref) return plain;
  const name = entityLabel(ents, ref.entity);
  const kind = ownerKind(ents, ref.entity);
  if (!name || !kind) return plain;
  if (ref.at === "mid") return `the midpoint of ${name}`;
  if (ref.at === "curve") return `a point on ${name}`;
  if (kind === "line" || kind === "arc") return `the ${ref.at === 0 ? "start" : "end"} of ${name}`;
  if (kind === "rectangle") return `corner ${ref.at + 1} of ${name}`;
  if (kind === "circle") return `the center of ${name}`;
  if (kind === "point") return name;
  return plain;
}

export function pointSentence(p: { x: number; y: number }, c: SnapCandidate | null, ents: ResolvedEntity[]): string {
  const at = `Point at ${coordWords(p.x, p.y)}`;
  return c ? `${at}, snapped to ${snapWords(c, ents)}` : at;
}

/** `step` is given only when it differs from the last one said. */
export function cursorSentence(
  p: { x: number; y: number },
  c: SnapCandidate | null,
  ents: ResolvedEntity[],
  step: number | null,
): string {
  const at = `Cursor at ${coordWords(p.x, p.y)}${c ? `, snapped to ${snapWords(c, ents)}` : ""}`;
  return step === null ? at : `Grid step ${fmtGridStep(step)}. ${at}`;
}

export function drawnSentence(e: ResolvedEntity, ents: ResolvedEntity[], closed: boolean): string {
  const name = entityLabel(ents, e.id) ?? e.type;
  if (e.type === "line") {
    const len = `${name}, length ${numberWords(Math.hypot(e.x2 - e.x1, e.y2 - e.y1))}`;
    return closed ? `${len}, loop closed` : len;
  }
  if (e.type === "rectangle") return `${name}, ${numberWords(e.width)} by ${numberWords(e.height)}`;
  if (e.type === "circle") return `${name}, diameter ${numberWords(2 * e.radius)}`;
  return name;
}
