import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { SELF_PROMPTING, SKETCH_PROMPTS } from "../../src/app/actionTables";
import { installSketchStateBridge } from "../../src/app/sketchStateBridge";
import { setPrompt } from "../../src/ui/prompt";
import { usePromptStore } from "../../src/stores/prompt";
import { useRibbonStore } from "../../src/stores/ribbon";

(globalThis as Record<string, unknown>).window ??= globalThis;

function bridge() {
  const state: Record<string, unknown> = {
    active: true,
    tool: "select",
    editingSketchId: null,
    onState: null,
    keyPrompt: null,
    armedByKeys: vi.fn(),
  };
  // every setter the palette calls on sketch entry is a no-op here
  const sketch = new Proxy(state, { get: (t, k) => (k in t ? t[k as string] : () => {}) });
  const none = new Proxy({}, { get: () => () => {} });
  installSketchStateBridge({ sketch, overlay: none, selectFeature() {} } as never);
  const to = (tool: string) => {
    state.tool = tool;
    (state.onState as () => void)();
  };
  const keys = (text: string | null) => {
    state.keyPrompt = text;
    (state.onState as () => void)();
  };
  return { to, keys, state };
}

describe("the prompt a sketch tool starts with", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it.each(["text", "project", "boltCircle", "hexHoles", "honeycomb", "gridHoles"])("is set for %s", (tool) => {
    const { to } = bridge();
    to(tool);
    expect(usePromptStore().text).toBe(SKETCH_PROMPTS[tool]);
    expect(usePromptStore().text).toMatch(/^Click /);
  });

  it("is left to the entity patterns and Mirror, which word their own as things are picked", () => {
    const { to } = bridge();
    expect([...SELF_PROMPTING].sort()).toEqual(["mirror", "patternCircular", "patternLinear", "patternRect"]);
    to("patternRect");
    setPrompt("2 picked · click more to add · click where the pattern starts · Esc");
    to("patternRect");
    expect(usePromptStore().text).toBe("2 picked · click more to add · click where the pattern starts · Esc");
    to("line");
    expect(usePromptStore().text).toBe(SKETCH_PROMPTS.line);
  });

  it("reads the keys prompt of a draw tool when the sketch has one, else the pointer's", () => {
    const { to, keys } = bridge();
    to("rectangle");
    expect(usePromptStore().text).toBe(SKETCH_PROMPTS.rectangle);
    keys("Type X and Y, or @dx,dy · Enter · Esc");
    expect(usePromptStore().text).toBe("Type X and Y, or @dx,dy · Enter · Esc");
    keys("Type the size · Enter · Esc");
    expect(usePromptStore().text).toBe("Type the size · Enter · Esc");
    keys(null);
    expect(usePromptStore().text).toBe(SKETCH_PROMPTS.rectangle);
    to("circle");
    expect(usePromptStore().text).toBe(SKETCH_PROMPTS.circle);
  });

  it("leaves a self-prompting tool to itself even with a keys prompt set", () => {
    const { to, keys } = bridge();
    to("patternRect");
    setPrompt("2 picked");
    keys("Type X and Y");
    expect(usePromptStore().text).toBe("2 picked");
  });

  it("clears the prompt when the sketch ends, whatever the keys prompt was", () => {
    const { keys, state } = bridge();
    keys("Type X and Y");
    state.active = false;
    (state.onState as () => void)();
    expect(usePromptStore().text).toBeNull();
  });

  it("hands the rail's keyboard arming to the sketch", () => {
    const { state } = bridge();
    useRibbonStore().actedByKeys();
    useRibbonStore().actedByKeys();
    expect(state.armedByKeys).toHaveBeenCalledTimes(2);
  });
});
