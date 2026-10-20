import { beforeEach, describe, expect, it } from "vitest";
import { matchName, screenLines, walkControls } from "../../src/harness/screenTree";
import { mountApp, rect } from "./fixture";

beforeEach(() => mountApp());

const refs = () => walkControls(document, { rect }).controls.map((c) => c.ref);

describe("walkControls", () => {
  it("skips hidden, inert and closed menu controls", () => {
    const r = refs();
    expect(r).not.toContain("field:distance");
    expect(r).not.toContain('text:"Behind Home"');
    expect(r).not.toContain("menu:File/Open...");
    expect(r).toContain("menu:Edit/Preferences...");
  });

  it("builds a ref from each hook the DOM has", () => {
    expect(refs()).toEqual(expect.arrayContaining([
      "#undo-btn", "#docname", "action:sketch", "family:cat:CREATE", "feature:e1",
      "field:angle", "item:body1", "eye:body1", "ctx:Rename", "menu:File", "#prompt", 'text:"Cancel"',
    ]));
  });

  it("reads labels without key hints and flags state", () => {
    const c = walkControls(document, { rect }).controls;
    const by = (ref: string) => c.find((x) => x.ref === ref)!;
    expect(by("ctx:Rename").label).toBe("Rename");
    expect(by("feature:e1").flags).toContain("selected");
    expect(by("#redo-btn").flags).toContain("disabled");
    expect(by("#docname").flags).toContain("dirty");
    expect(by("#docname").label).toBe("Untitled");
    expect(by("field:angle").flags).toContain('= "3 deg"');
    expect(by("menu:Edit/Preferences...").label).toBe("Preferences...");
  });

  it("counts rows scrolled out of their list", () => {
    const w = walkControls(document, { rect });
    expect(w.controls.map((c) => c.ref)).not.toContain("item:body2");
    expect(w.more.items).toBe(2);
  });
});

describe("screenLines", () => {
  it("groups by region with a header and a more line", () => {
    const { lines } = screenLines(walkControls(document, { rect }));
    const items = lines.findIndex((l) => l[0] === 0 && l[1] === "items");
    expect(lines[items + 1]![1]).toBe("item:body1");
    expect(lines.find((l) => l[2] === "more")![3]).toBe("2 more");
    expect(lines.find((l) => l[1] === "toolrail")![3]).toBe("mode=model");
  });

  it("caps the lines and says how many were left out", () => {
    const all = screenLines(walkControls(document, { rect })).lines.length;
    const { lines, truncated } = screenLines(walkControls(document, { rect }), { max: 5 });
    expect(lines).toHaveLength(5);
    expect(truncated).toBe(all - 5);
  });

  it("reads one region", () => {
    const { lines } = screenLines(walkControls(document, { rect }), { region: "valuebox" });
    expect(lines.map((l) => l[1])).toEqual(["valuebox", "field:angle", "text:\"Confirm\""]);
  });
});

describe("matchName", () => {
  it("drops a trailing key hint and case", () => {
    expect(matchName("Extrude (E)")).toBe("extrude");
    expect(matchName("  Press  Pull (Q) ")).toBe("press pull");
  });
});
