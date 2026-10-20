// One small file per document version, opened the way the app opens it. The
// expected documents were written by the build before forward compatibility work
// started, so a change here is a change in how an existing file opens.
// scripts/regen-version-fixtures.sh rewrites them.
import { describe, it, expect } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

const files = import.meta.glob("../fixtures/versions/*.funda", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const expected = import.meta.glob("../fixtures/versions/expected/*.json", { import: "default", eager: true }) as Record<string, unknown>;
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const writer = env["UPDATE_VERSION_FIXTURES"] === "1"
  ? ((await import(/* @vite-ignore */ "node:" + "fs")) as { writeFileSync(path: URL, text: string): void })
  : null;

const backend = {
  async rebuild() {
    return { ok: false, error: { message: "stub" } };
  },
  async init() {},
  onStatus() {
    return () => {};
  },
  connected: true,
} as unknown as GeometryBackend;

function openedAsToday(text: string): CadDocument {
  const store = new DocumentStore(backend, { parameters: {}, features: [] });
  store.load(text);
  return JSON.parse(JSON.stringify(store.toObject())) as CadDocument;
}

const version = (path: string) => Number(/v(\d+)\.funda$/.exec(path)![1]);
const paths = Object.keys(files).sort((a, b) => version(a) - version(b));

describe("a file of every document version opens as it did", () => {
  it("has one file per version", () => {
    expect(paths.map(version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  for (const path of paths) {
    const name = `v${version(path)}`;
    it(name, () => {
      const got = openedAsToday(files[path]!);
      const want = `../fixtures/versions/expected/${name}.json`;
      writer?.writeFileSync(new URL(want, import.meta.url), `${JSON.stringify(got, null, 2)}\n`);
      expect(got).toEqual(writer ? got : expected[want]);
    });
  }
});
