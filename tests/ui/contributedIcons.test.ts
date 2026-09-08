// A plugin's mark, and the order it is resolved in.
//
// The rule this file exists for is the ORDER, and it is a judgement rather than
// a mechanism: a pack is a look the user chose for the whole application, so a
// plugin that shipped its own idea of a mark must not punch a hole in it. A
// plugin fills a name no pack has, which is what a tool the application does
// not have needs, and nothing else.
//
// The security note in ui/icons.ts is about this file too. Contributed markup
// reaches the DOM through Icon.vue's v-html, and it is safe on exactly the same
// terms core markup is: every one of these is a compile-time constant in a
// bundle whose code already runs with the whole of the application's reach.
// tests/components/vHtmlPolicy.test.ts is the other half.

import { afterEach, describe, expect, it } from "vitest";
import { iconPaths, resolveIconPaths, type IconPack } from "../../src/ui/icons";
import { contribute, resetContributions } from "../../src/plugins/contrib";

afterEach(() => resetContributions());

const pack = (id: string, paths: Record<string, string>): IconPack => ({ id, label: id, paths });

describe("resolveIconPaths, over a registry it is handed", () => {
  const packs = new Map([
    ["forge", pack("forge", { fillet: "<forge-fillet/>" })],
    ["anvil", pack("anvil", { fillet: "<anvil-fillet/>", close: "<anvil-close/>" })],
  ]);

  it("prefers the active pack, then the default", () => {
    expect(resolveIconPaths(packs, "anvil", "fillet", "forge")).toBe("<anvil-fillet/>");
    expect(resolveIconPaths(packs, "anvil", "close", "forge")).toBe("<anvil-close/>");
    // active pack has no such name -> the default pack's
    expect(resolveIconPaths(packs, "forge", "close", "anvil")).toBe("<anvil-close/>");
  });

  it("falls to a contributed mark only when no pack has the name", () => {
    const extra = { texture: "<plugin-texture/>" };
    expect(resolveIconPaths(packs, "forge", "texture", "anvil", extra)).toBe("<plugin-texture/>");
  });

  // The order rule, stated as a test. A plugin cannot restyle a mark the user's
  // chosen pack already draws.
  it("lets a pack the user chose win over a plugin", () => {
    const extra = { fillet: "<plugin-fillet/>" };
    expect(resolveIconPaths(packs, "anvil", "fillet", "forge", extra)).toBe("<anvil-fillet/>");
    expect(resolveIconPaths(packs, "forge", "fillet", "anvil", extra)).toBe("<forge-fillet/>");
  });

  // A name nothing knows is a typo at a call site. An empty <svg> keeps the
  // button the same size with the same label; a throw loses the panel.
  it("returns the empty string rather than throwing on a name nothing has", () => {
    expect(resolveIconPaths(packs, "forge", "nonesuch", "anvil", {})).toBe("");
  });
});

describe("iconPaths, against the live registry", () => {
  // The measurement that the mark really left the application. If this ever
  // starts returning markup with nothing contributed, a pack has grown a
  // `texture` entry and the plugin's own mark has quietly stopped being used.
  it("has no mark for the tool that became a plugin", () => {
    expect(iconPaths("texture")).toBe("");
  });

  it("draws it once the plugin contributes one, and stops when it goes", () => {
    const markup = '<rect x="4" y="4" width="16" height="16" rx="2"/>';
    const off = contribute("FundaCAD.Texture", { icons: { texture: markup } });
    expect(iconPaths("texture")).toBe(markup);
    off();
    expect(iconPaths("texture")).toBe("");
  });

  it("still draws the application's own marks with a plugin running", () => {
    contribute("FundaCAD.Texture", { icons: { texture: "<rect/>" } });
    expect(iconPaths("fillet")).not.toBe("");
    expect(iconPaths("check")).not.toBe("");
  });
});
