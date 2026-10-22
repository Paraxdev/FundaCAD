import examples from "./examples.json";

export interface TemplateInfo {
  id: string;
  name: string;
  /** The card's second line, what the example shows. */
  caption: string;
  hint: string;
  icon: string;
  /** A document opens as an untitled copy, a STEP is imported into a new document. */
  source: "document" | "step";
}

// The cards in Home's order. Kept as data beside the files they open, since a model's name is content.
export const TEMPLATES = examples as TemplateInfo[];

const files = import.meta.glob<string>("./*.funda", { query: "?raw", import: "default" });
// A URL, so the STEP stays out of the JS chunk and loads only when its card is clicked.
const assets = import.meta.glob<string>("./*.stpz", { query: "?url", import: "default" });

export async function templateText(id: string): Promise<string> {
  const info = TEMPLATES.find((t) => t.id === id);
  if (info?.source === "step") throw new Error(`the ${info.name} example is a STEP file to import, not a document`);
  const load = files[`./${id}.funda`];
  if (!load) throw new Error(`no template called ${id}`);
  return load();
}

export async function templateFile(id: string, fetchFn: typeof fetch = fetch): Promise<File> {
  const load = assets[`./${id}.stpz`];
  if (!load) throw new Error(`no example file called ${id}`);
  const fail = `the example file ${id}.stpz could not be read`;
  const res = await fetchFn(await load()).catch(() => null);
  if (!res?.ok) throw new Error(fail);
  return new File([await res.arrayBuffer()], `${id}.stpz`);
}
