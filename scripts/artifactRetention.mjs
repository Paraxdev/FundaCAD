// Does every artifact upload say how long to keep it?
//
// The build matrix uploads ~1.6 GB of installers a run, for the release job in
// that same run to download. Nothing reads them afterwards. No step said so,
// and actions/upload-artifact's default is NINETY DAYS, so 33 runs were still
// holding 98 artifacts and 55 GB when FinalizeArtifact started answering 403
// Forbidden. The bytes had already uploaded; only the finalize was refused, on
// the longest leg of the matrix, which took the release job with it and made a
// storage ceiling look like a Linux build failure.
//
// Nothing tells you a step forgot this. The build stays green for weeks and
// then fails somewhere else entirely, so the setting is read rather than
// remembered, the same reason check-no-plugin-code.mjs reads the bundle.
//
// Pure text, no filesystem: the caller passes a workflow's contents, so this is
// checkable against a fixture that MUST be reported and not only against the
// file that happens to be right today.

/** Where a `uses: actions/upload-artifact` step is, and what it keeps.
 *
 *  Scanned rather than parsed because this repository has no YAML library, and
 *  adding one for four regular expressions is a dependency to keep current
 *  forever. The shape being read is a list of steps, which is the one shape
 *  every workflow file in this repository has.
 *
 *  @param {string} text one workflow file's contents
 *  @returns {{ line: number, name: string, retention: number | null }[]}
 */
export function uploadSteps(text) {
  const lines = text.split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(-\s+)?uses:\s*actions\/upload-artifact(@|\s|$)/.test(lines[i])) continue;

    // The step this `uses:` belongs to: itself when it carries the dash,
    // otherwise the nearest list item above it.
    let start = i;
    while (start > 0 && !/^\s*-\s/.test(lines[start])) start--;
    const indent = lines[start].length - lines[start].trimStart().length;

    // ...and it ends at the first non-blank line indented no further, which is
    // the next step, a sibling key, or the next job. Running past the end would
    // let a LATER step's retention-days answer for this one, which is a false
    // pass rather than a missed one.
    let end = start + 1;
    for (; end < lines.length; end++) {
      const line = lines[end];
      if (!line.trim()) continue;
      if (line.length - line.trimStart().length <= indent) break;
    }

    // The step's own keys, with the dash turned into a space so the first line
    // is indented like the rest of them. Without that the step's `name:` cannot
    // be told from `with: { name: ... }`, which is the artifact's name and not
    // the step's, a message that says "(fundacad-linux)" instead of "(Upload
    // artifacts)" points at the wrong line of the file.
    const step = lines.slice(start, end);
    step[0] = step[0].replace(/^(\s*)-/, "$1 ");
    const indentOf = (l) => l.length - l.trimStart().length;
    const keyIndent = indentOf(step[0]);

    const days = step.map((l) => /^\s*retention-days:\s*(\d+)\s*$/.exec(l)).find(Boolean);
    const named = step.find((l) => indentOf(l) === keyIndent && /^\s*name:\s*\S/.test(l)) ?? "";
    found.push({
      line: i + 1,
      name: named.replace(/^\s*name:\s*/, "").trim(),
      retention: days ? Number(days[1]) : null,
    });
  }
  return found;
}

/** The uploads that keep their artifact too long, or do not say.
 *
 *  @param {{ line: number, name: string, retention: number | null }[]} steps
 *  @param {number} maxDays the longest an intra-run handoff may be kept
 *  @returns {string[]} one sentence per finding, empty when there is nothing to say
 */
export function retentionFindings(steps, maxDays = 7) {
  return steps.flatMap((s) => {
    const where = `line ${s.line}${s.name ? ` (${s.name})` : ""}`;
    if (s.retention === null)
      return [`${where}: no retention-days, so the artifact is kept for the default 90`];
    if (s.retention > maxDays)
      return [`${where}: retention-days ${s.retention} is longer than ${maxDays}`];
    return [];
  });
}
