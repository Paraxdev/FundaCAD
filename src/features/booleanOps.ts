// Union, Subtract and Intersect are declared once so the ribbon, keys, right-click menu and selection toolbar
// all offer the same three. The names are the button words; the engine translates to OCCT's fuse/cut/common.

import { t, tEnglish, type MessageKey } from "../i18n";
import type { Feature } from "../types";

export type BooleanOp = Extract<Feature, { type: "boolean" }>["operation"];

export interface BooleanCommand {
  op: BooleanOp;
  /** The button word, also used in a refusal. A getter, so it follows a language switch. */
  readonly label: string;
  /** The same id in app/actions.ts and features/toolCapabilities.ts, which lets the selection toolbar run an offer. */
  action: string;
  /** Name in ui/icons.ts. */
  iconName: string;
}

const LABEL_KEY: Readonly<Record<BooleanOp, MessageKey>> = {
  union: "tool.union",
  subtract: "tool.subtract",
  intersect: "tool.intersect",
};

function command(op: BooleanOp, action: string, iconName: string): BooleanCommand {
  return {
    op,
    get label() {
      return t(LABEL_KEY[op]);
    },
    action,
    iconName,
  };
}

/** Declaration order is the offer order on every surface, most used first. */
export const BOOLEAN_COMMANDS: readonly BooleanCommand[] = [
  command("union", "boolean-union", "booleanUnion"),
  command("subtract", "boolean-subtract", "booleanSubtract"),
  command("intersect", "boolean-intersect", "booleanIntersect"),
];

export const BOOLEAN_LABEL: Readonly<Record<BooleanOp, string>> = {
  get union() {
    return t(LABEL_KEY.union);
  },
  get subtract() {
    return t(LABEL_KEY.subtract);
  },
  get intersect() {
    return t(LABEL_KEY.intersect);
  },
};

/** For the lines around a Boolean that are still English as a whole, so they do not mix two languages. */
export function booleanEnglish(op: BooleanOp): string {
  return tEnglish(LABEL_KEY[op]);
}

/** Null rather than throwing, since the dispatcher asks about every action. */
export function booleanOpOfAction(action: string): BooleanOp | null {
  return BOOLEAN_COMMANDS.find((c) => c.action === action)?.op ?? null;
}
