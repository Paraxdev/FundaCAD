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
// here, and a test that fails on every ordinary run is a test everyone learns to
// skip past. That gate no longer stops the publish, because the installers are
// fine and are what people download; it withholds latest.json, so the feed is
// empty rather than full of bundles no install can verify, and the release notes
// say the build does not update itself. What is checked here is the invariant
// that makes the stale key survivable in the meantime, which is that updates
// only ever come from a repository we control.

import { describe, expect, it } from "vitest";

import confRaw from "../../src-tauri/tauri.conf.json?raw";
import releaseRaw from "../../src-tauri/tauri.beta.conf.json?raw";
import stableRaw from "../../src-tauri/tauri.stable.conf.json?raw";
import devRaw from "../../src-tauri/tauri.dev.conf.json?raw";

const conf = JSON.parse(confRaw) as {
  plugins: { updater: { pubkey: string; endpoints: string[] } };
};

const release = JSON.parse(releaseRaw) as {
  plugins?: unknown;
};

const stable = JSON.parse(stableRaw) as {
  plugins: { updater: { endpoints: string[] } };
};

const dev = JSON.parse(devRaw) as {
  plugins: { updater: { endpoints: string[] } };
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
    for (const url of [
      ...conf.plugins.updater.endpoints,
      ...stable.plugins.updater.endpoints,
      ...dev.plugins.updater.endpoints,
    ]) {
      expect(new URL(url).origin, `updater endpoint ${url}`).toBe("https://github.com");
      expect(new URL(url).pathname.startsWith("/Paraxdev/fundacad/"), `updater endpoint ${url}`).toBe(true);
    }
  });

  it("carries a well-formed minisign public key", () => {
    // Not WHICH key: see the release job for that. Only that the field has not
    // been emptied, which would disable verification rather than fail it.
    const key = conf.plugins.updater.pubkey;
    expect(key.length).toBeGreaterThan(40);
    // atob rather than Buffer: this project's tsconfig has no node types, and a
    // test that does not typecheck is one vue-tsc reports instead of the code.
    expect(atob(key), "the updater pubkey is not a minisign public key").toMatch(/minisign public key/);
  });

  // The endpoint is baked into the binary at build time, so which feed a copy
  // reads is decided by the config it was built with and can never change
  // afterwards. A push to main builds the rolling beta, which reads
  // beta/latest.json. The retired alpha feed is only a mirror the release job
  // writes so old alpha installs move over, and nothing built now may read it,
  // or dropping the mirror would strand every copy built in the meantime.
  //
  // docs/ENGINE.md section 6 has the decision and why it is not "publish no
  // manifest at all": a rolling build that cannot update itself is one nobody
  // re-downloads.
  it("reads the beta feed and never the retired alpha one", () => {
    const path = (urls: string[]) => urls.map((u) => new URL(u).pathname);
    expect(path(conf.plugins.updater.endpoints)).toEqual(["/Paraxdev/fundacad/releases/download/beta/latest.json"]);
    expect(confRaw + releaseRaw + stableRaw + devRaw).not.toContain("/alpha/latest.json");
  });

  // GitHub's latest release is never a pre-release, so the rolling beta can
  // never be what a stable install finds there.
  it("a stable build reads the latest stable release's feed", () => {
    const path = (urls: string[]) => urls.map((u) => new URL(u).pathname);
    expect(path(stable.plugins.updater.endpoints)).toEqual(["/Paraxdev/fundacad/releases/latest/download/latest.json"]);
  });

  // Its own feed, so a development install never updates to a beta and the
  // development release can never move a beta install.
  it("a development build reads the development release's feed", () => {
    const path = (urls: string[]) => urls.map((u) => new URL(u).pathname);
    expect(path(dev.plugins.updater.endpoints)).toEqual([
      "/Paraxdev/fundacad/releases/download/development/latest.json",
    ]);
  });

  // No pubkey or identifier of its own, so the release job's guard on the
  // base config's key holds for every channel, and installing another
  // channel's installer replaces the app instead of adding a second one.
  it.each([
    ["stable", stable],
    ["development", dev],
  ])("the %s config is the beta one with the feed swapped and nothing else", (_, cfg) => {
    const { plugins, ...rest } = cfg;
    expect(rest).toEqual(release);
    expect(plugins).toEqual({ updater: { endpoints: plugins.updater.endpoints } });
  });

  it("leaves the feed to the base config, so the release build cannot diverge from it", () => {
    expect(release.plugins).toBeUndefined();
  });

  // The release job still refuses upstream's key, so a merge that brings it
  // back costs the feed rather than shipping updates nobody can verify.
  it("carries this project's own key, not upstream's", () => {
    expect(
      conf.plugins.updater.pubkey,
      "the updater pubkey is upstream's again, so no update this project signs would verify",
    ).not.toBe(UPSTREAM_PUBKEY);
  });
});
