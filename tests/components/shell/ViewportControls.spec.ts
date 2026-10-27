import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import ViewportControls from "../../../src/components/shell/ViewportControls.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { resetPathTracedOverride, type RenderTier } from "../../../src/ui/viewMode";

enableAutoUnmount(afterEach);

beforeEach(() => {
  setActivePinia(createPinia());
  resetPathTracedOverride();
});

async function render(renderTier: RenderTier) {
  const handleAction = vi.fn();
  const engine = {
    canvas: document.createElement("canvas"),
    handleAction,
    viewport: {
      renderTier,
      projection: "persp",
      onRenderTierChange: () => () => {},
      setViewCubeInset: () => {},
    },
    store: { buildState: {}, fileName: "Untitled", dirty: false },
    bridge: { buildVersion: ref(0), metaVersion: ref(0) },
  } as unknown as Engine;
  const w = mount(ViewportControls, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return { w, handleAction };
}

describe("ViewportControls Path traced button", () => {
  it("stays greyed but answers a click when a low powered computer soft blocks it", async () => {
    const { w, handleAction } = await render({ lowPower: true, auto: false, webgpu: true });
    const btn = w.get('[data-view-mode="pathtraced"]');
    await btn.trigger("click");
    expect([btn.attributes("aria-disabled"), btn.classes("is-disabled"), handleAction.mock.calls]).toEqual([
      "true",
      true,
      [["viewmode-pathtraced"]],
    ]);
  });

  it("swallows a click when the GPU cannot trace at all", async () => {
    const { w, handleAction } = await render({
      lowPower: false,
      auto: false,
      webgpu: false,
      native: { available: false },
    });
    const btn = w.get('[data-view-mode="pathtraced"]');
    await btn.trigger("click");
    expect([btn.attributes("aria-disabled"), btn.classes("is-disabled"), handleAction.mock.calls]).toEqual([
      "true",
      true,
      [],
    ]);
  });
});
