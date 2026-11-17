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

export interface ThrownFinding {
  path: string;
  line: number;
  /** The class thrown, for example `Error` or `MeasureRefusal`. */
  name: string;
  /** The message on one line, a hole shown as an ellipsis, or `t() at the throw: …`. */
  text: string;
}

export interface ThrownAllowEntry {
  path: string;
  prefix: string;
  reason: string;
}

export declare function isThrownScanned(path: string): boolean;
export declare function scanThrown(files: Record<string, string>): ThrownFinding[];
export declare function checkThrown(findings: readonly ThrownFinding[], allow: readonly ThrownAllowEntry[]): string[];
