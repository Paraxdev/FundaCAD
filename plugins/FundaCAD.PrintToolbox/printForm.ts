// What each toolbox tool is, as data: its feature type, its rows, its defaults, and the feature a
// pick turns into. Pure, so the tests run without a DOM or an app.

import type { ChoiceField, Feature, FieldKind, Selector, TargetField, ToggleField } from "fundacad";
import { t, toolLabel } from "./lines";

export type BuildDir = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";
type NumFieldRows = readonly [string, string, FieldKind][];

export interface PrintTool {
  /** Action id, tool id and ribbon action, one string for all three. */
  id: string;
  /** The feature type this tool leaves in the history. */
  type: string;
  readonly label: string;
  icon: string;
  /** What to pick, for the prompt line. */
  readonly pickHint: string;
  /** Written into a new feature before the pick. */
  defaults: Record<string, number | string>;
  /** Whether the feature records the build direction it was made for. */
  usesBuildDir: boolean;
  /** Read afresh, so the row names follow the language. */
  readonly numFields: NumFieldRows;
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
  get label() {
    return t("field.buildDir");
  },
  options: BUILD_DIRS,
  fallback: "+Z",
  get title() {
    return t("field.buildDir.hint");
  },
};

export const FACES_TARGET: readonly TargetField[] = [
  { field: "faces", label: "Faces", kind: "face", shape: "selector", arity: "many" },
];

export const TEARDROP: PrintTool = {
  id: "print-teardrop",
  type: "teardropHole",
  get label() {
    return toolLabel(this.id);
  },
  icon: "printTeardrop",
  get pickHint() {
    return t("pick.teardrop");
  },
  defaults: { angle: 45, roof: "pointed", flatHeight: 0 },
  usesBuildDir: true,
  get numFields(): NumFieldRows {
    return [
      ["angle", t("field.roofAngle"), "angle"],
      ["flatHeight", t("field.flatHeight"), "length"],
    ];
  },
  choiceFields: [
    BUILD_DIR_FIELD,
    {
      field: "roof",
      get label() {
        return t("field.roof");
      },
      options: [
        {
          value: "pointed",
          get label() {
            return t("field.roof.pointed");
          },
        },
        {
          value: "flat",
          get label() {
            return t("field.roof.flat");
          },
        },
      ],
      fallback: "pointed",
      get title() {
        return t("field.roof.hint");
      },
    },
  ],
  fieldApplies: (field, values) => field !== "flatHeight" || values["roof"] === "flat",
  pick: "faces",
  targets: FACES_TARGET,
};

export const ROOF_BRIDGE: PrintTool = {
  id: "print-roof-bridge",
  type: "roofBridge",
  get label() {
    return toolLabel(this.id);
  },
  icon: "printRoofBridge",
  get pickHint() {
    return t("pick.roofBridge");
  },
  defaults: { height: 0 },
  usesBuildDir: true,
  get numFields(): NumFieldRows {
    return [["height", t("field.extraHeight"), "length"]];
  },
  choiceFields: [BUILD_DIR_FIELD],
  pick: "faces",
  targets: FACES_TARGET,
};

export const COUNTERBORE_BRIDGE: PrintTool = {
  id: "print-counterbore-bridge",
  type: "counterboreBridge",
  get label() {
    return toolLabel(this.id);
  },
  icon: "printCounterboreBridge",
  get pickHint() {
    return t("pick.counterbore");
  },
  defaults: { layerHeight: 0.2, layers: 2, angle: 0 },
  usesBuildDir: false,
  get numFields(): NumFieldRows {
    return [
      ["layerHeight", t("field.layerHeight"), "length"],
      ["layers", t("field.layers"), "count"],
      ["angle", t("field.slotAngle"), "angle"],
    ];
  },
  choiceFields: [],
  pick: "faces",
  targets: FACES_TARGET,
};

export const SACRIFICIAL_LAYER: PrintTool = {
  id: "print-sacrificial-layer",
  type: "sacrificialLayer",
  get label() {
    return toolLabel(this.id);
  },
  icon: "printSacrificialLayer",
  get pickHint() {
    return t("pick.sacrificial");
  },
  defaults: { layerHeight: 0.2, layers: 1, depth: 0, side: "bottom" },
  usesBuildDir: true,
  get numFields(): NumFieldRows {
    return [
      ["layerHeight", t("field.layerHeight"), "length"],
      ["layers", t("field.layers"), "count"],
      ["depth", t("field.depth"), "length"],
    ];
  },
  choiceFields: [
    BUILD_DIR_FIELD,
    {
      field: "side",
      get label() {
        return t("field.closeEnd");
      },
      options: [
        {
          value: "bottom",
          get label() {
            return t("field.closeEnd.bottom");
          },
        },
        {
          value: "top",
          get label() {
            return t("field.closeEnd.top");
          },
        },
      ],
      fallback: "bottom",
      get title() {
        return t("field.closeEnd.hint");
      },
    },
  ],
  pick: "faces",
  targets: FACES_TARGET,
};

export const THREAD_RIBS: PrintTool = {
  id: "print-thread-ribs",
  type: "threadRibs",
  get label() {
    return toolLabel(this.id);
  },
  icon: "printThreadRibs",
  get pickHint() {
    return t("pick.threadRibs");
  },
  defaults: { ribCount: 3, ribWidth: 0.6, coreDiameter: 0, startDepth: 0.5 },
  usesBuildDir: false,
  get numFields(): NumFieldRows {
    return [
      ["ribCount", t("field.ribCount"), "count"],
      ["ribWidth", t("field.ribWidth"), "length"],
      ["coreDiameter", t("field.coreDiameter"), "length"],
      ["startDepth", t("field.startDepth"), "length"],
    ];
  },
  choiceFields: [],
  pick: "faces",
  targets: FACES_TARGET,
};

export const ZIP_TIE_CHANNEL: PrintTool = {
  id: "print-zip-tie-channel",
  type: "zipTieChannel",
  get label() {
    return toolLabel(this.id);
  },
  icon: "printZipTieChannel",
  get pickHint() {
    return t("pick.zipTie");
  },
  defaults: { channelWidth: 4, channelHeight: 2, insetDepth: 2, span: 10, angle: 0 },
  usesBuildDir: false,
  get numFields(): NumFieldRows {
    return [
      ["channelWidth", t("field.channelWidth"), "length"],
      ["channelHeight", t("field.channelHeight"), "length"],
      ["insetDepth", t("field.insetDepth"), "length"],
      ["span", t("field.span"), "length"],
      ["angle", t("field.angle"), "angle"],
    ];
  },
  choiceFields: [],
  toggleFields: [
    {
      field: "allowBreakthrough",
      get label() {
        return t("field.allowBreakthrough");
      },
      fallback: false,
    },
  ],
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
  get label() {
    return toolLabel(this.id);
  },
  icon: "printElephantFootChamfer",
  get pickHint() {
    return t("pick.elephantFoot");
  },
  defaults: { size: 0.4 },
  usesBuildDir: true,
  get numFields(): NumFieldRows {
    return [["size", t("field.chamferSize"), "length"]];
  },
  choiceFields: [BUILD_DIR_FIELD],
  pick: "bodies",
  targets: BODIES_TARGET,
};

export const VERTICAL_FILLET: PrintTool = {
  id: "print-vertical-fillet",
  type: "verticalFillet",
  get label() {
    return toolLabel(this.id);
  },
  icon: "printVerticalFillet",
  get pickHint() {
    return t("pick.verticalFillet");
  },
  defaults: { radius: 2 },
  usesBuildDir: true,
  get numFields(): NumFieldRows {
    return [["radius", t("field.radius"), "length"]];
  },
  choiceFields: [BUILD_DIR_FIELD],
  toggleFields: [
    {
      field: "onlyConvex",
      get label() {
        return t("field.onlyConvex");
      },
      fallback: false,
    },
  ],
  pick: "bodies",
  targets: BODIES_TARGET,
};

export const PRINT_TOOLS: readonly PrintTool[] = [
  TEARDROP,
  ROOF_BRIDGE,
  COUNTERBORE_BRIDGE,
  SACRIFICIAL_LAYER,
  THREAD_RIBS,
  ZIP_TIE_CHANNEL,
  ELEPHANT_FOOT_CHAMFER,
  VERTICAL_FILLET,
];

export interface FacePick {
  point: [number, number, number];
  body: string | null;
}

export function faceSelectors(picks: readonly FacePick[]): Selector[] {
  return picks.map(
    (p) =>
      ({
        kind: "face",
        by: "nearest",
        point: p.point,
        ...(p.body ? { body: p.body } : {}),
      }) as Selector,
  );
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

/** The feature a body-target tool makes: `bodies` when any are selected, else left off so the builder's own "active
 *  body" fallback applies (the `whenEmpty` contract BODIES_TARGET declares). */
export function bodyFeatureFor(tool: PrintTool, id: string, bodyIds: readonly string[], buildDir: BuildDir): Feature {
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
