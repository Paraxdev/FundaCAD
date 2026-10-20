// What opening a document tells the person about what this version leaves out.
//
// One cause, one toast. A feature whose type a shipped plugin declares keeps the
// plugin's own message (turn it on, or install it). Every other type this build
// cannot build is from a newer FundaCAD, or from something nobody here knows,
// and gets one notice for all of them together.

import type { CadDocument } from "../types";
import { FORMAT_VERSION } from "./migrate";
import { missingPluginMessage, missingPlugins } from "./missingPlugins";

export interface OpenNotice {
  message: string;
  kind: "info" | "warning";
  /** The full list, for the console log. */
  detail?: string;
}

const NEWER = "Opened a file from a newer version of FundaCAD.";
const MOST_NAMES = 3;

function namesOf(types: string[]): string {
  if (types.length <= MOST_NAMES) return types.join(", ");
  return `${types.slice(0, MOST_NAMES).join(", ")} and ${types.length - MOST_NAMES} more`;
}

/** The notices for a document just opened, `openedVersion` being the `version`
 *  the file was stamped with. */
export function openNotices(doc: Pick<CadDocument, "features">, openedVersion: number): OpenNotice[] {
  const out: OpenNotice[] = [];
  const unknown: { type: string; count: number }[] = [];
  for (const m of missingPlugins(doc)) {
    if (m.id !== null) out.push({ message: missingPluginMessage({ ...m, id: m.id }), kind: "info" });
    else unknown.push({ type: m.types[0]!, count: m.count });
  }
  const newer = openedVersion > FORMAT_VERSION;
  const total = unknown.reduce((n, u) => n + u.count, 0);
  if (total === 0) {
    if (newer) {
      out.unshift({ message: `${NEWER} Anything this version does not know is kept and saved with the file.`, kind: "info" });
    }
    return out;
  }
  const who = newer ? "this version" : "this version of FundaCAD";
  const names = namesOf(unknown.map((u) => u.type));
  const sentence =
    total === 1
      ? `1 feature was not included because ${who} does not know it: ${names}. It is kept and saved with the file. Bodies after it may differ.`
      : `${total} features were not included because ${who} does not know them: ${names}. They are kept and saved with the file. Bodies after them may differ.`;
  const detail = unknown
    .map((u) => {
      const ids = doc.features.filter((f) => f.type === u.type).map((f) => f.id);
      return `${u.type} (${u.count}): ${ids.join(", ")}`;
    })
    .join("\n");
  out.unshift({ message: newer ? `${NEWER} ${sentence}` : sentence, kind: "warning", detail });
  return out;
}
