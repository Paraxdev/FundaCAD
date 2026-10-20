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

  it("names a folder with no element id by its tree key, and an eye by its row", () => {
    const c = walkControls(document, { rect }).controls;
    const by = (ref: string) => c.find((x) => x.ref === ref)!;
    expect(by("folder:n:f1/0").label).toBe("Robot");
    expect(by("folder:n:f1/0").flags).toContain("closed");
    expect(by("eye:n:f1/0").label).toBe("Robot");
    expect(by("eye:n:f1/0").flags).toEqual(["hidden"]);
    expect(by("eye:body1").label).toBe("Plate");
    expect(by("eye:body1").flags).toEqual(["visible"]);
  });

  it("names a choice by its label, without the hint under it", () => {
    document.body.insertAdjacentHTML("beforeend",
      '<div class="choice-backdrop"><button class="choice-btn"><span>Box</span><small>l×w×h</small></button></div>');
    const box = walkControls(document, { rect }).controls.find((c) => c.ref.startsWith("choice:"))!;
    expect([box.ref, box.label]).toEqual(["choice:Box", "Box"]);
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
    expect(lines.slice(items + 1, items + 5).map((l) => l[1])).toContain("item:body1");
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
