import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

const invoke = vi.fn(async (..._a: unknown[]): Promise<unknown> => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

// happy-dom has no WebGL, and the test cube is not what these cases are about.
vi.mock("three", async (importOriginal) => ({
  ...(await importOriginal<typeof import("three")>()),
  WebGLRenderer: class {
    setPixelRatio() {}
    setSize() {}
    render() {}
    forceContextLoss() {}
    dispose() {}
  },
}));

import SpaceMouseSection from "../../../plugins/FundaCAD.SpaceMouse/SpaceMouseSection.vue";

const HINT =
  "start spacenavd on this computer, or grant the device with: flatpak override --user --device=all dev.fundacad.app";

enableAutoUnmount(afterEach);
afterEach(() => invoke.mockReset());

describe("the 3D mouse settings in the Flatpak", () => {
  it("say how to reach the device when the app runs as a Flatpak", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "spacemouse_flatpak_hint" ? HINT : null));
    const w = mount(SpaceMouseSection);
    await flushPromises();
    const line = w.find('[data-testid="spacemouse-flatpak-hint"]');
    expect(line.exists()).toBe(true);
    expect(line.text()).toContain("Flatpak");
    expect(line.text()).toContain("flatpak override --user --device=all dev.fundacad.app");
  });

  it("say nothing about it anywhere else", async () => {
    invoke.mockImplementation(async () => null);
    const w = mount(SpaceMouseSection);
    await flushPromises();
    expect(w.find('[data-testid="spacemouse-flatpak-hint"]').exists()).toBe(false);
  });

  it("say nothing when the app cannot be asked, as in a plain browser", async () => {
    invoke.mockImplementation(async () => {
      throw new TypeError("no Tauri");
    });
    const w = mount(SpaceMouseSection);
    await flushPromises();
    expect(w.find('[data-testid="spacemouse-flatpak-hint"]').exists()).toBe(false);
  });
});
