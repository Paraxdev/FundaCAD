import { themeColor } from "../viewport/themeColors";

// The Mirror panel's field stripes read the same two tokens, so a field and what it holds in the view match.
export const mirrorObjectsColor = (): number => themeColor("--accent", 0x9a9ff0);
export const mirrorLineColor = (): number => themeColor("--pick-line", 0xb48cff);
