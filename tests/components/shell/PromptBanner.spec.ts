import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const tool = vi.hoisted(() => ({ running: null as { label: string; action: string } | null }));
vi.mock("../../../src/ui/announce", () => ({ announce: vi.fn() }));
vi.mock("../../../src/ui/runningTool", () => ({ runningTool: () => tool.running }));
vi.mock("../../../src/input/shortcuts", () => ({ keyHint: () => "E" }));

import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import PromptBanner from "../../../src/components/shell/PromptBanner.vue";
import { setPrompt } from "../../../src/ui/prompt";
import { announce } from "../../../src/ui/announce";

enableAutoUnmount(afterEach);

const engine = { sketch: { active: false, tool: "select" }, tools: {} } as unknown as Engine;
const said = () => vi.mocked(announce).mock.calls.map(([text, priority]) => [text, priority]);

function render() {
  return mount(PromptBanner, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: engine } } });
}

describe("the prompt banner", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(announce).mockClear();
    tool.running = null;
  });

  it("keeps its text as drawn, with the middle dot hidden from screen readers", async () => {
    const w = render();
    setPrompt("Click an edge · Ctrl-click a chain · Esc");
    await nextTick();
    const text = w.find("#prompt");
    expect(text.text()).toBe("Click an edge · Ctrl-click a chain · Esc");
    const seps = text.findAll(".prompt-sep");
    expect(seps).toHaveLength(2);
    expect(seps.every((s) => s.attributes("aria-hidden") === "true")).toBe(true);
  });

  it("speaks a tool's first prompt with its name, and a later step alone", async () => {
    render();
    tool.running = { label: "Extrude", action: "extrude" };
    setPrompt("Select a profile · Esc to cancel");
    await nextTick();
    setPrompt("Drag the arrow or type a distance");
    await nextTick();
    expect(said()).toEqual([
      ["Extrude, Select a profile · Esc to cancel", "polite"],
      ["Drag the arrow or type a distance", "polite"],
    ]);
  });

  it("names the tool again after the prompt was put away, and is silent when it clears", async () => {
    render();
    tool.running = { label: "Extrude", action: "extrude" };
    setPrompt("Select a profile");
    await nextTick();
    setPrompt(null);
    await nextTick();
    setPrompt("Select a profile");
    await nextTick();
    expect(said()).toEqual([
      ["Extrude, Select a profile", "polite"],
      ["Extrude, Select a profile", "polite"],
    ]);
  });

  it("debounces prompts under one key, so a burst of steps speaks the last", async () => {
    render();
    setPrompt("Pick a face");
    await nextTick();
    expect(vi.mocked(announce).mock.calls[0]?.[2]).toMatchObject({ key: "prompt" });
  });
});
