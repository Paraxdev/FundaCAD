// Opening a document checks its linked files by size and modified time only; their content is read when the
// user picks Update or inserts a link.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, Feature } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

type Stat = { size: number; mtimeMs: number } | null | "refuse";

const host = vi.hoisted(() => ({
  invoked: [] as { cmd: string; path?: unknown }[],
  stat: (_path: string): unknown => null,
  toasts: [] as { message: string; kind?: string; action?: { label: string; onClick: () => void } }[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    host.invoked.push({ cmd, path: args.path });
    if (cmd === "container_stat") {
      const r = host.stat(String(args.path));
      if (r === "refuse") throw "that path was not handed over";
      return r;
    }
    if (cmd === "container_open") return SOURCE;
    return undefined;
  },
}));
vi.mock("@tauri-apps/api/path", () => ({
  tempDir: async () => "C:/tmp",
  join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("../../src/ui/toast", () => ({
  toast: (message: string, opts: { kind?: string; action?: { label: string; onClick: () => void } } = {}) => {
    host.toasts.push({ message, ...opts });
    return 1;
  },
}));
vi.mock("../../src/io/nativeDialog", () => ({
  nativeDialog: async () => ({ open: async () => "C:/parts/Bracket.funda" }),
}));
vi.mock("../../src/ui/choice", () => ({ choose: async () => "link" }));

const SOURCE = JSON.stringify({
  parameters: {},
  features: [{ id: "f1", type: "box", length: 10, width: 10, height: 10 }],
});

const { checkLinks, insertDocumentFromDialog } = await import("../../src/io/fundaLinks");

const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

function backend(): GeometryBackend {
  let n = 0;
  return {
    async rebuild() {
      return new Promise<never>(() => {});
    },
    async init() {},
    onStatus: () => () => {},
    onProgress: () => () => {},
    async cancel() {
      return true;
    },
    async export(_doc: CadDocument, _fmt: string, path: string) {
      return { ok: true, path };
    },
    async importGeometry() {
      n++;
      return { ok: true, geom: `${n}`.padStart(32, "0"), name: "tmp", solid: true, faces: 6 };
    },
  } as unknown as GeometryBackend;
}

const linked = (id: string, link: Record<string, unknown>) =>
  ({
    id,
    type: "import",
    format: "step",
    name: id,
    source: `C:/parts/${id}.funda`,
    geom: "0123456789abcdef0123456789abcdef",
    solid: true,
    link: { path: `C:/parts/${id}.funda`, stamp: "s", ...link },
  }) as unknown as Feature;

function storeWith(...features: Feature[]) {
  const be = backend();
  return { be, store: new DocumentStore(be, { parameters: {}, features }) };
}

function stubTauriWindow() {
  (globalThis as unknown as Record<string, unknown>).window = { __TAURI_INTERNALS__: {}, setTimeout, clearTimeout };
}

const cmds = () => host.invoked.map((c) => c.cmd);

describe("checkLinks", () => {
  beforeEach(() => {
    stubTauriWindow();
    host.invoked = [];
    host.toasts = [];
    host.stat = () => null;
  });

  it("asks only for each linked file's size and time on open, never its content", async () => {
    host.stat = (path): Stat =>
      path.includes("Bracket")
        ? { size: 99, mtimeMs: 5000 }
        : path.includes("Gone")
          ? null
          : { size: 10, mtimeMs: 5000 };
    const { be, store } = storeWith(
      linked("Bracket", { size: 10, mtime: 5000 }),
      linked("Same", { size: 10, mtime: 5000 }),
      linked("Gone", { size: 10, mtime: 5000 }),
    );
    await checkLinks(store, be);
    await flush();
    expect(cmds()).toEqual(["container_stat", "container_stat", "container_stat"]);
    expect(host.toasts.map((t) => t.message)).toEqual([
      "Bracket changed since it was linked",
      "Couldn't find the linked file for Gone",
    ]);
    expect(host.toasts[0]!.action?.label).toBe("Update");
  });

  it("shows a link stored without a size and time, or one the stat refused, as unknown with Update", async () => {
    host.stat = (path): Stat => (path.includes("Remote") ? "refuse" : { size: 10, mtimeMs: 5000 });
    const { be, store } = storeWith(linked("Old", {}), linked("Remote", { size: 10, mtime: 5000 }));
    await checkLinks(store, be);
    await flush();
    expect(cmds()).not.toContain("container_open");
    expect(host.toasts.map((t) => t.message)).toEqual(["Old, Remote may have changed since they were linked"]);
    expect(host.toasts[0]!.action?.label).toBe("Update");
  });

  it("Update reads the file and stores its fresh size and time", async () => {
    host.stat = (): Stat => ({ size: 42, mtimeMs: 7000 });
    const { be, store } = storeWith(linked("Old", {}));
    await checkLinks(store, be);
    await flush();
    host.invoked = [];
    host.toasts[0]!.action!.onClick();
    await vi.waitFor(() =>
      expect((store.document.features[0] as Feature & { link: { size?: number } }).link.size).toBe(42),
    );
    expect(cmds()).toEqual(["container_stat", "container_open"]);
    expect((store.document.features[0] as Feature & { link: unknown }).link).toMatchObject({ size: 42, mtime: 7000 });
  });
});

describe("insertDocumentFromDialog", () => {
  beforeEach(() => {
    stubTauriWindow();
    host.invoked = [];
    host.toasts = [];
  });

  it("stores the linked file's size and time, taken before it is read", async () => {
    host.stat = (): Stat => ({ size: 120, mtimeMs: 9000 });
    const { be, store } = storeWith();
    await insertDocumentFromDialog(store, be);
    expect(cmds()).toEqual(["container_stat", "container_open"]);
    expect((store.document.features[0] as Feature & { link: unknown }).link).toMatchObject({
      path: "C:/parts/Bracket.funda",
      size: 120,
      mtime: 9000,
    });
  });
});
