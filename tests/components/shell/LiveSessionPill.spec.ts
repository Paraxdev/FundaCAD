// The badge that says an assistant is in this document.
//
// This is not decoration and it is not optional. The live-editing setting
// defaults to allowing edits, and the case for that default rests entirely on
// nothing happening invisibly: the badge appears while someone is attached, says
// what they last did, and leads to the setting that turns it off. If it silently
// stopped rendering, the default would no longer be defensible and nothing else
// in the app would notice.
//
// So the assertions are: it is ABSENT with nobody attached (a permanent inert
// control in a full title bar is attention spent for nothing), PRESENT with
// somebody, and it says which of read-only and editable is in force.

import { beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import LiveSessionPill from "../../../src/components/shell/LiveSessionPill.vue";
import { ENGINE } from "../../../src/app/engineKey";
import { setLiveEditingMode } from "../../../src/ui/liveEditing";
import type { Engine } from "../../../src/app/engine";
import type { LiveState } from "../../../src/live/liveSession";

/** Just the live host, which is all this component reaches into. */
function makeEngine(initial: LiveState) {
  let state = initial;
  const listeners = new Set<(s: LiveState) => void>();
  const live = {
    get snapshot() {
      return state;
    },
    subscribe(fn: (s: LiveState) => void) {
      listeners.add(fn);
      fn(state);
      return () => listeners.delete(fn);
    },
    push(next: LiveState) {
      state = next;
      for (const fn of listeners) fn(state);
    },
  };
  return { live } as unknown as Engine & { live: typeof live };
}

const mountPill = (engine: Engine) =>
  mount(LiveSessionPill, { global: { provide: { [ENGINE as symbol]: engine } } });

describe("the assistant badge", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setLiveEditingMode("edit");
  });

  it("renders nothing while nobody is attached", () => {
    const engine = makeEngine({ sharing: true, guests: [], lastEdit: null });
    const w = mountPill(engine);
    expect(w.find("#live-pill").exists(), "an inert badge sat in the title bar").toBe(false);
  });

  it("appears, and names who is attached", async () => {
    const engine = makeEngine({ sharing: true, guests: [], lastEdit: null });
    const w = mountPill(engine as Engine);
    engine.live.push({ sharing: true, guests: ["an assistant"], lastEdit: null });
    await nextTick();

    const pill = w.find("#live-pill");
    expect(pill.exists(), "an attached assistant was invisible").toBe(true);
    expect(pill.text()).toContain("an assistant");
  });

  it("counts them when there is more than one", async () => {
    const engine = makeEngine({ sharing: true, guests: ["a", "b"], lastEdit: null });
    const w = mountPill(engine as Engine);
    await nextTick();
    expect(w.find("#live-pill").text()).toContain("2 assistants");
  });

  it("says whether the assistant can change anything", async () => {
    const engine = makeEngine({ sharing: true, guests: ["an assistant"], lastEdit: null });
    const w = mountPill(engine as Engine);
    await nextTick();
    expect(w.find("#live-pill").attributes("title")).toContain("can edit it");

    setLiveEditingMode("read");
    await nextTick();
    const title = w.find("#live-pill").attributes("title") ?? "";
    expect(title).toContain("not change it");
    expect(w.find("#live-pill").classes()).toContain("readonly");
  });

  it("goes away when the session stops", async () => {
    const engine = makeEngine({ sharing: true, guests: ["an assistant"], lastEdit: null });
    const w = mountPill(engine as Engine);
    await nextTick();
    expect(w.find("#live-pill").exists()).toBe(true);

    engine.live.push({ sharing: false, guests: [], lastEdit: null });
    await nextTick();
    expect(w.find("#live-pill").exists(), "the badge outlived the session").toBe(false);
  });

  it("opens preferences, which is where the session is turned off", async () => {
    const engine = makeEngine({ sharing: true, guests: ["an assistant"], lastEdit: null });
    const w = mountPill(engine as Engine);
    await nextTick();
    const { useDialogStore } = await import("../../../src/stores/dialogs");
    expect(useDialogStore().preferences).toBe(false);
    await w.find("#live-pill").trigger("click");
    expect(useDialogStore().preferences, "the badge led nowhere").toBe(true);
  });
});
