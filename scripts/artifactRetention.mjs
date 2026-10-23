// Every actions/upload-artifact step must set a short retention-days. The 90 day default once filled the storage
// quota, FinalizeArtifact answered 403 and took the release job down with what looked like a Linux build failure.

// Scanned, not parsed: the repository has no YAML library and every workflow is a plain list of steps.
export function uploadSteps(text) {
  const lines = text.split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(-\s+)?uses:\s*actions\/upload-artifact(@|\s|$)/.test(lines[i])) continue;

    let start = i;
    while (start > 0 && !/^\s*-\s/.test(lines[start])) start--;
    const indent = lines[start].length - lines[start].trimStart().length;

    // Stop at the next line indented no further, or a later step's retention-days would answer for this one.
    let end = start + 1;
    for (; end < lines.length; end++) {
      const line = lines[end];
      if (!line.trim()) continue;
      if (line.length - line.trimStart().length <= indent) break;
    }

    // The dash becomes a space so the step's own `name:` is told apart from `with: name:`, the artifact's name.
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

export function retentionFindings(steps, maxDays = 7) {
  return steps.flatMap((s) => {
    const where = `line ${s.line}${s.name ? ` (${s.name})` : ""}`;
    if (s.retention === null) return [`${where}: no retention-days, so the artifact is kept for the default 90`];
    if (s.retention > maxDays) return [`${where}: retention-days ${s.retention} is longer than ${maxDays}`];
    return [];
  });
}
