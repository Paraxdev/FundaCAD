// Carry on: the next face or edge pick finishes the open Extrude or Press/Pull and starts the next tool on the pick.

import type * as THREE from "three";
import { t } from "../i18n";
import type { Vec3 } from "../types";
import { treePickRefusal, type TreeClickRoute, type TreePick, type TreePickTaker } from "../ui/treePick";
import { polylineMid } from "../viewport/edgeMatch";
import type { Hit } from "../viewport/picking";
import type { Viewport } from "../viewport/viewport";

export type CarryKind = "face" | "edge";

/** A kind and a world point, never an id: preview ids differ from the committed ones, and face ids belong to one
 *  tessellation. */
export interface CarryTarget {
  kind: CarryKind;
  point: Vec3;
}

export type CarryCommit =
  | { kind: "added"; id: string }
  | { kind: "nothing"; note?: string }
  | { kind: "stayed"; why: string };

export interface CarrySource {
  /** The localized reason a commit must not go ahead now, else null. */
  carryBlocked(): string | null;
  commitForCarry(): CarryCommit;
}

export interface CarryHost {
  route(pick: TreePick): TreeClickRoute;
  after(done: Exclude<CarryCommit, { kind: "stayed" }>, target: CarryTarget): void;
}

/** What a source answers carryBlocked with, and the prompt fragment it appends while a carry is on offer. */
export const carryWords = {
  wait: () => t("carry.wait"),
  badValue: () => t("carry.badValue"),
  depthFirst: () => t("carry.depthFirst"),
  nothingMade: () => t("carry.nothingMade"),
  refused: (reason: string) => t("carry.refused", { reason }),
  prompt: () => t("carry.prompt"),
};

/** Face and edge hits only, anything else is empty space. */
export function pickOfHit(hit: Hit | null): TreePick | null {
  if (hit?.kind === "face") return { kind: "face", faceId: hit.faceId };
  if (hit?.kind === "edge") return { kind: "edge", edge: hit.edge };
  return null;
}

/** The middle of the largest triangle, which lies inside the face even for an L or a ring where the vertex centroid
 *  does not. */
export function pointOnFace(tris: readonly THREE.Triangle[]): Vec3 | null {
  let best: THREE.Triangle | null = null;
  for (const t of tris) if (!best || t.getArea() > best.getArea()) best = t;
  if (!best) return null;
  return [
    (best.a.x + best.b.x + best.c.x) / 3,
    (best.a.y + best.b.y + best.c.y) / 3,
    (best.a.z + best.b.z + best.c.z) / 3,
  ];
}

/** The target a pick stands for, or the hint saying why it has none. */
export function targetOf(pick: TreePick, vp: Pick<Viewport, "faceTriangles">): CarryTarget | string {
  if (pick.kind === "face") {
    const point = pointOnFace(vp.faceTriangles(pick.faceId));
    return point ? { kind: "face", point } : carryWords.wait();
  }
  if (pick.kind === "edge") {
    const point = polylineMid(pick.edge.points);
    return point ? { kind: "edge", point } : carryWords.wait();
  }
  return treePickRefusal(pick, "a face or an edge");
}

export function carryTaker(
  source: CarrySource,
  host: Pick<CarryHost, "after">,
  vp: Pick<Viewport, "faceTriangles">,
): TreePickTaker {
  return (pick) => {
    if (pick.kind !== "face" && pick.kind !== "edge") return treePickRefusal(pick, "a face or an edge");
    const blocked = source.carryBlocked();
    if (blocked) return blocked;
    const target = targetOf(pick, vp);
    if (typeof target === "string") return target;
    const done = source.commitForCarry();
    if (done.kind === "stayed") return done.why;
    host.after(done, target);
    return true;
  };
}
