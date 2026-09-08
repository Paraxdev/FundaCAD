// What a plugin author writes, run as a test so it cannot rot.
//
// This file is documentation that fails when it stops being true. `bracket` is
// a stand-in for plugin code: it knows nothing about the app except the broker
// it was handed, which is what makes it testable without an app at all — no
// Tauri, no webview, no geometry process, no window.
//
// The two cases are the pair every plugin should have. The first says the
// plugin does what it claims when it holds what it asked for. The second says
// it fails honestly when it does not, which is the case a plugin author
// otherwise never runs and a user eventually does, having turned something off.

import { describe, expect, it } from "vitest";

import type { Broker } from "../../src/plugins/broker/broker";
import { testBroker } from "../../src/plugins/broker/testing";

/** The plugin. It takes a broker and nothing else. */
async function bracket(app: Broker, width: number, thickness: number) {
  await app.callOrThrow("param_set", { name: "wall", expr: thickness });
  const { id } = await app.callOrThrow<{ id: string }>("feature_add", {
    feature: { type: "box", x: width, y: 20, z: thickness },
  });
  return id;
}

describe("a plugin, tested against an injected app", () => {
  it("does what it says when it holds what it asked for", async () => {
    const app = testBroker({ grants: ["document.write"] });
    expect(await bracket(app, 40, 3)).toBe("f1");
    expect(app.host.document().parameters).toEqual({ wall: 3 });
    expect(app.host.document().features).toHaveLength(1);
  });

  it("fails by name, changing nothing, when it does not", async () => {
    const app = testBroker({ grants: ["document.read"] });
    await expect(bracket(app, 40, 3)).rejects.toMatchObject({
      code: "not-granted",
      missing: ["document.write"],
    });
    expect(app.host.document()).toEqual({ parameters: {}, features: [] });
  });

  it("can be watched, for a plugin whose cost is in how often it asks", async () => {
    const app = testBroker({ grants: ["document.write"] });
    await bracket(app, 40, 3);
    expect(app.host.calls().map((c) => c.op)).toEqual(["param_set", "feature_add"]);
  });
});

// ---------------------------------------------------------------------------
// The other half a plugin usually needs: a file.
//
// `importSizes` stands in for the common shape, read something the person
// chose and use it. It is here because the three branches below are the ones
// plugin authors get wrong, and writing them as a worked example is cheaper
// than writing them as advice.

/** Reads a JSON file the person picks and writes its numbers in as parameters. */
async function importSizes(app: Broker): Promise<string> {
  const picked = await app.callOrThrow<{ handle: string; name: string } | null>("file_pick", {
    purpose: "choose a sizes file",
    extensions: ["json"],
  });
  // Branch one. `null` is not an error: the person dismissed the dialog, which
  // is a complete answer.
  if (!picked) return "nothing chosen";

  const body = await app.callOrThrow<{ text?: string }>("file_read", {
    handle: picked.handle,
  });
  // Branch two. The filter was advisory, so what came back may be anything.
  if (typeof body.text !== "string") return `${picked.name} is not text`;
  let sizes: Record<string, number>;
  try {
    sizes = JSON.parse(body.text) as Record<string, number>;
  } catch {
    return `${picked.name} is not readable JSON`;
  }

  for (const [name, value] of Object.entries(sizes)) {
    await app.callOrThrow("param_set", { name, expr: value });
  }
  return `${picked.name}: ${Object.keys(sizes).length} sizes`;
}

describe("a plugin that wants a file", () => {
  it("reads the one the person chose", async () => {
    const app = testBroker({
      grants: ["files.read", "document.write"],
      files: { "sizes.json": JSON.stringify({ wall: 3, gap: 1.5 }) },
    });
    expect(await importSizes(app)).toBe("sizes.json: 2 sizes");
    expect(app.host.document().parameters).toEqual({ wall: 3, gap: 1.5 });
  });

  it("does nothing at all when they dismiss the dialog", async () => {
    // The branch every plugin author forgets. It is reachable here only because
    // the double takes `null` as an answer, which is why it does.
    const app = testBroker({
      grants: ["files.read", "document.write"],
      files: { "sizes.json": "{}" },
      answers: { file_pick: null },
    });
    expect(await importSizes(app)).toBe("nothing chosen");
    expect(app.host.document().parameters).toEqual({});
  });

  it("says so plainly when the file is not what it hoped", async () => {
    const app = testBroker({
      grants: ["files.read", "document.write"],
      files: { "sizes.json": "this is not json" },
    });
    expect(await importSizes(app)).toBe("sizes.json is not readable JSON");
    expect(app.host.document().parameters).toEqual({});
  });

  it("cannot ask for a file it did not ask permission for", async () => {
    // The control that matters: the file ops are not free. A plugin whose
    // manifest omitted files.read is stopped by the broker, before the host and
    // long before a dialog could open.
    const app = testBroker({
      grants: ["document.write"],
      files: { "sizes.json": "{}" },
    });
    await expect(importSizes(app)).rejects.toMatchObject({
      code: "not-granted",
      missing: ["files.read"],
    });
  });
});
