// The app's own config with a dependency cache of its own: a worktree's node_modules is a junction shared
// with other checkouts, and another vite re-optimizing that shared cache reloads this page mid shot.
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import base from "../../../vite.config.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const key = createHash("sha1").update(root.toLowerCase()).digest("hex").slice(0, 10);

export default {
  ...base,
  cacheDir: join(tmpdir(), "fundacad-capture", `vite-${key}`),
};
