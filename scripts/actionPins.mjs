// Scanned, not parsed: the repository has no YAML library. The scan reads the plain block style the workflows are
// written in, and refusedForms reports every other spelling of what it checks, so nothing passes by being written oddly.

const indentOf = (line) => line.length - line.trimStart().length;
const withoutComment = (line) => line.replace(/(^|\s)#.*$/, "").trimEnd();

/** Actions pinned to a commit on a branch rather than to a release tag, and that branch. */
export const BRANCH_PINS = { "dtolnay/rust-toolchain": "stable" };

const BLOCK_SCALAR = /^(\s*)((?:-\s+)*)(?:([\w.-]+):\s+)?[|>][1-9+-]{0,2}$/;

/** The lines that hold YAML nodes, numbered from 1: the bodies of `|` and `>` block scalars are text and left out. */
export function yamlLines(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push({ n: i + 1, text: lines[i] });
    const m = BLOCK_SCALAR.exec(withoutComment(lines[i]));
    if (!m) continue;
    const dash = m[2].lastIndexOf("-");
    const parent = m[1].length + (m[3] ? m[2].length : Math.max(dash, 0));
    while (i + 1 < lines.length && (!lines[i + 1].trim() || indentOf(lines[i + 1]) > parent)) i++;
  }
  return out;
}

const KEY = /(?:^|[\s{,?-])["']?(?:uses|permissions)["']?\s*:(?:\s|$)/;
const PLAIN_KEY = /^\s*(?:-\s+)?(?:uses:\s+[\w./@-]+|permissions:(?:\s+(?:read-all|write-all|\{\}))?)$/;
const PROPERTY = /(?:^\s*(?:-\s+)*|:\s+|[[{,]\s*)[&*!][^\s=]/;
const MERGE_OR_EXPLICIT = /^\s*(?:-\s+)*(?:<<\s*:|\?(?:\s|$))/;

/** Lines the scan cannot read: `uses` or `permissions` spelled other than plainly, or an anchor, alias, tag or merge key. */
export function refusedForms(path, text) {
  return yamlLines(text).flatMap(({ n, text: raw }) => {
    const line = withoutComment(raw).replace(/\$\{\{.*?\}\}/g, "x");
    const odd = (KEY.test(line) && !PLAIN_KEY.test(line)) || PROPERTY.test(line) || MERGE_OR_EXPLICIT.test(line);
    return odd ? [`${path}:${n} ${raw.trim()}`] : [];
  });
}

const USES = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/;

/** The lines of the step that holds line i, from its dash to the next line indented no further. */
function stepAt(lines, i) {
  let start = i;
  while (start > 0 && !/^\s*-\s/.test(lines[start])) start--;
  const indent = indentOf(lines[start]);
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || indentOf(lines[end]) > indent)) end++;
  return lines.slice(start, end);
}

/** Every `uses:` in the files, with what follows its ref and the lines of its step. */
export function usesSteps(files) {
  return Object.entries(files).flatMap(([path, text]) => {
    const lines = text.split(/\r?\n/);
    return yamlLines(text).flatMap(({ n, text: line }) => {
      const m = USES.exec(line);
      return m ? [{ where: `${path}:${n}`, ref: m[1], comment: m[2].trim(), step: stepAt(lines, n - 1) }] : [];
    });
  });
}

const PIN = /^([\w.-]+\/[\w.-]+)(?:\/[\w./-]+)?@([0-9a-f]{40})$/;
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

/** Every action used by commit, as its owner/repo, the commit and the tag or branch its comment names. */
export function pins(files) {
  return usesSteps(files).flatMap((u) => {
    const m = PIN.exec(u.ref);
    const ref = /^#\s+(\S+)$/.exec(u.comment)?.[1];
    return m && ref ? [{ where: u.where, repo: m[1], sha: m[2], ref }] : [];
  });
}

/** Actions not run at a commit, comments that name no exact tag, and a commit or tag that disagrees with another use. */
export function pinFindings(files) {
  const found = usesSteps(files)
    .filter((u) => !u.ref.startsWith("./") && !(PIN.test(u.ref) && /^#\s+\S+$/.test(u.comment)))
    .map((u) => `${u.where} is not pinned to a commit with its tag in a comment: ${u.ref} ${u.comment}`.trimEnd());
  const tagsOf = new Map();
  const shasOf = new Map();
  for (const p of pins(files)) {
    if (!RELEASE_TAG.test(p.ref) && BRANCH_PINS[p.repo] !== p.ref)
      found.push(`${p.where} names ${p.ref}, not an exact release tag`);
    tagsOf.set(`${p.repo}@${p.sha}`, new Set([...(tagsOf.get(`${p.repo}@${p.sha}`) ?? []), p.ref]));
    shasOf.set(`${p.repo} ${p.ref}`, new Set([...(shasOf.get(`${p.repo} ${p.ref}`) ?? []), p.sha]));
  }
  for (const [pin, tags] of tagsOf) if (tags.size > 1) found.push(`${pin} is commented as ${[...tags].join(" and ")}`);
  for (const [tag, shas] of shasOf) if (shas.size > 1) found.push(`${tag} is pinned to ${[...shas].join(" and ")}`);
  return found;
}

/** Every permission a workflow grants, as `file job key: level`, with `top` for the workflow wide block. */
export function grants(files) {
  return Object.entries(files)
    .filter(([path]) => /\/workflows\/[^/]+\.ya?ml$/.test(path))
    .flatMap(([path, text]) => {
      const file = path.split("/").pop();
      const lines = yamlLines(text).map((l) => withoutComment(l.text));
      const out = [];
      let job = "top";
      let jobIndent = -1;
      let inJobs = false;
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        if (indentOf(line) === 0) {
          inJobs = /^jobs:$/.test(line);
          job = "top";
        } else if (inJobs) {
          if (jobIndent < 0) jobIndent = indentOf(line);
          if (indentOf(line) === jobIndent)
            job = line
              .trim()
              .replace(/:$/, "")
              .replace(/^(["'])(.*)\1$/, "$2");
        }
        const block = /^(\s*)permissions:\s*(.*)$/.exec(line);
        if (!block) return;
        if (block[2]) out.push(`${file} ${job} ${block[2]}`);
        for (let j = i + 1; j < lines.length && (!lines[j].trim() || indentOf(lines[j]) > block[1].length); j++) {
          if (lines[j].trim()) out.push(`${file} ${job} ${lines[j].trim().replace(/:\s*/, ": ")}`);
        }
      });
      return out;
    });
}
