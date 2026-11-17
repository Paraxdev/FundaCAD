// The guided first bracket.

import { t } from "../../i18n";
import { fmtKeys } from "../../input/platform";
import type { TourLines } from "./tourRunner";

export const firstBracketLines: TourLines = {
  finished: () => t("tour.bracket.finished", { keys: fmtKeys("Ctrl+S") }),
  opened: () => t("tour.bracket.opened"),
  assistant: () => t("tour.bracket.assistant"),
  refused: () => t("tour.bracket.refused"),
};
