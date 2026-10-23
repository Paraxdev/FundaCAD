// load() checks this before touching the store, so a non document is refused whole with a readable reason (FI-8).

// `reason` finishes "This file is not a FundaCAD document, or it is damaged: ..."; `message` keeps the detail.
export class UnreadableDocumentError extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(detail);
    this.name = "UnreadableDocumentError";
  }
}

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return `a ${typeof v}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function documentShapeProblem(parsed: unknown): { reason: string; detail: string } | null {
  if (!isRecord(parsed)) {
    return { reason: "it holds no document", detail: `top level is ${kindOf(parsed)}, expected an object` };
  }
  const features = parsed["features"];
  if (features === undefined) {
    return { reason: "it has no modelling steps in it", detail: `"features" is missing` };
  }
  if (!Array.isArray(features)) {
    return {
      reason: "its list of modelling steps is damaged",
      detail: `"features" is ${kindOf(features)}, expected an array`,
    };
  }
  for (let i = 0; i < features.length; i++) {
    const f: unknown = features[i];
    if (!isRecord(f) || typeof f["type"] !== "string" || !f["type"]) {
      return {
        reason: `step ${i + 1} of its modelling steps is damaged`,
        detail: `features[${i}] is ${isRecord(f) ? "missing a type" : kindOf(f)}`,
      };
    }
  }
  const params = parsed["parameters"];
  if (params !== undefined && !isRecord(params)) {
    return { reason: "its parameters are damaged", detail: `"parameters" is ${kindOf(params)}, expected an object` };
  }
  const version = parsed["version"];
  if (version !== undefined && typeof version !== "number") {
    return { reason: "its format version is damaged", detail: `"version" is ${kindOf(version)}, expected a number` };
  }
  return null;
}
