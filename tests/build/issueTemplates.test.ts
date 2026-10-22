import { describe, expect, it } from "vitest";

import bugRaw from "../../.github/ISSUE_TEMPLATE/bug.yml?raw";
import ideaRaw from "../../.github/ISSUE_TEMPLATE/idea.yml?raw";
import configRaw from "../../.github/ISSUE_TEMPLATE/config.yml?raw";
import securityMd from "../../SECURITY.md?raw";
import zensicalToml from "../../manual/zensical.toml?raw";
import { BUG_FORM_FIELDS } from "../../src/ui/reportText";

// Old app versions keep sending these query names to the form, so a rename breaks every report they open.
const BUG_IDS_THE_APP_SENDS: string[] = [...BUG_FORM_FIELDS];

// A Windows checkout with autocrlf hands the files over with CRLF, which the renames below would not find.
const lf = (text: string) => text.replace(/\r\n/g, "\n");
const bugYml = lf(bugRaw);
const ideaYml = lf(ideaRaw);
const configYml = lf(configRaw);

interface FormField {
  type: string;
  id: string | null;
  required: boolean;
  render: string | null;
}

interface Form {
  name: string | null;
  description: string | null;
  labels: string[];
  fields: FormField[];
}

// Reads only the shape GitHub's issue form schema gives these files, enough to pin the contract without a YAML dependency.
function readForm(text: string): Form {
  const top = (key: string) => text.match(new RegExp(`^${key}: (.+)$`, "m"))?.[1]?.trim() ?? null;
  const labels =
    top("labels")
      ?.match(/"([^"]+)"/g)
      ?.map((l) => l.slice(1, -1)) ?? [];
  const bodyAt = text.search(/^body:$/m);
  const items =
    bodyAt < 0
      ? []
      : text
          .slice(bodyAt)
          .split(/^ {2}- type: /m)
          .slice(1);
  const fields = items.map((item) => ({
    type: item.split("\n")[0]?.trim() ?? "",
    id: item.match(/^ {4}id: (\S+)$/m)?.[1] ?? null,
    required: /^ {6}required: true$/m.test(item),
    render: item.match(/^ {6}render: (\S+)$/m)?.[1] ?? null,
  }));
  return { name: top("name"), description: top("description"), labels, fields };
}

function missingIds(text: string, ids: string[]): string[] {
  const present = new Set(readForm(text).fields.map((f) => f.id));
  return ids.filter((id) => !present.has(id));
}

describe("the Problem report form", () => {
  const form = readForm(bugYml);

  it("has the fields the app fills and the Report box, in order", () => {
    expect(form.fields.map((f) => [f.type, f.id, f.required, f.render])).toEqual([
      ["markdown", null, false, null],
      ["textarea", "what", true, null],
      ["textarea", "steps", false, null],
      ["input", "version", false, null],
      ["input", "os", false, null],
      ["textarea", "report", false, "text"],
      ["markdown", null, false, null],
    ]);
  });

  it("is named and labelled bug", () => {
    expect([form.name, form.labels, form.description !== null]).toEqual(["Problem report", ["bug"], true]);
  });

  it("is missing no id the app sends, and a renamed id is caught", () => {
    expect(missingIds(bugYml, [...BUG_IDS_THE_APP_SENDS, "report"])).toEqual([]);
    const renamed = bugYml.replace("    id: version\n", "    id: app_version\n");
    expect(missingIds(renamed, [...BUG_IDS_THE_APP_SENDS, "report"])).toEqual(["version"]);
    const twoGone = bugYml.replace("    id: what\n", "    id: summary\n").replace("    id: os\n", "    id: system\n");
    expect(missingIds(twoGone, BUG_IDS_THE_APP_SENDS)).toEqual(["what", "os"]);
  });
});

describe("a checkout with CRLF line endings", () => {
  it("reads the same form", () => {
    expect(readForm(bugYml.replace(/\n/g, "\r\n"))).toEqual(readForm(bugYml));
  });
});

describe("the Idea form", () => {
  const form = readForm(ideaYml);

  it("asks the goal, the idea and today's way, the first two required", () => {
    expect(form.fields.map((f) => [f.type, f.id, f.required])).toEqual([
      ["markdown", null, false],
      ["textarea", "goal", true],
      ["textarea", "idea", true],
      ["textarea", "today", false],
    ]);
  });

  it("is named and labelled enhancement", () => {
    expect([form.name, form.labels, form.description !== null]).toEqual(["Idea", ["enhancement"], true]);
  });

  it("is missing neither required id, and a renamed one is caught", () => {
    expect(missingIds(ideaYml, ["goal", "idea"])).toEqual([]);
    expect(missingIds(ideaYml.replace("    id: goal\n", "    id: aim\n"), ["goal", "idea"])).toEqual(["goal"]);
  });
});

describe("the chooser", () => {
  const urls = [...configYml.matchAll(/^ {4}url: (\S+)$/gm)].map((m) => m[1]);
  const securityUrl = securityMd.match(/\((https:\/\/github\.com\/[^)]+\/security\/advisories\/new)\)/)?.[1];
  const manualUrl = zensicalToml.match(/^site_url = "([^"]+)"$/m)?.[1];

  it("keeps blank issues and links the security advisory and the manual, read from their own files", () => {
    expect(securityUrl).toBe("https://github.com/Paraxdev/fundacad/security/advisories/new");
    expect(manualUrl).toBe("https://paraxdev.github.io/FundaCAD/");
    expect({ blank: /^blank_issues_enabled: true$/m.test(configYml), urls }).toEqual({
      blank: true,
      urls: [securityUrl, manualUrl],
    });
  });
});

describe("the wording", () => {
  it("uses no dash as punctuation in any form", () => {
    for (const [name, text] of Object.entries({ bugYml, ideaYml, configYml })) {
      const lines = text.split("\n").filter((l) => /[\u2013\u2014]| - /.test(l.replace(/^\s*- /, "")));
      expect(lines, name).toEqual([]);
    }
  });

  it("and the check finds one when it is there", () => {
    const text = "      label: What happened - and why\n  - type: markdown\n";
    expect(text.split("\n").filter((l) => /[\u2013\u2014]| - /.test(l.replace(/^\s*- /, "")))).toEqual([
      "      label: What happened - and why",
    ]);
  });
});
