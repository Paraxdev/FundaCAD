// The sentences a sketch says by keys, in the display unit. Pure, so the wording is tested without a canvas.

import { listJoin, spellNumber } from "../ui/measure";
import { displayRound, fmtGridStep, toDisplay } from "../ui/units";
import { entityLabel } from "./relations";
import type { ResolvedEntity, SnapCandidate } from "./snap";
import { activeLanguage, t } from "../i18n";

// Screen readers disagree on whether a hyphen is spoken, so a negative number is written out.
function signedWords(v: number): string {
  if (v === 0) return "0";
  return v < 0 ? t("dim.negative", { amount: spellNumber(-v) }) : spellNumber(v);
}

const numberWords = (mm: number) => signedWords(displayRound(Math.round(toDisplay(mm) * 1000) / 1000));

/** The coordinates for the tag beside the cursor, which is read by eye and so keeps the minus sign. */
export function coordLabel(x: number, y: number): string {
  const v = (mm: number) => displayRound(Math.round(toDisplay(mm) * 1000) / 1000) || 0;
  return listJoin([spellNumber(v(x)), spellNumber(v(y))]);
}

export function coordWords(x: number, y: number): string {
  return listJoin([numberWords(x), numberWords(y)]);
}

function ownerKind(ents: ResolvedEntity[], id: string): ResolvedEntity["type"] | null {
  const base = id.split("~")[0]!;
  return ents.find((e) => e.id === base)?.type ?? null;
}

// A label is a capitalised name ("Face Center"). Only languages that lowercase a noun mid sentence take it lowercased.
const LOWERS_LABELS: ReadonlySet<string> = new Set(["en", "fr", "es"]);

function anchorWords(c: SnapCandidate): string {
  if (!c.label) return t("sketch.speech.anchor", { kind: c.kind });
  const label = LOWERS_LABELS.has(activeLanguage().code.split("-")[0]!) ? c.label.toLowerCase() : c.label;
  return t("sketch.speech.named", { label });
}

export function snapWords(c: SnapCandidate, ents: ResolvedEntity[]): string {
  const owner = c.owner ?? c.ref?.entity;
  const name = owner ? entityLabel(ents, owner) : null;
  const kind = owner ? ownerKind(ents, owner) : null;
  if (!owner || !name || !kind) return anchorWords(c);
  const at = c.ref?.at;
  const of = (part: string, n?: number) => t("sketch.speech.of", { part, name, n: n ?? 0 });
  if (at === "curve") return of("curve");
  if (kind === "point") return name;
  if (c.kind === "midpoint" || c.kind === "center" || c.kind === "control") return of(c.kind);
  if (c.kind !== "endpoint") return anchorWords(c);
  if ((kind === "line" || kind === "arc") && (at === 0 || at === 1)) return of(at === 0 ? "start" : "end");
  if (kind === "rectangle" && typeof at === "number") return of("corner", at + 1);
  return of(kind === "spline" || kind === "bspline" ? "point" : "endpoint");
}

const snapped = (at: string, c: SnapCandidate | null, ents: ResolvedEntity[]) =>
  c ? t("sketch.speech.snapped", { at, target: snapWords(c, ents) }) : at;

export function pointSentence(p: { x: number; y: number }, c: SnapCandidate | null, ents: ResolvedEntity[]): string {
  return snapped(t("sketch.speech.pointAt", { coords: coordWords(p.x, p.y) }), c, ents);
}

/** `step` is given only when it differs from the last one said. */
export function cursorSentence(
  p: { x: number; y: number },
  c: SnapCandidate | null,
  ents: ResolvedEntity[],
  step: number | null,
): string {
  const at = snapped(t("sketch.speech.cursorAt", { coords: coordWords(p.x, p.y) }), c, ents);
  return step === null ? at : t("sketch.speech.gridStep", { step: fmtGridStep(step), rest: at });
}

/** The stop Tab's walk ends on, back where it began, so a listener hears the list ended. It holds the nearest snaps only. */
export function walkEndSentence(p: { x: number; y: number }, c: SnapCandidate | null, ents: ResolvedEntity[]): string {
  const coords = coordWords(p.x, p.y);
  return c ? snapped(t("sketch.speech.walkEnd", { coords }), c, ents) : t("sketch.speech.noSnap", { coords });
}

/** `angle` is given only when one was typed, in degrees. */
export function drawnSentence(
  e: ResolvedEntity,
  ents: ResolvedEntity[],
  closed: boolean,
  angle?: number | null,
): string {
  const name = entityLabel(ents, e.id) ?? e.type;
  if (e.type === "line") {
    const len = t("sketch.speech.length", { name, length: numberWords(Math.hypot(e.x2 - e.x1, e.y2 - e.y1)) });
    const line =
      angle == null
        ? len
        : t("sketch.speech.angle", { line: len, angle: signedWords(Math.round(angle * 1000) / 1000) });
    return closed ? t("sketch.speech.closed", { line }) : line;
  }
  if (e.type === "rectangle")
    return t("sketch.speech.rect", { name, w: numberWords(e.width), h: numberWords(e.height) });
  if (e.type === "circle") return t("sketch.speech.circle", { name, d: numberWords(2 * e.radius) });
  return name;
}
