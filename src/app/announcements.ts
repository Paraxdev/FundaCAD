// What a screen reader has to hear that no component renders as it happens: builds and busy work, the mode and the
// workspace. The components that draw a readout (prompt, selection, measure, Stress) speak for themselves.

import { watch } from "vue";
import type { DocumentStore, RebuildState } from "../document/store";
import { useUiStore } from "../stores/ui";
import { announce } from "../ui/announce";
import { buildLine, failureKey } from "../ui/buildAnnouncement";
import { busyLine } from "../ui/buildProgress";
import { stepName } from "../ui/featureMeta";
import { onWorkspaceChange, WORKSPACES } from "../ui/workspace";

/** Work quicker than this only says its result, so a short rebuild is not "Rebuilding" then "Built". */
export const BUSY_SPEAK_MS = 1000;

export function installAnnouncements(e: { store: DocumentStore }): () => void {
  const store = e.store;
  const nameOf = (id: string) => {
    const f = store.document.features.find((x) => x.id === id);
    return f ? stepName(f) : null;
  };

  let building = false;
  let lastSettled: RebuildState | null = null;
  const offBuild = store.onBuild((s) => {
    if (s.building) {
      building = true;
      return;
    }
    // The replay on subscribe and progress ticks after the result are not a build finishing.
    const finished = building;
    building = false;
    const line = finished ? buildLine(s, lastSettled, nameOf) : null;
    if (!s.previewBuilt && !s.cancelled) lastSettled = s;
    if (!line) return;
    const failed = line.priority === "assertive" && s.errorFeatureId;
    announce(line.text, line.priority, { key: failed ? failureKey(failed) : "build" });
  });

  let pending: { text: string; timer: ReturnType<typeof setTimeout> } | null = null;
  let said: string | null = null;
  const offBusy = store.onBusy((b) => {
    const text = b.active ? busyLine({ ...b, pct: null, stage: null }).text : null;
    if (text === (pending ? pending.text : said)) return;
    if (pending) clearTimeout(pending.timer);
    pending = null;
    said = null;
    if (!text) return;
    pending = {
      text,
      timer: setTimeout(() => {
        pending = null;
        said = text;
        announce(text, "polite", { key: "busy" });
      }, BUSY_SPEAK_MS),
    };
  });

  const ui = useUiStore();
  const stopMode = watch(
    () => ui.sketchActive,
    (on) => announce(on ? "Sketch mode" : "Solid mode", "polite", { key: "mode" }),
  );
  const offWorkspace = onWorkspaceChange((w) => {
    // The switch itself is a radio group the screen reader already reads as it changes.
    if (document.activeElement?.closest("#workspace-toggle")) return;
    announce(`${WORKSPACES.find((x) => x.id === w)?.label ?? w} workspace`, "polite", { key: "mode" });
  });

  return () => {
    offBuild();
    offBusy();
    stopMode();
    offWorkspace();
    if (pending) clearTimeout(pending.timer);
  };
}
