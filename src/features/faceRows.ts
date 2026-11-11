import { awaitTreePick, treePickRefusal, type TreePickAnswer } from "../ui/treePick";
import type { Viewport } from "../viewport/viewport";
import type { PressPullFaces } from "../viewport/faceAnalysis";

/** A face row from the Geometry list reaches a face tool as that face selected before the tool starts. These tools stay
 *  open through undo and menu commands, so their row session does too. */
export function awaitFaceRows(
  viewport: Viewport,
  wanted: string,
  take: (faces: PressPullFaces) => TreePickAnswer,
  end: () => void,
  batch?: (run: () => void) => void,
): () => void {
  return awaitTreePick(
    (pick) => {
      if (pick.kind !== "face") return treePickRefusal(pick, wanted);
      const faces = viewport.facesForPressPull([pick.faceId]);
      return faces ? take(faces) : "The model is still building";
    },
    end,
    { keepsOnRewind: true, keepsOnCommand: true, batch },
  );
}
