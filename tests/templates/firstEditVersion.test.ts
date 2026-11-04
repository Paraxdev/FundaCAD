// A version saved straight after opening an example, then one edit and the next version: that version holds the edit
// and nothing the maker did not do.
import { describe, expect, it, vi } from "vitest";
import { TEMPLATES, templateText } from "../../src/templates";
import { diffTrees, versionById } from "../../src/document/versions";
import type { Feature } from "../../src/types";
import { box, freshStore } from "../document/storeKit";

vi.stubGlobal("window", globalThis);

async function openExample(id: string) {
  const s = freshStore();
  s.load(await templateText(id));
  return s;
}

function diffOfHead(s: ReturnType<typeof freshStore>) {
  const repo = s.versionRepo!;
  const head = versionById(repo, repo.branches[repo.current]!)!;
  return diffTrees(repo, versionById(repo, head.parent!)!.tree, head.tree);
}

describe("the first edit of an opened example", () => {
  it("is the only change in the Plate's next version", async () => {
    const s = await openExample("plate");
    expect(s.saveVersion("first plate")).not.toBeNull();
    s.updateFeature("plate", { name: "Base plate" } as Partial<Feature>);
    expect(s.changesSinceVersion()).toEqual({ added: [], removed: [], changed: ["plate"], settings: false });
    expect(s.saveVersion("renamed")).not.toBeNull();
    expect(diffOfHead(s)).toEqual({ added: [], removed: [], changed: ["plate"], settings: false });
  });

  for (const t of TEMPLATES) {
    it(`adds only the new feature to ${t.name}'s next version`, async () => {
      const s = await openExample(t.id);
      s.saveVersion("as opened");
      s.addFeature(box("extra", 4.25));
      s.saveVersion("one more block");
      expect(diffOfHead(s)).toEqual({ added: ["extra"], removed: [], changed: [], settings: false });
    });
  }
});
