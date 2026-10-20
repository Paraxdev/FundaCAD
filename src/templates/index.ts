export interface TemplateInfo {
  id: string;
  name: string;
  hint: string;
  icon: string;
}

export const TEMPLATES: TemplateInfo[] = [
  { id: "plate", name: "Plate", hint: "A plate with four holes, sized by parameters", icon: "box" },
  { id: "wall-bracket", name: "Wall bracket", hint: "An L bracket with a stress study ready to run", icon: "stress" },
  { id: "pinned-lever", name: "Pinned lever", hint: "A lever on a pin with a stress study ready to run", icon: "stress" },
];

const files = import.meta.glob<string>("./*.funda", { query: "?raw", import: "default" });

export async function templateText(id: string): Promise<string> {
  const load = files[`./${id}.funda`];
  if (!load) throw new Error(`no template called ${id}`);
  return load();
}
