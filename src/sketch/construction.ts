type Flagged = { id: string; construction?: boolean };

/** True when something is picked and every pick is construction already. */
export const allConstruction = (entities: readonly Flagged[], ids: ReadonlySet<string>): boolean =>
  entities.some((e) => ids.has(e.id)) && entities.every((e) => !ids.has(e.id) || e.construction === true);

/** A selection holding any normal entity goes to construction, an all construction one goes back to normal. */
export function toggleConstruction<T extends Flagged>(entities: readonly T[], ids: ReadonlySet<string>): T[] {
  const toNormal = allConstruction(entities, ids);
  return entities.map((e) => {
    if (!ids.has(e.id)) return e;
    if (!toNormal) return { ...e, construction: true };
    const { construction: _off, ...rest } = e;
    return rest as T;
  });
}
