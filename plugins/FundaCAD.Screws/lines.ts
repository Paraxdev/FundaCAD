import { activeLanguage, pluginText } from "fundacad";

export const { t } = pluginText<typeof import("./locales/en.json")>(
  "FundaCAD.Screws",
  import.meta.glob("./locales/*.json", { eager: true, import: "default" }),
);

// The catalogue data names things in English, which stay the ids, so a label read from it goes through this table.
const LABELS: Record<string, () => string> = {
  "Across flats": () => t("label.acrossFlats"),
  Bolts: () => t("label.bolts"),
  Button: () => t("label.button"),
  Chamfered: () => t("label.chamfered"),
  Cheese: () => t("label.cheese"),
  "Collar diameter": () => t("label.collarDiameter"),
  "Collar height": () => t("label.collarHeight"),
  Cone: () => t("label.cone"),
  Countersunk: () => t("label.countersunk"),
  Cup: () => t("label.cup"),
  "Cup diameter": () => t("label.cupDiameter"),
  Depth: () => t("label.depth"),
  "Flange diameter": () => t("label.flangeDiameter"),
  "Flange thickness": () => t("label.flangeThickness"),
  Flat: () => t("label.flat"),
  "Ground shoulder": () => t("label.groundShoulder"),
  "Head diameter": () => t("label.headDiameter"),
  "Head height": () => t("label.headHeight"),
  Headless: () => t("label.headless"),
  Height: () => t("label.height"),
  Hex: () => t("label.hex"),
  "Hex flange": () => t("label.hexFlange"),
  "Hex height": () => t("label.hexHeight"),
  "Hex socket": () => t("label.hexSocket"),
  "Hexalobular (Torx)": () => t("label.hexalobularTorx"),
  "Inner diameter": () => t("label.innerDiameter"),
  Inserts: () => t("label.inserts"),
  "Knurl diameter": () => t("label.knurlDiameter"),
  "Knurled heat-set": () => t("label.knurledHeatSet"),
  "Knurled thumb": () => t("label.knurledThumb"),
  Length: () => t("label.length"),
  "Length (under the head, overall for countersunk)": () => t("label.lengthUnderTheHeadOverallForCountersunk"),
  "Low cap": () => t("label.lowCap"),
  "Machine screws": () => t("label.machineScrews"),
  Metric: () => t("label.metric"),
  "Nominal diameter": () => t("label.nominalDiameter"),
  None: () => t("label.none"),
  Nut: () => t("label.nut"),
  Nuts: () => t("label.nuts"),
  "Nylon insert lock": () => t("label.nylonInsertLock"),
  "Outer diameter": () => t("label.outerDiameter"),
  "Overall head height": () => t("label.overallHeadHeight"),
  "Overall height": () => t("label.overallHeight"),
  Pan: () => t("label.pan"),
  Phillips: () => t("label.phillips"),
  Pitch: () => t("label.pitch"),
  Plain: () => t("label.plain"),
  "Point diameter": () => t("label.pointDiameter"),
  "Point to point (A)": () => t("label.pointToPointA"),
  Pozidriv: () => t("label.pozidriv"),
  "Recess diameter (m)": () => t("label.recessDiameterM"),
  "Screw or bolt": () => t("label.screwOrBolt"),
  "Section thickness": () => t("label.sectionThickness"),
  "Set screws": () => t("label.setScrews"),
  "Shoulder diameter": () => t("label.shoulderDiameter"),
  "Shoulder length": () => t("label.shoulderLength"),
  "Shoulder screw": () => t("label.shoulderScrew"),
  Slot: () => t("label.slot"),
  "Slot depth": () => t("label.slotDepth"),
  "Slot width": () => t("label.slotWidth"),
  "Socket cap": () => t("label.socketCap"),
  "Socket screws": () => t("label.socketScrews"),
  "Special screws": () => t("label.specialScrews"),
  "Split spring lock": () => t("label.splitSpringLock"),
  Square: () => t("label.square"),
  "Square size": () => t("label.squareSize"),
  Tapping: () => t("label.tapping"),
  "Tapping and wood screws": () => t("label.tappingAndWoodScrews"),
  "Tapping cone": () => t("label.tappingCone"),
  Thickness: () => t("label.thickness"),
  "Thread length": () => t("label.threadLength"),
  "Threaded insert": () => t("label.threadedInsert"),
  "Unified inch": () => t("label.unifiedInch"),
  Washer: () => t("label.washer"),
  Washers: () => t("label.washers"),
  "Width across flats": () => t("label.widthAcrossFlats"),
};

// A family's English name is what a saved spec carries, so its title is a display line keyed by the family id.
const FAMILY_TITLES: Record<string, () => string> = {
  asmeButton: () => t("family.asmeButton"),
  asmeFlatSocket: () => t("family.asmeFlatSocket"),
  asmeHexCap: () => t("family.asmeHexCap"),
  asmeHexNut: () => t("family.asmeHexNut"),
  asmeSocketCap: () => t("family.asmeSocketCap"),
  din127: () => t("family.din127"),
  din464: () => t("family.din464"),
  din562: () => t("family.din562"),
  din6921: () => t("family.din6921"),
  din6923: () => t("family.din6923"),
  din7984: () => t("family.din7984"),
  heatset: () => t("family.heatset"),
  iso10642: () => t("family.iso10642"),
  iso1207: () => t("family.iso1207"),
  iso14583: () => t("family.iso14583"),
  iso4014: () => t("family.iso4014"),
  iso4017: () => t("family.iso4017"),
  iso4026: () => t("family.iso4026"),
  iso4027: () => t("family.iso4027"),
  iso4029: () => t("family.iso4029"),
  iso4032: () => t("family.iso4032"),
  iso4035: () => t("family.iso4035"),
  iso4762: () => t("family.iso4762"),
  iso7040: () => t("family.iso7040"),
  iso7045: () => t("family.iso7045"),
  iso7046: () => t("family.iso7046"),
  iso7049: () => t("family.iso7049"),
  iso7089: () => t("family.iso7089"),
  iso7093: () => t("family.iso7093"),
  iso7379: () => t("family.iso7379"),
  iso7380: () => t("family.iso7380"),
  saeWasher: () => t("family.saeWasher"),
};

/** A catalogue family's title in the chosen language, its English name when it has no line. */
export const familyTitle = (id: string, english: string): string => FAMILY_TITLES[id]?.() ?? english;

/** A label from fields.json or a category heading in the chosen language, the English text when it has no line. */
export const label = (english: string): string => LABELS[english]?.() ?? english;

// Only languages that lowercase a noun mid sentence take a label lowercased, the rule of LOWERS_LABELS in the core.
const LOWERS_LABELS: ReadonlySet<string> = new Set(["en", "fr", "es"]);

export const languageTag = () => activeLanguage().bcp47;

const languageCode = () => activeLanguage().code.split("-")[0] || "en";

export const lowerCase = (text: string) => (LOWERS_LABELS.has(languageCode()) ? text.toLowerCase() : text);
