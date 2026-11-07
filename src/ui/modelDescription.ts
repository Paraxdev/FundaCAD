// Describe model and Describe selection as text. The dialog renders a ModelDescription and Copy as text writes
// descriptionText of the same one, so the two cannot disagree.

import { displayRound, getUnit, toDisplay } from "./units";
import { spokenUnit } from "./measure";
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
const size = (b: Box) => [0, 1, 2].map((i) => num(b.max[i]! - b.min[i]!));
const center = (b: Box) => [0, 1, 2].map((i) => num((b.max[i]! + b.min[i]!) / 2));

function bodyLine(b: DescribedBody): string {
  if (!b.box) return `${b.name}: not built yet`;
  const unit = getUnit();
  const parts = [`${size(b.box).join(" × ")} ${unit}`, `center at ${center(b.box).join(", ")} ${unit}`];
  if (b.volume !== null && !b.fault) parts.push(`volume ${displayRound(b.volume * toDisplay(1) ** 3)} ${unit}³`);
  if (b.material) parts.push(b.material);
  if (!b.visible) parts.push("hidden");
  if (b.fault) parts.push(`fault: ${b.fault}`);
  return `${b.name}: ${parts.join(", ")}`;
}

function featureLine(f: DescribedFeature): string {
  const state = f.state.startsWith("error: ") ? `failed: ${f.state.slice(7)}` : f.state;
  return state ? `${f.name}, ${state}` : f.name;
}

export function describeModel(f: ModelFacts): ModelDescription {
  const failed = f.features.filter((x) => x.state.startsWith("error")).length;
  const hidden = f.bodies.filter((b) => !b.visible).length;
  return {
    title: "Model description",
    sections: [
      {
        heading: "Overview",
        ordered: false,
        items: [
          `File: ${f.file}`,
          countWords({ bodies: f.bodies.length, hidden, features: f.features.length, failed }),
          `Sizes are X by Y by Z in ${getUnit()}, Z points up`,
        ],
      },
      { heading: "Bodies", ordered: false, items: f.bodies.length ? f.bodies.map(bodyLine) : ["No bodies"] },
      {
        heading: "Features",
        ordered: true,
        items: f.features.length ? f.features.map(featureLine) : ["No features"],
      },
      {
        heading: "View",
        ordered: false,
        items: [viewWords(f.view), f.view.section ? "Section on" : "Section off", selectionWords(f.selection)],
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
const said = (v: number) => (v < 0 ? `minus ${Math.abs(v)}` : `${v}`);

export function selectionSpeech(parts: readonly SelectedPart[]): string {
  if (!parts.length) return "Nothing selected";
  const unit = spokenUnit(getUnit(), true);
  return parts
    .map((p) => {
      if (!p.box) return p.what;
      const extent = size(p.box).map(said).join(" by ");
      return `${p.what}, ${extent} ${unit}, center at ${center(p.box).map(said).join(", ")} ${unit}`;
    })
    .join(". ");
}
