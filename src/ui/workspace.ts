// Which of the two jobs the window is set up for: making the shape, or making
// the picture of it.
//
// The house shape for a user setting (ui/theme.ts, renderPrefs.ts, units.ts):
// module state, a validating gate, a listener set. No Vue import, so the
// headless suite can reach it, and no Three import, so this stays a statement
// about the window rather than a piece of the renderer.
//
// WHY A MODE AT ALL, when every one of these controls could simply be on screen.
// Because they are not wanted at the same time. Dialling in roughness while
// placing a hole is not a thing anyone does, and the two want opposite things
// from the same 300px: modelling wants the viewport as wide as the window goes,
// and choosing a finish wants a column of materials open beside the part. One
// mode is not a lesser version of the other, they are two arrangements of the
// same document, and the toggle is how you say which you are doing.
//
// NOT PERSISTED, unlike theme or units, and that is the one real decision here.
// A setting that survives a restart is one describing the user; this one
// describes the sitting. Reopening a week-old part into a render layout, with a
// dock over the model and the tools a click away, is a worse first frame than
// the one click it costs to get back into Render.

/** "model" is the app as it has always been: the whole width, every tool.
 *  "render" trades a column of it for the finish, the environment and the
 *  camera, and is the only mode in which a material can be CHANGED. */
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

/** Whether the material controls are live. Reading a material is allowed
 *  anywhere, which is why this is asked about EDITING and not about showing:
 *  the swatch beside a body in the browser is the same swatch in both modes. */
export function canEditMaterials(): boolean {
  return current === "render";
}

export function setWorkspace(w: Workspace): void {
  if (w !== "model" && w !== "render") return;
  if (current === w) return;
  current = w;
  for (const fn of listeners) fn(current);
}

/** Subscribe to changes; returns the unsubscribe. */
export function onWorkspaceChange(fn: (w: Workspace) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
