// The updater's signing key, and the endpoint it trusts.
//
// Tauri's updater verifies a release with the minisign public key baked into
// tauri.conf.json. The fork inherited UPSTREAM's public key while the endpoint
// now points at this project's own releases, and the two do not go together:
// a release signed with a key generated here will not verify against upstream's
// public key, so the updater fails for every installed copy. Nothing reports
// that at build time. The first sign of it is users who stop receiving updates.
//
// This is a broken feature rather than an open door, since the endpoint is a
// repository we control. It stays that way only while the endpoint does, which
// is why that is pinned here too: a pubkey we do not hold the private half of,
// pointed at a host we do not own, is a different and much worse thing.
//
// The fix is not something a test can do, because it involves a private key that
// must not exist in this repository:
//
//   npm run tauri signer generate -- -w <a path OUTSIDE this repo>
//
// then put the private key and its password in the TAURI_SIGNING_PRIVATE_KEY
// and TAURI_SIGNING_PRIVATE_KEY_PASSWORD repository secrets and paste the public
// half into tauri.conf.json.
//
// So the "is it still upstream's key" gate lives in the RELEASE job rather than
// here: it has to stop a publish, and a test that fails on every ordinary run is
// a test everyone learns to skip past. What is checked here is the invariant
// that makes the stale key survivable in the meantime, which is that updates
// only ever come from a repository we control.

import { describe, expect, it } from "vitest";

import confRaw from "../../src-tauri/tauri.conf.json?raw";

const conf = JSON.parse(confRaw) as {
  plugins: { updater: { pubkey: string; endpoints: string[] } };
};

/** Upstream's minisign public key, as inherited at the fork point. Recorded so
 *  the check names what it found rather than saying only "wrong". */
const UPSTREAM_PUBKEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDUwMkY3MDMzN0E1RUREMUYKUldRZjNWNTZNM0F2VU81ZU9YLzBPdDV6UVdkVklPOWg1S01zdU1lWitDMGR6aFg1cmJoZnYrMWIK";

describe("updater", () => {
  it("only ever fetches updates from this project's own releases", () => {
    // The endpoint is what makes the stale pubkey survivable. If updates came
    // from somewhere we do not control, holding the wrong public key would stop
    // being an inconvenience.
    for (const url of conf.plugins.updater.endpoints) {
      expect(new URL(url).origin, `updater endpoint ${url}`).toBe("https://github.com");
      expect(new URL(url).pathname.startsWith("/Paraxdev/neocad/"), `updater endpoint ${url}`)
        .toBe(true);
    }
  });

  it("carries a well-formed minisign public key", () => {
    // Not WHICH key: see the release job for that. Only that the field has not
    // been emptied, which would disable verification rather than fail it.
    const key = conf.plugins.updater.pubkey;
    expect(key.length).toBeGreaterThan(40);
    expect(
      Buffer.from(key, "base64").toString("utf8"),
      "the updater pubkey is not a minisign public key",
    ).toMatch(/minisign public key/);
  });

  it("still carries UPSTREAM's key, which the release job must refuse", () => {
    // A live record of the thing that is not done yet, so it cannot be forgotten
    // quietly. When the key is replaced this test fails, and the correct fix is
    // to delete it along with UPSTREAM_PUBKEY above and the guard in the release
    // job, because the problem is then gone.
    expect(
      conf.plugins.updater.pubkey,
      "the updater pubkey is no longer upstream's, so remove this test, " +
        "UPSTREAM_PUBKEY, and the pubkey guard in .github/workflows/build.yml",
    ).toBe(UPSTREAM_PUBKEY);
  });
});
