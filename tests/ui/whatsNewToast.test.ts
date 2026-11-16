// The toast that follows an update reads in the chosen language, its button too.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const toasts = vi.hoisted(() => [] as { message: string; label: string | undefined }[]);
vi.mock("../../src/ui/toast", () => ({
  toast: (message: string, opts?: { action?: { label: string } }) =>
    toasts.push({ message, label: opts?.action?.label }),
}));
vi.mock("../../src/io/recentFiles", () => ({ getRecentFiles: () => [{ name: "a" }] }));
vi.mock("../../src/ui/updates", () => ({ appVersion: async () => "1.0.0" }));

import { setLanguage } from "../../src/i18n";
import { startWhatsNew } from "../../src/ui/whatsNew";

beforeEach(() => {
  setActivePinia(createPinia());
  toasts.length = 0;
});
afterEach(() => setLanguage("system"));

const home = { isOpen: () => false, open: () => {} };

describe("the update toast", () => {
  it("reads English by default", async () => {
    await startWhatsNew(home, false);
    expect(toasts).toEqual([{ message: "FundaCAD was updated.", label: "What's new" }]);
  });

  it("reads German once picked", async () => {
    await setLanguage("de");
    await startWhatsNew(home, false);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).not.toBe("FundaCAD was updated.");
    expect(toasts[0]!.message).toContain("FundaCAD");
    expect(toasts[0]!.label).not.toBe("What's new");
  });
});
