import { fmtKeys } from "../../input/platform";

/** The one tooltip text of a base control: `tip`, its shortcut in brackets, with the platform's key names. */
export function tipText(tip: string | undefined, keys?: string): string | undefined {
  if (!tip) return undefined;
  return fmtKeys(keys ? `${tip} (${keys})` : tip);
}
