import { describe, expect, it } from "vitest";
import { parseOnshapeUrl, sourceOf } from "../../plugins/FundaCAD.Onshape/url";

const D = "e60c4803eaf2ac8be492c18e";
const W = "d2558da712764516cc9fec62";
const E = "6bed6b43463f6a46a37b4a22";

describe("an Onshape link", () => {
  it("reads a workspace, version and microversion part studio", () => {
    for (const wvm of ["w", "v", "m"] as const) {
      expect(parseOnshapeUrl(`https://cad.onshape.com/documents/${D}/${wvm}/${W}/e/${E}`)).toEqual({
        base: "https://cad.onshape.com",
        did: D,
        wvm,
        wvmid: W,
        eid: E,
      });
    }
  });

  it("reads a link with no element as the whole document", () => {
    expect(parseOnshapeUrl(`https://cad.onshape.com/documents/${D}/w/${W}`)).toEqual({
      base: "https://cad.onshape.com",
      did: D,
      wvm: "w",
      wvmid: W,
    });
    expect(parseOnshapeUrl(`https://cad.onshape.com/documents/${D}/`)).toEqual({
      base: "https://cad.onshape.com",
      did: D,
    });
  });

  it("accepts a company host, spaces around, a query and a fragment", () => {
    const r = parseOnshapeUrl(`  https://acme.onshape.com/documents/${D}/w/${W}/e/${E}?renderMode=0&uiState=x#hash \n`);
    expect(r).toEqual({ base: "https://acme.onshape.com", did: D, wvm: "w", wvmid: W, eid: E });
  });

  it("refuses anything that is not an Onshape document link", () => {
    for (const bad of [
      `http://cad.onshape.com/documents/${D}/w/${W}/e/${E}`,
      `https://evil.com/documents/${D}/w/${W}/e/${E}`,
      `https://evilonshape.com/documents/${D}/w/${W}/e/${E}`,
      `https://cad.onshape.com.evil.net/documents/${D}/w/${W}/e/${E}`,
      `https://onshape.com@evil.com/documents/${D}`,
      `https://cad.onshape.com/documents/${D.slice(1)}/w/${W}/e/${E}`,
      `https://cad.onshape.com/documents/${D}/x/${W}/e/${E}`,
      `https://cad.onshape.com/documents/${D}/w/${W}/e/${E}/extra`,
      `https://cad.onshape.com/documents/${D}/w`,
      "not a link",
      "",
    ]) {
      expect(parseOnshapeUrl(bad), bad).toHaveProperty("error");
    }
  });

  it("records the link without its query or fragment", () => {
    const link = parseOnshapeUrl(`https://cad.onshape.com/documents/${D}/w/${W}/e/${E}?key=secret#x`);
    if ("error" in link) throw new Error(link.error);
    expect(sourceOf(link)).toBe(`https://cad.onshape.com/documents/${D}/w/${W}/e/${E}`);
  });
});
