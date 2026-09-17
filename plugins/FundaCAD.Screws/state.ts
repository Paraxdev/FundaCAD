// The library window's state, shared by the panel, the drop on the viewport and the body menu.

import { ref, shallowRef } from "vue";
import { loadLibrary, newFastenerId, saveLibrary, type UserFastener } from "./library";
import type { ItemChoice } from "./catalogue";
import type { FastenerSpec } from "./spec";

export const PLUGIN_ID = "FundaCAD.Screws";
export const GENERATOR = "fastener";
export const DRAG_MIME = "application/x-fundacad-fastener";

export const open = ref(false);
export const tab = ref<"catalogue" | "custom">("catalogue");

export type Selection =
  | { source: "catalogue"; choice: ItemChoice }
  | { source: "custom"; id: string }
  | { source: "document"; spec: FastenerSpec };

export const selection = shallowRef<Selection | null>(null);

export const userLibrary = shallowRef<UserFastener[]>(loadLibrary());

/** A spec in flight from the list to the viewport. The drop reads it here, since a browser keeps
 *  dataTransfer unreadable until the drop itself. */
export const dragging = shallowRef<FastenerSpec | null>(null);

export function addUserFastener(spec: FastenerSpec): UserFastener {
  const now = Date.now();
  const item = { id: newFastenerId(), spec, created: now, updated: now };
  userLibrary.value = [...userLibrary.value, item];
  saveLibrary(userLibrary.value);
  return item;
}

export function updateUserFastener(id: string, spec: FastenerSpec): void {
  userLibrary.value = userLibrary.value.map((it) => (it.id === id ? { ...it, spec, updated: Date.now() } : it));
  saveLibrary(userLibrary.value);
}

export function removeUserFastener(id: string): void {
  userLibrary.value = userLibrary.value.filter((it) => it.id !== id);
  saveLibrary(userLibrary.value);
  const sel = selection.value;
  if (sel?.source === "custom" && sel.id === id) selection.value = null;
}

export function resetState(): void {
  open.value = false;
  tab.value = "catalogue";
  selection.value = null;
  dragging.value = null;
}
