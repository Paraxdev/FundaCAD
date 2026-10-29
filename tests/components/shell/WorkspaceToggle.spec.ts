import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import WorkspaceToggle from "../../../src/components/shell/WorkspaceToggle.vue";
import { setWorkspace, workspace } from "../../../src/ui/workspace";
import { useUiStore } from "../../../src/stores/ui";

enableAutoUnmount(afterEach);

async function render() {
  const w = mount(WorkspaceToggle, { attachTo: document.body });
  await new Promise((r) => setTimeout(r, 2));
  return w;
}
const radios = (w: Awaited<ReturnType<typeof render>>) => w.findAll('[role="radio"]');

async function press(key: string) {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
  await flushPromises();
}

describe("WorkspaceToggle", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setWorkspace("model");
  });
  afterEach(() => setWorkspace("model"));

  it("is one named radio group with the e2e hooks and tooltips on its options", async () => {
    const w = await render();
    const root = w.get("#workspace-toggle");
    expect([root.attributes("role"), root.attributes("aria-label")]).toEqual(["radiogroup", "Workspace"]);
    expect(radios(w).map((r) => [r.attributes("data-workspace"), r.attributes("aria-checked"), r.text()])).toEqual([
      ["model", "true", "Model"],
      ["render", "false", "Render"],
    ]);
    expect(radios(w)[1]!.attributes("title")).toBe("Render: materials, environment and camera");
  });

  it("switches on a click and follows a switch made elsewhere", async () => {
    const w = await render();
    await w.get('[data-workspace="render"]').trigger("click");
    expect(workspace()).toBe("render");
    await nextTick();
    expect(w.get('[data-workspace="render"]').attributes("aria-checked")).toBe("true");
    setWorkspace("model");
    await nextTick();
    expect(w.get('[data-workspace="model"]').attributes("aria-checked")).toBe("true");
  });

  it("is one Tab stop, and the arrows switch the workspace", async () => {
    const w = await render();
    expect(radios(w).map((r) => r.attributes("tabindex"))).toEqual(["0", "-1"]);
    (radios(w)[0]!.element as HTMLElement).focus();
    await press("ArrowRight");
    expect(workspace()).toBe("render");
    await press("ArrowLeft");
    expect(workspace()).toBe("model");
  });

  it("is gone while a sketch is open", async () => {
    useUiStore().sketchActive = true;
    const w = await render();
    expect(w.find("#workspace-toggle").exists()).toBe(false);
  });
});
