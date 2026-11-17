import { describe, expect, it } from "vitest";
import { englishLeft } from "./englishLeft";

const EN = "4 of the held faces are too narrow for the mesh and hold nothing. Choose Fine under Mesh detail.";

describe("englishLeft", () => {
  it("finds the English words a half translated line still holds", () => {
    expect(englishLeft("4 der gehaltenen faces sind zu schmal für das Netz, Mesh detail wählen", EN)).toEqual([
      "faces",
      "mesh",
      "detail",
    ]);
  });

  it("stays quiet for a translated line, for short words and for a word the test allows", () => {
    expect(englishLeft("4 der gehaltenen Flächen sind zu schmal für das Netz, 12,5 MPa", EN)).toEqual([]);
    expect(englishLeft("Die Fine Stufe, 3 mm", EN, ["FINE"])).toEqual([]);
    expect(englishLeft("das Netz am Rand", "the net at the edge")).toEqual([]);
  });
});
