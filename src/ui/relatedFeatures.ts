// Which history entries relate to what is selected, for History's "Related to Selection".

/** Sketch ids a feature is built from. Read generically, so a new sketch-based
 *  feature is covered as long as it names its sketch the way the others do. */
export function sketchesOf(f: object): string[] {
  const out: string[] = [];
  const rec = f as { sketch?: unknown; sketches?: unknown; profiles?: unknown };
  if (typeof rec.sketch === "string") out.push(rec.sketch);
  if (Array.isArray(rec.sketches)) for (const s of rec.sketches) if (typeof s === "string") out.push(s);
  if (Array.isArray(rec.profiles)) {
    for (const p of rec.profiles) {
      const s = (p as { sketch?: unknown } | null)?.sketch;
      if (typeof s === "string") out.push(s);
    }
  }
  return out;
}

/** The features `seeds` name, the sketches they are built from, and for a seed
 *  that IS a sketch, the features built from it. */
export function relatedFeatureIds(
  features: readonly ({ id: string; type: string } & object)[],
  seeds: Iterable<string>,
): Set<string> {
  const byId = new Map(features.map((f) => [f.id, f]));
  const out = new Set<string>();
  for (const id of seeds) {
    const f = byId.get(id);
    if (!f) continue;
    out.add(id);
    for (const s of sketchesOf(f)) out.add(s);
    if (f.type === "sketch") {
      for (const g of features) if (sketchesOf(g).includes(id)) out.add(g.id);
    }
  }
  return out;
}
