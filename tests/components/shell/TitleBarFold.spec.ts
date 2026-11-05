// Under TITLEBAR_FOLD_PX the CSS hides the document name and the workspace toggle, and the File menu carries both.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { useUiStore } from "../../../src/stores/ui";
import { setWorkspace, workspace } from "../../../src/ui/workspace";
import { TITLEBAR_FOLD_QUERY } from "../../../src/ui/layoutBreakpoints";
import TitleBar from "../../../src/components/shell/TitleBar.vue";

vi.mock("../../../src/app/menubarDef", () => ({
  buildMenubar: () => [
    { label: "File", items: [{ label: "Home", onClick: () => {} }] },
    { label: "Edit", items: [{ label: "Undo", onClick: () => {} }] },
  ],
}));

enableAutoUnmount(afterEach);

let narrow = false;
const changes = new Set<(e: { matches: boolean }) => void>();
function stubWindow(): void {
  vi.stubGlobal("matchMedia", (q: string) => ({
    get matches() {
      return q === TITLEBAR_FOLD_QUERY && narrow;
    },
    media: q,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => changes.add(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => changes.delete(fn),
  }));
}
function resize(toNarrow: boolean): void {
  narrow = toNarrow;
  for (const fn of changes) fn({ matches: toNarrow });
}

function makeEngine() {
  const live = { snapshot: { sharing: false, guests: [] }, subscribe: () => () => {} };
  return { live, ui: { home: { toggle: vi.fn() } }, doUndo: vi.fn(), doRedo: vi.fn() } as unknown as Engine;
}

const popup = () => document.body.querySelector<HTMLElement>(".ui-menu");
const rows = () =>
  [...(popup()?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])].map((r) => [
    r.querySelector(".ui-menu-label")?.textContent,
    r.getAttribute("aria-checked"),
  ]);

async function openMenu(label: string) {
  const w = mount(TitleBar, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: makeEngine() } } });
  const btn = w.findAll(".menu-btn").find((b) => b.text() === label)!;
  await btn.trigger("click");
  await nextTick();
  return w;
}

describe("the title bar folded into the File menu", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
    narrow = false;
    changes.clear();
    stubWindow();
  });
  afterEach(() => {
    setWorkspace("model");
    vi.unstubAllGlobals();
  });

  it("leaves the File menu alone while the title bar has room", async () => {
    await openMenu("File");
    expect(popup()?.getAttribute("aria-label")).toBe("File");
    expect(popup()?.querySelector(".tb-fold-doc")).toBeNull();
    expect(rows()).toEqual([["Home", null]]);
  });

  it("names the document and its unsaved state, and offers both workspaces as checks", async () => {
    narrow = true;
    const ui = useUiStore();
    ui.docName = "bracket.funda";
    ui.dirty = true;
    await openMenu("File");
    const doc = popup()!.querySelector<HTMLElement>(".tb-fold-doc")!;
    expect(doc.textContent?.trim()).toBe("bracket.funda*");
    // For the eye: a screen reader has the name and its state from the window title (unsavedGuard.ts).
    expect(doc.getAttribute("aria-hidden")).toBe("true");
    // The harness names a menu ref by the menu's name, so the name never carries the document.
    expect(popup()?.getAttribute("aria-label")).toBe("File");
    expect(rows()).toEqual([
      ["Model Workspace", "true"],
      ["Render Workspace", "false"],
      ["Home", null],
    ]);
  });

  it("switches the workspace from the menu and closes it", async () => {
    narrow = true;
    await openMenu("File");
    const render = [...popup()!.querySelectorAll<HTMLElement>("[role=menuitemcheckbox]")].find((r) =>
      r.textContent?.includes("Render"),
    )!;
    render.click();
    await nextTick();
    expect(workspace()).toBe("render");
    expect(popup()).toBeNull();
  });

  it("drops the workspace rows while a sketch is open, as the toggle hides", async () => {
    narrow = true;
    const ui = useUiStore();
    ui.sketchActive = true;
    await openMenu("File");
    expect(popup()?.querySelector(".tb-fold-doc")?.textContent?.trim()).toBe("Untitled");
    expect(rows()).toEqual([["Home", null]]);
  });

  it("keeps the other menus as they are", async () => {
    narrow = true;
    await openMenu("Edit");
    expect(popup()?.getAttribute("aria-label")).toBe("Edit");
    expect(rows()).toEqual([["Undo", null]]);
  });

  it("follows the window across the breakpoint", async () => {
    const w = await openMenu("File");
    expect(popup()?.querySelector(".tb-fold-doc")).toBeNull();
    await w.get(".menu-btn").trigger("click");
    resize(true);
    await w.get(".menu-btn").trigger("click");
    await nextTick();
    expect(popup()?.querySelector(".tb-fold-doc")).not.toBeNull();
  });
});
