// Settings a plugin declares and the app keeps: the schema check, one stored
// key per plugin, versions, the one-time import of an old key, and what a
// listener hears.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  definePluginSettings,
  pluginSettingsOf,
  removePluginSettings,
  settingMatches,
  storageKey,
  storedSettings,
  validateSchema,
  type SettingsSchema,
} from "../../src/plugins/settings";
import { MemoryStorage } from "./memoryStorage";

let store: MemoryStorage;
beforeEach(() => {
  store = new MemoryStorage();
  vi.stubGlobal("localStorage", store);
});
afterEach(() => vi.unstubAllGlobals());

const schema = (extra: Partial<SettingsSchema> = {}): SettingsSchema => ({
  version: 1,
  props: [
    { key: "on", type: "boolean", label: "On", default: false },
    { key: "speed", type: "number", label: "Speed", default: 2, min: 0, max: 10 },
    { key: "mode", type: "enum", label: "Mode", default: "a", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
    { key: "name", type: "string", label: "Name", default: "", maxLength: 4 },
    { key: "tint", type: "colour", label: "Tint", default: "#ff8800", group: "Look" },
    { key: "hotkey", type: "key", label: "Hot key", default: "Ctrl+K" },
    { key: "path", type: "file", label: "Library", default: "", extensions: ["json"] },
    { key: "list", type: "data", default: [1, 2] },
  ],
  ...extra,
});

describe("validateSchema", () => {
  it("accepts every listed type", () => {
    expect(validateSchema(schema())).toEqual([]);
  });

  it("names each thing wrong with a schema", () => {
    const bad = validateSchema({
      version: 0,
      props: [
        { key: "a", type: "boolean", label: "A", default: false },
        { key: "a", type: "boolean", label: "A again", default: true },
        { key: "n", type: "number", label: "N", default: Number.NaN },
        { key: "r", type: "number", label: "R", default: 20, min: 0, max: 10 },
        { key: "e", type: "enum", label: "E", default: "z", options: [{ id: "x", label: "X" }] },
        { key: "u", type: "slider", label: "U", default: 1 } as never,
        { key: "c", type: "colour", label: "C", default: "orange" },
        { key: "l", type: "boolean", default: false },
      ],
    });
    expect(bad.join("\n")).toMatch(/version/);
    expect(bad.join("\n")).toMatch(/"a" is declared twice/);
    expect(bad.join("\n")).toMatch(/"n" needs a finite default/);
    expect(bad.join("\n")).toMatch(/"r" default 20: has to be at most 10/);
    expect(bad.join("\n")).toMatch(/"e" default is not one of its options/);
    expect(bad.join("\n")).toMatch(/"u" has an unknown type/);
    expect(bad.join("\n")).toMatch(/"c" default is not a valid colour/);
    expect(bad.join("\n")).toMatch(/"l" has no label/);
  });

  it("refuses to define settings from a broken schema", () => {
    expect(() => definePluginSettings("A.Bad", { version: 1, props: [{ key: "x", type: "number", label: "X", default: Infinity }] })).toThrow(/finite/);
  });
});

describe("storage", () => {
  it("keeps each plugin under its own key and nothing else", () => {
    const x = definePluginSettings("A.X", schema());
    const y = definePluginSettings("A.Y", schema());
    expect(x.set("speed", 7)).toBeNull();
    expect(y.get("speed")).toBe(2);
    expect([...store.map.keys()]).toEqual([storageKey("A.X")]);
    expect(storageKey("A.X")).toBe("fundacad.pluginSettings.A.X");
    expect(JSON.parse(store.getItem("fundacad.pluginSettings.A.X")!)).toMatchObject({ version: 1, values: { speed: 7 } });
  });

  it("reads back what an earlier start stored", () => {
    definePluginSettings("A.X", schema()).set("mode", "b");
    expect(definePluginSettings("A.X", schema()).get("mode")).toBe("b");
    expect(pluginSettingsOf("A.X")!.get("mode")).toBe("b");
    expect(storedSettings("A.X")).toMatchObject({ mode: "b", speed: 2 });
  });

  it("falls back per property when a stored value is no longer valid", () => {
    store.setItem(storageKey("A.X"), JSON.stringify({ version: 1, values: { speed: "fast", mode: "gone", on: true, name: "toolong" } }));
    const s = definePluginSettings("A.X", schema());
    expect(s.get("speed")).toBe(2);
    expect(s.get("mode")).toBe("a");
    expect(s.get("on")).toBe(true);
    expect(s.get("name")).toBe("");
  });

  it("refuses a value it cannot keep, with a reason, and keeps the old one", () => {
    const s = definePluginSettings("A.X", schema());
    expect(s.set("speed", 11)).toBe("Speed has to be at most 10");
    expect(s.set("tint", "red")).toMatch(/colour/);
    expect(s.get("speed")).toBe(2);
    expect(() => s.set("nope", 1)).toThrow(/no setting/);
  });

  it("hands out copies, so editing a read value changes nothing", () => {
    const s = definePluginSettings("A.X", schema());
    s.get<number[]>("list").push(3);
    s.all().list = [];
    expect(s.get("list")).toEqual([1, 2]);
  });

  it("removing the plugin's data leaves the defaults and no stored value", () => {
    const s = definePluginSettings("A.X", schema());
    s.set("speed", 5);
    removePluginSettings("A.X");
    expect(JSON.parse(store.getItem(storageKey("A.X"))!).values).toEqual({});
    expect(s.get("speed")).toBe(2);
  });
});

describe("versions and old keys", () => {
  it("migrates an older stored version once", () => {
    store.setItem(storageKey("A.X"), JSON.stringify({ version: 1, values: { speedPercent: 50 } }));
    const migrate = vi.fn((old: Record<string, unknown>) => ({ speed: (old.speedPercent as number) / 10 }));
    const s = definePluginSettings("A.X", schema({ version: 2, migrate }));
    expect(migrate).toHaveBeenCalledWith({ speedPercent: 50 }, 1);
    expect(s.get("speed")).toBe(5);
    expect(JSON.parse(store.getItem(storageKey("A.X"))!).version).toBe(2);
    definePluginSettings("A.X", schema({ version: 2, migrate }));
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it("imports an old key once, when nothing is stored yet", () => {
    store.setItem("old.key", JSON.stringify({ speed: 9 }));
    const legacy = vi.fn(() => JSON.parse(store.getItem("old.key")!));
    expect(definePluginSettings("A.X", schema({ legacy })).get("speed")).toBe(9);
    store.setItem("old.key", JSON.stringify({ speed: 1 }));
    expect(definePluginSettings("A.X", schema({ legacy })).get("speed")).toBe(9);
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("does not import the old key again after Remove forgot the settings", () => {
    store.setItem("old.key", JSON.stringify({ speed: 7 }));
    const legacy = () => JSON.parse(store.getItem("old.key")!);
    expect(definePluginSettings("A.X", schema({ legacy })).get("speed")).toBe(7);
    removePluginSettings("A.X");
    const again = definePluginSettings("A.X", schema({ legacy }));
    expect(again.get("speed")).toBe(2);
    expect(storedSettings("A.X")).toEqual(again.all());
    again.set("speed", 4);
    expect(definePluginSettings("A.X", schema({ legacy })).get("speed")).toBe(4);
  });

  it("forgets a plugin that is not running without importing its old key later", () => {
    store.setItem("old.key", JSON.stringify({ speed: 7 }));
    removePluginSettings("A.Y");
    const legacy = () => JSON.parse(store.getItem("old.key")!);
    expect(definePluginSettings("A.Y", schema({ legacy })).get("speed")).toBe(2);
  });

  it("writes nothing when there was nothing to import", () => {
    definePluginSettings("A.X", schema({ legacy: () => null }));
    expect(store.map.size).toBe(0);
  });
});

describe("listeners", () => {
  it("hear a set and a reset, and not a set to the same value", () => {
    const s = definePluginSettings("A.X", schema());
    const heard: string[][] = [];
    const off = s.onChange((keys) => heard.push(keys));
    s.set("speed", 3);
    s.set("speed", 3);
    s.set("on", true);
    s.reset("speed");
    s.reset("speed");
    s.reset();
    off();
    s.set("speed", 4);
    expect(heard).toEqual([["speed"], ["on"], ["speed"], ["on"]]);
    expect(s.isDefault("speed")).toBe(false);
  });
});

describe("search", () => {
  it("matches labels, descriptions and groups, and never data", () => {
    const props = schema().props;
    const hit = (q: string) => props.filter((p) => settingMatches(p, q)).map((p) => p.key);
    expect(hit("spe")).toEqual(["speed"]);
    expect(hit("look")).toEqual(["tint"]);
    expect(hit("")).not.toContain("list");
  });
});
