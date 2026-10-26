// The release channel this build was made for (VITE_FUNDACAD_RELEASE, set by .github/workflows/build.yml). The
// development build is its own product, FundaCAD Dev, so it can be told apart from the beta it installs beside.

const release = (import.meta.env.VITE_FUNDACAD_RELEASE as string | undefined) || "beta";

export function productName(tag: string = release): string {
  return tag === "development" ? "FundaCAD Dev" : "FundaCAD";
}

export const PRODUCT_NAME = productName();

/** The development build shows its CI build number as dev-<n>. The real version stays 1.0.<n>, which the updater
 *  compares and the NSIS and MSI version fields require. */
export function versionLabel(version: string, tag: string = release): string {
  if (tag !== "development") return version;
  const build = /^\d+\.\d+\.(\d+)$/.exec(version)?.[1];
  return build ? `dev-${build}` : version;
}

/** The SourceForge mirror copies every release into a folder per channel, the root holds the rest. */
export function sourceforgeUrl(tag: string = release): string {
  const base = "https://sourceforge.net/projects/fundacad/files/";
  return tag === "beta" || tag === "development" ? `${base}${tag}/` : base;
}
