// A feature failure written up as a GitHub issue body: what failed, the
// OpenCASCADE call that refused and what it was handed, the calls before it,
// the bodies and parameters in play, and the feature itself. Everything a
// maintainer needs without the document.

import type { FeatureErrorDetail } from "../types";
import { appVersion } from "./updates";

let version = "unknown";
void appVersion().then((v) => { version = v; }, () => {});

export interface FeatureFailure {
  label: string;
  message: string;
  code?: string | undefined;
  feature?: unknown;
  detail?: FeatureErrorDetail | undefined;
  diagnostics?: unknown[] | undefined;
}

const fence = (lang: string, body: string) => ["```" + lang, body, "```"];

export function featureFailureReport(f: FeatureFailure): string {
  const d = f.detail;
  const kind = d?.type ?? (f.feature as { type?: string } | undefined)?.type ?? "unknown";
  const id = (f.feature as { id?: string } | undefined)?.id;
  const out: string[] = [
    `### ${f.label} failed`,
    "",
    `**Message:** ${f.message}`,
    "",
    `| | |`,
    `|---|---|`,
    `| Feature | ${f.label} (type \`${kind}\`${id ? `, id \`${id}\`` : ""}${d ? `, #${d.index + 1} in the timeline` : ""}) |`,
  ];
  if (f.code) out.push(`| Error code | \`${f.code}\` |`);
  out.push(`| FundaCAD | ${version} |`);
  if (d?.occt) out.push(`| OpenCASCADE | ${d.occt} |`);
  out.push(`| Platform | ${typeof navigator === "undefined" ? "unknown" : navigator.userAgent} |`);
  if (d) out.push(`| Time in feature | ${d.ms} ms |`);

  const calls = d?.kernel ?? [];
  const failed = [...calls].reverse().find((c) => c.error);
  out.push("", "#### Kernel operation that failed");
  if (failed) {
    out.push(
      "",
      `\`${failed.op}\` raised \`${failed.error}\``,
      ...(failed.args ? ["", ...fence("", failed.args)] : []),
    );
  } else if (d) {
    out.push("", "No OpenCASCADE call failed, the feature refused its inputs before or after the kernel ran.");
  } else {
    out.push("", "Not recorded (the engine sent no detail for this error).");
  }

  if (calls.length) {
    out.push("", "#### OpenCASCADE calls in this feature, oldest first", "");
    // A retry loop repeats one call many times, one line with a count says it.
    const runs: { c: (typeof calls)[number]; n: number }[] = [];
    for (const c of calls) {
      const last = runs[runs.length - 1];
      if (last && last.c.op === c.op && last.c.error === c.error && last.c.args === c.args) last.n++;
      else runs.push({ c, n: 1 });
    }
    runs.forEach(({ c, n }, i) => {
      const times = n > 1 ? ` (x${n})` : "";
      const ms = c.ms === undefined ? "" : ` ${c.ms} ms`;
      const args = c.args && c !== failed ? ` with ${c.args}` : "";
      out.push(`${i + 1}. \`${c.op}\`${times}${ms}${c.error ? `, failed: ${c.error}${args}` : ", ok"}`);
    });
  }

  if (d?.bodies.length) {
    out.push("", `#### Bodies before the feature (${d.bodyCount})`, "");
    for (const b of d.bodies) out.push(`- \`${b.id}\` ${b.name}: ${b.shape}`);
    if (d.bodyCount > d.bodies.length) out.push(`- and ${d.bodyCount - d.bodies.length} more`);
  }

  const params = d ? Object.entries(d.params) : [];
  if (params.length) {
    out.push("", "#### Parameter values", "");
    out.push(params.map(([k, v]) => `${k} = ${v}`).join(", "));
  }

  if (f.diagnostics?.length) {
    out.push("", "#### Engine diagnostics", "", ...fence("json", JSON.stringify(f.diagnostics, null, 2)));
  }

  if (f.feature !== undefined) {
    out.push("", "#### Feature definition", "", ...fence("json", JSON.stringify(f.feature, null, 2)));
  }
  return out.join("\n");
}
