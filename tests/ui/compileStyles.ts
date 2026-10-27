import * as sass from "sass";

// Raw text through Vite, so no node types. Keyed by the path below src/styles, "ui/_button.scss".
const files = new Map(
  Object.entries(
    import.meta.glob("../../src/styles/**/*.scss", { query: "?raw", import: "default", eager: true }) as Record<
      string,
      string
    >,
  ).map(([path, text]) => [path.replace(/^.*\/src\/styles\//, ""), text]),
);

function resolve(path: string): string | null {
  const slash = path.lastIndexOf("/") + 1;
  const dir = path.slice(0, slash);
  const base = path.slice(slash);
  return [path, `${dir}_${base}.scss`, `${path}.scss`, `${path}/_index.scss`].find((p) => files.has(p)) ?? null;
}

const below = (url: URL) => decodeURIComponent(url.pathname).replace(/^\/styles\//, "");

/** src/styles/main.scss compiled the way Vite compiles it, partials and folder indexes resolved. */
export function compileMainScss(): string {
  return sass.compileString(files.get("main.scss") ?? "", {
    url: new URL("file:///styles/main.scss"),
    importers: [
      {
        canonicalize: (url) => {
          const found = resolve(below(new URL(url, "file:///styles/")));
          return found === null ? null : new URL(`file:///styles/${found}`);
        },
        load: (canonical) => {
          const contents = files.get(below(canonical));
          return contents === undefined ? null : { contents, syntax: "scss" };
        },
      },
    ],
  }).css;
}
