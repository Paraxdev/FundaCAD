// WebKitGTK shows the page no files on a drop from the file manager, and an
// empty text/uri-list (webkit.org/b/271957), so a dropped .funda did nothing on
// Linux. The paths come from GTK through drop_paths_take instead.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const opened: string[] = [];
const asked: unknown[] = [];
let held: string[] = [];
type Listener = (ev: { payload: { id: string; paths: (string | null)[] } }) => void;
const listeners = new Set<Listener>();
const win = window as unknown as Record<string, unknown>;

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, fn: Listener) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: { id: string }) => {
    asked.push([cmd, args]);
    const paths = held;
    held = [];
    for (const fn of [...listeners]) fn({ payload: { id: args.id, paths } });
  }),
}));
vi.mock("../../src/app/documentActions", () => ({ mayDiscard: vi.fn(async () => true) }));
vi.mock("../../src/io/files", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/io/files")>();
  return {
    ...real,
    openDocumentAtPath: vi.fn(async (_s: unknown, path: string) => {
      opened.push(`path ${path}`);
      return "ok";
    }),
    openDocumentBytes: vi.fn(async (_s: unknown, file: File) => {
      opened.push(`bytes ${file.name}`);
      return "ok";
    }),
    importPath: vi.fn(async (_s: unknown, _g: unknown, path: string) => {
      opened.push(`import ${path}`);
    }),
    importFileBytes: vi.fn(async (_s: unknown, _g: unknown, file: File) => {
      opened.push(`import bytes ${file.name}`);
    }),
    reportError: vi.fn(async () => {}),
  };
});

import { installDesktopDrop } from "../../src/io/desktopDrop";

/** What WebKitGTK 2.50 hands the page for a file dragged from Nautilus. */
const GTK_TYPES = ["text/uri-list", "text/html"];

function drag(type: string, types: string[]): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { types, files: [], dropEffect: "none", getData: () => "" } });
  window.dispatchEvent(ev);
  return ev;
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("a file dropped from a Linux file manager", () => {
  let uninstall: () => void = () => {};
  let platform: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    opened.length = 0;
    asked.length = 0;
    held = [];
    win.__TAURI_INTERNALS__ = {};
    platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  });
  afterEach(() => {
    uninstall();
    delete win.__TAURI_INTERNALS__;
    platform.mockRestore();
  });

  function install() {
    const shown: boolean[] = [];
    uninstall = installDesktopDrop({ store: {}, sketch: {}, geometry: {} } as never, (s) => shown.push(s));
    return shown;
  }

  it("opens the .funda at the path GTK saw, so Save saves in place", async () => {
    const shown = install();
    held = ["/home/me/My Parts/pärt ü #1.funda"];
    drag("dragenter", GTK_TYPES);
    expect(drag("dragover", GTK_TYPES).defaultPrevented).toBe(true);
    expect(shown).toEqual([true]);
    expect(drag("drop", GTK_TYPES).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(opened).toEqual(["path /home/me/My Parts/pärt ü #1.funda"]));
    expect(asked).toEqual([["drop_paths_take", { id: expect.any(String) }]]);
  });

  it("imports the rest of the drop by path after the document", async () => {
    install();
    held = ["/d/b.stl", "/d/a.funda"];
    drag("drop", GTK_TYPES);
    await vi.waitFor(() => expect(opened).toEqual(["path /d/a.funda", "import /d/b.stl"]));
  });

  it("does nothing for a uri-list that names no local file, a link from a browser", async () => {
    install();
    drag("drop", ["text/uri-list"]);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    await flush();
    expect(opened).toEqual([]);
  });

  it("leaves an in-page drag alone", async () => {
    install();
    held = ["/d/a.funda"];
    drag("dragstart", GTK_TYPES);
    expect(drag("dragover", GTK_TYPES).defaultPrevented).toBe(false);
    drag("drop", GTK_TYPES);
    await flush();
    expect(asked).toEqual([]);
  });

  it("leaves a browser tab alone, which cannot open a path", async () => {
    delete win.__TAURI_INTERNALS__;
    install();
    expect(drag("dragover", GTK_TYPES).defaultPrevented).toBe(false);
    drag("drop", GTK_TYPES);
    await flush();
    expect(asked).toEqual([]);
  });

  it("leaves a link dragged into the app on another platform alone", async () => {
    platform.mockReturnValue("Win32");
    install();
    expect(drag("dragover", ["text/uri-list"]).defaultPrevented).toBe(false);
    drag("drop", ["text/uri-list"]);
    await flush();
    expect(asked).toEqual([]);
  });
});
