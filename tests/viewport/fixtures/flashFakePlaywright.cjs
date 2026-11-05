// Stands in for playwright-core under `node --require`, so tests/viewport/pathtraceFlashRun.test.ts can run the flash
// script's start and end without a browser. A run's page hangs, throws out of goto, or with opensApp stops after the adapter.
const fs = require("fs");
const Module = require("module");

const {
  consoleLines = [],
  chromeLines = [],
  pageErrors = [],
  gotoThrowsAfterMs = null,
  launchHangs = false,
  launchThrows = false,
  opensApp = false,
} = JSON.parse(process.env.FAKE_PW);
const realLoad = Module._load;

function fakePlaywright() {
  console.log(`fake load ${JSON.stringify({ DEBUG: process.env.DEBUG, DEBUG_FILE: process.env.DEBUG_FILE })}`);
  const logFile = process.env.DEBUG_FILE ? fs.createWriteStream(process.env.DEBUG_FILE) : null;
  const pending = [];
  let waits = 0;
  const page = {
    listeners: {},
    on(event, listener) {
      this.listeners[event] = listener;
    },
    async addInitScript() {},
    async goto(url) {
      for (const text of consoleLines) this.listeners.console({ type: () => "log", text: () => text });
      for (const message of pageErrors) this.listeners.pageerror({ message });
      if (gotoThrowsAfterMs === null) return;
      await new Promise((r) => setTimeout(r, gotoThrowsAfterMs));
      throw new Error(`fake stop at ${url}`);
    },
    async waitForFunction() {
      if (opensApp && waits++ === 0) return;
      if (opensApp) throw new Error("fake stop");
      await new Promise((_, reject) => pending.push(reject));
    },
    async waitForTimeout() {},
    $: async () => null,
    evaluate: async () => ({ fake: "adapter" }),
  };
  const browser = {
    newPage: async () => page,
    async close() {
      for (const reject of pending) reject(new Error("fake browser closed"));
    },
  };
  return {
    chromium: {
      async launch({ args }) {
        console.log(`fake launch ${JSON.stringify(args)}`);
        for (const line of chromeLines) logFile?.write(`${line}\n`);
        if (launchThrows) throw new Error("fake launch failed");
        // Exits by itself, so a run that never stops at its deadline fails here and not on the test's own timeout.
        if (launchHangs) await new Promise(() => setTimeout(() => process.exit(7), 5000));
        return browser;
      },
    },
  };
}

Module._load = function (request, ...rest) {
  return request === "playwright-core" ? fakePlaywright() : realLoad.call(this, request, ...rest);
};
