// The sentences a sketch says by keys, in the display unit. Pure, so the wording is tested without a canvas.

import { displayRound, toDisplay } from "../ui/units";
import { entityLabel } from "./relations";
import { snapLabel, type ResolvedEntity, type SnapCandidate } from "./snap";

// Screen readers disagree on whether a hyphen is spoken, so a negative number is written out.
function numberWords(mm: number): string {
  const v = displayRound(Math.round(toDisplay(mm) * 1000) / 1000);
  if (v === 0) return "0";
  return v < 0 ? `minus ${-v}` : `${v}`;
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
