// openUrl is refused for any address the capability does not list, and the refusal is silent in the packaged app.
import { describe, expect, it } from "vitest";

import { sourceforgeUrl } from "../../src/app/channel";
import capabilityRaw from "../../src-tauri/capabilities/default.json?raw";

type Permission = string | { identifier: string; allow?: { url: string }[] };
const capability = JSON.parse(capabilityRaw) as { permissions: Permission[] };
const scopes = capability.permissions.flatMap((p) =>
  typeof p === "object" && p.identifier === "opener:allow-open-url" ? (p.allow ?? []).map((a) => a.url) : [],
);
// Every scope ends in /*, so a scope allows what starts with the text before the star.
const allowed = (url: string) => scopes.some((s) => s.endsWith("/*") && url.startsWith(s.slice(0, -1)));

describe("the opener scope", () => {
  it.each(["beta", "development", "stable", "other"])("allows the SourceForge folder of the %s channel", (tag) => {
    expect([sourceforgeUrl(tag), allowed(sourceforgeUrl(tag))]).toEqual([sourceforgeUrl(tag), true]);
  });

  it("does not allow another SourceForge project", () => {
    expect(allowed("https://sourceforge.net/projects/other/files/")).toBe(false);
  });
});
