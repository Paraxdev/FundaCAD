// What opening a document says about what this version leaves out: a plugin-declared type keeps the plugin's own
// message, every other unbuildable type shares one notice.

import type { CadDocument, Feature } from "../types";
import { FORMAT_VERSION } from "./migrate";
import { missingPluginMessage, missingPlugins } from "./missingPlugins";

export interface OpenNotice {
  message: string;
  kind: "info" | "warning";
  // The full list, for the console log.
  detail?: string;
}

const NEWER = "Opened a file from a newer version of FundaCAD.";
const MOST_NAMES = 3;

function namesOf(names: string[]): string {
  if (names.length <= MOST_NAMES) return names.join(", ");
  return `${names.slice(0, MOST_NAMES).join(", ")} and ${names.length - MOST_NAMES} more`;
}

// As History names it.
function rowName(f: Pick<Feature, "type">): string {
  return (f as { name?: string }).name?.trim() || f.type;
}

// `openedVersion` is the `version` the file was stamped with.
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
      out.unshift({
        message: `${NEWER} Anything this version does not know is kept and saved with the file.`,
        kind: "info",
      });
    }
    return out;
  }
  const types = new Set(unknown.map((u) => u.type));
  const left = doc.features.filter((f) => types.has(f.type));
  const names = namesOf([...new Set(left.map(rowName))]);
  const one = total === 1;
  const kept = one
    ? "It is kept and saved with the file. Bodies after it may differ."
    : "They are kept and saved with the file. Bodies after them may differ.";
  // An older stamp means no newer version wrote these, so most likely a plugin not running here, which can also be one
  // the engine still builds.
  const sentence = newer
    ? `${NEWER} ${one ? "1 feature was" : `${total} features were`} not included because this version does not know ${one ? "it" : "them"}: ${names}. ${kept} Update FundaCAD to build ${one ? "it" : "them"}.`
    : `${one ? "1 feature needs" : `${total} features need`} a plugin that is not running here: ${names}. ${kept}`;
  const detail = unknown
    .map((u) => {
      const ids = doc.features.filter((f) => f.type === u.type).map((f) => f.id);
      return `${u.type} (${u.count}): ${ids.join(", ")}`;
    })
    .join("\n");
  out.unshift({ message: sentence, kind: "warning", detail });
  return out;
}
