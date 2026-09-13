// What a click takes when the viewport picks body first, then faces: the first
// click on a body takes the body, and a click on a body that is already chosen
// takes the face or edge under the cursor instead.

export type SelectPolicy = "auto" | "faces" | "bodies";

export interface ClickState {
  /** the body under the cursor */
  bodyId: string | null;
  additive: boolean;
  /** bodies selected whole */
  selectedBodies: readonly string[];
  /** bodies that own a selected face or edge */
  drilledBodies: ReadonlySet<string>;
}

/** "body" selects the body whole, "part" lets the face and edge pick run. */
export function clickTakes(s: ClickState): "body" | "part" {
  if (s.bodyId === null) return "part";
  if (s.selectedBodies.length) {
    return !s.additive && s.selectedBodies.includes(s.bodyId) ? "part" : "body";
  }
  if (s.drilledBodies.has(s.bodyId)) return "part";
  return s.additive && s.drilledBodies.size ? "part" : "body";
}
