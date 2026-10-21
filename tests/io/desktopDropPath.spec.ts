// WebKitGTK hands a dropped file to the page as bytes and no path, so a dropped
// .funda used to open unsaved-looking and Save asked where. The path survives
// in the drop's text/uri-list.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const opened: string[] = [];
vi.mock("../../src/app/documentActions", () => ({ mayDiscard: vi.fn(async () => true) }));
vi.mock("../../src/io/files", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/io/files")>();
  return {
    ...real,
    openDocumentAtPath: vi.fn(async (_s: unknown, path: string) => { opened.push(`path ${path}`); return "ok"; }),
    openDocumentBytes: vi.fn(async (_s: unknown, file: File) => { opened.push(`bytes ${file.name}`); return "ok"; }),
    reportError: vi.fn(async () => {}),
  };
});

import { installDesktopDrop } from "../../src/io/desktopDrop";

function drop(file: File, uriList: string): void {
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", {
    value: { types: ["Files"], files: [file], getData: (t: string) => (t === "text/uri-list" ? uriList : "") },
  });
  window.dispatchEvent(ev);
}

describe("a file dropped where the webview gives no path", () => {
  let uninstall: () => void = () => {};
  beforeEach(() => { opened.length = 0; });
  afterEach(() => uninstall());

  async function settled() {
    await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0));
  }

  it("opens the .funda at the path its uri-list names, so Save saves in place", async () => {
    uninstall = installDesktopDrop({ store: {}, sketch: {}, geometry: {} } as never, () => {});
    drop(new File(["{}"], "part.funda"), "file:///home/me/My%20Parts/part.funda\r\n");
    await settled();
    expect(opened).toEqual(["path /home/me/My Parts/part.funda"]);
  });

  it("falls back to the bytes when the drop carries no uri-list", async () => {
    uninstall = installDesktopDrop({ store: {}, sketch: {}, geometry: {} } as never, () => {});
    drop(new File(["{}"], "part.funda"), "");
    await settled();
    expect(opened).toEqual(["bytes part.funda"]);
  });
});
