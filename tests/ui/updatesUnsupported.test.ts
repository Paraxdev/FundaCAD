import { afterEach, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => false }));
vi.mock("../../src/ui/toast", () => ({
  toast: (t: string) => {
    toasts.push(t);
  },
}));
vi.mock("../../src/ui/choice", () => ({ choose: async () => null }));

import { checkForUpdates } from "../../src/ui/updates";

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

// The .deb, .rpm and Flatpak come from the releases page, not from a package
// repository, so no package manager ever offers the next build.
it("tells a .deb, .rpm or Flatpak install where its update comes from", async () => {
  (globalThis as Record<string, unknown>).window = { __TAURI_INTERNALS__: {} };
  await checkForUpdates(true);
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).not.toMatch(/package manager/);
  expect(toasts[0]).toMatch(/releases page/);
});
