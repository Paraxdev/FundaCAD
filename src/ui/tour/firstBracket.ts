// The guided first bracket.

import { t } from "../../i18n";
import { fmtKeys } from "../../input/platform";
import { keyHint } from "../../input/shortcuts";
import { singleKeysOn } from "../a11yPrefs";
import type { TourContext } from "./context";
import type { Tour, TourLines, TourStep } from "./tourRunner";

/** The new document's name, English in every language as an example's is, since a model's name is content. */
export const FIRST_BRACKET_NAME = "Bracket";

export const firstBracketLines: TourLines = {
  finished: () => t("tour.bracket.finished", { keys: fmtKeys("Ctrl+S") }),
  opened: () => t("tour.bracket.opened"),
  assistant: () => t("tour.bracket.assistant"),
  refused: () => t("tour.bracket.refused"),
};

/** The key an action is bound to now, none when it was unbound or is a single key while those are off. */
function keyOf(action: string): { has: "yes" | "no"; key: string } {
  const k = keyHint(action);
  const bare = k !== undefined && !k.startsWith("Ctrl+") && k.replace(/^Shift\+/, "").length === 1;
  return k === undefined || (bare && !singleKeysOn()) ? { has: "no", key: "" } : { has: "yes", key: fmtKeys(k) };
}

const extrudeDistance = (c: TourContext) => {
  const f = c.latest("extrude");
  return f?.type === "extrude" ? f.distance : undefined;
};

export const firstBracketSteps: TourStep[] = [
  {
    target: { ui: "action:sketch" },
    caption: () => t("tour.bracket.sketch", { tool: t("tool.sketch"), ...keyOf("sketch") }),
    done: (c) => c.planePick() || c.sketchOpen(),
  },
  {
    target: null,
    caption: () => t("tour.bracket.plane"),
    done: (c) => c.sketchOpen(),
  },
  {
    target: { ui: "action:line" },
    caption: () => t("tour.bracket.line", { tool: t("tool.line"), ...keyOf("line") }),
    done: (c) => c.sketchOpen() && (c.tool() === "line" || c.entities("line") > 0),
  },
  {
    target: null,
    caption: () => t("tour.bracket.draw"),
    // Six lines that miss the first corner are no profile, and every step after Extrude would wait on it.
    hint: (c) => (c.entities("line") >= 6 && c.regions() === 0 ? t("tour.bracket.drawOpen") : null),
    done: (c) => c.regions() > 0,
  },
  {
    target: { ui: "action:finish" },
    caption: () => t("tour.bracket.finish", { tool: t("rail.exitSketching") }),
    done: (c) => !c.sketchOpen() && c.features("sketch") > 0,
  },
  {
    target: { ui: "pick:extrude" },
    caption: () => t("tour.bracket.extrude", { tool: t("tool.extrude"), ...keyOf("extrude") }),
    done: (c) => c.tool() === "extrude" || c.features("extrude") > 0,
  },
  {
    target: null,
    caption: () => t("tour.bracket.depth"),
    done: (c) => c.features("extrude") > 0 && !c.building() && c.bodies() > 0,
  },
  {
    target: { ui: "pick:fillet" },
    caption: () => t("tour.bracket.fillet", { tool: t("tool.fillet"), ...keyOf("fillet") }),
    done: (c) => c.tool() === "fillet" || c.features("fillet") > 0,
  },
  {
    target: null,
    caption: () => t("tour.bracket.edge"),
    done: (c) => c.features("fillet") > 0,
  },
  {
    target: { ui: "pick:hole" },
    caption: () => t("tour.bracket.hole", { tool: t("tool.hole"), ...keyOf("hole") }),
    done: (c) => c.tool() === "hole" || c.features("hole") > 0,
  },
  {
    target: null,
    caption: () => t("tour.bracket.place"),
    done: (c) => c.features("hole") > 0,
  },
  {
    target: (c) => {
      const f = c.latest("extrude");
      return { ui: f ? `feature:${f.id}` : "#timeline" };
    },
    caption: () => t("tour.bracket.edit", { history: t("history.title"), tool: t("tool.extrude") }),
    enter: extrudeDistance,
    done: (c, was) => was !== undefined && extrudeDistance(c) !== undefined && extrudeDistance(c) !== was,
  },
  {
    target: { ui: "menu:File/Export…" },
    caption: () => t("tour.bracket.export", { ...keyOf("save"), file: t("menu.file"), export: t("menu.file.export") }),
    done: (c) => c.exportOpen(),
  },
  {
    target: null,
    caption: () => t("tour.bracket.done", { home: t("menu.file.home"), help: t("menu.help"), next: t("guide.next") }),
  },
];

export const firstBracketTour: Tour = { id: "first-bracket", steps: firstBracketSteps, lines: firstBracketLines };
