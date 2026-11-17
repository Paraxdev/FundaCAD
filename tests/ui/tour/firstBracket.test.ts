// The guided first bracket's steps against a fake context, one state per step as a maker reaches it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { buildMenubar } from "../../../src/app/menubarDef";
import type { Engine } from "../../../src/app/engine";
import { setLanguage, t } from "../../../src/i18n";
import type { Feature } from "../../../src/types";
import { setA11yPref } from "../../../src/ui/a11yPrefs";
import { familyOf } from "../../../src/ui/controlRefs";
import { REF_FAMILIES } from "../../../src/ui/guide/controls";
import { menuName } from "../../../src/ui/menu";
import { modelRail, sketchRail } from "../../../src/ui/railDefs";
import type { TourContext } from "../../../src/ui/tour/context";
import { firstBracketSteps, firstBracketTour } from "../../../src/ui/tour/firstBracket";
import type { GuideTarget } from "../../../src/ui/guide/guideSession";
import toolRailVue from "../../../src/components/shell/ToolRail.vue?raw";
import timelineVue from "../../../src/components/shell/TimelineBar.vue?raw";

interface State {
  planePick: boolean;
  sketchOpen: boolean;
  tool: string | null;
  lines: number;
  regions: number;
  features: { id: string; type: string; distance?: number }[];
  bodies: number;
  building: boolean;
  exportOpen: boolean;
}

const EMPTY: State = {
  planePick: false,
  sketchOpen: false,
  tool: null,
  lines: 0,
  regions: 0,
  features: [],
  bodies: 0,
  building: false,
  exportOpen: false,
};

function ctxOf(s: Partial<State>): TourContext {
  const st = { ...EMPTY, ...s };
  const of = (type?: string) => st.features.filter((f) => !type || f.type === type);
  return {
    planePick: () => st.planePick,
    sketchOpen: () => st.sketchOpen,
    tool: () => st.tool,
    entities: (type) => (!type || type === "line" ? st.lines : 0),
    regions: () => st.regions,
    features: (type) => of(type).length,
    latest: (type) => (of(type).at(-1) as unknown as Feature) ?? null,
    bodies: () => st.bodies,
    building: () => st.building,
    exportOpen: () => st.exportOpen,
  };
}

const sketch = { id: "f1", type: "sketch" };
const extrude = { id: "f2", type: "extrude", distance: 25 };
const solid = { features: [sketch, extrude], bodies: 1 };
const filleted = { features: [sketch, extrude, { id: "f3", type: "fillet" }], bodies: 1 };
const holed = { features: [...filleted.features, { id: "f4", type: "hole" }], bodies: 1 };

/** The state each step waits for, in step order. */
const REACHED: Partial<State>[] = [
  { planePick: true },
  { sketchOpen: true, tool: "select" },
  { sketchOpen: true, tool: "line" },
  { sketchOpen: true, tool: "line", lines: 6, regions: 1 },
  { features: [sketch] },
  { features: [sketch], tool: "extrude" },
  solid,
  { ...solid, tool: "fillet" },
  filleted,
  { ...filleted, tool: "hole" },
  holed,
  { ...holed, features: holed.features.map((f) => (f.type === "extrude" ? { ...f, distance: 30 } : f)) },
  { ...holed, exportOpen: true },
];

const VOICE = [/[\u2013\u2014]/, / - /, /!/, /\bsimply\b/i, /\bjust\b/i];

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  setA11yPref("singleKeys", true);
});

describe("the guided first bracket", () => {
  it("has fourteen steps and ends on Next", () => {
    expect(firstBracketSteps).toHaveLength(14);
    expect(firstBracketTour.steps).toBe(firstBracketSteps);
    expect(firstBracketSteps.at(-1)!.done).toBeUndefined();
    expect(firstBracketSteps.slice(0, -1).every((s) => s.done)).toBe(true);
  });

  it.each([true, false])("speaks plainly in English with single keys %s", (on) => {
    setA11yPref("singleKeys", on);
    const lines = [
      ...firstBracketSteps.map((s) => s.caption()),
      t("tour.bracket.drawOpen"),
      ...Object.values(firstBracketTour.lines).map((l) => l()),
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/[{}]/);
      for (const rule of VOICE) expect(line, line).not.toMatch(rule);
    }
  });

  it("names a tool's key while single keys are on, and leaves it out while they are off", () => {
    setA11yPref("singleKeys", true);
    expect(firstBracketSteps[0]!.caption()).toBe("A part starts as a flat drawing. Click Sketch, or press S.");
    setA11yPref("singleKeys", false);
    expect(firstBracketSteps[0]!.caption()).toBe("A part starts as a flat drawing. Click Sketch.");
  });

  it.each(["de", "fr", "es", "ja", "zh-CN"])("fills every line in %s", async (code) => {
    await setLanguage(code);
    try {
      for (const on of [true, false]) {
        setA11yPref("singleKeys", on);
        for (const s of firstBracketSteps) {
          const line = s.caption();
          expect(line.length).toBeGreaterThan(0);
          expect(line, line).not.toMatch(/[{}]/);
        }
      }
    } finally {
      await setLanguage("system");
    }
  });

  it("passes no step on an empty document", () => {
    const empty = ctxOf({});
    firstBracketSteps
      .slice(0, -1)
      .forEach((s, i) => expect(s.done!(empty, s.enter?.(empty)), `step ${i + 1}`).toBe(false));
  });

  it("passes each step on its own state and not on the one before", () => {
    REACHED.forEach((own, i) => {
      const step = firstBracketSteps[i]!;
      const before = ctxOf(i === 0 ? {} : REACHED[i - 1]!);
      const was = step.enter?.(before);
      expect(step.done!(before, was), `step ${i + 1} before`).toBe(false);
      expect(step.done!(ctxOf(own), was), `step ${i + 1} own`).toBe(true);
    });
  });

  it("holds step 4 on an open L and says to close it", () => {
    const draw = firstBracketSteps[3]!;
    const open = ctxOf({ sketchOpen: true, tool: "line", lines: 6, regions: 0 });
    const closed = ctxOf({ sketchOpen: true, tool: "line", lines: 6, regions: 1 });
    expect(draw.done!(open, undefined)).toBe(false);
    expect(draw.done!(closed, undefined)).toBe(true);
    expect(draw.hint!(open)).toBe("The L is not closed yet, click its first corner again.");
    expect(draw.hint!(closed)).toBeNull();
    expect(draw.hint!(ctxOf({ sketchOpen: true, tool: "line", lines: 3 }))).toBeNull();
  });

  it("holds the depth step while the part builds or has no body", () => {
    const depth = firstBracketSteps[6]!;
    expect(depth.done!(ctxOf({ ...solid, building: true }), undefined)).toBe(false);
    expect(depth.done!(ctxOf({ ...solid, bodies: 0 }), undefined)).toBe(false);
  });

  it("passes the edit step only once the extrude's distance changed from the one it came up with", () => {
    const edit = firstBracketSteps[11]!;
    const was = edit.enter!(ctxOf(holed));
    expect(was).toBe(25);
    expect(edit.done!(ctxOf(holed), was)).toBe(false);
    expect(edit.done!(ctxOf(REACHED[11]!), was)).toBe(true);
    expect(edit.done!(ctxOf(REACHED[11]!), undefined)).toBe(false);
    expect(edit.enter!(ctxOf({}))).toBeUndefined();
  });

  it("points the edit step at the extrude in History, else at History itself", () => {
    const target = firstBracketSteps[11]!.target as (c: TourContext) => GuideTarget | null;
    expect(target(ctxOf(holed))).toEqual({ ui: "feature:f2" });
    expect(target(ctxOf({}))).toEqual({ ui: "#timeline" });
  });

  it("points only at refs the app has", () => {
    const refs = firstBracketSteps.flatMap((s) => {
      const targets = typeof s.target === "function" ? [s.target(ctxOf(holed)), s.target(ctxOf({}))] : [s.target];
      return targets.flatMap((g) => (g?.ui ? [g.ui] : []));
    });
    expect(refs).toEqual([
      "action:sketch",
      "action:line",
      "action:finish",
      "pick:extrude",
      "pick:fillet",
      "pick:hole",
      "feature:f2",
      "#timeline",
      "menu:File/Export…",
    ]);
    const prefixes = REF_FAMILIES.map(([p]) => p);
    for (const ref of refs)
      expect(
        prefixes.some((p) => ref.startsWith(p)),
        ref,
      ).toBe(true);

    const top = (rail: ReturnType<typeof modelRail>, action: string) =>
      rail.some((e) => e.kind === "tool" && e.action === action);
    expect(top(modelRail(), "sketch")).toBe(true);
    expect(top(sketchRail(), "line")).toBe(true);
    expect(toolRailVue).toContain('data-action="finish"');
    for (const tool of ["extrude", "fillet", "hole"]) expect(familyOf(tool, modelRail())?.pick).toBe(`pick:${tool}`);
    expect(timelineVue).toContain('id="timeline"');
    const file = buildMenubar({ ui: { home: { open: () => {} } } } as unknown as Engine).find(
      (m) => menuName(m) === "File",
    )!;
    expect(file.refName).toBe("File");
    expect(file.items.some((i) => i.refName === "Export…")).toBe(true);
  });
});
