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
    expect(await bracket(app, 40, 3)).toBe("bx1");
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
