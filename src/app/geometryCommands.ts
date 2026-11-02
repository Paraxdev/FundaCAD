// Next Face, Previous Face, Next Edge and Previous Edge. A command has no Enter to follow it, so where the canvas
// brackets only light a row, these select it.

import { watch } from "vue";
import { useGeometryBrowserStore, type GeometryKind } from "../stores/geometryBrowser";
import { announce } from "../ui/announce";
import { describePick } from "../ui/describePick";
import { emptyStepWords } from "./canvasPick";
import type { Engine } from "./engine";
import { SELECTION_SPEECH_DELAY } from "./selectionWords";

export function createGeometryCommands(e: Pick<Engine, "geometryBrowser" | "setStatus">) {
  let dropWait: (() => void) | null = null;

  // The readout speaks a changed selection under this same key and replaces these words. They are heard when it has
  // nothing to say: a body of one face, or the row already selected.
  const say = (text: string) => announce(text, "polite", { key: "selection", delay: SELECTION_SPEECH_DELAY });

  // A toast reaches no screen reader.
  function refuse(text: string) {
    e.setStatus(text, "");
    say(text);
  }

  function select(delta: 1 | -1) {
    const list = useGeometryBrowserStore();
    const only = list.selected.length === 1 ? list.selected[0] : undefined;
    if (!list.litRow && list.filtered.some((r) => r.key === only)) list.setCursor(only!);
    const row = e.geometryBrowser.step(delta);
    if (!row) return say(emptyStepWords(list));
    const refused = e.geometryBrowser.pickRows([row], { additive: false });
    if (refused) return refuse(refused);
    say(describePick(row.facts).spoken);
  }

  // The list's first reply can take a second on a big body, so anything the person did meanwhile outranks the command.
  function waitForList(kind: GeometryKind, delta: 1 | -1) {
    const list = useGeometryBrowserStore();
    const selected = list.selected;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") dropWait?.();
    };
    const stop = watch(
      () => list.state,
      (state) => {
        if (state === "loading") return;
        dropWait?.();
        const moved = list.kind !== kind || list.selected !== selected;
        if (state !== "idle" && !moved && !e.geometryBrowser.pickBlocked()) select(delta);
      },
      { flush: "sync" },
    );
    window.addEventListener("keydown", onKey, true);
    dropWait = () => {
      dropWait = null;
      stop();
      window.removeEventListener("keydown", onKey, true);
    };
  }

  return {
    selectStep(kind: GeometryKind, delta: 1 | -1) {
      dropWait?.();
      const ctl = e.geometryBrowser;
      const list = useGeometryBrowserStore();
      const blocked = ctl.pickBlocked();
      if (blocked) return refuse(blocked);
      ctl.setKind(kind);
      ctl.startStepping();
      if (list.state !== "loading") return select(delta);
      say(`Listing ${kind}`);
      waitForList(kind, delta);
    },
  };
}
