// The three booleans, held to being three of everything.
//
// They replaced one command that opened a dialog, and that is only an
// improvement if all three are equally reachable. The way it regresses is a
// surface learning about two of them, or about a third under a name nothing
// else uses — a ribbon button whose action nobody dispatches, a toolbar offer
// with no icon, a key the keymap does not bind. Each of those ships looking
// fine and does nothing when clicked.

import { describe, it, expect } from "vitest";
import { BOOLEAN_COMMANDS, BOOLEAN_LABEL, booleanOpOfAction } from "../../src/features/booleanOps";
import { TOOL_CAPABILITIES, TOOL_IDS, applicableTools } from "../../src/features/toolCapabilities";
import { SHORTCUTS, keyHint } from "../../src/input/shortcuts";
import { MODEL, leavesOf } from "../../src/ui/ribbonDefs";
import { iconPaths } from "../../src/ui/icons";
import { selectionOffers, toolbarOffers } from "../../src/ui/selectionTools";
import { FEATURE_CHOICE_FIELDS, FEATURE_TOGGLE_FIELDS } from "../../src/document/optionFields";
import { featureMeta } from "../../src/ui/featureMeta";
import { allCommands } from "../../src/ui/commands";

const ACTIONS = BOOLEAN_COMMANDS.map((c) => c.action);

describe("the inventory", () => {
  it("is three, and they are union, subtract and intersect", () => {
    expect(BOOLEAN_COMMANDS.map((c) => c.op)).toEqual(["union", "subtract", "intersect"]);
  });

  it("round-trips every action id back to its operation", () => {
    for (const c of BOOLEAN_COMMANDS) expect(booleanOpOfAction(c.action)).toBe(c.op);
    // ...and claims nothing it does not own. The dispatcher asks this about
    // EVERY action in the app, so a loose match would swallow a command.
    expect(booleanOpOfAction("extrude")).toBeNull();
    expect(booleanOpOfAction("split")).toBeNull();
    expect(booleanOpOfAction("")).toBeNull();
  });

  it("draws a mark for each, and three different ones", () => {
    const marks = BOOLEAN_COMMANDS.map((c) => iconPaths(c.iconName));
    for (const [i, m] of marks.entries()) {
      // iconPaths returns "" for a name no pack defines rather than throwing, so
      // a typo here ships as an invisible button that still takes clicks.
      expect(m, BOOLEAN_COMMANDS[i]!.iconName).not.toBe("");
    }
    // They are one drawing seen three ways — same circles, different region
    // shaded — so identical markup is a real hazard rather than a far-fetched
    // one, and it would put three buttons you cannot tell apart on the bar.
    expect(new Set(marks).size).toBe(3);
  });

  it("agrees with itself about the words", () => {
    for (const c of BOOLEAN_COMMANDS) expect(BOOLEAN_LABEL[c.op]).toBe(c.label);
  });
});

describe("every surface carries all three", () => {
  it("the capability table, as tools a two-body selection can feed", () => {
    for (const a of ACTIONS) {
      expect(TOOL_IDS, a).toContain(a);
      expect(TOOL_CAPABILITIES[a as (typeof TOOL_IDS)[number]].min).toBe(2);
    }
    // One body is not enough, two are. The minimum is the reason: a boolean
    // needs something to boolean WITH, and offering it off a single pick is an
    // offer that cannot be taken.
    expect(applicableTools({ body: 1 }).filter((t) => ACTIONS.includes(t))).toEqual([]);
    expect(applicableTools({ body: 2 }).filter((t) => ACTIONS.includes(t))).toEqual(ACTIONS);
  });

  it("the hover bar, uncapped", () => {
    // This is the affordance the split into three exists for: two bodies
    // selected, three answers one click away. The old single Combine put a
    // question there instead.
    const bar = toolbarOffers({ body: 2 }).map((o) => o.tool);
    for (const a of ACTIONS) expect(bar, a).toContain(a);
    expect(selectionOffers({ body: 1 }).filter((o) => ACTIONS.includes(o.tool)).every((o) => !o.enabled))
      .toBe(true);
  });

  it("the ribbon, on one split button", () => {
    const model = MODEL.flatMap((g) => g.items);
    const family = model.find((it) => "children" in it && it.label === "Boolean");
    expect(family).toBeDefined();
    expect(leavesOf(family!).map((t) => t.action)).toEqual(ACTIONS);
    // Split Body left that family: it cuts ONE body with a plane, where a
    // boolean is two bodies meeting, and it was filed with Combine only because
    // both change how many bodies there are.
    expect(model.some((it) => !("children" in it) && it.action === "split")).toBe(true);
  });

  it("the keymap, with a modifier that does not collide", () => {
    for (const a of ACTIONS) {
      const s = SHORTCUTS.find((x) => x.action === a);
      expect(s, a).toBeDefined();
      expect(s!.ctrl, a).toBe(true);
      expect(keyHint(a), a).toBe(`Ctrl+${s!.key.toUpperCase()}`);
      // CONTROL: the same bare letter is a different command, and all three of
      // them are taken (U is Clean Up, B is Chamfer, I is Measure). Without the
      // modifier being part of the match, pressing B would chamfer OR subtract
      // depending on table order.
      const bare = SHORTCUTS.find((x) => x.key === s!.key && !x.ctrl && x.context === "model");
      expect(bare, `bare ${s!.key}`).toBeDefined();
      expect(bare!.action).not.toBe(a);
    }
  });

  it("the command palette", () => {
    const names = allCommands().map((c) => c.id);
    for (const a of ACTIONS) expect(names, a).toContain(a);
  });
});

describe("the feature it makes", () => {
  it("names itself after the operation, not after its type", () => {
    // A history column reading "Boolean, Boolean, Boolean" over three different
    // operations is one you cannot skim, which is the whole reason featureMeta
    // takes a feature rather than a type.
    for (const c of BOOLEAN_COMMANDS) {
      expect(featureMeta({ type: "boolean", operation: c.op }).label).toBe(c.label);
      expect(featureMeta({ type: "boolean", operation: c.op }).icon).toBe(c.iconName);
    }
    // An operation this build has never heard of still renders as something.
    expect(featureMeta({ type: "boolean", operation: "nonsense" }).label).toBeTruthy();
  });

  it("stays editable afterwards: the operation is a row, keeping originals is a switch", () => {
    const choices = FEATURE_CHOICE_FIELDS["boolean"] ?? [];
    const op = choices.find((c) => c.field === "operation");
    expect(op).toBeDefined();
    expect(op!.options.map((o) => o.value)).toEqual(BOOLEAN_COMMANDS.map((c) => c.op));
    expect(op!.fallback).toBe("union");

    const toggles = FEATURE_TOGGLE_FIELDS["boolean"] ?? [];
    const keep = toggles.find((t) => t.field === "keepOriginals");
    expect(keep).toBeDefined();
    // Off by default: a boolean consuming its tools is what the operation means
    // and what leaves a browser tree you can read.
    expect(keep!.fallback).toBe(false);
  });
});
