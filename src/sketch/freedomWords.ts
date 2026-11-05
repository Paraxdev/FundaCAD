// Kept apart from the probes so the palette can word a shape's freedom without loading the solver.

export interface Freedom {
  x: boolean;
  y: boolean;
  size: boolean;
}

export function freedomWords(f: Freedom | undefined): string {
  if (!f) return "";
  const ways = [f.x && "X", f.y && "Y", f.size && "size"].filter((w): w is string => !!w);
  const last = ways.pop();
  if (!last) return "fixed";
  return `free in ${ways.length ? `${ways.join(", ")} and ${last}` : last}`;
}
