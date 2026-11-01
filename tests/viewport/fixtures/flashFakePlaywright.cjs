// Stands in for playwright-core under `node --require`, so tests/viewport/pathtraceFlashRun.test.ts can run the flash
// script's start and end without a browser. A run's page either hangs or throws out of goto, it never gets past openApp.
const fs = require("fs");
const Module = require("module");

const {
  consoleLines = [],
  chromeLines = [],
  gotoThrowsAfterMs = null,
  launchHangs = false,
  launchThrows = false,
} = JSON.parse(process.env.FAKE_PW);
const realLoad = Module._load;

function fakePlaywright() {
  console.log(`fake load ${JSON.stringify({ DEBUG: process.env.DEBUG, DEBUG_FILE: process.env.DEBUG_FILE })}`);
  const logFile = process.env.DEBUG_FILE ? fs.createWriteStream(process.env.DEBUG_FILE) : null;
  const pending = [];
  const page = {
    listeners: {},
    on(event, listener) {
      this.listeners[event] = listener;
    },
    async addInitScript() {},
    async goto() {
      for (const text of consoleLines) this.listeners.console({ type: () => "log", text: () => text });
      if (gotoThrowsAfterMs === null) return;
      await new Promise((r) => setTimeout(r, gotoThrowsAfterMs));
      throw new Error("fake stop");
    },
    waitForFunction: () => new Promise((_, reject) => pending.push(reject)),
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
