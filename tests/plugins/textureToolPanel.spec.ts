// The Texture plugin's panel: its VIEW, in the sense the contribution table
// means. Which rows a kind/profile shows is tested purely in textureForm.test.ts;
// this covers the wiring, and three behaviours that exist because their opposite
// was a bug:
//
//   * it is mounted for the whole life of the plugin and draws nothing until the
//     tool opens it. App.vue used to carry a `v-if` for this panel, which was the
//     application knowing this tool exists;
//
//   * commit does NOT close the panel, the tool refuses a commit with no target
//     and stays active, and closing first stranded the user in an invisible
//     modal (panel gone, tool still owning face-picking, toolBusy() blocking
//     every Esc handler);
//   * the summary line is separate from the form, so refreshing it on every rAF
//     tick cannot re-render the fields and steal focus from one being typed in.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import TextureToolPanel from "../../plugins/FundaCAD.Texture/TextureToolPanel.vue";
import * as panel from "../../plugins/FundaCAD.Texture/panel";
import type { TextureMode, TextureValues } from "../../plugins/FundaCAD.Texture/textureForm";
import { setLanguage } from "../../src/i18n";

enableAutoUnmount(afterEach);

/** Mount the overlay the way the application does: once, with no props and no
 *  condition on it. Everything after this goes through the plugin's own state,
 *  which is the arrangement under test. */
function mountPanel() {
  return mount(TextureToolPanel, { attachTo: document.body });
}

function open(opts: Partial<Parameters<typeof panel.show>[0]> = {}) {
  const handlers = {
    onCommit: vi.fn<(v: TextureValues) => void>(),
    onCancel: vi.fn(),
    onChange: vi.fn<(v: TextureValues) => void>(),
    onModeChange: vi.fn<(m: TextureMode) => void>(),
  };
  const wrapper = mountPanel();
  panel.show({ editing: false, mode: "faces", summary: "2 faces", initial: {}, ...opts }, handlers);
  return { handlers, wrapper };
}

const visible = (el: HTMLElement | null) => !!el && el.style.display !== "none";
const rowOf = (labelText: string) =>
  [...document.querySelectorAll<HTMLElement>("label")].find((l) => l.textContent === labelText)?.parentElement ?? null;

// A base Select draws its list only while open, so a pick is a click on the trigger and then on the option.
const trigger = (labelText: string) =>
  [...document.querySelectorAll<HTMLElement>("[role=combobox]")].find((el) =>
    (el.getAttribute("aria-label") ?? "").startsWith(`${labelText},`),
  )!;
const optionTexts = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim() ?? "");
async function pickOption(labelText: string, option: string) {
  trigger(labelText).click();
  await flushPromises();
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes(option))!.click();
  await flushPromises();
}

describe("TextureToolPanel", () => {
  beforeEach(() => {
    panel.resetPanel();
    document.body.innerHTML = "";
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    panel.resetPanel();
    vi.unstubAllGlobals();
  });

  // The whole of what "a contributed overlay decides its own visibility" means.
  // Mounted, and drawing nothing, because the tool is not running.
  it("draws nothing until the tool opens it", async () => {
    mountPanel();
    await nextTick();
    expect(document.body.textContent).not.toContain("Texture");
    expect(panel.isOpen()).toBe(false);

    panel.show(
      { editing: false, mode: "faces", summary: "2 faces", initial: {} },
      {
        onCommit: vi.fn(),
        onCancel: vi.fn(),
        onChange: vi.fn(),
        onModeChange: vi.fn(),
      },
    );
    await nextTick();
    expect(document.body.textContent).toContain("2 faces");
  });

  it("opens through the plugin\'s own state, not one of the app\'s stores", async () => {
    open();
    await nextTick();
    expect(panel.isOpen()).toBe(true);
  });

  it("labels the commit button for the flow it is in", async () => {
    const first = open({ editing: true });
    await nextTick();
    expect(document.body.textContent).toContain("Apply");
    panel.resetPanel();
    first.wrapper.unmount();
    open({ editing: false });
    await nextTick();
    expect(document.body.textContent).toContain("Add");
  });

  // A permanently mounted overlay has no `:key` to remount it, so re-opening
  // has to reseed the form explicitly. Without this the second run of the tool
  // shows the values from the first.
  it("reseeds the form when the tool re-opens it", async () => {
    open({ initial: { depth: 0.4 } });
    await nextTick();
    const depth = () => document.querySelector<HTMLInputElement>("input[inputmode=decimal]")!;
    expect(depth().value).toBe("0.4");

    depth().value = "9";
    depth().dispatchEvent(new Event("input"));
    await nextTick();
    expect(depth().value).toBe("9");

    panel.hide();
    await nextTick();
    panel.show(
      { editing: false, mode: "faces", summary: "", initial: { depth: 2.5 } },
      {
        onCommit: vi.fn(),
        onCancel: vi.fn(),
        onChange: vi.fn(),
        onModeChange: vi.fn(),
      },
    );
    await nextTick();
    expect(depth().value).toBe("2.5");
  });

  it("shows the live summary and refreshes it without touching the form", async () => {
    open({ summary: "2 faces" });
    await nextTick();
    expect(document.body.textContent).toContain("2 faces");

    const depth = document.querySelector<HTMLInputElement>("input[inputmode=decimal]")!;
    depth.value = "9";
    depth.dispatchEvent(new Event("input"));
    await nextTick();

    panel.summary.value = "5 faces";
    await nextTick();
    expect(document.body.textContent).toContain("5 faces");
    expect(depth.value).toBe("9"); // the field being typed into is untouched
  });

  it("switches mode from a button and reflects a mode set by the tool", async () => {
    const { handlers } = open({ mode: "faces" });
    await nextTick();
    const [faces, body] = [...document.querySelectorAll<HTMLElement>("[role=radio]")];
    expect(faces!.textContent).toBe("Faces");
    expect(faces!.getAttribute("aria-checked")).toBe("true");

    body!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(handlers.onModeChange).toHaveBeenCalledWith("body");
    expect(panel.mode.value).toBe("body");
    expect(body!.getAttribute("aria-checked")).toBe("true");

    panel.mode.value = "faces";
    await nextTick();
    expect(document.querySelectorAll("[role=radio]")[0]!.getAttribute("aria-checked")).toBe("true");
  });

  it("hides the rows the chosen kind has no use for", async () => {
    open({ initial: { kind: "knurl", profile: "round" } });
    await nextTick();
    expect(visible(rowOf("Angle"))).toBe(true);
    expect(visible(rowOf("Seed"))).toBe(false);

    await pickOption("Kind", "Voronoi");
    expect(visible(rowOf("Angle"))).toBe(false);
    expect(visible(rowOf("Seed"))).toBe(true);
    // Direction is not gated on kind: every kind honours it, and gating it left
    // noise/voronoi/image able only to grow the part.
    expect(visible(rowOf("Direction"))).toBe(true);
  });

  it("hides the print-colour row when the document has no palette", async () => {
    open({ palette: [] });
    await nextTick();
    expect(visible(rowOf("Print color"))).toBe(false);
  });

  it("offers one option per palette slot when there is one", async () => {
    open({
      palette: [
        { name: "Black", color: "#000" },
        { name: "Red", color: "#f00" },
      ],
    });
    await nextTick();
    expect(visible(rowOf("Print color"))).toBe(true);
    trigger("Print color").click();
    await flushPromises();
    expect(optionTexts()).toEqual(["Body color", "Black (slot 1)", "Red (slot 2)"]);
  });

  it("fires the live preview on an edit", async () => {
    const { handlers } = open();
    await nextTick();
    const depth = document.querySelector<HTMLInputElement>("input[inputmode=decimal]")!;
    depth.value = "1.5";
    depth.dispatchEvent(new Event("input"));
    await nextTick();
    expect(handlers.onChange.mock.lastCall![0].depth).toBe(1.5);
  });

  it("keeps a typed 0,125 in German, which the form holds in the language's spelling", async () => {
    await setLanguage("de");
    try {
      const { handlers } = open();
      await nextTick();
      const depth = document.querySelector<HTMLInputElement>("input[inputmode=decimal]")!;
      depth.value = "0,125";
      depth.dispatchEvent(new Event("input"));
      await nextTick();
      expect(handlers.onChange.mock.lastCall![0].depth).toBe(0.125);
    } finally {
      await setLanguage("system");
    }
  });

  it("commits WITHOUT closing, the tool may refuse and stay active", async () => {
    const { handlers } = open();
    await nextTick();
    const ok = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent!.includes("Add"))!;
    ok.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(handlers.onCommit).toHaveBeenCalledOnce();
    expect(panel.isOpen()).toBe(true);
  });

  it("cancels and closes on Cancel", async () => {
    const { handlers } = open();
    await nextTick();
    const no = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent!.includes("Cancel"),
    )!;
    no.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(handlers.onCancel).toHaveBeenCalledOnce();
    expect(panel.isOpen()).toBe(false);
  });

  // TextureTool owns Escape for its whole active lifetime, which starts before
  // this panel is open and must outlast a refused commit.
  it("does not handle Escape itself", async () => {
    const { handlers } = open();
    await nextTick();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });
});
