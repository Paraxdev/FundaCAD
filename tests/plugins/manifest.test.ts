// The permission vocabulary, which is the whole of the security promise that
// this side of the app can keep.
//
// Two halves, and both matter for different reasons. The parser is a gate: a
// manifest it lets through is one an install screen will describe, so anything
// it cannot describe has to be refused rather than trimmed. The copy is the
// screen itself: the "cannot" list is the only thing that makes the "can" list
// mean anything, and it is generated, so the test that earns its place is the
// one asserting a permission NOT asked for shows up on the reassuring side and
// nowhere else.
//
// Every refusal below is paired with the same input made valid, so a parser
// that had simply started refusing everything would fail here rather than look
// like a very thorough set of guards.

import { describe, expect, it } from "vitest";
import {
  describeGrants,
  parseManifest,
  promiseCovers,
  promiseOf,
  sandboxNote,
  type PluginManifest,
} from "../../src/plugins/manifest";

const base = {
  id: "sample",
  name: "Sample",
  version: "1.0.0",
  kind: "process",
  summary: "does a thing",
  grants: ["document.read"],
};

const ok = (raw: unknown): PluginManifest => {
  const res = parseManifest(raw);
  if (!res.ok) throw new Error(`expected this to parse, got: ${res.why}`);
  return res.manifest;
};

const why = (raw: unknown): string => {
  const res = parseManifest(raw);
  if (res.ok) throw new Error("expected this to be refused, it parsed");
  return res.why;
};

describe("what a manifest is allowed to say", () => {
  it("refuses a permission it does not know, and says which one", () => {
    // The control: the same manifest without the invented grant. If this did
    // not parse, the assertion above would be measuring something else.
    expect(ok({ ...base, grants: ["document.read"] }).grants).toEqual(["document.read"]);

    const refusal = why({ ...base, grants: ["document.read", "everything"] });
    expect(refusal).toContain("unknown permission");
    expect(refusal).toContain("everything");
  });

  it("refuses a permission asked for twice", () => {
    expect(why({ ...base, grants: ["document.read", "document.read"] })).toContain(
      "twice",
    );
  });

  it("refuses network with no hosts, and hosts with no network", () => {
    expect(why({ ...base, grants: ["network"] })).toContain("without naming any hosts");
    expect(why({ ...base, grants: ["document.read"], hosts: ["example.com"] })).toContain(
      "without asking for network",
    );
    // Control: together they are fine, which is what makes the two refusals
    // above about the pairing rather than about either field alone.
    expect(ok({ ...base, grants: ["network"], hosts: ["example.com"] }).hosts).toEqual([
      "example.com",
    ]);
  });

  it("refuses a host that is not a host name", () => {
    for (const bad of ["https://example.com", "example.com/path", "*.example.com", "localhost"]) {
      expect(why({ ...base, grants: ["network"], hosts: [bad] })).toContain("not a host name");
    }
    expect(ok({ ...base, grants: ["network"], hosts: [".example.com"] }).hosts).toEqual([
      ".example.com",
    ]);
  });

  it("refuses an id that could name something other than itself", () => {
    for (const bad of ["../evil", "Sample", "", "a/b", "9lives"]) {
      expect(why({ ...base, id: bad })).toContain("not a plugin id");
    }
    expect(ok({ ...base, id: "a-plugin-9" }).id).toBe("a-plugin-9");
  });

  it("refuses a kind it cannot describe the sandbox of", () => {
    expect(why({ ...base, kind: "native" })).toContain("not a plugin kind");
    expect(ok({ ...base, kind: "compute" }).kind).toBe("compute");
  });
});

describe("the install screen's two lists", () => {
  const reader = ok({ ...base, grants: ["document.read"] });
  const writer = ok({ ...base, grants: ["document.read", "document.write"] });

  it("does not claim a plugin can change the document when it did not ask to", () => {
    const { can, cannot } = describeGrants(reader);
    expect(can).toContain("Read the document you have open");
    expect(can).not.toContain("Change the document you have open");
    expect(cannot).toContain("Change your document");
  });

  it("moves that same line to the other list once it is asked for", () => {
    const { can, cannot } = describeGrants(writer);
    expect(can).toContain("Change the document you have open");
    expect(cannot).not.toContain("Change your document");
  });

  it("names the hosts rather than saying the internet", () => {
    const net = ok({ ...base, grants: ["network"], hosts: ["api.example.com"] });
    const { can, cannot } = describeGrants(net);
    expect(can).toContain("Connect to api.example.com");
    expect(can).not.toContain("Connect to the internet");
    expect(cannot).not.toContain("Use the internet");
    // Control: without the grant, the reassuring line is the vague one, which
    // is the right way round. There is nothing to be specific about.
    expect(describeGrants(reader).cannot).toContain("Use the internet");
  });

  it("keeps quiet about the permissions nobody would be reassured by", () => {
    // ui.panel has no "cannot" line on purpose. A list padded with "cannot add
    // a panel" is a list that gets skimmed, and the ones worth reading are in
    // it.
    expect(describeGrants(reader).cannot).not.toContain("Add a panel to the window");
  });
});

describe("saying what a process plugin actually is", () => {
  it("does not pretend a separate program is in a cage", () => {
    expect(sandboxNote("process")).toContain("normal program on your computer");
    expect(sandboxNote("panel")).toContain("all it can do");
    expect(sandboxNote("compute")).toContain("all it can do");
  });
});

describe("the promise, as something that can be stored and compared", () => {
  it("does not change when the publisher reorders the list", () => {
    const a = ok({ ...base, grants: ["document.read", "geometry.build"] });
    const b = ok({ ...base, grants: ["geometry.build", "document.read"] });
    expect(promiseOf(a)).toBe(promiseOf(b));
  });

  it("changes when the plugin asks for more", () => {
    const a = ok({ ...base, grants: ["document.read"] });
    const b = ok({ ...base, grants: ["document.read", "document.write"] });
    expect(promiseOf(a)).not.toBe(promiseOf(b));
  });

  it("lets an update through only when it asks for the same or less", () => {
    const consented = ok({ ...base, grants: ["document.read", "document.write"] });
    expect(promiseCovers(consented, ok({ ...base, grants: ["document.read"] }))).toBe(true);
    expect(promiseCovers(consented, consented)).toBe(true);
    expect(
      promiseCovers(consented, ok({ ...base, grants: ["document.read", "process.spawn"] })),
    ).toBe(false);
  });

  it("treats a change of kind as a change of promise", () => {
    // A panel becoming a process is the sandbox disappearing, whatever the
    // grant list says.
    const consented = ok({ ...base, kind: "panel", grants: ["ui.panel"] });
    expect(promiseCovers(consented, ok({ ...base, kind: "process", grants: ["ui.panel"] }))).toBe(
      false,
    );
  });

  it("counts a newly named host as more", () => {
    const consented = ok({ ...base, grants: ["network"], hosts: ["a.example.com"] });
    const wider = ok({ ...base, grants: ["network"], hosts: ["a.example.com", "b.example.com"] });
    expect(promiseCovers(consented, wider)).toBe(false);
    expect(promiseCovers(wider, consented)).toBe(true);
  });
});
