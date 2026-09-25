// A mirror that names bodies stores its plane as {name}, which a build from
// before targeted mirrors refuses. A bare "YZ" it would read, and reflect the
// active body instead of the ones named. The engine refuses the bare form with
// bodies, so every write goes through here.
import type { CadDocument, Feature } from "../types";

type Mirror = Extract<Feature, { type: "mirror" }>;

export function mirrorPlaneName(plane: Mirror["plane"] | undefined): string | null {
  if (typeof plane === "string") return plane;
  return typeof plane?.name === "string" ? plane.name : null;
}

export function canonicalMirrorPlanes(doc: CadDocument): void {
  doc.features.forEach((f, i) => {
    if (f.type !== "mirror") return;
    const m = f as Mirror;
    if (!m.bodies?.length || typeof m.plane !== "string") return;
    doc.features[i] = { ...m, plane: { name: m.plane } };
  });
}
