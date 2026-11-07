import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DescribeModelDialog from "../../../src/components/overlays/DescribeModelDialog.vue";
import { useDialogStore } from "../../../src/stores/dialogs";
import { descriptionText, type ModelDescription } from "../../../src/ui/modelDescription";
import { announce } from "../../../src/ui/announce";

vi.mock(import("../../../src/ui/announce"), async (orig) => ({ ...(await orig()), announce: vi.fn() }));

enableAutoUnmount(afterEach);

const description: ModelDescription = {
  title: "Model description",
  sections: [
    { heading: "Overview", ordered: false, items: ["File: plate.funda", "1 body, 2 features"] },
    { heading: "Bodies", ordered: false, items: ["Plate: 40 × 30 × 20 mm, center at 0, 0, 10 mm"] },
    { heading: "Features", ordered: true, items: ["Sketch 1", "Extrude 1"] },
  ],
};

const writeText = vi.fn<(text: string) => Promise<void>>();
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(announce).mockClear();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  useDialogStore().describeModel = description;
  mount(DescribeModelDialog, { attachTo: document.body });
});

const dialog = () => document.querySelector<HTMLElement>("[role=dialog]")!;
const button = (name: string) =>
  [...dialog().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name)!;

describe("DescribeModelDialog", () => {
  it("is a dialog named Model description", () => {
    const id = dialog().getAttribute("aria-labelledby")!;
    expect(document.getElementById(id)?.textContent?.trim()).toBe("Model description");
  });

  it("gives each section a heading under the title and its lines as a list", () => {
    const heads = [...dialog().querySelectorAll("h3")].map((h) => h.textContent?.trim());
    expect(heads).toEqual(["Overview", "Bodies", "Features"]);
    const lists = [...dialog().querySelectorAll("ul, ol")];
    expect(lists.map((l) => l.tagName)).toEqual(["UL", "UL", "OL"]);
    expect([...lists[1]!.querySelectorAll("li")].map((li) => li.textContent?.trim())).toEqual([
      "Plate: 40 × 30 × 20 mm, center at 0, 0, 10 mm",
    ]);
  });

  it("labels each list by its heading", () => {
    for (const list of dialog().querySelectorAll("ul, ol")) {
      const head = document.getElementById(list.getAttribute("aria-labelledby")!);
      expect(head?.tagName).toBe("H3");
    }
  });

  it("copies the same text the dialog shows and says so", async () => {
    button("Copy as text").click();
    await settle();
    expect(writeText).toHaveBeenCalledWith(descriptionText(description));
    expect(vi.mocked(announce)).toHaveBeenCalledWith("Copied the model description");
  });

  it("says when the clipboard refused the copy", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    button("Copy as text").click();
    await settle();
    expect(vi.mocked(announce).mock.calls[0]).toEqual([
      "Could not reach the clipboard, select the text in the dialog and copy it",
      "assertive",
    ]);
  });

  it("closes on Close", async () => {
    button("Close").click();
    await nextTick();
    expect(useDialogStore().describeModel).toBeNull();
  });
});
