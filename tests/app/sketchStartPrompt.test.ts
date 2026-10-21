import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { SELF_PROMPTING, SKETCH_PROMPTS } from "../../src/app/actionTables";
import { installSketchStateBridge } from "../../src/app/sketchStateBridge";
import { setPrompt } from "../../src/ui/prompt";
import { usePromptStore } from "../../src/stores/prompt";

(globalThis as Record<string, unknown>).window ??= globalThis;

function bridge() {
  const state: Record<string, unknown> = { active: true, tool: "select", editingSketchId: null, onState: null };
  // every setter the palette calls on sketch entry is a no-op here
  const sketch = new Proxy(state, { get: (t, k) => (k in t ? t[k as string] : () => {}) });
  const none = new Proxy({}, { get: () => () => {} });
  installSketchStateBridge({ sketch, overlay: none, selectFeature() {} } as never);
  const to = (tool: string) => { state.tool = tool; (state.onState as () => void)(); };
  return { to };
}

describe("the prompt a sketch tool starts with", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it.each(["text", "project", "boltCircle", "hexHoles", "honeycomb", "gridHoles"])("is set for %s", (tool) => {
    const { to } = bridge();
    to(tool);
    expect(usePromptStore().text).toBe(SKETCH_PROMPTS[tool]);
    expect(usePromptStore().text).toMatch(/^Click /);
  });

  it("is left to the entity patterns, which word their own as curves are picked", () => {
    const { to } = bridge();
    expect([...SELF_PROMPTING].sort()).toEqual(["patternCircular", "patternRect"]);
    to("patternRect");
    setPrompt("2 picked · click more to add · click where the pattern starts · Esc");
    to("patternRect");
    expect(usePromptStore().text).toBe("2 picked · click more to add · click where the pattern starts · Esc");
    to("line");
    expect(usePromptStore().text).toBe(SKETCH_PROMPTS.line);
  });
});
