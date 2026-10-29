import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import NormalToSketch from "../../../src/components/shell/NormalToSketch.vue";
import { useSketchPaletteStore } from "../../../src/stores/sketchPalette";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));

describe("Normal to Sketch", () => {
  it("shows only while a sketch is open and the view is off its plane, and squares the view on a click", async () => {
    const palette = useSketchPaletteStore();
    const lookAt = vi.spyOn(palette, "lookAt").mockImplementation(() => {});
    const w = mount(NormalToSketch, { attachTo: document.body });
    expect(w.find('[data-testid="normal-to-sketch"]').exists()).toBe(false);
    palette.visible = true;
    palette.offNormal = true;
    await nextTick();
    const b = w.get('[data-testid="normal-to-sketch"]');
    expect([b.attributes("type"), b.attributes("title"), b.text()]).toEqual([
      "button",
      "Square the view to the sketch plane",
      "Normal to Sketch",
    ]);
    await new Promise((r) => setTimeout(r, 2));
    await b.trigger("click");
    expect(lookAt).toHaveBeenCalledTimes(1);
  });
});
