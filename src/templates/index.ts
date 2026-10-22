import examples from "./examples.json";

export interface TemplateInfo {
  id: string;
  name: string;
  /** The card's second line, what the example shows. */
  caption: string;
  hint: string;
  icon: string;
}

// The cards in Home's order. Kept as data beside the files they open, since a model's name is content.
export const TEMPLATES = examples as TemplateInfo[];

const files = import.meta.glob<string>("./*.funda", { query: "?raw", import: "default" });

export async function templateText(id: string): Promise<string> {
  const load = files[`./${id}.funda`];
  if (!load) throw new Error(`no template called ${id}`);
  return load();
}
