import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";

/** The plugin host specifier, the same one vite.config.ts aliases. Repeated
 *  here because vitest's projects do not inherit the app's vite config, and a
 *  test that could not resolve `fundacad` would be a test that cannot import a
 *  plugin. */
const alias = {
  "fundacad/ui": fileURLToPath(new URL("./src/plugins/hostUi.ts", import.meta.url)),
  fundacad: fileURLToPath(new URL("./src/plugins/host.ts", import.meta.url)),
};

// Two suites, separated by filename so they can't blur together:
//   tests/**/*.test.ts -> "logic": node, no DOM. The geometry/solver tests are the
//                         load-bearing ones and have no business paying for a DOM.
//   tests/**/*.spec.ts -> "components": Vue SFCs under happy-dom.
//
// happy-dom implements no layout: offsetWidth is 0 and getBoundingClientRect()
// returns zeros, so measurement-driven code (ribbon overflow, context-menu flip,
// timeline gapIndexAt, dimension-label projection) is e2e territory, not this.
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "logic",
          include: ["tests/**/*.test.ts"],
          environment: "node",
          globals: false,
        },
      },
      {
        plugins: [vue()],
        resolve: { alias },
        test: {
          name: "components",
          include: ["tests/**/*.spec.ts"],
          environment: "happy-dom",
          globals: false,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/document/**", "src/sketch/**", "src/geometry/**", "src/io/**"],
      reporter: ["text-summary"],
    },
  },
});
