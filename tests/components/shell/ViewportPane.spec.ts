import { afterEach, beforeEach, expect, it } from "vitest";
import { enableAutoUnmount, shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, nextTick, ref } from "vue";
import ViewportPane from "../../../src/components/shell/ViewportPane.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";

enableAutoUnmount(afterEach);

beforeEach(() => setActivePinia(createPinia()));

it("the inert App gives the pane under Home lands on #viewport, and goes again once Home closes", async () => {
  const homeShown = ref(true);
  const engine = { canvas: document.createElement("canvas") } as unknown as Engine;
  const App = defineComponent(() => () => h(ViewportPane, { inert: homeShown.value }));
  shallowMount(App, {
    attachTo: document.body,
    global: { provide: { [ENGINE]: engine }, stubs: { ViewportPane: false } },
  });
  const pane = document.getElementById("viewport")!;
  expect(pane.inert).toBe(true);
  homeShown.value = false;
  await nextTick();
  expect(pane.inert).toBe(false);
});
