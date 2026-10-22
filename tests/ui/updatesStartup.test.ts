import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Action = { label: string; onClick: () => void };
const h = vi.hoisted(() => ({
  events: [] as string[],
  toasts: [] as { message: string; kind?: string | undefined; action?: Action | undefined }[],
  answers: [] as (string | null)[],
  supported: true,
  found: true,
  saveCleans: true,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    if (cmd === "updates_supported") return h.supported;
    h.events.push(cmd);
  },
}));
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: async () =>
    h.found
      ? {
          version: "1.0.413",
          download: async () => void h.events.push("download"),
          install: async () => void h.events.push("install"),
        }
      : null,
}));
vi.mock("../../src/ui/toast", () => ({
  toast: (message: string, opts: { kind?: string; action?: Action } = {}) =>
    void h.toasts.push({ message, kind: opts.kind, action: opts.action }),
}));
vi.mock("../../src/ui/choice", () => ({
  choose: async (question: string, options: { value: string; label: string; hint?: string }[]) => {
    h.events.push(`ask: ${question} [${options.map((o) => o.label + (o.hint ? ` (${o.hint})` : "")).join(", ")}]`);
    return h.answers.shift() ?? null;
  },
}));
vi.mock("../../src/io/files", () => ({
  saveDocument: async (store: { dirty: boolean }) => {
    h.events.push("save");
    if (h.saveCleans) store.dirty = false;
  },
}));

import { checkForUpdates } from "../../src/ui/updates";
import { beforeUpdate, saveFirst } from "../../src/app/unsavedGuard";
import type { Engine } from "../../src/app/engine";

const SAVE_Q =
  "ask: Save changes to bracket.funda before updating? [Save, Don't save (restart and lose the changes), Cancel]";
const UPDATE_Q = "ask: Update 1.0.413 is available [Restart & update, Later]";
const NOT_INSTALLED = "Update not installed. Help > Check for Updates… installs it later.";
const FINISH_SKETCH = "Update not installed, finish the sketch first. Restart & update installs it.";

function rig(o: { dirty?: boolean; sketchEdits?: boolean } = {}) {
  return {
    store: { dirty: o.dirty ?? false, fileName: "bracket.funda", onMeta: () => {} },
    sketch: { hasUncommittedEdits: o.sketchEdits ?? false },
  } as unknown as Engine;
}

/** The startup check, then a press of the toast's Restart & update. */
async function startupThenPress(e: Engine): Promise<void> {
  await checkForUpdates(false, beforeUpdate(e));
  const offer = h.toasts.find((t) => t.message === "FundaCAD 1.0.413 is available.")!;
  expect(offer.action!.label).toBe("Restart & update");
  offer.action!.onClick();
  await vi.waitFor(() => expect(h.toasts.length).toBeGreaterThan(1));
  await new Promise((r) => setTimeout(r, 0));
}

const messages = () => h.toasts.map((t) => t.message);

beforeEach(() => {
  Object.assign(h, { events: [], toasts: [], answers: [], supported: true, found: true, saveCleans: true });
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("the update found at startup", () => {
  it("is a toast with Restart & update, not a question", async () => {
    await checkForUpdates(false, beforeUpdate(rig()));
    expect(h.toasts.map((t) => [t.message, t.action?.label])).toEqual([
      ["FundaCAD 1.0.413 is available.", "Restart & update"],
    ]);
    expect(h.events).toEqual([]);
  });

  it.each([
    ["no update", { found: false }],
    ["an install that does not update itself", { supported: false }],
  ])("says nothing for %s", async (_, state) => {
    Object.assign(h, state);
    await checkForUpdates(false, beforeUpdate(rig()));
    expect([h.toasts, h.events]).toEqual([[], []]);
  });
});

describe("Restart & update", () => {
  it("downloads, installs and restarts, asking nothing, when no work is unsaved", async () => {
    await startupThenPress(rig());
    expect(h.events).toEqual(["download", "install", "restart_for_update"]);
  });

  it("asks about unsaved work after the download and before the install, and a Save that worked goes on", async () => {
    h.answers = ["save"];
    await startupThenPress(rig({ dirty: true }));
    expect(h.events).toEqual(["download", SAVE_Q, "save", "install", "restart_for_update"]);
  });

  it("installs nothing when the Save was cancelled or failed", async () => {
    h.answers = ["save"];
    h.saveCleans = false;
    await startupThenPress(rig({ dirty: true }));
    expect(h.events).toEqual(["download", SAVE_Q, "save"]);
    expect(messages().at(-1)).toBe(NOT_INSTALLED);
  });

  it("installs over the changes on Don't save", async () => {
    h.answers = ["discard"];
    await startupThenPress(rig({ dirty: true }));
    expect(h.events).toEqual(["download", SAVE_Q, "install", "restart_for_update"]);
  });

  it.each([["cancel"], [null]])("installs nothing on %s", async (answer) => {
    h.answers = [answer];
    await startupThenPress(rig({ dirty: true }));
    expect(h.events).toEqual(["download", SAVE_Q]);
    expect(messages().at(-1)).toBe(NOT_INSTALLED);
  });

  it.each([[false], [true]])(
    "stops for an open sketch with edits (unsaved store %s), and a second press does not download again",
    async (dirty) => {
      const e = rig({ dirty, sketchEdits: true });
      await startupThenPress(e);
      expect(h.events).toEqual(["download"]);
      const stop = h.toasts.at(-1)!;
      expect([stop.message, stop.kind, stop.action?.label]).toEqual([FINISH_SKETCH, "warning", "Restart & update"]);

      (e.sketch as { hasUncommittedEdits: boolean }).hasUncommittedEdits = false;
      h.answers = ["discard"];
      stop.action!.onClick();
      await vi.waitFor(() => expect(h.events.at(-1)).toBe("restart_for_update"));
      expect(h.events).toEqual(["download", ...(dirty ? [SAVE_Q] : []), "install", "restart_for_update"]);
    },
  );

  it("takes the same path from Help after its question", async () => {
    h.answers = ["install", "save"];
    await checkForUpdates(true, beforeUpdate(rig({ dirty: true })));
    expect(h.events).toEqual([UPDATE_Q, "download", SAVE_Q, "save", "install", "restart_for_update"]);
  });

  it("does nothing from Help on Later", async () => {
    h.answers = ["later"];
    await checkForUpdates(true, beforeUpdate(rig({ dirty: true })));
    expect(h.events).toEqual([UPDATE_Q]);
  });
});

describe("the question closing the window asks, shared with the update", () => {
  const close = (e: Engine) =>
    saveFirst(e, "Save changes to bracket.funda before closing?", "close and lose the changes");

  it("has the same three answers", async () => {
    h.answers = ["cancel"];
    expect(await close(rig({ dirty: true }))).toBe(false);
    expect(h.events).toEqual([
      "ask: Save changes to bracket.funda before closing? [Save, Don't save (close and lose the changes), Cancel]",
    ]);
  });

  it("goes on after a Save that worked or Don't save, and not after a Save that did not", async () => {
    h.answers = ["save", "discard", "save"];
    expect(await close(rig({ dirty: true }))).toBe(true);
    expect(await close(rig({ dirty: true }))).toBe(true);
    h.saveCleans = false;
    expect(await close(rig({ dirty: true }))).toBe(false);
  });

  it("goes on for a clean document without asking", async () => {
    expect(await close(rig())).toBe(true);
    expect(h.events).toEqual([]);
  });
});
