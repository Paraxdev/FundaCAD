// The sentences a sketch says by keys, in the display unit. Pure, so the wording is tested without a canvas.

import { displayRound, fmtGridStep, toDisplay } from "../ui/units";
import { entityLabel } from "./relations";
import { snapLabel, type ResolvedEntity, type SnapCandidate } from "./snap";

// Screen readers disagree on whether a hyphen is spoken, so a negative number is written out.
function signedWords(v: number): string {
  if (v === 0) return "0";
  return v < 0 ? `minus ${-v}` : `${v}`;
}

const numberWords = (mm: number) => signedWords(displayRound(Math.round(toDisplay(mm) * 1000) / 1000));

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
  const owner = c.owner ?? c.ref?.entity;
  const name = owner ? entityLabel(ents, owner) : null;
  const kind = owner ? ownerKind(ents, owner) : null;
  if (!owner || !name || !kind) return plain;
  const at = c.ref?.at;
  if (at === "curve") return `a point on ${name}`;
  if (kind === "point") return name;
  if (c.kind === "midpoint") return `the midpoint of ${name}`;
  if (c.kind === "center") return `the center of ${name}`;
  if (c.kind === "control") return `a control point of ${name}`;
  if (c.kind !== "endpoint") return plain;
  if ((kind === "line" || kind === "arc") && (at === 0 || at === 1))
    return `the ${at === 0 ? "start" : "end"} of ${name}`;
  if (kind === "rectangle" && typeof at === "number") return `corner ${at + 1} of ${name}`;
  return kind === "spline" || kind === "bspline" ? `a point of ${name}` : `an endpoint of ${name}`;
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

/** The stop Tab's walk ends on, back where it began, so a listener hears the list ended. */
export function walkEndSentence(p: { x: number; y: number }, c: SnapCandidate | null, ents: ResolvedEntity[]): string {
  const at = `cursor at ${coordWords(p.x, p.y)}`;
  return c ? `End of snaps, ${at}, snapped to ${snapWords(c, ents)}` : `No snap, ${at}`;
}

/** `angle` is given only when one was typed, in degrees. */
export function drawnSentence(e: ResolvedEntity, ents: ResolvedEntity[], closed: boolean, angle?: number | null): string {
  const name = entityLabel(ents, e.id) ?? e.type;
  if (e.type === "line") {
    const len = `${name}, length ${numberWords(Math.hypot(e.x2 - e.x1, e.y2 - e.y1))}`;
    const line = angle == null ? len : `${len}, angle ${signedWords(Math.round(angle * 1000) / 1000)} degrees`;
    return closed ? `${line}, loop closed` : line;
  }
  if (e.type === "rectangle") return `${name}, ${numberWords(e.width)} by ${numberWords(e.height)}`;
  if (e.type === "circle") return `${name}, diameter ${numberWords(2 * e.radius)}`;
  return name;
}
