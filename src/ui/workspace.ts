// Which job the window is set up for, modelling or rendering: the two want opposite things from the same 300px.
// Not persisted, since it describes the sitting, not the user; reopening into a render layout is a worse first frame.

/** "render" trades a column for finish, environment and camera, and is the only mode where a material can change. */
export type Workspace = "model" | "render";

export const WORKSPACES: readonly { id: Workspace; label: string; icon: string }[] = [
  { id: "model", label: "Model", icon: "box" },
  { id: "render", label: "Render", icon: "material" },
];

let current: Workspace = "model";
const listeners = new Set<(w: Workspace) => void>();

export function workspace(): Workspace {
  return current;
}

/** About editing, not showing: reading a material is allowed anywhere. */
export function canEditMaterials(): boolean {
  return current === "render";
}

export function setWorkspace(w: Workspace): void {
  if (w !== "model" && w !== "render") return;
  if (current === w) return;
  current = w;
  for (const fn of listeners) fn(current);
}

export function onWorkspaceChange(fn: (w: Workspace) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
