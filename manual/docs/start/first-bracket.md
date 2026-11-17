# Your first bracket

The guided first bracket walks you through a small L bracket, from a flat sketch to a file for your slicer. It takes about 10 minutes. A bubble says what to do next, and a ring shows the control to use.

## Start the guide

Start it from any of these:

1. On Home, click **Your first bracket**.
2. Help > Guided First Bracket.
3. Ctrl+K, type `Guided First Bracket` and press Enter.

If the open document has unsaved changes, FundaCAD asks first. The guide then opens a new document called Bracket, closes Home and shows step 1.

## The steps

Each step moves on by itself once you have done what it asks. The key in brackets works in place of the click.

| Step | The guide asks you to | Moves on when |
|---|---|---|
| 1 | Click **Sketch** (S). | the plane tiles show |
| 2 | Click the small square labelled XZ beside the origin. It stands upright, so you draw the side of the bracket on it. | the sketch opens |
| 3 | Click **Line** (L). | Line is running |
| 4 | Click the six corners of an L, about 50 mm each way with arms 5 mm thick, and finish on the first corner. Rough is fine. | the L is closed |
| 5 | Click **Exit Sketching**. | the sketch closes |
| 6 | Click **Extrude** (E). | Extrude is running |
| 7 | Click inside the L, type 25 and press Enter. | the bracket is solid |
| 8 | Click **Fillet** (F). | Fillet is running |
| 9 | Click the inside corner edge where the arms meet, type 4 and press Enter. | the corner is rounded |
| 10 | Click **Hole**. | Hole is running |
| 11 | Click the flat back of the upright arm where a screw goes, click once more for each other screw, then press Enter. | the holes are made |
| 12 | Double click **Extrude** in the History, change 25 to 30 and press Enter. | the Extrude's distance changes |
| 13 | Save it with Ctrl+S, then choose **Export…** from the **File** menu and pick STL. | the Export window is open |
| 14 | Press **Next** to finish. | you press Next |

If the six lines miss the first corner, the L has no inside to extrude. After a few seconds the bubble adds "The L is not closed yet, click its first corner again."

## Next and Stop

1. **Next** skips the step on screen, whether you did it or not.
2. **Stop** ends the guide. Your bracket stays as it is.
3. Undo does not take the guide back a step. The step waits until what it asks is true again.
4. While Home is open, the bubble hides, and it comes back when you close Home.

## How the guide ends

| What happens | What you see |
|---|---|
| You press Next on step 14 | Guide finished. Save your bracket with Ctrl+S. |
| You press Stop | the bubble closes, nothing else |
| You open another document | The guided bracket stopped because another document opened. |
| An assistant starts a guide | The guided bracket stopped, an assistant started a guide. |

While an assistant's guide is running, the guided bracket does not start: stop that guide first. The guided bracket saves nothing for you, and nothing leaves your computer. To go again, start it from Home or Help.

Next, build a plate on your own in [Your first part](first-part.md), or open one of the [examples](examples.md).
