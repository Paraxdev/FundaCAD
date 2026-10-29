// The one log line per committed edit: its format, and that a store writes it once per committed rebuild.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { formatEditTiming, type EngineTiming } from "../../src/diagnostics/editTiming";
import { appLog } from "../../src/diagnostics/breadcrumbs";
import type { CadDocument, Feature, RebuildReply } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

vi.mock("../../src/diagnostics/breadcrumbs", async (orig) => ({
  ...(await orig<typeof import("../../src/diagnostics/breadcrumbs")>()),
  appLog: vi.fn(),
}));

const engine = (over: Partial<EngineTiming> = {}): EngineTiming => ({
  copy: 2840,
  replay: 11,
  slow: "fillet",
  post: 298,
  mesh: 8.4,
  meshed: 1,
  ...over,
});

describe("formatEditTiming", () => {
  it("names every stage in seconds with two significant figures", () => {
    expect(formatEditTiming({ totalMs: 3812, engine: engine(), replyBytes: 605_520, applyMs: 419 })).toBe(
      "edit 3.8 s: copy 2.8, replay 0.011 (fillet), post 0.3, mesh 0.0084 (1 part), reply 606 KB, apply 0.42",
    );
  });

  it("pluralises the parts, drops them at none, and shows a stage under a millisecond as 0", () => {
    const many = formatEditTiming({
      totalMs: 17122,
      engine: engine({ copy: 0.4, meshed: 7, slow: null }),
      replyBytes: 9_412_404,
      applyMs: 405,
    });
    expect(many).toBe("edit 17 s: copy 0, replay 0.011, post 0.3, mesh 0.0084 (7 parts), reply 9.4 MB, apply 0.41");
    expect(formatEditTiming({ totalMs: 90, engine: engine({ meshed: 0 }), replyBytes: 999, applyMs: 4 })).toContain(
      "mesh 0.0084, reply 1 KB, apply 0.004",
    );
  });

  it("is still a line without engine stages, and never reaches 200 characters", () => {
    expect(formatEditTiming({ totalMs: 250, engine: null, replyBytes: 12_300, applyMs: 31 })).toBe(
      "edit 0.25 s: reply 12 KB, apply 0.031",
    );
    const hostile = engine({ slow: "x".repeat(500) });
    const line = formatEditTiming({ totalMs: 123_456_789, engine: hostile, replyBytes: 5e12, applyMs: 123_456_789 });
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line).toContain("(" + "x".repeat(24) + ")");
  });
});

const ok = (n: number): RebuildReply =>
  ({
    ok: true,
    result: {
      mesh: { positions: new Float32Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0) },
      edges: [],
      bbox: { min: [0, 0, 0], max: [n, 1, 1] },
    },
  }) as unknown as RebuildReply;

function backend(replies: RebuildReply[], costs: { engine: EngineTiming | null; replyBytes: number }[]) {
  let at = 0;
  return {
    rebuild: async () => replies[at++] ?? ok(0),
    lastRebuildCost: () => costs[at - 1]!,
    async init() {},
    onStatus: () => () => {},
    connected: true,
  } as unknown as GeometryBackend;
}

const doc = (length: number): CadDocument => ({
  parameters: {},
  features: [{ id: "a", type: "box", length, width: 13, height: 7 }] as Feature[],
});

describe("the edit timing line in the app log", () => {
  beforeEach(() => vi.mocked(appLog).mockClear());

  it("is written once per committed rebuild, with that rebuild's own numbers", async () => {
    const costs = [
      { engine: engine({ copy: 1900 }), replyBytes: 41_000 },
      { engine: engine({ copy: 120, slow: "extrude", meshed: 3 }), replyBytes: 2_700_000 },
    ];
    const store = new DocumentStore(backend([ok(1), ok(2)], costs), doc(11));
    await store.rebuildNow();
    expect(vi.mocked(appLog).mock.calls.length).toBe(1);
    expect(vi.mocked(appLog).mock.calls[0]![0]).toMatch(
      /^edit \S+ s: copy 1\.9, .*\(fillet\).*reply 41 KB, apply \S+$/,
    );

    store.loadDocument(doc(29));
    await store.whenBuilt();
    expect(vi.mocked(appLog).mock.calls.length).toBe(2);
    expect(vi.mocked(appLog).mock.calls[1]![0]).toMatch(/copy 0\.12, .*\(extrude\).*\(3 parts\), reply 2\.7 MB/);
  });

  it("is not written for a refused rebuild or a preview", async () => {
    const refused = { ok: false, error: { message: "no" } } as RebuildReply;
    const costs = [{ engine: engine(), replyBytes: 10 }];
    const store = new DocumentStore(backend([refused], costs), doc(11));
    await store.rebuildNow();
    expect(appLog).not.toHaveBeenCalled();
  });

  it("is not written for a live preview of a feature being dragged", async () => {
    vi.useFakeTimers();
    try {
      const rebuilt = vi.fn(async () => ok(3));
      const geometry = {
        rebuild: rebuilt,
        lastRebuildCost: () => ({ engine: engine(), replyBytes: 10 }),
        async init() {},
        onStatus: () => () => {},
        connected: true,
      } as unknown as GeometryBackend;
      const store = new DocumentStore(geometry, doc(11));
      await store.rebuildNow();
      vi.mocked(appLog).mockClear();
      rebuilt.mockClear();
      store.setPreview({ id: "p", type: "box", length: 17, width: 5, height: 3 } as Feature);
      await vi.advanceTimersByTimeAsync(1000);
      expect(rebuilt.mock.calls.length).toBeGreaterThan(0);
      expect(appLog).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
