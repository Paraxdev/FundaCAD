import { t, type MessageKey } from "../i18n";
import examples from "./examples.json";

export interface TemplateInfo {
  id: string;
  /** The new document's name, English in every language since a model's name is content. */
  name: string;
  icon: string;
}

// The cards in Home's order. Kept as data beside the files they open, since a model's name is content.
export const TEMPLATES = examples as TemplateInfo[];

interface ExampleLines {
  name: MessageKey;
  caption: MessageKey;
  hint: MessageKey;
}

const LINES: Record<string, ExampleLines> = {
  "wall-bracket": {
    name: "home.example.wallBracket.name",
    caption: "home.example.wallBracket.caption",
    hint: "home.example.wallBracket.hint",
  },
  "box-with-lid": {
    name: "home.example.boxWithLid.name",
    caption: "home.example.boxWithLid.caption",
    hint: "home.example.boxWithLid.hint",
  },
  "capsule-holder": {
    name: "home.example.capsuleHolder.name",
    caption: "home.example.capsuleHolder.caption",
    hint: "home.example.capsuleHolder.hint",
  },
  plate: {
    name: "home.example.plate.name",
    caption: "home.example.plate.caption",
    hint: "home.example.plate.hint",
  },
  "pinned-lever": {
    name: "home.example.pinnedLever.name",
    caption: "home.example.pinnedLever.caption",
    hint: "home.example.pinnedLever.hint",
  },
};

export const exampleLines = (id: string): ExampleLines | undefined => LINES[id];

/** The card's words in the language: its name, the line under it and its tip. */
export function exampleCard(info: TemplateInfo): { name: string; caption: string; hint: string } {
  const k = LINES[info.id];
  return k ? { name: t(k.name), caption: t(k.caption), hint: t(k.hint) } : { name: info.name, caption: "", hint: "" };
}

const files = import.meta.glob<string>("./*.funda", { query: "?raw", import: "default" });

export async function templateText(id: string): Promise<string> {
  const load = files[`./${id}.funda`];
  if (!load) throw new Error(`no template called ${id}`);
  return load();
}
