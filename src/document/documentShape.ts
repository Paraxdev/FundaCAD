// What load() checks before it touches the store, so a file that is not a
// document, or is a damaged one, is refused whole and with a reason a person
// can read, instead of failing halfway through with whatever a migration step
// tripped over ("features.flatMap is not a function", FI-8).

/** A file load() refused. `reason` is for people, finishing the sentence "This
 *  file is not a FundaCAD document, or it is damaged: ...". `message` keeps the
 *  technical detail. */
export class UnreadableDocumentError extends Error {
  constructor(readonly reason: string, detail: string) {
    super(detail);
    this.name = "UnreadableDocumentError";
  }
}

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return `a ${typeof v}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Null when `parsed` has the shape of a document, else what is wrong with it. */
export function documentShapeProblem(parsed: unknown): { reason: string; detail: string } | null {
  if (!isRecord(parsed)) {
    return { reason: "it holds no document", detail: `top level is ${kindOf(parsed)}, expected an object` };
  }
  const features = parsed["features"];
  if (features === undefined) {
    return { reason: "it has no modelling steps in it", detail: `"features" is missing` };
  }
  if (!Array.isArray(features)) {
    return { reason: "its list of modelling steps is damaged", detail: `"features" is ${kindOf(features)}, expected an array` };
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
