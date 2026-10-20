// Contracts carried over from the welcome screen: `.modal-close` is what the e2e
// scripts click to dismiss the startup screen (a missing one hangs them), names
// are escaped once, no remote content, the modal gate lasts exactly the mount.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useModalStore } from "../../../src/stores/modals";
import { useHomeStore } from "../../../src/stores/home";
import { choose } from "../../../src/ui/choice";
import type { HomeCallbacks } from "../../../src/ui/home";
import type { OpenOutcome } from "../../../src/io/files";
import { setLibrary, type DocumentLibrary, type FileStat } from "../../../src/io/library";
import ContextMenuHost from "../../../src/components/overlays/ContextMenuHost.vue";
import HomeScreen from "../../../src/components/home/HomeScreen.vue";
import ModalHost from "../../../src/components/overlays/ModalHost.vue";

enableAutoUnmount(afterEach);

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const key = (k: string, init: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));

function callbacks(over: Partial<HomeCallbacks> = {}): HomeCallbacks {
  return {
    newDocument: vi.fn(async () => {}),
    openDoc: vi.fn(async () => {}),
    newFromTemplate: vi.fn(async () => {}),
    openPath: vi.fn(async () => "ok" as const),
    currentPath: () => null,
    ...over,
  };
}

/** Every path exists unless listed in `missing`, edited at `mtime`, its picture named after it. */
function fakeLibrary(missing: string[] = [], mtime = 0): DocumentLibrary {
  return {
    stat: vi.fn(async (paths: string[]): Promise<FileStat[]> =>
      paths.map((path) => missing.includes(path)
        ? { path, exists: false, mtimeMs: null, size: null }
        : { path, exists: true, mtimeMs: mtime || null, size: 1 })),
    thumbs: vi.fn(async (paths: string[]) => paths.map((p) => `data:image/jpeg;base64,${btoa(p)}`)),
    putThumb: vi.fn(async () => {}),
  };
}

function open(
  recents: { path: string; openedAt: number }[] = [],
  over: Partial<HomeCallbacks> = {},
  lib: DocumentLibrary | null = fakeLibrary(),
) {
  setLibrary(lib);
  // The pre-rename key: a list written by an older build has to keep showing up.
  localStorage.setItem("sindri.recentFiles", JSON.stringify(recents));
  const cb = callbacks(over);
  const home = useHomeStore();
  home.bind(cb);
  home.visible = true;
  const w = mount(HomeScreen, { attachTo: document.body });
  return { w, cb, home };
}

describe("HomeScreen", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("keeps the .modal-close button the e2e scripts click", () => {
    open();
    expect($(".modal-close")?.getAttribute("aria-label")).toBe("Back to the document");
  });

  it("shows a card per recent document, the name escaped once", () => {
    open([
      { path: "C:/work/Bracket & Plate.sindri", openedAt: 2 },
      { path: "C:/work/gear.funda", openedAt: 1 },
    ]);
    const names = $$(".home-card-name");
    expect(names.map((n) => n.textContent)).toEqual(["Bracket & Plate", "gear"]);
    expect(names[0]!.innerHTML).not.toContain("&amp;amp;");
    expect($(".home-card")!.getAttribute("title")).toBe("C:/work/Bracket & Plate.sindri");
  });

  it("says where recent documents are in the browser build", () => {
    open([{ path: "C:/a.funda", openedAt: 1 }], {}, null);
    expect($$(".home-card")).toHaveLength(0);
    expect($(".home-empty")!.textContent).toContain("desktop app");
  });

  it("embeds no remote content", () => {
    open();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("gates global shortcuts for exactly its own lifetime", async () => {
    const { w } = open();
    expect(useModalStore().depth).toBe(1);
    w.unmount();
    await nextTick();
    expect(useModalStore().depth).toBe(0);
  });

  it("closes on Escape and on the close button", async () => {
    const { home } = open();
    key("Escape");
    expect(home.visible).toBe(false);
    home.visible = true;
    $(".modal-close")!.click();
    expect(home.visible).toBe(false);
  });

  it("leaves Escape to a choice raised over it", async () => {
    const { home } = open();
    mount(ModalHost, { attachTo: document.body });
    const picked = choose("Discard unsaved changes?", [{ value: "discard", label: "Discard" }]);
    await nextTick();
    key("Escape");
    expect(await picked).toBeNull();
    expect(home.visible).toBe(true);
  });

  it("swallows undo so the hidden document is not changed", () => {
    open();
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    key("z", { ctrlKey: true });
    key("y", { ctrlKey: true });
    key("k", { ctrlKey: true });
    window.removeEventListener("keydown", seen);
    expect(seen.mock.calls.map(([e]) => (e as KeyboardEvent).key)).toEqual(["k"]);
  });

  it("opens a card through openPath", async () => {
    const { cb } = open([{ path: "C:/a.funda", openedAt: 1 }]);
    $(".home-card")!.click();
    await flushPromises();
    expect(cb.openPath).toHaveBeenCalledWith("C:/a.funda");
  });

  it("just closes on the card of the document already open", async () => {
    const { cb, home } = open([{ path: "C:/a.funda", openedAt: 1 }], { currentPath: () => "C:/a.funda" });
    expect($(".home-badge")!.textContent).toBe("Open");
    $(".home-card")!.click();
    await flushPromises();
    expect(cb.openPath).not.toHaveBeenCalled();
    expect(home.visible).toBe(false);
  });

  it("keeps a card that could not be read, with a badge", async () => {
    open(
      [{ path: "C:/a.funda", openedAt: 2 }, { path: "C:/b.funda", openedAt: 1 }],
      { openPath: vi.fn(async (p: string): Promise<OpenOutcome> => (p === "C:/a.funda" ? "unreadable" : "newerFormat")) },
    );
    for (const c of $$(".home-card")) c.click();
    await flushPromises();
    expect($$(".home-card")).toHaveLength(2);
    expect($$(".home-badge").map((b) => b.textContent)).toEqual(["Could not be read"]);
    expect(JSON.parse(localStorage.getItem("fundacad.recentFiles") ?? localStorage.getItem("sindri.recentFiles")!)).toHaveLength(2);
  });

  it("starts a blank document and opens the file dialog", async () => {
    const { cb } = open();
    $(".home-new-blank")!.click();
    $(".home-open")!.click();
    await flushPromises();
    expect(cb.newDocument).toHaveBeenCalledOnce();
    expect(cb.openDoc).toHaveBeenCalledOnce();
  });

  it("remembers the show on startup choice", async () => {
    open();
    const box = document.querySelector<HTMLInputElement>(".home-startup input")!;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    expect(localStorage.getItem("fundacad.welcomeOnStartup")).toBe("false");
  });

  it("shows the last edit and marks a missing file", async () => {
    const now = Date.now();
    open([{ path: "C:/a.funda", openedAt: 2 }, { path: "C:/gone.funda", openedAt: 1 }], {}, fakeLibrary(["C:/gone.funda"], now - 5 * 60_000));
    await flushPromises();
    expect($$(".home-card-time").map((t) => t.textContent)).toEqual(["Edited 5 min ago", expect.stringMatching(/^Opened /)]);
    expect($$(".home-card.missing")).toHaveLength(1);
    expect($$(".home-badge").map((b) => b.textContent)).toEqual(["Not found"]);
  });

  it("asks before taking a missing file off the list", async () => {
    const { cb } = open([{ path: "C:/gone.funda", openedAt: 1 }], {}, fakeLibrary(["C:/gone.funda"]));
    mount(ModalHost, { attachTo: document.body });
    await flushPromises();
    $(".home-card")!.click();
    await flushPromises();
    expect(document.body.textContent).toContain("gone was not found.");
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Cancel"))!.click();
    await flushPromises();
    expect($$(".home-card")).toHaveLength(1);
    $(".home-card")!.click();
    await flushPromises();
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Remove from list"))!.click();
    await flushPromises();
    expect($$(".home-card")).toHaveLength(0);
    expect(cb.openPath).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("fundacad.recentFiles")!)).toEqual([]);
  });

  it("removes a card from its right click menu", async () => {
    open([{ path: "C:/a.funda", openedAt: 2 }, { path: "C:/b.funda", openedAt: 1 }]);
    mount(ContextMenuHost, { attachTo: document.body });
    await flushPromises();
    $(".home-card")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await nextTick();
    const rows = [...document.querySelectorAll<HTMLElement>(".ctx-menu button, .ctx-item")];
    expect(rows.map((r) => r.textContent?.trim())).toEqual(expect.arrayContaining(["Open", "Remove from list", "Copy path"]));
    rows.find((r) => r.textContent?.trim() === "Remove from list")!.click();
    await flushPromises();
    expect($$(".home-card-name").map((n) => n.textContent)).toEqual(["b"]);
  });

  it("filters the cards as you type and says when nothing matches", async () => {
    open([{ path: "C:/work/bracket.funda", openedAt: 2 }, { path: "C:/work/gear.funda", openedAt: 1 }]);
    await flushPromises();
    const field = document.querySelector<HTMLInputElement>(".home-search")!;
    field.value = "gea";
    field.dispatchEvent(new Event("input"));
    await nextTick();
    expect($$(".home-card-name").map((n) => n.textContent)).toEqual(["gear"]);
    field.value = "nothing";
    field.dispatchEvent(new Event("input"));
    await nextTick();
    expect($(".home-empty")!.textContent).toBe("No documents match");
  });

  it("sorts and remembers the order", async () => {
    open([{ path: "C:/b.funda", openedAt: 2 }, { path: "C:/a.funda", openedAt: 1 }]);
    await flushPromises();
    const sort = document.querySelector<HTMLSelectElement>(".home-sort")!;
    sort.value = "name";
    sort.dispatchEvent(new Event("change"));
    await nextTick();
    expect($$(".home-card-name").map((n) => n.textContent)).toEqual(["a", "b"]);
    expect(localStorage.getItem("fundacad.home.sort")).toBe("name");
  });

  it("takes Ctrl+F for its search field instead of passing it on", () => {
    open([{ path: "C:/a.funda", openedAt: 1 }]);
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    key("f", { ctrlKey: true });
    window.removeEventListener("keydown", seen);
    expect(seen).not.toHaveBeenCalled();
    expect(document.activeElement).toBe($(".home-search"));
  });

  it("lets undo work inside the search field", () => {
    open([{ path: "C:/a.funda", openedAt: 1 }]);
    const field = $(".home-search")!;
    field.focus();
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    window.removeEventListener("keydown", seen);
    expect(seen).toHaveBeenCalledOnce();
  });

  it("starts a document from a template card", async () => {
    const { cb } = open();
    const cards = $$(".home-new-template");
    expect(cards.map((c) => c.querySelector(".home-new-name")!.textContent)).toEqual(["Plate", "Wall bracket", "Pinned lever"]);
    cards[1]!.click();
    await flushPromises();
    expect(cb.newFromTemplate).toHaveBeenCalledWith("wall-bracket");
  });

  it("loads a card's picture only once the card is in view", async () => {
    const watched = new Map<Element, (e: { isIntersecting: boolean }[]) => void>();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
      observe(el: Element) { watched.set(el, this.cb); }
      disconnect() {}
    });
    try {
      const lib = fakeLibrary([], 5000);
      open([{ path: "C:/w/a.funda", openedAt: 2 }, { path: "C:/w/b.funda", openedAt: 1 }], {}, lib);
      await flushPromises();
      expect(lib.thumbs).not.toHaveBeenCalled();
      expect($(".home-card-pic img")).toBeNull();
      const [first] = $$(".home-card");
      watched.get(first!)!([{ isIntersecting: true }]);
      await flushPromises();
      expect(lib.thumbs).toHaveBeenCalledWith(["C:/w/a.funda"]);
      const imgs = $$(".home-card-pic img");
      expect(imgs.length).toBe(1);
      expect(imgs[0]!.getAttribute("src")).toBe(`data:image/jpeg;base64,${btoa("C:/w/a.funda")}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
