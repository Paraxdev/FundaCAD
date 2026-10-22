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
import {
  setLibrary,
  type DocumentLibrary,
  type DocSummary,
  type FileStat,
  type FolderListing,
} from "../../../src/io/library";
import { saveFolder, setSaveFolder } from "../../../src/io/saveFolder";
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
    currentVersions: () => null,
    openVersion: vi.fn(async () => true),
    openBranch: vi.fn(async () => true),
    ...over,
  };
}

/** Every path exists unless listed in `missing`, edited at `mtime`, its picture named after it.
 *  `folders` are the listings, `picks` what the folder dialog hands out. */
function fakeLibrary(
  missing: string[] = [],
  mtime = 0,
  folders: Record<string, FolderListing> = {},
  picks: string[] = [],
  summaries: Record<string, DocSummary | null> = {},
): DocumentLibrary {
  return {
    summary: vi.fn(async (path: string) => {
      if (!(path in summaries)) throw new Error("unreadable");
      return summaries[path]!;
    }),
    list: vi.fn(async (dir: string) => {
      const l = folders[dir];
      if (!l) throw new Error("not found");
      return l;
    }),
    pickFolder: vi.fn(async () => picks.shift() ?? null),
    stat: vi.fn(async (paths: string[]): Promise<FileStat[]> =>
      paths.map((path) =>
        missing.includes(path)
          ? { path, exists: false, mtimeMs: null, size: null }
          : { path, exists: true, mtimeMs: mtime || null, size: 1 },
      ),
    ),
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
      [
        { path: "C:/a.funda", openedAt: 2 },
        { path: "C:/b.funda", openedAt: 1 },
      ],
      {
        openPath: vi.fn(async (p: string): Promise<OpenOutcome> => (p === "C:/a.funda" ? "unreadable" : "newerFormat")),
      },
    );
    for (const c of $$(".home-card")) c.click();
    await flushPromises();
    expect($$(".home-card")).toHaveLength(2);
    expect($$(".home-badge").map((b) => b.textContent)).toEqual(["Could not be read"]);
    expect(
      JSON.parse(localStorage.getItem("fundacad.recentFiles") ?? localStorage.getItem("sindri.recentFiles")!),
    ).toHaveLength(2);
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
    open(
      [
        { path: "C:/a.funda", openedAt: 2 },
        { path: "C:/gone.funda", openedAt: 1 },
      ],
      {},
      fakeLibrary(["C:/gone.funda"], now - 5 * 60_000),
    );
    await flushPromises();
    expect($$(".home-card-time").map((t) => t.textContent)).toEqual([
      "Edited 5 min ago",
      expect.stringMatching(/^Opened /),
    ]);
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
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent?.includes("Remove from list"))!
      .click();
    await flushPromises();
    expect($$(".home-card")).toHaveLength(0);
    expect(cb.openPath).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("fundacad.recentFiles")!)).toEqual([]);
  });

  it("removes a card from its right click menu", async () => {
    open([
      { path: "C:/a.funda", openedAt: 2 },
      { path: "C:/b.funda", openedAt: 1 },
    ]);
    mount(ContextMenuHost, { attachTo: document.body });
    await flushPromises();
    $(".home-card")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    await nextTick();
    const rows = [...document.querySelectorAll<HTMLElement>(".ctx-menu button, .ctx-item")];
    expect(rows.map((r) => r.textContent?.trim())).toEqual(
      expect.arrayContaining(["Open", "Remove from list", "Copy path"]),
    );
    rows.find((r) => r.textContent?.trim() === "Remove from list")!.click();
    await flushPromises();
    expect($$(".home-card-name").map((n) => n.textContent)).toEqual(["b"]);
  });

  it("filters the cards as you type and says when nothing matches", async () => {
    open([
      { path: "C:/work/bracket.funda", openedAt: 2 },
      { path: "C:/work/gear.funda", openedAt: 1 },
    ]);
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
    open([
      { path: "C:/b.funda", openedAt: 2 },
      { path: "C:/a.funda", openedAt: 1 },
    ]);
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

  it("puts the focus in its search field", () => {
    open([{ path: "C:/a.funda", openedAt: 1 }]);
    expect(document.activeElement).toBe($(".home-search"));
  });

  it("gives the focus back to what had it when it closes", async () => {
    const before = document.createElement("button");
    document.body.append(before);
    before.focus();
    const { w } = open([{ path: "C:/a.funda", openedAt: 1 }]);
    w.unmount();
    expect(document.activeElement).toBe(before);
  });

  it("with nothing to search, puts the focus on the first New button", () => {
    open([]);
    expect(document.activeElement?.closest(".home-main")).toBeTruthy();
    expect(document.activeElement?.tagName).toBe("BUTTON");
  });

  it("clears the search on Escape before it closes", async () => {
    const { home } = open([
      { path: "C:/a.funda", openedAt: 1 },
      { path: "C:/b.funda", openedAt: 2 },
    ]);
    const field = document.querySelector<HTMLInputElement>(".home-search")!;
    field.value = "a";
    field.dispatchEvent(new Event("input"));
    await nextTick();
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    expect(home.visible).toBe(true);
    expect(field.value).toBe("");
    expect($$(".home-card-name")).toHaveLength(2);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(home.visible).toBe(false);
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

  it("keeps only Blank and Open at the top and lists the examples as cards", () => {
    open([{ path: "C:/work/gear.funda", openedAt: 1 }]);
    expect($$(".home-new-card").map((c) => c.querySelector(".home-new-name")!.textContent)).toEqual(["Blank", "Open…"]);
    expect($(".home-new-template")).toBeNull();
    expect($$(".home-example-name").map((n) => n.textContent)).toEqual(["Plate", "Wall bracket", "Pinned lever"]);
    expect($$(".home-example-line").map((n) => n.textContent)).toEqual(["Example", "Example", "Example"]);
    expect($(".home-examples")!.closest(".home-scroll")).toBe($(".home-grid")!.closest(".home-scroll"));
    expect($(".home-section")!.textContent).toBe("Examples");
  });

  it("starts a document from an example card", async () => {
    const { cb } = open();
    $$(".home-example")[1]!.click();
    await flushPromises();
    expect(cb.newFromTemplate).toHaveBeenCalledWith("wall-bracket");
  });

  it("finds an example by name, and says nothing matches only when no example does either", async () => {
    open([
      { path: "C:/work/bracket.funda", openedAt: 2 },
      { path: "C:/work/gear.funda", openedAt: 1 },
    ]);
    await flushPromises();
    const field = document.querySelector<HTMLInputElement>(".home-search")!;
    field.value = "LEVER";
    field.dispatchEvent(new Event("input"));
    await nextTick();
    expect($$(".home-card")).toHaveLength(0);
    expect($$(".home-example-name").map((n) => n.textContent)).toEqual(["Pinned lever"]);
    expect($(".home-empty")).toBeNull();
    field.value = "zzz";
    field.dispatchEvent(new Event("input"));
    await nextTick();
    expect($$(".home-example")).toHaveLength(0);
    expect($(".home-empty")!.textContent).toBe("No documents match");
  });

  it.each([
    ["the desktop app", fakeLibrary(), "Documents you open or save appear here."],
    ["the browser build", null, "Recent documents appear here in the desktop app."],
  ] as const)("shows the examples with no recent documents in %s", (_where, lib, empty) => {
    open([], {}, lib);
    expect($$(".home-example")).toHaveLength(3);
    expect($(".home-empty")!.textContent).toBe(empty);
  });

  it("loads a card's picture only once the card is in view", async () => {
    const watched = new Map<Element, (e: { isIntersecting: boolean }[]) => void>();
    const roots = new Set<Element | Document | null>();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(
          private cb: (e: { isIntersecting: boolean }[]) => void,
          opts?: IntersectionObserverInit,
        ) {
          roots.add(opts?.root ?? null);
        }
        observe(el: Element) {
          watched.set(el, this.cb);
        }
        disconnect() {}
      },
    );
    try {
      const lib = fakeLibrary([], 5000);
      open(
        [
          { path: "C:/w/a.funda", openedAt: 2 },
          { path: "C:/w/b.funda", openedAt: 1 },
        ],
        {},
        lib,
      );
      await flushPromises();
      expect(lib.thumbs).not.toHaveBeenCalled();
      expect($(".home-card-pic img")).toBeNull();
      // The scrolling box, a root that grows with its cards would see every card at once.
      expect([...roots]).toEqual([$(".home-scroll")]);
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

  describe("folders", () => {
    const stat = (path: string, mtimeMs: number): FileStat => ({ path, exists: true, mtimeMs, size: 1 });
    const proj: FolderListing = {
      files: [stat("D:/proj/b.funda", 30), stat("D:/proj/sub/a.funda", 20)],
      truncated: false,
    };
    const rows = () => $$(".home-nav-row").map((r) => r.textContent?.trim());
    const menuRows = () => [...document.querySelectorAll<HTMLElement>(".ctx-menu button, .ctx-item")];

    beforeEach(() => setSaveFolder(null));

    it("adds a folder from the dialog and lists its documents", async () => {
      const lib = fakeLibrary([], 0, { "D:/proj": proj }, ["D:/proj"]);
      open([{ path: "C:/r.funda", openedAt: 1 }], {}, lib);
      await flushPromises();
      $(".home-add-folder")!.click();
      await flushPromises();
      expect(rows()).toEqual(["Recent", "proj", "Add folder…"]);
      expect($(".home-folder-row.active")!.getAttribute("title")).toBe("D:/proj");
      expect($$(".home-card-name").map((n) => n.textContent)).toEqual(["b", "a"]);
      expect(JSON.parse(localStorage.getItem("fundacad.home.folders")!)[0].path).toBe("D:/proj");
      const sort = document.querySelector<HTMLSelectElement>(".home-sort")!;
      expect([...sort.options].map((o) => o.textContent)).toEqual(["Last edited", "Name"]);
      $(".home-nav-row")!.click();
      await flushPromises();
      expect($$(".home-card-name").map((n) => n.textContent)).toEqual(["r"]);
    });

    it("puts the narrow Show list back on its view when the folder dialog is cancelled", async () => {
      const lib = fakeLibrary([], 0, {}, []);
      open([{ path: "C:/r.funda", openedAt: 1 }], {}, lib);
      await flushPromises();
      const select = document.querySelector<HTMLSelectElement>(".home-view-select")!;
      select.value = "add";
      select.dispatchEvent(new Event("change"));
      await flushPromises();
      expect(lib.pickFolder).toHaveBeenCalledOnce();
      expect(select.value).toBe("recent");
    });

    it("removes a folder from Home and goes back to Recent", async () => {
      localStorage.setItem("fundacad.home.folders", JSON.stringify([{ path: "D:/proj", addedAt: 1 }]));
      open([], {}, fakeLibrary([], 0, { "D:/proj": proj }));
      mount(ContextMenuHost, { attachTo: document.body });
      $(".home-folder-row")!.click();
      await flushPromises();
      $(".home-card")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await nextTick();
      expect(menuRows().map((r) => r.textContent?.trim())).not.toContain("Remove from list");
      key("Escape");
      $(".home-folder-row")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await nextTick();
      menuRows()
        .find((r) => r.textContent?.trim() === "Remove from Home")!
        .click();
      await flushPromises();
      expect(rows()).toEqual(["Recent", "Add folder…"]);
      expect($(".home-nav-row.active")!.textContent).toBe("Recent");
      expect(localStorage.getItem("fundacad.home.folders")).toBe("[]");
    });

    it("says when a folder holds more than it lists, or cannot be read", async () => {
      localStorage.setItem(
        "fundacad.home.folders",
        JSON.stringify([
          { path: "D:/big", addedAt: 1 },
          { path: "D:/gone", addedAt: 2 },
        ]),
      );
      open([], {}, fakeLibrary([], 0, { "D:/big": { files: proj.files, truncated: true } }));
      const [big, gone] = $$(".home-folder-row");
      big!.click();
      await flushPromises();
      expect($(".home-note")!.textContent?.trim()).toBe("Showing the first 2000 documents");
      gone!.click();
      await flushPromises();
      expect($(".home-note")).toBeNull();
      expect($(".home-empty")!.textContent).toBe("gone could not be read.");
    });

    it("starts a new document from a folder view in that folder", async () => {
      localStorage.setItem("fundacad.home.folders", JSON.stringify([{ path: "D:/proj", addedAt: 1 }]));
      let refuse = true;
      const { home } = open(
        [],
        {
          newDocument: vi.fn(async () => {
            if (!refuse) home.visible = false;
          }),
        },
        fakeLibrary([], 0, { "D:/proj": proj }),
      );
      $(".home-folder-row")!.click();
      await flushPromises();
      $(".home-new-blank")!.click();
      await flushPromises();
      expect(saveFolder()).toBeNull();
      refuse = false;
      $(".home-new-blank")!.click();
      await flushPromises();
      expect(saveFolder()).toBe("D:/proj");
    });

    it("has no folders in the browser build", () => {
      open([], {}, null);
      expect(rows()).toEqual(["Recent"]);
    });
  });

  describe("versions drawer", () => {
    const row = (id: string, parent: string | null, branch: string, time: number) => ({
      id,
      parent,
      branch,
      message: `msg ${id}`,
      time,
    });
    const hist: DocSummary = {
      format: "funda",
      versions: [row("v1", null, "main", 1), row("v2", "v1", "main", 2), row("v3", "v1", "wide", 3)],
      branches: { main: "v2", wide: "v3" },
      current: "wide",
    };
    const P = "D:/p/part.funda";
    const texts = (sel: string) => $$(sel).map((n) => n.textContent?.trim());
    const button = (sel: string, label: string) => $$(sel).find((b) => b.textContent?.trim() === label)!;

    async function drawerFor(summaries: Record<string, DocSummary | null>, over: Partial<HomeCallbacks> = {}) {
      const opened = open([{ path: P, openedAt: 1 }], over, fakeLibrary([], 0, {}, [], summaries));
      await flushPromises();
      $(".home-card-versions")!.click();
      await flushPromises();
      return opened;
    }

    it("lists the branches, current first, and the versions of the one shown", async () => {
      await drawerFor({ [P]: hist });
      expect(texts(".home-branch-name")).toEqual(["widecurrent", "main"]);
      expect(texts(".home-version-msg")).toEqual(["msg v3", "msg v1"]);
      $$(".home-branch-name")[1]!.click();
      await nextTick();
      expect(texts(".home-version-msg")).toEqual(["msg v2", "msg v1"]);
    });

    it("restores a version and closes once the document shows it", async () => {
      const { cb, home } = await drawerFor({ [P]: hist });
      button(".home-version-restore", "Restore").click();
      await flushPromises();
      expect(cb.openVersion).toHaveBeenCalledWith(P, "v3", false);
      expect(home.visible).toBe(false);
    });

    it("passes the copy and branch actions through and stays up when they are refused", async () => {
      const { cb, home } = await drawerFor(
        { [P]: hist },
        {
          openVersion: vi.fn(async () => false),
          openBranch: vi.fn(async () => false),
        },
      );
      $$(".home-version-copy")[1]!.click();
      await flushPromises();
      expect(cb.openVersion).toHaveBeenCalledWith(P, "v1", true);
      $$(".home-branch-open")[1]!.click();
      await flushPromises();
      expect(cb.openBranch).toHaveBeenCalledWith(P, "main");
      expect(home.visible).toBe(true);
      expect($(".home-drawer")).not.toBeNull();
    });

    it("closes the drawer on Escape before Home", async () => {
      const { home } = await drawerFor({ [P]: hist });
      key("Escape");
      await nextTick();
      expect($(".home-drawer")).toBeNull();
      expect(home.visible).toBe(true);
      key("Escape");
      expect(home.visible).toBe(false);
    });

    it("says when there is no history, the file is too old, or it cannot be read", async () => {
      await drawerFor({ [P]: { ...hist, versions: [], branches: {} } });
      expect($(".home-drawer-note")!.textContent).toBe("No versions saved in this document.");
      document.body.innerHTML = "";
      await drawerFor({ [P]: null });
      expect($(".home-drawer-note")!.textContent).toBe("Open the document to see its versions.");
      document.body.innerHTML = "";
      await drawerFor({});
      expect($(".home-drawer-note")!.textContent).toBe("The versions could not be read.");
    });

    it("reads the open document's history live instead of the file", async () => {
      const lib = fakeLibrary([], 0, {}, [], { [P]: hist });
      open(
        [{ path: P, openedAt: 1 }],
        {
          currentPath: () => P,
          currentVersions: () => ({
            objects: {},
            versions: [
              { id: "u1", parent: null, branch: "main", message: "unsaved", time: 9, tree: { features: [], rest: "" } },
            ],
            branches: { main: "u1" },
            current: "main",
          }),
        },
        lib,
      );
      await flushPromises();
      $(".home-card-versions")!.click();
      await flushPromises();
      expect(lib.summary).not.toHaveBeenCalled();
      expect(texts(".home-version-msg")).toEqual(["unsaved"]);
    });
  });
});
