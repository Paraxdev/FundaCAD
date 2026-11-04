import type { ClashRow, ClearanceRow, InterferenceData } from "../stores/panels";

interface Reply {
  pairs: { a: string; b: string; aName: string; bName: string; volume: number }[];
  clearances: { a: string; b: string; aName: string; bName: string; distance: number }[];
  unchecked: { id: string; name: string; reason: string }[];
}

interface Display {
  unit: string;
  /** Display units per mm. */
  scale: number;
  round: (n: number) => number | string;
  label: (id: string, raw: string) => string;
}

export function interferenceTitle(clashes: number): string {
  return clashes ? `Interference, ${clashes} clash${clashes > 1 ? "es" : ""}` : "Interference";
}

export function interferenceData(reply: Reply, d: Display): InterferenceData {
  const names = (r: { a: string; b: string; aName: string; bName: string }) =>
    `${d.label(r.a, r.aName)} and ${d.label(r.b, r.bName)}`;
  const f = d.scale;
  const clashes: ClashRow[] = reply.pairs.map((p) => {
    const v = `${d.round(p.volume * f * f * f)} ${d.unit}³`;
    return { key: `${p.a} ${p.b}`, label: names(p), v, spoken: `${names(p)}, overlap ${v}`, a: p.a, b: p.b };
  });
  const clearances: ClearanceRow[] = reply.clearances.map((c) => {
    const v = `${d.round(c.distance * f)} ${d.unit}`;
    return { key: `${c.a} ${c.b}`, label: names(c), v, spoken: `${names(c)}, ${v} apart`, a: c.a, b: c.b };
  });
  return {
    title: interferenceTitle(clashes.length),
    clashes,
    clearances,
    unchecked: reply.unchecked.map((u) => `${d.label(u.id, u.name)} ${u.reason}`),
  };
}
