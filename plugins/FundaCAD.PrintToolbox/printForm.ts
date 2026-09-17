// What each toolbox tool is, as data: its feature type, its rows, its defaults, and the feature a
// pick turns into. Pure, so the tests run without a DOM or an app.

import type { ChoiceField, Feature, FieldKind, Selector, TargetField, ToggleField } from "fundacad";

export type BuildDir = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";

export interface PrintTool {
  /** Action id, tool id and ribbon action, one string for all three. */
  id: string;
  /** The feature type this tool leaves in the history. */
  type: string;
  label: string;
  icon: string;
  /** What to pick, for the prompt line. */
  pickHint: string;
  /** Written into a new feature before the pick. */
  defaults: Record<string, number | string>;
  /** Whether the feature records the build direction it was made for. */
  usesBuildDir: boolean;
  numFields: readonly [string, string, FieldKind][];
  choiceFields: readonly ChoiceField[];
  toggleFields?: readonly ToggleField[];
  fieldApplies?: (field: string, values: Record<string, unknown>) => boolean;
  /** What a run of this tool consumes: faces already selected (FaceTool), or
   *  the selected bodies, defaulting to the active one (BodyTool). */
  pick: "faces" | "bodies";
  /** The selection row(s) the feature panel shows for this type. */
  targets: readonly TargetField[];
}

export const BUILD_DIRS: { value: BuildDir; label: string }[] = [
  { value: "+Z", label: "+Z" },
  { value: "-Z", label: "-Z" },
  { value: "+X", label: "+X" },
  { value: "-X", label: "-X" },
  { value: "+Y", label: "+Y" },
  { value: "-Y", label: "-Y" },
];

const BUILD_DIR_FIELD: ChoiceField = {
  field: "buildDir",
  label: "Build direction",
  options: BUILD_DIRS,
  fallback: "+Z",
  title: "The direction the printer stacks layers, so the roof points up. Taken from Overhang when the feature is made.",
};

export const FACES_TARGET: readonly TargetField[] = [
  { field: "faces", label: "Faces", kind: "face", shape: "selector", arity: "many" },
];

export const TEARDROP: PrintTool = {
  id: "print-teardrop",
  type: "teardropHole",
  label: "Teardrop",
  icon: "printTeardrop",
  pickHint: "select the inside face of each sideways hole",
  defaults: { angle: 45, roof: "pointed", flatHeight: 0 },
  usesBuildDir: true,
  numFields: [
    ["angle", "Roof angle", "angle"],
    ["flatHeight", "Flat above hole", "length"],
  ],
  choiceFields: [
    BUILD_DIR_FIELD,
    {
      field: "roof",
      label: "Roof",
      options: [
        { value: "pointed", label: "Pointed" },
        { value: "flat", label: "Flat" },
      ],
      fallback: "pointed",
      title: "Pointed meets in a tip. Flat cuts the tip off level, at the top of the hole plus the height below.",
    },
  ],
  fieldApplies: (field, values) => field !== "flatHeight" || values["roof"] === "flat",
  pick: "faces",
  targets: FACES_TARGET,
};

export const ROOF_BRIDGE: PrintTool = {
  id: "print-roof-bridge",
  type: "roofBridge",
  label: "Roof Bridge",
  icon: "printRoofBridge",
  pickHint: "select the inside face of each sideways hole",
  defaults: { height: 0 },
  usesBuildDir: true,
  numFields: [["height", "Extra height", "length"]],
  choiceFields: [BUILD_DIR_FIELD],
  pick: "faces",
  targets: FACES_TARGET,
};

export const COUNTERBORE_BRIDGE: PrintTool = {
  id: "print-counterbore-bridge",
  type: "counterboreBridge",
  label: "Counterbore Bridge",
  icon: "printCounterboreBridge",
  pickHint: "select the flat floor of each counterbore",
  defaults: { layerHeight: 0.2, layers: 2, angle: 0 },
  usesBuildDir: false,
  numFields: [
    ["layerHeight", "Layer height", "length"],
    ["layers", "Layers", "count"],
    ["angle", "Slot angle", "angle"],
  ],
  choiceFields: [],
  pick: "faces",
  targets: FACES_TARGET,
};

export const SACRIFICIAL_LAYER: PrintTool = {
  id: "print-sacrificial-layer",
  type: "sacrificialLayer",
  label: "Sacrificial Layer",
  icon: "printSacrificialLayer",
  pickHint: "select a hole's inside face, or the flat face it opens onto",
  defaults: { layerHeight: 0.2, layers: 1, depth: 0, side: "bottom" },
  usesBuildDir: true,
  numFields: [
    ["layerHeight", "Layer height", "length"],
    ["layers", "Layers", "count"],
    ["depth", "Depth", "length"],
  ],
  choiceFields: [
    BUILD_DIR_FIELD,
    {
      field: "side",
      label: "Close end",
      options: [
        { value: "bottom", label: "Bottom" },
        { value: "top", label: "Top" },
      ],
      fallback: "bottom",
      title: "Which opening is closed when a hole's inside face was picked, lowest or highest along the build direction.",
    },
  ],
  pick: "faces",
  targets: FACES_TARGET,
};

export const THREAD_RIBS: PrintTool = {
  id: "print-thread-ribs",
  type: "threadRibs",
  label: "Thread-Forming Ribs",
  icon: "printThreadRibs",
  pickHint: "select the inside face of each screw hole",
  defaults: { ribCount: 3, ribWidth: 0.6, coreDiameter: 0, startDepth: 0.5 },
  usesBuildDir: false,
  numFields: [
    ["ribCount", "Rib count", "count"],
    ["ribWidth", "Rib width", "length"],
    ["coreDiameter", "Core diameter", "length"],
    ["startDepth", "Start depth", "length"],
  ],
  choiceFields: [],
  pick: "faces",
  targets: FACES_TARGET,
};

export const ZIP_TIE_CHANNEL: PrintTool = {
  id: "print-zip-tie-channel",
  type: "zipTieChannel",
  label: "Zip-Tie Channel",
  icon: "printZipTieChannel",
  pickHint: "select the face to cut a channel under",
  defaults: { channelWidth: 4, channelHeight: 2, insetDepth: 2, span: 10, angle: 0 },
  usesBuildDir: false,
  numFields: [
    ["channelWidth", "Channel width", "length"],
    ["channelHeight", "Channel height", "length"],
    ["insetDepth", "Inset depth", "length"],
    ["span", "Span", "length"],
    ["angle", "Angle", "angle"],
  ],
  choiceFields: [],
  toggleFields: [{
    field: "allowBreakthrough", label: "Allow breakthrough", fallback: false,
  }],
  pick: "faces",
  targets: FACES_TARGET,
};

/** Body-target tools: no face pick, act on the selected bodies or the active one. */
export const BODIES_TARGET: readonly TargetField[] = [
  { field: "bodies", label: "Bodies", kind: "body", shape: "bodyId", arity: "many", whenEmpty: "the active body" },
];

export const ELEPHANT_FOOT_CHAMFER: PrintTool = {
  id: "print-elephant-foot-chamfer",
  type: "elephantFootChamfer",
  label: "Elephant-Foot Chamfer",
  icon: "printElephantFootChamfer",
  pickHint: "select the body, or its bottom face",
  defaults: { size: 0.4 },
  usesBuildDir: true,
  numFields: [["size", "Chamfer size", "length"]],
  choiceFields: [BUILD_DIR_FIELD],
  pick: "bodies",
  targets: BODIES_TARGET,
};

export const VERTICAL_FILLET: PrintTool = {
  id: "print-vertical-fillet",
  type: "verticalFillet",
  label: "Vertical Edge Fillet",
  icon: "printVerticalFillet",
  pickHint: "select the body to round",
  defaults: { radius: 2 },
  usesBuildDir: true,
  numFields: [["radius", "Radius", "length"]],
  choiceFields: [BUILD_DIR_FIELD],
  toggleFields: [{ field: "onlyConvex", label: "Convex edges only", fallback: false }],
  pick: "bodies",
  targets: BODIES_TARGET,
};

export const PRINT_TOOLS: readonly PrintTool[] = [
  TEARDROP, ROOF_BRIDGE, COUNTERBORE_BRIDGE, SACRIFICIAL_LAYER,
  THREAD_RIBS, ZIP_TIE_CHANNEL, ELEPHANT_FOOT_CHAMFER, VERTICAL_FILLET,
];

export interface FacePick {
  point: [number, number, number];
  body: string | null;
}

export function faceSelectors(picks: readonly FacePick[]): Selector[] {
  return picks.map((p) => ({
    kind: "face",
    by: "nearest",
    point: p.point,
    ...(p.body ? { body: p.body } : {}),
  }) as Selector);
}

/** The feature a pick makes, or null when nothing was picked. */
export function featureFor(
  tool: PrintTool,
  id: string,
  picks: readonly FacePick[],
  buildDir: BuildDir,
): Feature | null {
  if (!picks.length) return null;
  const sels = faceSelectors(picks);
  return {
    id,
    type: tool.type,
    faces: sels.length === 1 ? sels[0] : sels,
    ...tool.defaults,
    ...(tool.usesBuildDir ? { buildDir } : {}),
  } as unknown as Feature;
}

/** The feature a body-target tool makes: `bodies` when any are selected, left
 *  off entirely so the builder's own "active body" fallback applies (the same
 *  `whenEmpty` contract BODIES_TARGET declares). */
export function bodyFeatureFor(
  tool: PrintTool,
  id: string,
  bodyIds: readonly string[],
  buildDir: BuildDir,
): Feature {
  return {
    id,
    type: tool.type,
    ...(bodyIds.length ? { bodies: [...bodyIds] } : {}),
    ...tool.defaults,
    ...(tool.usesBuildDir ? { buildDir } : {}),
  } as unknown as Feature;
}

export function toolById(id: string): PrintTool | null {
  return PRINT_TOOLS.find((t) => t.id === id) ?? null;
}
