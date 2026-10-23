import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import type { CadDocument } from "../../src/types";
import { encodeRgbe } from "../../src/viewport/hdrImage";
import { createEnvLibrary, memoryKv, type EnvLibrary } from "../../src/ui/environmentLibrary";
import { importEnvironmentBytes, syncDocumentEnvironment } from "../../src/ui/environmentImport";
import { renderPrefs, setRenderPref } from "../../src/ui/renderPrefs";

const geometry = {
  rebuild: async () => ({
    ok: true as const,
    result: { mesh: { positions: [], indices: [], faceIds: [] }, edges: [], bbox: null, bodies: [] },
  }),
  async init() {},
  onStatus: () => () => {},
  onProgress: () => () => {},
} as unknown as GeometryBackend;

// Each test lights with its own panorama, so none finds another's already packed.
let shade = 0.1;
const panorama = () => {
  shade += 0.1;
  const data = new Float32Array(8 * 4 * 4).fill(shade);
  return encodeRgbe({ width: 8, height: 4, data });
};

// Every panorama read the library answers, and a gate the reads after the first `free` wait on.
function watchedLibrary(free = Infinity) {
  const lib = createEnvLibrary(memoryKv());
  const reads: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let reach!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const library: EnvLibrary = {
    ...lib,
    async getHdr(hash) {
      reads.push(hash);
      if (reads.length > free) {
        reach();
        await gate;
      }
      return lib.getHdr(hash);
    },
  };
  return { library, reads, reached, open };
}

const look = () => (renderPrefs().environment.startsWith("hdr:") ? renderPrefs().environment.slice(4) : "room");

beforeEach(() => setRenderPref("environment", "studio"));
afterEach(() => setRenderPref("environment", "studio"));

describe("a panorama chosen in the library panel", () => {
  it("lights the view before it is packed for the document", async () => {
    const store = new DocumentStore(geometry, { parameters: {}, features: [] } as unknown as CadDocument);
    // The first read is the library's own check whether it already keeps the panorama.
    const { library, reached, open } = watchedLibrary(1);
    const lit = importEnvironmentBytes(store, panorama(), "studio.hdr", library);
    await reached;
    const whilePacked = { look: look() !== "room", environment: store.documentEnvironment?.hdr?.name ?? null };
    open();
    expect(await lit).toBeNull();
    expect({ whilePacked, environment: store.documentEnvironment?.hdr?.name ?? null }).toEqual({
      whilePacked: { look: true, environment: null },
      environment: "studio.hdr",
    });
  });
});

describe("a dropped panorama asked whether it is left out", () => {
  it.each([
    ["left out", true, "first.hdr"],
    ["taken", false, "second.hdr"],
  ])("when %s, keeps the panorama the document wears packed", async (_what, left, wears) => {
    const store = new DocumentStore(geometry, { parameters: {}, features: [] } as unknown as CadDocument);
    const { library, reads } = watchedLibrary();
    await importEnvironmentBytes(store, panorama(), "first.hdr", library);
    const first = look();
    await importEnvironmentBytes(store, panorama(), "second.hdr", library, { leftOut: () => left });
    const lit = look();
    reads.length = 0;
    await syncDocumentEnvironment(store, library);
    expect({
      lit: lit === first,
      environment: store.documentEnvironment?.hdr?.name ?? null,
      readsToPack: reads,
    }).toEqual({ lit: left, environment: wears, readsToPack: [] });
  });
});
