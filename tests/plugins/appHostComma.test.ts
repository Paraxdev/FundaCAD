// An assistant's param_set reads the same in every language: the point form works and a decimal comma is refused,
// whichever language the app shows, and a refusal leaves the document as it was.

import { afterEach, describe, expect, it } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { appHost } from "../../src/plugins/broker/appHost";
import { createBroker } from "../../src/plugins/broker/broker";
import { allOpGrants } from "../../src/plugins/broker/ops";
import { setLanguage } from "../../src/i18n";
import type { GeometryBackend } from "../../src/geometry/client";

afterEach(() => setLanguage("system"));

const backend = {
  rebuild: async () => ({ ok: true, result: { bodies: [] } }),
  async init() {},
  onStatus: () => () => {},
  onRebuildChunk: () => () => {},
  onProgress: () => () => {},
  cancel: async () => true,
  connected: false,
} as unknown as GeometryBackend;

async function run(language: "en" | "de") {
  await setLanguage(language);
  const store = new DocumentStore(backend, {
    parameters: {},
    paramDefs: { width: { expr: "40", value: 40, unit: "mm" } },
    features: [],
  });
  const b = createBroker({ plugin: "under-test", grants: allOpGrants(), host: appHost({ store }) });
  const out: unknown[] = [];
  for (const params of [
    { name: "wall", expr: "width*1,5" },
    { name: "rib", expr: "max(1,5; 2)" },
    { name: "wall", expr: "width*1.5+0.25" },
    { name: "width", expr: "width0*1,25" },
    { name: "width", expr: "60.5" },
  ]) {
    const r = await b.call("param_set", params);
    out.push(r.ok ? r.value : { refused: r.code, why: r.why });
  }
  return { out, defs: store.document.paramDefs };
}

describe("MCP param_set and the language", () => {
  it("answers and writes the same in German as in English", async () => {
    const en = await run("en");
    const de = await run("de");
    expect(de).toEqual(en);
  });

  it("refuses a comma and stores a point expression exactly", async () => {
    const { out, defs } = await run("de");
    expect(out.slice(0, 2).every((r) => (r as { refused?: string }).refused !== undefined)).toBe(true);
    expect(out[2]).toEqual({ ok: true, name: "wall" });
    expect(defs).toEqual({
      width: { expr: "60.5", value: 60.5, unit: "mm" },
      wall: { expr: "width*1.5+0.25", value: 91, unit: "mm" },
    });
  });
});
