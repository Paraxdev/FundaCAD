import { beforeEach, describe, expect, it } from "vitest";
import { covered, findControl, HarnessError, stamp, toolPath } from "../../src/harness/locate";
import { walkControls } from "../../src/harness/screenTree";
import type { RailEntry } from "../../src/ui/railDefs";
import { mountApp, rect } from "./fixture";

beforeEach(() => mountApp());

const walk = () => walkControls(document, { rect });
const fail = (target: string): HarnessError => {
  try {
    findControl(walk(), target);
  } catch (e) {
    return e as HarnessError;
  }
  throw new Error(`"${target}" was found`);
};

describe("findControl", () => {
  it("takes a ref as is", () => {
    expect(findControl(walk(), "family:cat:CREATE").label).toBe("Create");
    expect(findControl(walk(), "#undo-btn").ref).toBe("#undo-btn");
  });

  it("matches a label exactly, then by prefix, ignoring the key hint", () => {
    expect(findControl(walk(), "sketch").ref).toBe("action:sketch");
    expect(findControl(walk(), "Extrude 1").ref).toBe("feature:e1");
    expect(findControl(walk(), "Mod").ref).toBe("family:cat:MODIFY");
  });

  it("leaves eyes out of a label, they share their row's name and go by eye:<id>", () => {
    expect(findControl(walk(), "Robot").ref).toBe("folder:n:f1/0");
    expect(findControl(walk(), "Plate").ref).toBe("item:body1");
    expect(findControl(walk(), "eye:body1").role).toBe("eye");
  });

  it("lists the refs when a label matches several", () => {
    const e = fail("Cancel");
    expect(e.kind).toBe("Ambiguous");
    expect(e.message).toContain('text:"Cancel"#1');
    expect(findControl(walk(), "Cancel#2").el).toBe(document.querySelectorAll("button.plain")[1]);
  });

  it("refuses a disabled control and says so", () => {
    const e = fail("Measure");
    expect(e.kind).toBe("Disabled");
    expect(e.message).toBe('action:measure "Measure (I)" is disabled');
  });

  it("suggests near misses when nothing matches", () => {
    const e = fail("Extrud 2");
    expect(e.kind).toBe("NotFound");
    expect(e.message).toMatch(/^no visible control "Extrud 2": did you mean feature:e1 "Extrude 1"/);
    expect(fail("action:nope").kind).toBe("NotFound");
  });

  it("leaves out hints that only share a few letters or the middle of a word", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<nav id="toolrail"><button data-action="isolate">Isolate Off</button><button data-group="print">3D Printing Toolbox</button></nav>',
    );
    expect(fail("isometric").message).toBe('no visible control "isometric"');
    expect(fail("Box").message).toBe('no visible control "Box"');
    expect(fail("Tool").message).toContain('group:print "3D Printing Toolbox"');
  });

  it("says when History shows only what relates to the selection", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<button class="timeline-related on" data-testid="history-related">Related to Selection · 1</button>',
    );
    expect(fail("feature:f9").message).toBe(
      'no visible control "feature:f9", History shows only what relates to' +
        " the selection, press Escape to clear the selection or click testid:history-related",
    );
  });

  it("hints a missing value field with the fields on screen, or says no value box is open", () => {
    expect(fail("field:size").message).toContain('did you mean field:angle "Angle"');
    document.querySelectorAll(".dim-input").forEach((e) => e.remove());
    expect(fail("field:angle").message).toBe(
      'no visible control "field:angle", no value box is open, the tool may still be waiting for a pick',
    );
  });

  it("hints a missing menu item with the items of that menu", () => {
    const e = fail("menu:Edit/Nope");
    expect(e.candidates).toEqual(['menu:Edit/Preferences... "Preferences..."']);
  });

  it("finds a disabled control when asked to", () => {
    expect(findControl(walk(), "Measure", { disabled: true }).ref).toBe("action:measure");
  });
});

describe("stamp", () => {
  it("moves the one mark to the newest element", () => {
    const a = document.querySelector("#undo-btn")!;
    const b = document.querySelector("#redo-btn")!;
    stamp(a);
    const id = stamp(b);
    expect(a.hasAttribute("data-harness-target")).toBe(false);
    expect(b.getAttribute("data-harness-target")).toBe(id);
  });
});

describe("toolPath", () => {
  const rail: RailEntry[] = [
    { kind: "tool", action: "sketch", label: "Sketch", icon: "sketch" },
    {
      kind: "family",
      id: "cat:CREATE",
      label: "Create",
      icon: "extrude",
      style: "category",
      items: [{ kind: "tool", action: "extrude", label: "Extrude", icon: "extrude" }],
    },
    {
      kind: "family",
      id: "fam:circle",
      label: "Circle",
      icon: "circle",
      style: "variants",
      items: [{ kind: "tool", action: "circle3", label: "3 point circle", icon: "circle" }],
    },
  ];

  it("clicks a visible tool straight away", () => {
    expect(toolPath(walk(), "Sketch", "model", rail)).toEqual([{ ref: "action:sketch", button: "left" }]);
  });

  it("opens a category flyout first", () => {
    expect(toolPath(walk(), "Extrude", "model", rail)).toEqual([
      { ref: "family:cat:CREATE", button: "left" },
      { ref: "pick:extrude", button: "left" },
    ]);
  });

  it("opens a variant family with a right click", () => {
    expect(toolPath(walk(), "3 point", "sketch", rail)[0]).toEqual({ ref: "family:fam:circle", button: "right" });
  });

  it("says where tools live when no family has it", () => {
    expect(() => toolPath(walk(), "Loft", "model", rail)).toThrow(
      'no tool "Loft" in the rail: click a family to list its tools (family:cat:CREATE "Create",' +
        ` family:cat:MODIFY "Modify"), a tool's own choices, such as the shapes of Primitive, show once it starts`,
    );
  });
});

describe("covered", () => {
  const box = (w: number) => {
    const el = document.createElement("button");
    el.getBoundingClientRect = () => ({ left: 10, top: 10, width: w, height: w }) as DOMRect;
    const inner = el.appendChild(document.createElement("span"));
    const parent = document.createElement("div");
    parent.appendChild(el);
    return { el, inner, parent };
  };
  const at = (top: Element | null) => ({ elementFromPoint: () => top }) as unknown as Document;

  it("tells when another element is drawn over the middle", () => {
    const { el } = box(20);
    expect(covered(el, at(document.createElement("div")))).toBe(true);
  });

  it("leaves the element, its children and its parents alone", () => {
    const { el, inner, parent } = box(20);
    expect(covered(el, at(el))).toBe(false);
    expect(covered(el, at(inner))).toBe(false);
    expect(covered(el, at(parent))).toBe(false);
    expect(covered(el, at(null))).toBe(false);
    expect(covered(box(0).el, at(document.createElement("div")))).toBe(false);
  });
});
