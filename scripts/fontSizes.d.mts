// Types for the font size scan, so tests/ui/fontSizes.test.ts type checks under vue-tsc without @types/node.

export interface FontSizeFinding {
  path: string;
  /** 1-based. */
  line: number;
  /** The declaration as written, for example `font-size: 10px` or `font: 600 11px/1 var(--mono)`. */
  decl: string;
}

export interface FontSizeAllowEntry {
  path: string;
  count: number;
  reason: string;
}

export declare function isScanned(path: string): boolean;
export declare function shorthandSize(value: string): string | null;
export declare function isTokened(size: string): boolean;
export declare function scanFontSizes(files: Record<string, string>): FontSizeFinding[];
export declare function checkAllowlist(
  findings: readonly FontSizeFinding[],
  allow: readonly FontSizeAllowEntry[],
): string[];
export declare function lowerAllowlist(
  findings: readonly FontSizeFinding[],
  allow: readonly FontSizeAllowEntry[],
): FontSizeAllowEntry[];
export declare function formatAllowlist(allow: readonly FontSizeAllowEntry[]): string;
