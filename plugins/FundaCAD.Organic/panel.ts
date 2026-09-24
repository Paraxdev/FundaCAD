// What the node panel draws, and the ways back to the tool. Module refs rather
// than a store, for the reason plugins/FundaCAD.Texture/panel.ts gives.

import { shallowRef } from "vue";
import type { NodeFeature, NodeValues } from "./nodeForm";

export interface NodeHandlers {
  select(id: string | null): void;
  setValue(id: string, field: keyof NodeValues & string, raw: string): string | null;
  setFeature(patch: Partial<Pick<NodeFeature, "blend" | "operation">>): void;
  removeNode(id: string): void;
  removeChain(index: number): void;
  setLinkNew(on: boolean): void;
  commit(): void;
  cancel(): void;
}

export interface NodeView {
  editing: boolean;
  feature: NodeFeature;
  selected: string | null;
  linkNew: boolean;
  /** Fields a parameter drives, as `nodeId.field`, shown locked. */
  bound: ReadonlySet<string>;
  error: string | null;
}

/** null while the tool is not running. Replaced, never mutated. */
export const view = shallowRef<NodeView | null>(null);

/** The reference size on the selected node, placed on screen by the tool. */
export const label = shallowRef<{ x: number; y: number; text: string } | null>(null);

let handlers: NodeHandlers | null = null;

export function open(v: NodeView, h: NodeHandlers): void {
  handlers = h;
  view.value = v;
}

export function update(v: NodeView): void {
  view.value = v;
}

export function close(): void {
  view.value = null;
  label.value = null;
  handlers = null;
}

export function act(): NodeHandlers | null {
  return handlers;
}
