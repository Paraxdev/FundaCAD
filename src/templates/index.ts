export interface TemplateInfo {
  id: string;
  name: string;
  /** The card's second line, what the example shows. */
  caption: string;
  hint: string;
  icon: string;
}

export const TEMPLATES: TemplateInfo[] = [
  {
    id: "wall-bracket",
    name: "Wall bracket",
    caption: "Stress study ready",
    hint: "An L bracket with a stress study ready to run",
    icon: "stress",
  },
  {
    id: "plate",
    name: "Plate",
    caption: "Sized by parameters",
    hint: "A plate with four holes, sized by parameters",
    icon: "box",
  },
  {
    id: "pinned-lever",
    name: "Pinned lever",
    caption: "Stress study ready",
    hint: "A lever on a pin with a stress study ready to run",
    icon: "rotate",
  },
];

const files = import.meta.glob<string>("./*.funda", { query: "?raw", import: "default" });

export async function templateText(id: string): Promise<string> {
  const load = files[`./${id}.funda`];
  if (!load) throw new Error(`no template called ${id}`);
  return load();
}
