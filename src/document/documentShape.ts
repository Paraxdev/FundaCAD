import { t, type MessageArgs, type MessageKey } from "../i18n";

// load() checks this before touching the store, so a non document is refused whole with a readable reason (FI-8).

// `reason` finishes "This file is not a FundaCAD document, or it is damaged: ..."; `message` keeps the detail.
export class UnreadableDocumentError extends Error {
  constructor(
    readonly key: MessageKey,
    detail: string,
    readonly args: MessageArgs = {},
  ) {
    super(detail);
    this.name = "UnreadableDocumentError";
  }

  /** Worded where it is read, in the chosen language. */
  get reason(): string {
    return t(this.key, this.args);
  }
}

export interface ShapeProblem {
  key: MessageKey;
  args: MessageArgs;
  detail: string;
  readonly reason: string;
}

const problem = (key: MessageKey, detail: string, args: MessageArgs = {}): ShapeProblem => ({
  key,
  args,
  detail,
  get reason() {
    return t(key, args);
  },
});

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return `a ${typeof v}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function documentShapeProblem(parsed: unknown): ShapeProblem | null {
  if (!isRecord(parsed)) {
    return problem("files.unreadable.noDocument", `top level is ${kindOf(parsed)}, expected an object`);
  }
  const features = parsed["features"];
  if (features === undefined) {
    return problem("files.unreadable.noSteps", `"features" is missing`);
  }
  if (!Array.isArray(features)) {
    return problem("files.unreadable.stepsDamaged", `"features" is ${kindOf(features)}, expected an array`);
  }
  for (let i = 0; i < features.length; i++) {
    const f: unknown = features[i];
    if (!isRecord(f) || typeof f["type"] !== "string" || !f["type"]) {
      return problem(
        "files.unreadable.stepDamaged",
        `features[${i}] is ${isRecord(f) ? "missing a type" : kindOf(f)}`,
        {
          n: i + 1,
        },
      );
    }
  }
  const params = parsed["parameters"];
  if (params !== undefined && !isRecord(params)) {
    return problem("files.unreadable.parametersDamaged", `"parameters" is ${kindOf(params)}, expected an object`);
  }
  const version = parsed["version"];
  if (version !== undefined && typeof version !== "number") {
    return problem("files.unreadable.versionDamaged", `"version" is ${kindOf(version)}, expected a number`);
  }
  return null;
}
