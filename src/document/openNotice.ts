// What opening a document says about what this version leaves out: a plugin-declared type keeps the plugin's own
// message, every other unbuildable type shares one notice.

import { t } from "../i18n";
import type { CadDocument, Feature } from "../types";
import { FORMAT_VERSION } from "./migrate";
import { missingPluginMessage, missingPlugins } from "./missingPlugins";

export interface OpenNotice {
  message: string;
  kind: "info" | "warning";
  // The full list, for the console log.
  detail?: string;
}

const MOST_NAMES = 3;

const listed = (names: string[]) => names.reduce((before, after) => t("pick.list.more", { before, after }));

function namesOf(names: string[]): string {
  if (names.length <= MOST_NAMES) return listed(names);
  return t("openNotice.andMore", { names: listed(names.slice(0, MOST_NAMES)), n: names.length - MOST_NAMES });
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
      out.unshift({ message: t("openNotice.newerKnown"), kind: "info" });
    }
    return out;
  }
  const types = new Set(unknown.map((u) => u.type));
  const left = doc.features.filter((f) => types.has(f.type));
  const names = namesOf([...new Set(left.map(rowName))]);
  // An older stamp means no newer version wrote these, so most likely a plugin not running here, which can also be one
  // the engine still builds.
  const sentence = t(newer ? "openNotice.newerUnknown" : "openNotice.needsPlugin", { n: total, names });
  const detail = unknown
    .map((u) => {
      const ids = doc.features.filter((f) => f.type === u.type).map((f) => f.id);
      return `${u.type} (${u.count}): ${ids.join(", ")}`;
    })
    .join("\n");
  out.unshift({ message: sentence, kind: "warning", detail });
  return out;
}
