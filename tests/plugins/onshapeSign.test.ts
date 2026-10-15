// The vectors use the example secret and date from Onshape's API key page,
// which publishes no expected signature, so the answers were computed with the
// reference client's algorithm and checked with openssl (see the plugin README).

import { describe, expect, it } from "vitest";
import { signOnshape } from "../../plugins/FundaCAD.Onshape/sign";

const keys = { access: "abcdefghi0123456789jkl", secret: "abcdefghijklmnopqrstuvwxzy0123456789abcdefghijkl" }; // gitleaks:allow, the example keys from Onshape's API key page
const date = "Mon, 11 Apr 2016 20:08:56 GMT";
const nonce = "0123456789abcdefghijklm";

describe("Onshape request signing", () => {
  it("matches the reference signature for a GET with no query", async () => {
    const h = await signOnshape({
      method: "GET",
      url: "https://cad.onshape.com/api/v10/translations/5d6f9ec8a6a7ce1a1e2a0b34",
      contentType: "",
      ...keys,
      date,
      nonce,
    });
    expect(h.Authorization).toBe("On abcdefghi0123456789jkl:HmacSHA256:T/HvilblhstL8GD7dro5Ue8xkh3j0U0eSaGAE3nS5h0=");
    expect(h.Date).toBe(date);
    expect(h["On-Nonce"]).toBe(nonce);
  });

  it("signs the query in the order it is sent", async () => {
    const h = await signOnshape({
      method: "GET",
      url: "https://cad.onshape.com/api/v10/documents/d/e60c4803eaf2ac8be492c18e/elements?elementType=PARTSTUDIO&withThumbnails=false",
      contentType: "",
      ...keys,
      date,
      nonce,
    });
    expect(h.Authorization.split(":").pop()).toBe("RwaFUah9VwB6fTgecMp7QKqWTXkWk130GqWbY/LdFIo=");
  });

  it("signs a POST with its content type", async () => {
    const h = await signOnshape({
      method: "POST",
      url: "https://cad.onshape.com/api/v10/partstudios/d/e60c4803eaf2ac8be492c18e/w/d2558da712764516cc9fec62/e/6bed6b43463f6a46a37b4a22/export/step",
      contentType: "application/json",
      ...keys,
      date,
      nonce,
    });
    expect(h.Authorization.split(":").pop()).toBe("ENjN7s5E76HVGOUXzMHMsWgBjvisN23aSNDLmUtshdk=");
    expect(h["Content-Type"]).toBe("application/json");
  });

  it("makes a fresh 25 character nonce and an RFC 1123 date when none is given", async () => {
    const a = await signOnshape({ method: "GET", url: "https://cad.onshape.com/api/x", contentType: "", ...keys });
    const b = await signOnshape({ method: "GET", url: "https://cad.onshape.com/api/x", contentType: "", ...keys });
    expect(a["On-Nonce"]).toMatch(/^[A-Za-z0-9]{25,}$/);
    expect(a["On-Nonce"]).not.toBe(b["On-Nonce"]);
    expect(a.Date).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
  });
});
