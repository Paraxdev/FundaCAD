// Describe model and Describe selection as text. The dialog renders a ModelDescription and Copy as text writes
// descriptionText of the same one, so the two cannot disagree.

import { t } from "../i18n";
import { knownBodyReason } from "./engineReasons";
import { shownLine } from "./englishLines";
import { listJoin, spellNumber } from "./measure";
import { displayRound, getUnit, toDisplay } from "./units";
import { countWords, selectionWords, viewWords, type SelectionFacts, type ViewFacts } from "./viewSummary";

export type Vec3 = readonly [number, number, number];
export interface Box {
  min: Vec3;
  max: Vec3;
}

export interface DescribedBody {
  name: string;
  /** Null while the view has not drawn the body. */
  box: Box | null;
  /** Null for a body that is not a sound solid, whose mesh has no inside. */
  volume: number | null;
  visible: boolean;
  material: string | null;
  fault: string | null;
}

export interface DescribedFeature {
  name: string;
  /** The History readout's state: "", "rolled back", "suppressed" or "error: <message>". */
  state: string;
}

export interface ModelFacts {
  file: string;
  bodies: DescribedBody[];
  features: DescribedFeature[];
  view: ViewFacts;
  selection: SelectionFacts;
}

export interface DescriptionSection {
  heading: string;
  ordered: boolean;
  items: string[];
}

export interface ModelDescription {
  title: string;
  sections: DescriptionSection[];
}

const num = (mm: number) => displayRound(toDisplay(mm));
const spelled = (v: number) => spellNumber(v);
const size = (b: Box) => [0, 1, 2].map((i) => num(b.max[i]! - b.min[i]!));
const center = (b: Box) => [0, 1, 2].map((i) => num((b.max[i]! + b.min[i]!) / 2));

const joinParts = (parts: readonly string[]) => parts.reduce((before, after) => t("describe.next", { before, after }));

function bodyLine(b: DescribedBody): string {
  if (!b.box) return t("describe.body.notBuilt", { name: b.name });
  const unit = getUnit();
  const parts = [
    `${size(b.box).map(spelled).join(" × ")} ${unit}`,
    t("describe.body.center", { center: listJoin(center(b.box).map(spelled)), unit }),
  ];
  if (b.volume !== null && !b.fault)
    parts.push(t("describe.body.volume", { volume: spelled(displayRound(b.volume * toDisplay(1) ** 3)), unit }));
  if (b.material) parts.push(b.material);
  if (!b.visible) parts.push(t("describe.body.hidden"));
  if (b.fault) parts.push(t("describe.body.fault", { why: knownBodyReason(b.name, b.fault) ?? b.fault }));
  return t("describe.body.line", { name: b.name, parts: joinParts(parts) });
}

/** The History readout's state, which stays English for the harness, in the maker's language. */
function stateWords(state: string): string {
  if (state === "rolled back") return t("history.state.rolledBack");
  if (state === "suppressed") return t("history.state.suppressed");
  if (state.startsWith("error: ")) return t("history.state.failed", { message: shownLine(state.slice(7)) });
  return state;
}

function featureLine(f: DescribedFeature): string {
  const state = stateWords(f.state);
  return state ? joinParts([f.name, state]) : f.name;
}

export function describeModel(f: ModelFacts): ModelDescription {
  const failed = f.features.filter((x) => x.state.startsWith("error")).length;
  const hidden = f.bodies.filter((b) => !b.visible).length;
  return {
    title: t("describe.title"),
    sections: [
      {
        heading: t("describe.heading.overview"),
        ordered: false,
        items: [
          t("describe.file", { name: f.file }),
          countWords({ bodies: f.bodies.length, hidden, features: f.features.length, failed }),
          t("describe.axes", { unit: getUnit() }),
        ],
      },
      {
        heading: t("describe.heading.bodies"),
        ordered: false,
        items: f.bodies.length ? f.bodies.map(bodyLine) : [t("describe.noBodies")],
      },
      {
        heading: t("describe.heading.features"),
        ordered: true,
        items: f.features.length ? f.features.map(featureLine) : [t("describe.noFeatures")],
      },
      {
        heading: t("describe.heading.view"),
        ordered: false,
        items: [
          viewWords(f.view),
          t("describe.section", { on: f.view.section ? "yes" : "no" }),
          selectionWords(f.selection),
        ],
      },
    ],
  };
}

export function descriptionText(d: ModelDescription): string {
  const out = [d.title, ""];
  for (const s of d.sections) {
    out.push(s.heading, ...s.items.map((item, i) => `${s.ordered ? `${i + 1}.` : "-"} ${item}`), "");
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

export interface SelectedPart {
  /** "Plate", "2 faces on Plate", "1 edge". */
  what: string;
  box: Box | null;
}

// Voices can drop a hyphen before a number, so a negative says minus.
const said = (v: number) => (v < 0 ? t("units.spoken.minus", { amount: spelled(Math.abs(v)) }) : spelled(v));

export function selectionSpeech(parts: readonly SelectedPart[]): string {
  if (!parts.length) return t("selection.said.none");
  const unit = t("units.spoken.word", { unit: getUnit() });
  return parts
    .map((p) => {
      if (!p.box) return p.what;
      const [x = "", y = "", z = ""] = size(p.box).map(said);
      return t("describe.selection.box", { what: p.what, x, y, z, unit, center: listJoin(center(p.box).map(said)) });
    })
    .reduce((before, after) => t("describe.selection.next", { before, after }));
}
