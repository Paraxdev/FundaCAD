import { t, tEnglish, type MessageKey } from "../i18n";
import { nameRef, nameText, type NameRef } from "../ui/featureMeta";
import type { CadDocument, Feature } from "../types";

/** A step's name as the document had it, spoken in the language of the moment. */
export type StepName = NameRef;

/** A label held as data and worded when it is read, so a language switch renames a waiting step. */
export interface LateStep {
  key: MessageKey;
  args?: Record<string, string | number>;
  step?: StepName;
}

export type StepLabel = string | LateStep;

export function stepText(label: StepLabel, english = false): string {
  if (typeof label === "string") return label;
  const args = label.step ? { ...label.args, step: nameText(label.step, english) } : label.args;
  return (english ? tEnglish : t)(label.key, args);
}

const late = (key: MessageKey): LateStep => ({ key });

export const STEP_LABEL = {
  edit: late("step.label.edit"),
  bodyVisibility: late("step.label.bodyVisibility"),
  planeVisibility: late("step.label.planeVisibility"),
  bodyName: late("step.label.bodyName"),
  referenceImage: late("step.label.referenceImage"),
  material: late("step.label.material"),
  colour: late("step.label.colour"),
  view: late("step.label.view"),
  restoreVersion: late("step.label.restoreVersion"),
  parameters: late("step.label.parameters"),
} as const;

// Walks instead of stringifying, which copied an import's inline BREP twice per compare: 4 ms against 9 ms on 300 steps with 5 MB.
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function movedLabel(before: readonly Feature[], after: readonly Feature[]): LateStep {
  const at = before.findIndex((f, i) => f.id !== after[i]!.id);
  const without = (list: readonly Feature[], id: string) => list.filter((f) => f.id !== id).map((f) => f.id);
  for (const id of [before[at]!.id, after[at]!.id]) {
    if (same(without(before, id), without(after, id))) {
      return {
        key: "step.label.move",
        step: nameRef(
          before.find((f) => f.id === id)!,
          before,
        ),
      };
    }
  }
  return { key: "step.label.moveMany", args: { n: before.filter((f, i) => f.id !== after[i]!.id).length } };
}

function paramLabel(before: CadDocument, after: CadDocument): LateStep | null {
  const read = (d: CadDocument, k: string) => d.paramDefs?.[k] ?? d.parameters?.[k];
  const names = new Set([
    ...Object.keys(before.paramDefs ?? before.parameters ?? {}),
    ...Object.keys(after.paramDefs ?? after.parameters ?? {}),
  ]);
  const changed = [...names].filter((k) => !same(read(before, k), read(after, k)));
  if (!changed.length) return null;
  return changed.length === 1 ? { key: "step.label.parameter", args: { name: changed[0]! } } : STEP_LABEL.parameters;
}

/** What a model step did, read off the document before and after it. */
export function stepLabel(before: CadDocument, after: CadDocument): LateStep {
  const was = before.features;
  const now = after.features;
  const nowIds = new Set(now.map((f) => f.id));
  const wasIds = new Set(was.map((f) => f.id));
  const removed = was.filter((f) => !nowIds.has(f.id));
  if (removed.length)
    return {
      key: "step.label.delete",
      args: { n: removed.length },
      ...(removed.length === 1 && { step: nameRef(removed[0]!, was) }),
    };
  const added = now.filter((f) => !wasIds.has(f.id));
  if (added.length)
    return added.length === 1
      ? { key: "step.label.named", step: nameRef(added[0]!, now) }
      : { key: "step.label.added", args: { n: added.length } };
  if (was.some((f, i) => f.id !== now[i]!.id)) return movedLabel(was, now);

  const edited = now.filter((f, i) => !same(was[i], f));
  if (edited.length > 1) return { key: "step.label.editMany", args: { n: edited.length } };
  if (edited.length === 1) {
    const at = now.indexOf(edited[0]!);
    const unnamed = (f: Feature) => ({ ...f, name: undefined });
    if (same(unnamed(was[at]!), unnamed(now[at]!))) return { key: "step.label.rename", step: nameRef(was[at]!, was) };
    // Lower case in English: it only follows Undo, Redo, Undid or Redid.
    return { key: "step.label.editOf", step: nameRef(now[at]!, now) };
  }
  return paramLabel(before, after) ?? STEP_LABEL.edit;
}
