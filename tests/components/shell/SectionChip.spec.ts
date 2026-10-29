// The "Section on" chip: there while a cut is drawn, gone otherwise, and its Edit, Flip and Off reach the tool.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SectionChip from "../../../src/components/shell/SectionChip.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import type { SectionPhase } from "../../../src/features/sectionTool";

function makeEngine(start: SectionPhase) {
  const calls: string[] = [];
  const listeners = new Set<(p: SectionPhase) => void>();
  const section = {
    phase: start,
    onChange(fn: (p: SectionPhase) => void) {
      listeners.add(fn);
      fn(section.phase);
      return () => {
        listeners.delete(fn);
      };
    },
    confirm: () => calls.push("confirm"),
    edit: () => calls.push("edit"),
    flip: () => calls.push("flip"),
    stop: () => calls.push("stop"),
  };
  const state = { owns: false, busy: false };
  const engine = {
    tools: { section },
    store: { onDocChange: () => () => {}, onBuild: () => () => {} },
    toolOwnsScreen: () => state.owns,
    toolBusy: () => state.busy || state.owns,
    dropBodyGizmo: () => calls.push("dropBodyGizmo"),
  };
  const go = (p: SectionPhase) => {
    section.phase = p;
    for (const fn of [...listeners]) fn(p);
  };
  return { engine: engine as unknown as Engine, calls, state, listeners, go };
}

let frames: (() => void)[] = [];
const flush = async () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
  await nextTick();
};

const mounted: VueWrapper[] = [];
function mountChip(engine: Engine) {
  const w = mount(SectionChip, { global: { provide: { [ENGINE as symbol]: engine } } });
  mounted.push(w);
  return w;
}

describe("the section chip", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
      frames.push(fn);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    for (const w of mounted.splice(0)) w.unmount();
    vi.unstubAllGlobals();
  });

  it("is there for a cut that is on or being edited, and absent while off or aiming", () => {
    const seen = (["off", "aiming", "editing", "on"] as const).map((p) => {
      const w = mountChip(makeEngine(p).engine);
      return w.find('[data-testid="section-chip"]').exists();
    });
    expect(seen).toEqual([false, false, true, true]);
  });

  it("names itself and its three buttons", () => {
    const w = mountChip(makeEngine("on").engine);
    const chip = w.find('[data-testid="section-chip"]');
    expect(chip.attributes("role")).toBe("toolbar");
    expect(chip.text()).toContain("Section on");
    expect(w.findAll("button").map((b) => b.text())).toEqual(["Edit", "Flip", "Off"]);
  });

  it("Edit drops the body gizmo then edits while on, and only confirms while editing", async () => {
    const t = makeEngine("on");
    const w = mountChip(t.engine);
    const edit = w.find('[data-testid="section-edit"]');
    expect(edit.attributes("aria-pressed")).toBe("false");
    await edit.trigger("click");
    expect(t.calls).toEqual(["dropBodyGizmo", "edit"]);

    t.go("editing");
    await nextTick();
    expect(edit.attributes("aria-pressed")).toBe("true");
    expect(edit.classes()).toContain("is-on");
    t.calls.length = 0;
    await edit.trigger("click");
    expect(t.calls).toEqual(["confirm"]);
  });

  it("Edit waits while another tool owns the screen, but not for a body selection's Move gizmo", async () => {
    const t = makeEngine("on");
    t.state.owns = true;
    const w = mountChip(t.engine);
    const edit = w.find('[data-testid="section-edit"]');
    expect(edit.attributes("aria-disabled")).toBe("true");
    expect(edit.classes()).toContain("is-disabled");
    expect(edit.attributes("title")).toBe("Finish the current tool first");
    await edit.trigger("click");
    expect(t.calls).toEqual([]);

    t.state.owns = false;
    t.state.busy = true;
    window.dispatchEvent(new Event("pointerup"));
    await flush();
    expect(edit.attributes("aria-disabled")).toBeUndefined();
    expect(edit.classes()).not.toContain("is-disabled");
    await edit.trigger("click");
    expect(t.calls).toEqual(["dropBodyGizmo", "edit"]);
  });

  it("Flip flips and Off stops, once each", async () => {
    const t = makeEngine("on");
    const w = mountChip(t.engine);
    await w.find('[data-testid="section-flip"]').trigger("click");
    await w.find('[data-testid="section-off"]').trigger("click");
    expect(t.calls).toEqual(["flip", "stop"]);
  });

  it("a mouse press leaves the focus where it was, so the Offset box keeps its keys", async () => {
    const t = makeEngine("editing");
    const w = mountChip(t.engine);
    const pressed = ["section-edit", "section-flip", "section-off"].map((id) => {
      const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      w.find(`[data-testid="${id}"]`).element.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(pressed).toEqual([true, true, true]);
    expect(t.calls).toEqual([]);
  });

  it("follows the tool's phase and lets go of it when unmounted", async () => {
    const t = makeEngine("off");
    const w = mountChip(t.engine);
    expect(w.find('[data-testid="section-chip"]').exists()).toBe(false);
    t.go("editing");
    await nextTick();
    expect(w.find('[data-testid="section-chip"]').exists()).toBe(true);
    t.go("off");
    await nextTick();
    expect(w.find('[data-testid="section-chip"]').exists()).toBe(false);
    expect(t.listeners.size).toBe(1);
    w.unmount();
    mounted.length = 0;
    expect(t.listeners.size).toBe(0);
  });
});
