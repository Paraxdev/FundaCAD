// The guest measures its result before posting it, so an oversized one is never cloned across to the host.
import { describe, expect, it } from "vitest";

import { serveGuest } from "../../src/plugins/runner/guest";
import { MAX_RESULT, type Port } from "../../src/plugins/runner/protocol";

async function finish(value: unknown) {
  const sent: unknown[] = [];
  let listener: ((ev: { data: unknown }) => void) | null = null;
  const port: Port = {
    postMessage: (m) => sent.push(m),
    addEventListener: (_t, l) => (listener = l),
    removeEventListener: () => (listener = null),
  };
  const stop = serveGuest({ port, run: async () => value });
  listener!({ data: { t: "start", source: "", grants: [] } });
  await new Promise((r) => setTimeout(r, 0));
  stop();
  return sent.slice(1);
}

describe("the guest end of a run", () => {
  it("posts a failure instead of a result over the cap", async () => {
    expect(await finish({ blob: "y".repeat(MAX_RESULT) })).toEqual([
      { t: "failed", why: `the plugin returned more than ${MAX_RESULT} characters` },
    ]);
  });

  it("posts a result under the cap as JSON would carry it", async () => {
    expect(await finish({ n: 1, f: () => 1, at: undefined })).toEqual([{ t: "done", value: { n: 1 } }]);
  });
});
