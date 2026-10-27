// Picking several History or Items rows, and acting on them: the one place the three lists share.

import type { DocumentStore } from "../document/store";
import { useSelectionStore } from "../stores/selection";
import { actOn, modsOf, selectRow } from "../ui/rowSelection";
import type { Engine } from "./engine";

/** Origin plane rows are picked as "o:XY", they are not features. */
const isOriginKey = (k: string) => k.startsWith("o:");

/** Click, Ctrl-click or Shift-click a row. `order` is the rows of that list as drawn, so a run never crosses into
 *  another list or a hidden row. The inspector follows the row just added, a Ctrl-click removing it hands that to the
 *  last one left. */
export function clickFeatureRow(
  e: Pick<Engine, "selectFeatureRows">,
  order: readonly string[],
  id: string,
  ev: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
): void {
  const sel = useSelectionStore();
  const next = selectRow(sel.rows, order, id, modsOf(ev));
  const features = next.keys.filter((k) => !isOriginKey(k));
  let primary = sel.featureId;
  if (next.keys.includes(id) && !isOriginKey(id)) primary = id;
  else if (primary === null || !next.keys.includes(primary)) primary = features.at(-1) ?? null;
  e.selectFeatureRows(next, primary);
}

/** The features a row action covers: the whole selection when the grabbed row is in it, else just that row. */
export function rowTargets(id: string): string[] {
  return actOn(useSelectionStore().rows.keys, id).filter((k) => !isOriginKey(k));
}

/** The features picked right now, in document order. A selection made by the engine alone still counts as one. */
export function pickedFeatureIds(e: Pick<Engine, "store" | "selectedFeature">): string[] {
  const keys = new Set(useSelectionStore().rows.keys);
  if (e.selectedFeature !== null) keys.add(e.selectedFeature);
  return e.store.document.features.map((f) => f.id).filter((id) => keys.has(id));
}

/** Suppresses them all, or unsuppresses them all when every one is already suppressed. */
export function toggleSuppressRows(
  store: Pick<DocumentStore, "isSuppressed" | "setSuppressed">,
  ids: readonly string[],
) {
  store.setSuppressed(ids, !ids.every((id) => store.isSuppressed(id)));
}

/** Deletes them as one undo step and drops the selection when it held any of them. */
export function deleteRows(e: Pick<Engine, "store" | "selectFeature">, ids: readonly string[]) {
  e.store.removeFeatures(ids);
  const sel = useSelectionStore();
  if (ids.some((id) => id === sel.featureId || sel.rows.keys.includes(id))) e.selectFeature(null);
}

/** The selected feature for a tool that needs exactly one: none while several rows are picked. */
export function soleSelectedFeature(e: Pick<Engine, "selectedFeature">): string | null {
  return useSelectionStore().rows.keys.length > 1 ? null : e.selectedFeature;
}
