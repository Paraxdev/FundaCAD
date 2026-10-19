import type { Feature, ImportFormat, ImportReply } from "../types";

type ImportOk = Extract<ImportReply, { ok: true }>;

/** `count` ids of the `f<n>` form that `taken` does not hold, the same series
 *  store.nextId walks, for features added together before any of them exists. */
export function freeIds(taken: Iterable<string>, count: number): string[] {
  const ids = new Set(taken);
  const out: string[] = [];
  let n = ids.size + 1;
  while (out.length < count) {
    while (ids.has(`f${n}`)) n++;
    ids.add(`f${n}`);
    out.push(`f${n}`);
  }
  return out;
}

/** The features an import reply adds: a plain sketch on XY for every layer of
 *  a drawing (DXF, SVG), then the `import` feature when the file had 3D geometry. */
export function importFeatures(
  res: ImportOk,
  opts: { format: ImportFormat; source: string; taken: Iterable<string> },
): Feature[] {
  const sketches = res.sketches ?? [];
  const hasGeom = res.geom !== undefined;
  const ids = freeIds(opts.taken, sketches.length + (hasGeom ? 1 : 0));
  const take = (): string => ids.shift() ?? "";
  const out: Feature[] = sketches.map((s) => ({
    id: take(),
    type: "sketch",
    plane: "XY",
    name: s.name,
    entities: s.entities,
    ...(s.fillRule !== undefined ? { fillRule: s.fillRule } : {}),
  }));
  if (hasGeom) {
    out.push({
      id: take(),
      type: "import",
      format: opts.format,
      name: res.name,
      geom: res.geom,
      source: opts.source,
      solid: res.solid ?? true,
      ...(res.color !== undefined ? { color: res.color } : {}),
      // the file's assembly tree, when it had one. Spread the same way `color` is,
      // so an import with no tree produces exactly the feature it always did.
      ...(res.nodes !== undefined ? { nodes: res.nodes } : {}),
      ...(res.parts !== undefined ? { parts: res.parts } : {}),
      ...(res.notes !== undefined ? { notes: res.notes } : {}),
      ...(res.unit !== undefined ? { unit: res.unit } : {}),
      ...(res.scan ? { scan: true } : {}),
    });
  }
  return out;
}
