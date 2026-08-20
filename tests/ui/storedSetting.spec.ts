// Settings survive the rename of the key they are stored under.
//
// A .spec so it runs under happy-dom, which supplies a real localStorage: the
// whole point is what happens to values already on disk, and a stubbed store
// would only test the stub.

import { beforeEach, describe, expect, it } from "vitest";
import { readSetting } from "../../src/ui/storedSetting";

const NEW = "neocad.thing";
const OLD = "sindricad.thing";

describe("readSetting", () => {
  beforeEach(() => localStorage.clear());

  it("returns null when neither name holds anything", () => {
    expect(readSetting(NEW, OLD)).toBeNull();
  });

  it("reads the new name", () => {
    localStorage.setItem(NEW, "forge");
    expect(readSetting(NEW, OLD)).toBe("forge");
  });

  it("finds a value stored under the old name and carries it forward", () => {
    // The case the rebrand creates. Without this the app finds nothing under the
    // new name, falls back to its default, and reads as having forgotten the
    // setting.
    localStorage.setItem(OLD, "paper");
    expect(readSetting(NEW, OLD)).toBe("paper");
    expect(localStorage.getItem(NEW), "the value was not copied forward").toBe("paper");
  });

  it("leaves the old value in place", () => {
    // Deliberate: it costs a few bytes and nothing reads it once the copy
    // exists, whereas deleting it strands anyone who steps back to an older
    // build partway through.
    localStorage.setItem(OLD, "paper");
    readSetting(NEW, OLD);
    expect(localStorage.getItem(OLD)).toBe("paper");
  });

  it("prefers the new name when both exist", () => {
    // Otherwise a stale pre-rename value would keep overriding every change the
    // user makes, since changes are only ever written to the new name.
    localStorage.setItem(OLD, "paper");
    localStorage.setItem(NEW, "moss");
    expect(readSetting(NEW, OLD)).toBe("moss");
  });

  it("treats an empty string as a value, not as absence", () => {
    // `getItem` returns "" for a key that was set to "", and `?? null` style
    // fallbacks that use || would silently promote that to the default.
    localStorage.setItem(OLD, "");
    expect(readSetting(NEW, OLD)).toBe("");
  });
});
