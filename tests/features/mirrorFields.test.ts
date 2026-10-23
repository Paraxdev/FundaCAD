import { describe, expect, it } from "vitest";
import {
  activate,
  addObjects,
  clearField,
  countLabel,
  enterStep,
  isReady,
  nextPick,
  pickLine,
  pickObject,
  startFields,
  switchField,
  type MirrorFields,
} from "../../src/features/mirrorFields";

type Axis = { a: [number, number]; b: [number, number] };
const AX: Axis = { a: [3.5, -2], b: [9.5, 6.25] };
const AX2: Axis = { a: [-7, 1.5], b: [4, 12.25] };

describe("startFields", () => {
  it("starts on Objects with nothing preselected", () => {
    expect(startFields<Axis>([])).toEqual({ objects: [], line: null, lineId: null, active: "objects" });
  });

  it("fills Objects from one or many preselected and starts on the line", () => {
    expect(startFields<Axis>(["e7"])).toEqual({ objects: ["e7"], line: null, lineId: null, active: "line" });
    expect(startFields<Axis>(["e7", "e2", "e9", "e2"])).toEqual({
      objects: ["e7", "e2", "e9"],
      line: null,
      lineId: null,
      active: "line",
    });
  });
});

describe("pickObject", () => {
  const empty = startFields<Axis>([]);

  it("adds one and many plain picks while Objects stays active", () => {
    const one = pickObject(empty, "e4");
    expect(one).toEqual({ objects: ["e4"], line: null, lineId: null, active: "objects" });
    expect(pickObject(pickObject(one, "e5"), "e9")).toEqual({
      objects: ["e4", "e5", "e9"],
      line: null,
      lineId: null,
      active: "objects",
    });
  });

  it("adds without moving whichever field is active", () => {
    const f: MirrorFields<Axis> = { objects: ["e1"], line: null, lineId: null, active: "line" };
    expect(pickObject(f, "e4")).toEqual({ objects: ["e1", "e4"], line: null, lineId: null, active: "line" });
  });

  it("toggles a picked object off without moving", () => {
    const f: MirrorFields<Axis> = { objects: ["e4", "e5"], line: null, lineId: null, active: "objects" };
    expect(pickObject(f, "e4")).toEqual({ objects: ["e5"], line: null, lineId: null, active: "objects" });
  });

  it("clears the line when the line itself is picked as an object", () => {
    const f: MirrorFields<Axis> = { objects: ["e1"], line: AX, lineId: "ax", active: "objects" };
    expect(pickObject(f, "ax")).toEqual({ objects: ["e1", "ax"], line: null, lineId: null, active: "objects" });
  });
});

describe("addObjects", () => {
  it("adds only new ids and stays on Objects", () => {
    const f = pickObject(startFields<Axis>([]), "e1");
    expect(addObjects(f, ["e1", "e2", "e3"])).toEqual({
      objects: ["e1", "e2", "e3"],
      line: null,
      lineId: null,
      active: "objects",
    });
  });

  it("returns the same fields when nothing is new", () => {
    const f = startFields<Axis>(["e1", "e2"]);
    expect(addObjects(f, ["e2", "e1"])).toBe(f);
    expect(addObjects(f, [])).toBe(f);
  });

  it("clears the line when a loop takes it in", () => {
    const f: MirrorFields<Axis> = { objects: [], line: AX, lineId: "ax", active: "objects" };
    expect(addObjects(f, ["e1", "ax"])).toEqual({ objects: ["e1", "ax"], line: null, lineId: null, active: "objects" });
  });
});

describe("pickLine", () => {
  it("sets the line, takes it out of Objects and goes back to Objects", () => {
    const f = startFields<Axis>(["e1", "ax", "e2"]);
    expect(pickLine(f, AX, "ax")).toEqual({ objects: ["e1", "e2"], line: AX, lineId: "ax", active: "objects" });
  });

  it("replaces an earlier line, and a plane without an id leaves Objects alone", () => {
    const f = activate(pickLine(startFields<Axis>(["e1"]), AX, "ax"), "line");
    expect(pickLine(f, AX2, null)).toEqual({ objects: ["e1"], line: AX2, lineId: null, active: "objects" });
  });
});

describe("enterStep", () => {
  it("moves from Objects to the empty line once something is picked", () => {
    const f: MirrorFields<Axis> = { objects: ["e1", "e2"], line: null, lineId: null, active: "objects" };
    expect(enterStep(f)).toEqual({ ...f, active: "line" });
  });

  it("stays on, or goes back to, Objects while nothing is picked", () => {
    const f: MirrorFields<Axis> = { objects: [], line: AX, lineId: null, active: "line" };
    expect(enterStep(f)).toEqual({ ...f, active: "objects" });
    const g = startFields<Axis>([]);
    expect(enterStep(g)).toBe(g);
  });

  it("applies once both fields hold something, whichever is active", () => {
    expect(enterStep({ objects: ["e1"], line: AX, lineId: null, active: "objects" })).toBe("commit");
    expect(enterStep({ objects: ["e1", "e2", "e3"], line: AX, lineId: "ax", active: "line" })).toBe("commit");
  });
});

describe("nextPick", () => {
  const at = (objects: string[], line: Axis | null, active: "objects" | "line") =>
    nextPick({ objects, line, lineId: null, active }, "line").toLowerCase();

  it("names what to mirror while Objects is active and the line is empty", () => {
    expect(at([], null, "objects")).toContain("pick what to mirror");
    expect(at([], null, "objects")).not.toContain("enter");
    expect(at(["e1"], null, "objects")).toContain("pick what to mirror");
    expect(at(["e1"], null, "objects")).toContain("enter");
  });

  it("names the mirror line or plane while that field is active", () => {
    expect(at(["e1"], null, "line")).toContain("pick the mirror line");
    expect(at(["e1"], AX, "line")).toContain("pick the mirror line");
    expect(nextPick({ objects: [], line: null, lineId: null, active: "line" }, "plane")).toContain("mirror plane");
  });

  it("offers Enter once ready", () => {
    expect(at(["e1", "e2"], AX, "objects")).toContain("enter to mirror");
  });
});

describe("field switching and clearing", () => {
  const full: MirrorFields<Axis> = { objects: ["e1", "e2"], line: AX, lineId: "ax", active: "line" };

  it("activates a field, and activating the active one changes nothing", () => {
    expect(activate(full, "objects")).toEqual({ ...full, active: "objects" });
    expect(activate(full, "line")).toBe(full);
  });

  it("switches back and forth", () => {
    expect(switchField(full).active).toBe("objects");
    expect(switchField(switchField(full))).toEqual(full);
  });

  it("clears each field and makes it active", () => {
    expect(clearField(full, "objects")).toEqual({ objects: [], line: AX, lineId: "ax", active: "objects" });
    expect(clearField({ ...full, active: "objects" }, "line")).toEqual({
      objects: ["e1", "e2"],
      line: null,
      lineId: null,
      active: "line",
    });
  });
});

describe("isReady and countLabel", () => {
  it("needs at least one object and a line", () => {
    expect(isReady({ objects: [], line: AX, lineId: null, active: "line" })).toBe(false);
    expect(isReady({ objects: ["e1"], line: AX, lineId: null, active: "line" })).toBe(true);
    expect(isReady({ objects: ["e1", "e2", "e3"], line: null, lineId: null, active: "line" })).toBe(false);
  });

  it("counts nothing, one and many", () => {
    expect(countLabel(0, "entity", "entities")).toBe("Nothing picked");
    expect(countLabel(1, "entity", "entities")).toBe("1 entity");
    expect(countLabel(3, "body", "bodies")).toBe("3 bodies");
  });
});
