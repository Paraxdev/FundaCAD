// Types for the raw UI text scan, so tests/ui/uiStrings.test.ts type checks under vue-tsc without @types/node.

export interface StringFinding {
  path: string;
  /** 1-based. */
  line: number;
  kind: "template" | "script";
  /** Where the text sits, for example `text`, `{{ }}`, `title=`, `:title=`, `toast()`, `label:` or `sentence`. */
  detail: string;
  /** On one line, a `${}` hole shown as an ellipsis. */
  text: string;
}

export interface StringAllowEntry {
  path: string;
  kind: string;
  count: number;
  reason: string;
}

export declare function isScanned(path: string): boolean;
export declare function scanStrings(files: Record<string, string>): StringFinding[];
export declare function usedKeys(files: Record<string, string>): Set<string>;
export declare function checkAllowlist(
  findings: readonly StringFinding[],
  allow: readonly StringAllowEntry[],
): string[];
export declare function lowerAllowlist(
  findings: readonly StringFinding[],
  allow: readonly StringAllowEntry[],
): StringAllowEntry[];
export declare function formatAllowlist(allow: readonly StringAllowEntry[]): string;
