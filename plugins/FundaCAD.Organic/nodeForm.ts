// The node body feature as the document stores it, and the rows the app draws
// for it. Pure, so it is tested without a window.
//
// A node is a point with three radii and a turn; a chain is an ordered list of
// node ids. Every number is a Num, so any of them may carry a parameter. The
// rows address a node by its id (`nodes.n3.sx`), never by its place in the
// list, so a binding follows the node through a reorder or a delete.

import type { ChoiceField, FieldKind, TargetField } from "fundacad";

export const NODE_TYPE = "organic";

export type Num = number | string;

export interface NodeValues {
  id: string;
  x: Num;
  y: Num;
  z: Num;
  sx: Num;
  sy: Num;
  sz: Num;
  rx: Num;
  ry: Num;
  rz: Num;
}

export type Operation = "new" | "join" | "cut" | "intersect";

export interface NodeFeature {
  id: string;
  type: typeof NODE_TYPE;
  name?: string;
  nodes: NodeValues[];
  chains: string[][];
  blend?: Num;
  operation?: Operation;
  targets?: string[];
}

export const NODE_FIELDS: readonly (readonly [keyof NodeValues & string, string, FieldKind])[] = [
  ["x", "X", "length"],
  ["y", "Y", "length"],
  ["z", "Z", "length"],
  ["sx", "Radius X", "length"],
  ["sy", "Radius Y", "length"],
  ["sz", "Radius Z", "length"],
  ["rx", "Turn X", "angle"],
  ["ry", "Turn Y", "angle"],
  ["rz", "Turn Z", "angle"],
];

export function asNodeFeature(f: unknown): NodeFeature | null {
  if (typeof f !== "object" || f === null) return null;
  const o = f as Record<string, unknown>;
  return o["type"] === NODE_TYPE ? (o as unknown as NodeFeature) : null;
}

/** The value rows: the blend, then every node's position, radii and turn. */
export function nodeNumFields(values: Record<string, unknown>): [string, string, FieldKind][] {
  const rows: [string, string, FieldKind][] = [["blend", "Blend", "length"]];
  const nodes = Array.isArray(values["nodes"]) ? (values["nodes"] as { id?: unknown }[]) : [];
  for (const n of nodes) {
    if (typeof n?.id !== "string") continue;
    for (const [field, label, kind] of NODE_FIELDS) rows.push([`nodes.${n.id}.${field}`, `${n.id} ${label}`, kind]);
  }
  return rows;
}

export const NODE_CHOICE_FIELDS: ChoiceField[] = [{
  field: "operation",
  label: "Operation",
  options: [
    { value: "new", label: "New body" },
    { value: "join", label: "Join" },
    { value: "cut", label: "Cut" },
    { value: "intersect", label: "Intersect" },
  ],
  fallback: "new",
}];

export const NODE_TARGETS: TargetField[] = [{
  field: "targets", label: "Bodies", kind: "body", shape: "bodyId", arity: "many",
  whenEmpty: "every body it reaches",
}];

/** A number, or the value a parameter-bound field last resolved to. */
export function numOf(v: Num | undefined, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}

/** The first `n<k>` id no node has. */
export function freshNodeId(nodes: readonly { id: string }[]): string {
  const taken = new Set(nodes.map((n) => n.id));
  let k = nodes.length + 1;
  while (taken.has(`n${k}`)) k++;
  return `n${k}`;
}

/** A readable size for a first node: a round number near `target` mm. */
export function roundSize(target: number): number {
  if (!(target > 0) || !Number.isFinite(target)) return 5;
  const p = 10 ** Math.floor(Math.log10(target));
  for (const m of [1, 2, 5, 10]) if (m * p >= target * 0.75) return m * p;
  return 10 * p;
}

/** `from` joined to `to`: onto the end of a chain `from` closes, else a new
 *  chain of the two. Nothing when they are already neighbours. */
export function link(chains: readonly string[][], from: string, to: string): string[][] {
  const next = chains.map((c) => c.slice());
  for (const c of next) {
    for (let i = 0; i + 1 < c.length; i++) {
      if ((c[i] === from && c[i + 1] === to) || (c[i] === to && c[i + 1] === from)) return next;
    }
  }
  const tail = next.find((c) => c[c.length - 1] === from && !c.includes(to));
  if (tail) {
    tail.push(to);
    return next;
  }
  const head = next.find((c) => c[0] === from && !c.includes(to));
  if (head) {
    head.unshift(to);
    return next;
  }
  next.push([from, to]);
  return next;
}

/** Every chain with `id` taken out. A chain it split in two becomes two, and
 *  a chain left with one node is dropped (that node stands on its own). */
export function unlinkNode(chains: readonly string[][], id: string): string[][] {
  const out: string[][] = [];
  for (const c of chains) {
    let run: string[] = [];
    for (const n of c) {
      if (n === id) {
        if (run.length >= 2) out.push(run);
        run = [];
      } else {
        run.push(n);
      }
    }
    if (run.length >= 2) out.push(run);
  }
  return out;
}

/** Row major 3x3: Rz * Ry * Rx, degrees, the geometry's own convention. */
export function rotationMatrix(rx: number, ry: number, rz: number): number[][] {
  const r = Math.PI / 180;
  const [sx, cx] = [Math.sin(rx * r), Math.cos(rx * r)];
  const [sy, cy] = [Math.sin(ry * r), Math.cos(ry * r)];
  const [sz, cz] = [Math.sin(rz * r), Math.cos(rz * r)];
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}

/** The node's ellipsoid's half extent along each world axis. */
export function halfExtent(n: NodeValues): [number, number, number] {
  const m = rotationMatrix(numOf(n.rx, 0), numOf(n.ry, 0), numOf(n.rz, 0));
  const s = [numOf(n.sx, 5), numOf(n.sy, 5), numOf(n.sz, 5)];
  return [0, 1, 2].map((i) => Math.hypot(m[i]![0]! * s[0]!, m[i]![1]! * s[1]!, m[i]![2]! * s[2]!)) as [number, number, number];
}

/** The world box around every node's ellipsoid, or null with no nodes. */
export function nodesBox(nodes: readonly NodeValues[]): { min: number[]; max: number[] } | null {
  if (!nodes.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const n of nodes) {
    const c = [numOf(n.x, 0), numOf(n.y, 0), numOf(n.z, 0)];
    const h = halfExtent(n);
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, c[i]! - h[i]!);
      max[i] = Math.max(max[i]!, c[i]! + h[i]!);
    }
  }
  return { min, max };
}

/** A length for a label: whole millimetres, or centimetres from 10 mm up
 *  when that is a round number, so a reference reads at a glance. */
export function sizeLabel(mm: number): string {
  const r = Math.round(mm * 100) / 100;
  if (r >= 10 && Math.abs(r / 10 - Math.round(r / 10)) < 1e-9) return `${Math.round(r / 10)} cm`;
  return `${r} mm`;
}
