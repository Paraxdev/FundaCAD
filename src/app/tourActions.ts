// Where the Home card, Help and the palette start a guided tour.

import { t } from "../i18n";
import { closeHome } from "../ui/home";
import { FIRST_BRACKET_NAME, firstBracketTour } from "../ui/tour/firstBracket";
import type { Tour } from "../ui/tour/tourRunner";
import { mayDiscard } from "./documentActions";
import type { Engine } from "./engine";

export type TourEngine = Pick<Engine, "store" | "sketch" | "viewport" | "guide" | "tour"> &
  Partial<Pick<Engine, "tools">>;

/** False when the maker kept the open document, or an assistant's guide is up. */
export async function startTour(e: TourEngine, tour: Tour, name: string): Promise<boolean> {
  // Refused with its toast before the open document is given up.
  if (e.guide.active) return e.tour.start(tour);
  if (!(await mayDiscard(e, t("document.discard.newDocument")))) return false;
  // Stopped as Stop would, since the new document would end it with the toast about another document.
  if (e.tour.running) e.tour.session.stop();
  // newDocument tells its open listeners at once, so the tour that one would stop is not yet running.
  e.store.newDocument();
  e.viewport.resetCamera(false);
  e.store.markOpenedWithoutPath(name);
  closeHome();
  return e.tour.start(tour);
}

export const startFirstBracket = (e: TourEngine): Promise<boolean> =>
  startTour(e, firstBracketTour, FIRST_BRACKET_NAME);
