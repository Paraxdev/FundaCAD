import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { MirrorFlow, LINE_LEFT_OBJECTS, LINE_REFUSED, type MirrorHost } from "../../src/sketch/mirrorFlow";
import { PROJECTED_FIXED_MSG } from "../../src/sketch/modify";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { MirrorPanelView } from "../../src/stores/toolPanels";

const v = (x: number, y: number) => new THREE.Vector2(x, y);

function sketch(): ResolvedEntity[] {
  return [
    { type: "line", id: "l1", x1: 12, y1: 1.5, x2: -4.25, y2: 7 },
    { type: "circle", id: "c1", radius: 2.75, x: 8, y: 9 },
    { type: "line", id: "ax", x1: 3.5, y1: -2, x2: 9.5, y2: 6.25, construction: true },
    { type: "arc", id: "a1", x1: 20, y1: 1, x2: 24, y2: 5, mx: 23.5, my: 2.5 },
    {
      type: "projected",
      id: "pr",
      source: { kind: "edge" },
      curve: { kind: "line", x1: 30, y1: -4, x2: 36, y2: 8.5 },
    } as unknown as ResolvedEntity,
    { type: "rectangle", id: "r1", width: 6, height: 4, x: -10, y: -6 },
  ];
}

const ON = {
  l1: v(3.875, 4.25),
  c1: v(10.75, 9),
  ax: v(6.5, 2.125),
  a1: v(23.5, 2.5),
  pr: v(33, 2.25),
  insideR1: v(-9.5, -5.25),
  empty: v(-30, 40),
};

function rig(pre: string[] = []) {
  const entities = sketch();
  const selected = new Set(pre);
  const log = {
    previews: [] as { copies: ResolvedEntity[]; line: string | null; hover: string | null }[],
    panels: [] as (MirrorPanelView | null)[],
    prompts: [] as string[],
    warns: [] as string[],
    afterModify: 0,
    armSelect: 0,
  };
  let n = 0;
  const host: MirrorHost = {
    entities: () => entities,
    selected: () => selected,
    pickTol: () => 0.5,
    textAt: (p) => entities.find((e) => e.type === "text" && Math.hypot(p.x - e.x, p.y - e.y) < 2) ?? null,
    loopIdsAt: (p) => (p.x > -13 && p.x < -7 && p.y > -8 && p.y < -4 ? ["r1"] : []),
    showPreview: (copies, line, hover) =>
      log.previews.push({ copies, line: line?.id ?? null, hover: hover?.id ?? null }),
    showPanel: (view) => log.panels.push(view),
    prompt: (t) => log.prompts.push(t),
    warn: (m) => log.warns.push(m),
    refreshActive: () => {},
    afterModify: () => log.afterModify++,
    armSelect: () => log.armSelect++,
    newId: () => `n${++n}`,
  };
  const flow = new MirrorFlow(host);
  const panel = () => log.panels.at(-1) ?? null;
  return { flow, entities, selected, log, panel };
}

const round = (e: ResolvedEntity) =>
  JSON.parse(JSON.stringify(e, (_k, x) => (typeof x === "number" ? Math.round(x * 1e6) / 1e6 + 0 : x)));

describe("MirrorFlow start", () => {
  it("fills Objects from the selection and drops projected geometry with a warning", () => {
    const r = rig(["c1", "pr", "l1"]);
    r.flow.begin();
    expect(r.log.warns).toEqual([PROJECTED_FIXED_MSG]);
    expect([...r.selected]).toEqual(["c1", "l1"]);
    const p = r.panel()!;
    expect(p.active).toBe("line");
    expect(p.fields.map((f) => [f.key, f.value, f.filled])).toEqual([
      ["objects", "2 entities", true],
      ["line", "Nothing picked", false],
    ]);
    expect(p.ready).toBe(false);
  });

  it("starts on Objects with no warning when nothing is selected", () => {
    const r = rig();
    r.flow.begin();
    expect(r.log.warns).toEqual([]);
    expect(r.panel()!.active).toBe("objects");
    expect(r.flow.running).toBe(true);
  });
});

describe("MirrorFlow picking", () => {
  it("refuses an arc as the mirror line and changes nothing", () => {
    const r = rig(["c1"]);
    r.flow.begin();
    const before = r.panel();
    r.flow.click(ON.a1, false);
    expect(r.log.prompts.at(-1)).toBe(LINE_REFUSED);
    expect(r.panel()!.fields).toEqual(before!.fields);
    expect(r.flow.ready).toBe(false);
  });

  it("takes a construction line, previews the copies and the line", () => {
    const r = rig(["c1", "l1"]);
    r.flow.begin();
    r.flow.click(ON.ax, false);
    expect(r.panel()!.fields[1]).toMatchObject({ value: "Construction line", filled: true });
    expect(r.flow.ready).toBe(true);
    const last = r.log.previews.at(-1)!;
    expect(last.line).toBe("ax");
    expect(last.copies.map((c) => c.type)).toEqual(["line", "circle"]);
  });

  it("takes a projected straight edge as the line", () => {
    const r = rig(["c1"]);
    r.flow.begin();
    r.flow.click(ON.pr, false);
    expect(r.panel()!.fields[1]!.value).toBe("Projected edge");
  });

  it("refuses a projected object with a warning", () => {
    const r = rig();
    r.flow.begin();
    r.flow.click(ON.pr, false);
    expect(r.log.warns).toEqual([PROJECTED_FIXED_MSG]);
    expect([...r.selected]).toEqual([]);
    expect(r.panel()!.active).toBe("objects");
  });

  it("moves to the line after a plain pick and stays for a Shift pick", () => {
    const shift = rig();
    shift.flow.begin();
    shift.flow.click(ON.c1, true);
    shift.flow.click(ON.l1, true);
    expect([...shift.selected]).toEqual(["c1", "l1"]);
    expect(shift.panel()!.active).toBe("objects");
    const plain = rig();
    plain.flow.begin();
    plain.flow.click(ON.c1, false);
    expect(plain.panel()!.active).toBe("line");
    plain.flow.click(ON.l1, true);
    expect([...plain.selected]).toEqual(["c1", "l1"]);
    expect(plain.panel()!.active).toBe("line");
  });

  it("adds the curves around a closed area clicked inside", () => {
    const r = rig();
    r.flow.begin();
    r.flow.click(ON.insideR1, false);
    expect([...r.selected]).toEqual(["r1"]);
    expect(r.panel()!.active).toBe("line");
    r.flow.activate("objects");
    r.flow.click(ON.empty, false);
    expect([...r.selected]).toEqual(["r1"]);
  });

  it("takes the line out of Objects when it becomes the line", () => {
    const r = rig(["ax", "c1"]);
    r.flow.begin();
    r.flow.click(ON.ax, false);
    expect([...r.selected]).toEqual(["c1"]);
    expect(r.panel()!.fields[0]!.value).toBe("1 entity");
    expect(r.log.prompts.at(-1)).toBe(LINE_LEFT_OBJECTS);
  });

  it("says nothing extra for a line that was not in Objects", () => {
    const r = rig(["c1"]);
    r.flow.begin();
    r.flow.click(ON.ax, false);
    expect(r.panel()!.fields[0]!.value).toBe("1 entity");
    expect(r.log.prompts.at(-1)).not.toBe(LINE_LEFT_OBJECTS);
    expect(r.log.prompts.at(-1)).toContain("Mirror line");
  });

  it("lights only lines on hover in the line field, anything in Objects", () => {
    const r = rig(["c1"]);
    r.flow.begin();
    r.flow.hover(ON.l1);
    expect(r.log.previews.at(-1)!.hover).toBe("l1");
    r.flow.hover(ON.c1);
    expect(r.log.previews.at(-1)!.hover).toBe(null);
    r.flow.activate("objects");
    r.flow.hover(ON.c1);
    expect(r.log.previews.at(-1)!.hover).toBe("c1");
  });
});

describe("MirrorFlow text", () => {
  const text: ResolvedEntity = {
    type: "text",
    id: "t1",
    text: "R2",
    x: -14,
    y: 11.5,
    height: 3.5,
    angle: 12,
    font: "Sans",
  };
  const ON_TEXT = v(-13.25, 12);

  it("a click on a text adds it to Objects and the copy keeps its glyphs upright", () => {
    const r = rig();
    r.entities.push(text);
    r.flow.begin();
    r.flow.click(ON_TEXT, false);
    expect([...r.selected]).toEqual(["t1"]);
    r.flow.click(ON.ax, false);
    expect(r.flow.commit()).toBe(true);
    const copy = r.entities.at(-1)!;
    expect(round(copy)).toEqual(round({ ...text, id: "n1", x: 21.7351351351, y: -14.4891891892 }));
  });

  it("hover lights a text in Objects, a text is refused as the mirror line", () => {
    const r = rig(["c1"]);
    r.entities.push(text);
    r.flow.begin();
    r.flow.hover(ON_TEXT);
    expect(r.log.previews.at(-1)!.hover).toBe(null);
    r.flow.click(ON_TEXT, false);
    expect(r.log.prompts.at(-1)).toBe(LINE_REFUSED);
    r.flow.activate("objects");
    r.flow.hover(ON_TEXT);
    expect(r.log.previews.at(-1)!.hover).toBe("t1");
  });
});

describe("MirrorFlow commit and cancel", () => {
  it("adds exactly the reflected copies as one step and arms Select", () => {
    const r = rig(["c1", "l1"]);
    r.flow.begin();
    r.flow.click(ON.ax, false);
    expect(r.entities).toHaveLength(6);
    expect(r.flow.commit()).toBe(true);
    expect(r.entities.slice(6).map(round)).toEqual([
      { type: "line", id: "n1", x1: 4.210811, y1: 7.164865, x2: 14.45, y2: -6.6 },
      { type: "circle", id: "n2", radius: 2.75, x: 12.578378, y: 5.67027 },
    ]);
    expect(r.log.afterModify).toBe(1);
    expect(r.log.armSelect).toBe(1);
    expect([...r.selected]).toEqual([]);
    expect(r.panel()).toBeNull();
    expect(r.flow.running).toBe(false);
  });

  it("commits nothing without a line", () => {
    const r = rig(["c1"]);
    r.flow.begin();
    expect(r.flow.commit()).toBe(false);
    expect(r.entities).toHaveLength(6);
    expect(r.log.afterModify).toBe(0);
    expect(r.flow.running).toBe(true);
  });

  it("cancels without touching the sketch and clears the preview", () => {
    const r = rig(["c1"]);
    r.flow.begin();
    r.flow.click(ON.ax, false);
    const before = JSON.stringify(sketch());
    r.flow.cancel();
    expect(JSON.stringify(r.entities)).toBe(before);
    expect(r.log.previews.at(-1)).toEqual({ copies: [], line: null, hover: null });
    expect(r.panel()).toBeNull();
    expect([...r.selected]).toEqual(["c1"]);
    expect(r.log.armSelect).toBe(1);
  });

  it("cancel gives back what was selected before, not what was picked since", () => {
    const r = rig(["c1", "pr", "l1"]);
    r.flow.begin();
    r.flow.clear("objects");
    r.flow.click(ON.a1, true);
    r.flow.cancel();
    expect([...r.selected]).toEqual(["l1", "c1"]);
  });

  it("cancel with nothing selected before leaves nothing selected", () => {
    const r = rig();
    r.flow.begin();
    r.flow.click(ON.l1, false);
    r.flow.cancel();
    expect([...r.selected]).toEqual([]);
  });

  it("starts a second run clean after the first", () => {
    const r = rig(["c1"]);
    r.flow.begin();
    r.flow.click(ON.ax, false);
    const firstId = r.panel()!.id;
    r.flow.commit();
    r.selected.add("l1");
    r.flow.begin();
    const p = r.panel()!;
    expect(p.id).not.toBe(firstId);
    expect(p.fields.map((f) => f.value)).toEqual(["1 entity", "Nothing picked"]);
    expect(r.log.previews.at(-1)).toEqual({ copies: [], line: null, hover: null });
  });

  it("clears a field from the panel and makes it active", () => {
    const r = rig(["c1"]);
    r.flow.begin();
    r.flow.click(ON.ax, false);
    r.panel()!.onClear("objects");
    expect([...r.selected]).toEqual([]);
    expect(r.panel()!.active).toBe("objects");
    expect(r.panel()!.ready).toBe(false);
  });
});
