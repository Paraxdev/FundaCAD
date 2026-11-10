import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("../../../src/ui/announce", () => ({ announce: vi.fn() }));

import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import PromptBanner from "../../../src/components/shell/PromptBanner.vue";
import { setPrompt } from "../../../src/ui/prompt";
import { setLanguage } from "../../../src/i18n";

enableAutoUnmount(afterEach);

afterEach(async () => {
  setPrompt(null);
  await setLanguage("system");
});

function render(tool: string) {
  setActivePinia(createPinia());
  const engine = reactive({ sketch: { active: true, tool }, tools: {} }) as unknown as Engine;
  return mount(PromptBanner, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: engine } } });
}

describe("the prompt banner title in a sketch", () => {
  it("switches language while a sketch tool's prompt is showing", async () => {
    await setLanguage("en");
    const w = render("perpendicular");
    setPrompt("Pick two lines");
    await nextTick();
    const title = () => w.get('[data-testid="prompt-title"]').text();
    expect(title()).toContain("Perpendic.");
    await setLanguage("de");
    await nextTick();
    expect(title()).toContain("Senkrecht");
    expect(title()).not.toContain("Perpendic.");
  });

  it("shows no title for the select tool, and none for an unknown one", async () => {
    await setLanguage("de");
    for (const tool of ["select", "no-such-tool"]) {
      const w = render(tool);
      setPrompt("Pick");
      await nextTick();
      expect(w.find('[data-testid="prompt-title"]').exists()).toBe(false);
    }
  });
});
