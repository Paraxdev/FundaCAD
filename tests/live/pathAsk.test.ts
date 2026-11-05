// The window's dialog for an assistant's path ask. In the Flatpak that dialog is the file chooser portal, so the
// dialog here is a fake that records what it was asked to show.

import { describe, expect, it } from "vitest";
import { askTitle, askWithDialog, parseAsk, type PathAsk } from "../../src/live/pathAsk";

const ask = (over: Partial<PathAsk> = {}): PathAsk => ({
  askId: "g-1",
  kind: "save",
  tool: "doc_save",
  path: "/home/me/parts/bracket.funda",
  exts: ["funda"],
  name: "an assistant",
  ...over,
});

function fakeDialog(pick: unknown) {
  const calls: { fn: "open" | "save"; options: Record<string, unknown> }[] = [];
  const dialog = {
    open: async (options?: object) => {
      calls.push({ fn: "open", options: options as Record<string, unknown> });
      return pick;
    },
    save: async (options?: object) => {
      calls.push({ fn: "save", options: options as Record<string, unknown> });
      return pick;
    },
  };
  return { calls, dialog: dialog as unknown as Parameters<typeof askWithDialog>[1] };
}

describe("parseAsk", () => {
  it("takes a well formed ask and fills a missing name", () => {
    const raw = { askId: "g-1", kind: "open", tool: "doc_open", path: "/a/b.funda", exts: ["funda", 3, ""] };
    expect(parseAsk(raw)).toEqual({
      askId: "g-1",
      kind: "open",
      tool: "doc_open",
      path: "/a/b.funda",
      exts: ["funda"],
      name: "an assistant",
    });
  });

  it("refuses an ask without an id, a known kind or a path", () => {
    for (const bad of [null, 1, "x", {}, { ...ask(), askId: 4 }, { ...ask(), kind: "write" }, { ...ask(), path: "" }]) {
      expect(parseAsk(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("askTitle", () => {
  it("names who asks, what for and which file", () => {
    expect(askTitle(ask())).toBe("An assistant asks to save bracket.funda");
    expect(askTitle(ask({ tool: "doc_open", kind: "open", name: "Claude Code" }))).toBe(
      "Claude Code asks to open bracket.funda",
    );
    expect(askTitle(ask({ tool: "doc_import", kind: "open", path: "C:\\parts\\bolt.step" }))).toBe(
      "An assistant asks to import bolt.step",
    );
    expect(askTitle(ask({ tool: "export", kind: "folder", path: "/home/me/parts/" }))).toBe(
      "An assistant asks to export into parts",
    );
  });
});

describe("askWithDialog", () => {
  it("opens a save dialog prefilled with the asked path for a save", async () => {
    const { calls, dialog } = fakeDialog("/run/user/1000/doc/ab12/bracket.funda");
    expect(await askWithDialog(ask(), dialog)).toBe("/run/user/1000/doc/ab12/bracket.funda");
    expect(calls).toEqual([
      {
        fn: "save",
        options: {
          title: "An assistant asks to save bracket.funda",
          defaultPath: "/home/me/parts/bracket.funda",
          filters: [{ name: "FUNDA", extensions: ["funda", "FUNDA"] }],
        },
      },
    ]);
  });

  it("opens one file for an open and a folder for a folder", async () => {
    const open = fakeDialog("/run/user/1000/doc/cd34/bolt.step");
    await askWithDialog(ask({ kind: "open", tool: "doc_import", path: "/x/bolt.step", exts: ["step"] }), open.dialog);
    expect(open.calls[0]).toMatchObject({
      fn: "open",
      options: { defaultPath: "/x/bolt.step", multiple: false, directory: false },
    });

    const folder = fakeDialog("/run/user/1000/doc/ef56/out");
    await askWithDialog(ask({ kind: "folder", tool: "export", path: "/x/out", exts: ["stl"] }), folder.dialog);
    expect(folder.calls[0]).toMatchObject({ fn: "open", options: { directory: true } });
    expect(folder.calls[0]!.options).not.toHaveProperty("filters");
  });

  it("gives null for a cancel or anything that is not one path", async () => {
    for (const pick of [null, undefined, "", ["/a", "/b"]]) {
      expect(await askWithDialog(ask({ kind: "open" }), fakeDialog(pick).dialog)).toBeNull();
    }
  });
});
