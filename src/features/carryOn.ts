// Carry on: the next face, edge or profile pick, or the next tool command, finishes the open Extrude or Press/Pull and
// starts the next tool.

import * as THREE from "three";
import { t } from "../i18n";
import type { Vec3 } from "../types";
import type { WorldRegion } from "../sketch/overlay";
import { treePickRefusal, type TreeClickRoute, type TreePick, type TreePickTaker } from "../ui/treePick";
import { polylineMid } from "../viewport/edgeMatch";
import type { Hit } from "../viewport/picking";
import type { Viewport } from "../viewport/viewport";

export type CarryKind = "face" | "edge";

/** A kind and a world point, never an id: preview ids differ from the committed ones, and face ids belong to one
 *  tessellation. A profile names its sketch too, which the commit may hide. An action is a tool command. */
export type CarryTarget =
  | { kind: CarryKind; point: Vec3 }
  | { kind: "profile"; point: Vec3; sketch: string }
  | { kind: "action"; action: string };

export type CarryCommit =
  { kind: "added"; id: string } | { kind: "nothing"; note?: string } | { kind: "stayed"; why: string };

export interface CarrySource {
  /** The localized reason a commit must not go ahead now, else null. */
  carryBlocked(): string | null;
  commitForCarry(): CarryCommit;
}

export interface CarryHost {
  route(pick: TreePick): TreeClickRoute;
  after(done: Exclude<CarryCommit, { kind: "stayed" }>, target: CarryTarget): void;
  /** The profile a click there picks, decided against the face behind it as an idle click decides. */
  profileAt(clientX: number, clientY: number): WorldRegion | null;
  /** Lights the profile a press would carry to, null puts it out. */
  lightProfile(wr: WorldRegion | null): void;
  refuse(why: string): void;
}

/** What a source answers carryBlocked with, and the prompt fragment it appends while a carry is on offer. */
export const carryWords = {
  wait: () => t("carry.wait"),
  badValue: () => t("carry.badValue"),
  depthFirst: () => t("carry.depthFirst"),
  nothingMade: () => t("carry.nothingMade"),
  refused: (reason: string) => t("carry.refused", { reason }),
  promptProfile: () => t("carry.promptProfile"),
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
  return treePickRefusal(pick, "faceOrEdge");
}

/** Commits the open step and hands the target on, or answers why not. */
export function carryTo(source: CarrySource, host: Pick<CarryHost, "after">, target: CarryTarget): true | string {
  const blocked = source.carryBlocked();
  if (blocked) return blocked;
  const done = source.commitForCarry();
  if (done.kind === "stayed") return done.why;
  host.after(done, target);
  return true;
}

export function carryTaker(
  source: CarrySource,
  host: Pick<CarryHost, "after">,
  vp: Pick<Viewport, "faceTriangles">,
): TreePickTaker {
  return (pick) => {
    if (pick.kind !== "face" && pick.kind !== "edge") return treePickRefusal(pick, "faceOrEdge");
    const blocked = source.carryBlocked();
    if (blocked) return blocked;
    const target = targetOf(pick, vp);
    if (typeof target === "string") return target;
    return carryTo(source, host, target);
  };
}

/** What a press carries on to, in the idle click's order: an edge, then a profile over the face behind it, then a
 *  face. A profile `own` says the open tool holds is no target, the press goes on to what lies under it. */
export function carryPressTarget(
  vp: Pick<Viewport, "pickEntity" | "rayFrom">,
  host: Pick<CarryHost, "profileAt">,
  x: number,
  y: number,
  own: (wr: WorldRegion) => boolean,
): { hit: Hit | null; profile: (CarryTarget & { kind: "profile" }) | null; wr: WorldRegion | null } {
  const hit = vp.pickEntity(x, y);
  const wr = hit?.kind === "edge" ? null : host.profileAt(x, y);
  if (!wr || own(wr)) return { hit, profile: null, wr: null };
  const at = vp.rayFrom(x, y).ray.intersectPlane(wr.plane.plane, new THREE.Vector3()) ?? wr.interior3D;
  return { hit, profile: { kind: "profile", point: [at.x, at.y, at.z], sketch: wr.sketchId }, wr };
}

/** True when the press carried on or was refused aloud, false when it is a plain commit. A face `ownFace` says the
 *  open tool pushes is no target either, a press there just commits. */
export function carryPress(
  source: CarrySource,
  host: CarryHost,
  vp: Pick<Viewport, "pickEntity" | "rayFrom">,
  x: number,
  y: number,
  own: (wr: WorldRegion) => boolean,
  ownFace: (faceId: number) => boolean = () => false,
): boolean {
  const next = carryPressTarget(vp, host, x, y, own);
  if (!next.profile) {
    const pick = pickOfHit(next.hit);
    if (!pick || (pick.kind === "face" && ownFace(pick.faceId))) return false;
    return host.route(pick) !== "row";
  }
  const done = carryTo(source, host, next.profile);
  if (done !== true) host.refuse(done);
  return true;
}
