// Plugins compiled into a development build only. ./activate.ts imports this inside an `import.meta.env.DEV` branch, so
// rollup drops it and every plugin's code from a shipped build; tests/plugins/shipped.test checks the built output.

const MAIN = import.meta.glob("../../plugins/*/main.ts") as Record<string, () => Promise<unknown>>;

/** `../../plugins/Some.Thing/main.ts` -> `Some.Thing`. */
function idOf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 2] ?? "";
}

export const devLoaders: Record<string, () => Promise<unknown>> = Object.fromEntries(
  Object.entries(MAIN).map(([path, load]) => [idOf(path), load]),
);
