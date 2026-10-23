// Marks the model on screen out of date while something it was built from is gone from the document, so a body
// already deleted is never taken for a current one. An ordinary edit's model stays drawn and pickable meanwhile.
import type { DocumentStore } from "../document/store";

/** Long enough that a normal edit's build lands first and nothing flickers. */
export const OUT_OF_DATE_GRACE_MS = 600;

type Watched = Pick<
  DocumentStore,
  "onBuild" | "onBusy" | "buildState" | "busyState" | "runningOps" | "hasPreview" | "drawnBehind"
>;

export function watchOutOfDate(store: Watched, mark: (on: boolean) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let marked = false;
  const set = (on: boolean) => {
    if (on === marked) return;
    marked = on;
    mark(on);
  };
  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  // A tool's preview build is the tool's to show, its refusals already ghost the model.
  const behind = () => store.drawnBehind && !store.hasPreview;
  const check = () => {
    if (!behind()) {
      stopTimer();
      set(false);
      return;
    }
    if (!store.buildState.building || store.busyState.waiting || store.runningOps.some((o) => !o.rebuild)) {
      stopTimer();
      set(true);
      return;
    }
    if (marked || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (behind()) set(true);
    }, OUT_OF_DATE_GRACE_MS);
  };
  const offs = [store.onBuild(check), store.onBusy(check)];
  return () => {
    stopTimer();
    for (const off of offs) off();
  };
}
