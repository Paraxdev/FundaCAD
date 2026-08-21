// Minimal stroke icons (24x24, currentColor) for the whole app. Each entry is the
// INNER SVG markup; Icon.vue and iconElement() wrap it in the <svg> carrying the
// shared viewBox / stroke / linecap so no icon can drift off the house weight.
//
// Everything here is a compile-time string constant. That is the security
// invariant, not a style note: this markup reaches the DOM through v-html, and it
// is only safe because no document data, file name or network payload can ever be
// interpolated into this table. tests/components/vHtmlPolicy.test.ts enforces the
// Vue half.
//
// A pack is a whole named table; the user picks one, and any name the chosen pack
// does not define resolves against the default pack. That fallback is what makes a
// pack cheap to write — a variant redraws only the marks whose weight it wants to
// change, so a half-finished pack is legitimate rather than a screen full of holes.

import { readSetting } from "./storedSetting";

/** A named, self-contained icon table. `paths` maps a semantic icon name to the
 *  inner SVG markup drawn inside the shared 24×24 stroke wrapper. */
export interface IconPack {
  id: string;
  /** Shown in the settings menu. */
  label: string;
  paths: Readonly<Record<string, string>>;
}

const FORGE_PATHS: Record<string, string> = {
  // sketch create
  line: `<line x1="4" y1="20" x2="20" y2="4"/><circle cx="4" cy="20" r="1.6" fill="currentColor"/><circle cx="20" cy="4" r="1.6" fill="currentColor"/>`,
  rectangle: `<rect x="4" y="6" width="16" height="12" rx="0.5"/>`,
  circle: `<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1" fill="currentColor"/>`,
  arc: `<path d="M4 19 A 14 14 0 0 1 20 11"/><circle cx="4" cy="19" r="1.5" fill="currentColor"/><circle cx="20" cy="11" r="1.5" fill="currentColor"/>`,
  spline: `<path d="M3 17 C 7 5, 11 5, 13 12 S 19 19, 21 7" fill="none"/><circle cx="3" cy="17" r="1.5" fill="currentColor"/><circle cx="13" cy="12" r="1.5" fill="currentColor"/><circle cx="21" cy="7" r="1.5" fill="currentColor"/>`,
  polygon: `<polygon points="12,3 20,9 17,19 7,19 4,9"/>`,
  point: `<circle cx="12" cy="12" r="2.2" fill="currentColor"/>`,
  text: `<path d="M4 6 H20 M12 6 V19" fill="none"/>`,
  slot: `<path d="M8 8 A 4 4 0 0 0 8 16 L16 16 A 4 4 0 0 0 16 8 Z"/>`,
  patternRect: `<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/>`,
  patternCircular: `<circle cx="12" cy="4" r="2.4"/><circle cx="19" cy="9" r="2.4"/><circle cx="16.5" cy="18" r="2.4"/><circle cx="7.5" cy="18" r="2.4"/><circle cx="5" cy="9" r="2.4"/>`,
  boltCircle: `<circle cx="12" cy="12" r="9" fill="none"/><circle cx="12" cy="3.5" r="1.8" fill="currentColor"/><circle cx="19.4" cy="8.3" r="1.8" fill="currentColor"/><circle cx="19.4" cy="15.7" r="1.8" fill="currentColor"/><circle cx="12" cy="20.5" r="1.8" fill="currentColor"/><circle cx="4.6" cy="15.7" r="1.8" fill="currentColor"/><circle cx="4.6" cy="8.3" r="1.8" fill="currentColor"/>`,
  hexHoles: `<circle cx="12" cy="6" r="2" fill="currentColor"/><circle cx="6.8" cy="9" r="2" fill="currentColor"/><circle cx="17.2" cy="9" r="2" fill="currentColor"/><circle cx="6.8" cy="15" r="2" fill="currentColor"/><circle cx="17.2" cy="15" r="2" fill="currentColor"/><circle cx="12" cy="18" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/>`,
  honeycomb: `<polygon points="12,2 16,4.5 16,9.5 12,12 8,9.5 8,4.5" fill="none"/><polygon points="12,12 16,14.5 16,19.5 12,22 8,19.5 8,14.5" fill="none"/><polygon points="20,7 24,9.5 24,14.5 20,17 16,14.5 16,9.5" fill="none"/><polygon points="4,7 8,9.5 8,14.5 4,17 0,14.5 0,9.5" fill="none"/>`,
  gridHoles: `<circle cx="6" cy="6" r="2" fill="currentColor"/><circle cx="12" cy="6" r="2" fill="currentColor"/><circle cx="18" cy="6" r="2" fill="currentColor"/><circle cx="6" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="18" cy="12" r="2" fill="currentColor"/><circle cx="6" cy="18" r="2" fill="currentColor"/><circle cx="12" cy="18" r="2" fill="currentColor"/><circle cx="18" cy="18" r="2" fill="currentColor"/>`,
  centerRectangle: `<rect x="4" y="6" width="16" height="12" rx="0.5"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="12" y1="9" x2="12" y2="15"/>`,
  // Three-point rectangle: a TILTED rectangle with the two edge corners and the
  // thickness point marked — the tilt is the whole point of the tool, so an
  // upright box here would read as the ordinary Rectangle.
  rectangle3: `<polygon points="3,13 12,4.5 21,11 12,19.5" fill="none"/><circle cx="3" cy="13" r="1.6" fill="currentColor"/><circle cx="12" cy="4.5" r="1.6" fill="currentColor"/><circle cx="21" cy="11" r="1.6" fill="currentColor"/>`,
  circle2: `<circle cx="12" cy="12" r="8"/><circle cx="4.5" cy="12" r="1.4" fill="currentColor"/><circle cx="19.5" cy="12" r="1.4" fill="currentColor"/>`,
  circle3: `<circle cx="12" cy="12" r="8"/><circle cx="12" cy="4" r="1.4" fill="currentColor"/><circle cx="19" cy="16" r="1.4" fill="currentColor"/><circle cx="5" cy="16" r="1.4" fill="currentColor"/>`,
  dimension: `<line x1="4" y1="7" x2="4" y2="17"/><line x1="20" y1="7" x2="20" y2="17"/><line x1="4" y1="12" x2="20" y2="12"/><path d="M7 9l-3 3 3 3"/><path d="M17 9l3 3-3 3"/>`,
  // Project: a 3D curve above, an arrow projecting it down onto a plane
  project: `<path d="M5 6 Q 12 1 19 6" fill="none"/><line x1="12" y1="7" x2="12" y2="13"/><path d="M9.5 11 L12 14 L14.5 11"/><path d="M3 19l5-4h13l-5 4z"/><path d="M6.5 17.4 Q 12 13.6 17.5 17.4" fill="none" stroke-dasharray="2 1.4"/>`,

  // inspect
  measure: `<rect x="3" y="9" width="18" height="6" rx="0.5"/><line x1="7" y1="9" x2="7" y2="12"/><line x1="11" y1="9" x2="11" y2="12.5"/><line x1="15" y1="9" x2="15" y2="12"/><line x1="19" y1="9" x2="19" y2="12.5"/>`,
  properties: `<rect x="4" y="3" width="16" height="18" rx="1"/><line x1="7" y1="7" x2="17" y2="7"/><line x1="7" y1="11" x2="17" y2="11"/><line x1="7" y1="15" x2="13" y2="15"/>`,
  parameters: `<line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="7" cy="17" r="2"/>`,
  section: `<path d="M4 8 L12 4 L20 8 L20 16 L12 20 L4 16 Z"/><line x1="4" y1="8" x2="20" y2="16" stroke-dasharray="2 2"/>`,
  componentColors: `<rect x="3" y="3" width="9" height="9" rx="1"/><rect x="12" y="12" width="9" height="9" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/>`,
  draftAnalysis: `<path d="M5 4 L5 20 L19 20"/><line x1="5" y1="20" x2="17" y2="6"/><polyline points="13,6 17,6 17,10"/>`,
  interference: `<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>`,
  zebra: `<path d="M3 21 L9 3"/><path d="M9 21 L15 3"/><path d="M15 21 L21 3"/>`,
  curvature: `<path d="M3 17 Q12 3 21 17" fill="none"/><line x1="7" y1="11" x2="6" y2="7"/><line x1="12" y1="8" x2="12" y2="3.5"/><line x1="17" y1="11" x2="18" y2="7"/>`,

  // sketch modify
  trim: `<path d="M5 5l6 6"/><path d="M19 5l-6 6"/><path d="M11 13l-6 6"/><circle cx="13" cy="13" r="2"/>`,
  offset: `<rect x="7" y="7" width="10" height="10"/><rect x="3.5" y="3.5" width="17" height="17" stroke-dasharray="2 2"/>`,
  extend: `<line x1="4" y1="12" x2="14" y2="12"/><path d="M14 8l4 4-4 4"/>`,
  fillet: `<path d="M5 4 L5 11 Q5 19 13 19 L20 19 M5 11 L5 19 L13 19" fill="none"/>`,
  break: `<line x1="4" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="20" y2="12"/><line x1="11" y1="7" x2="11" y2="17"/><line x1="13" y1="7" x2="13" y2="17"/>`,

  // modeling create
  sketch: `<path d="M14 4l6 6L9 21l-6 1 1-6z"/><line x1="13" y1="5" x2="19" y2="11"/>`,
  extrude: `<rect x="4" y="13" width="10" height="7"/><path d="M9 11V4m0 0l-3 3m3-3l3 3"/>`,
  revolve: `<path d="M12 4v16"/><ellipse cx="12" cy="12" rx="7" ry="3"/><path d="M5 12a7 3 0 0 0 14 0"/>`,
  loft: `<path d="M4 18h16M7 8h10M4 18l3-10M20 18L17 8"/>`,
  sweep: `<circle cx="5" cy="18" r="2.4"/><path d="M5 18 C 5 9, 12 6, 20 6" fill="none"/><path d="M16 3l4 3-4 3"/>`,

  // modeling modify
  chamfer: `<path d="M4 20V12l8-8h8" fill="none"/>`,
  mirror: `<line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="2 2"/><path d="M9 7L4 12l5 5z"/><path d="M15 7l5 5-5 5z"/>`,
  presspull: `<path d="M4 16l6-3 8 3-6 3z" fill="none"/><path d="M10 13V4m0 0l-3 3m3-3l3 3"/>`,
  // body ops: split a body by a plane; the three booleans.
  //
  // The booleans are one drawing seen three ways — the same two circles at the
  // same centres, with the RESULT shaded. That is the whole distinction between
  // them, so drawing three unrelated marks would hide the only thing the user
  // needs to read. The outlines are stroked on top of the shading so the tool
  // bodies stay visible in every one of them, including the two where most of
  // the drawing is not the result.
  //
  // Each shaded region is ONE path with the fill rule doing the work, not two
  // overlapping filled circles: overlapping fills double their opacity in the
  // lens, which would make the union's middle read as a third region.
  //
  // The shading is nearly opaque, and it has to be. These are drawn at 18px on
  // the hover bar, where the three sit side by side and are told apart ONLY by
  // which part is filled — at a polite 30% the blob, the crescent and the lens
  // were three grey smudges.
  split: `<rect x="4" y="7" width="16" height="10" rx="0.5"/><line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="2 2"/>`,
  // Both circles, wound the same way, nonzero: the lens has winding 2 and is
  // still simply inside, so the union shades evenly.
  booleanUnion: `<path d="M3.5 12a6 6 0 1 0 12 0a6 6 0 1 0-12 0M8.5 12a6 6 0 1 0 12 0a6 6 0 1 0-12 0" fill="currentColor" fill-opacity="0.85" stroke="none"/><circle cx="9.5" cy="12" r="6"/><circle cx="14.5" cy="12" r="6"/>`,
  // The left circle with the lens as a hole (evenodd): the target minus the
  // tool, which is what "subtract" means and which way round it goes.
  booleanSubtract: `<path d="M3.5 12a6 6 0 1 0 12 0a6 6 0 1 0-12 0M12 6.546A6 6 0 0 1 12 17.454A6 6 0 0 1 12 6.546Z" fill="currentColor" fill-opacity="0.85" fill-rule="evenodd" stroke="none"/><circle cx="9.5" cy="12" r="6"/><circle cx="14.5" cy="12" r="6"/>`,
  // The lens alone.
  booleanIntersect: `<path d="M12 6.546A6 6 0 0 1 12 17.454A6 6 0 0 1 12 6.546Z" fill="currentColor" fill-opacity="0.85" stroke="none"/><circle cx="9.5" cy="12" r="6"/><circle cx="14.5" cy="12" r="6"/>`,
  shell: `<rect x="4" y="4" width="16" height="16" rx="1"/><rect x="8" y="8" width="8" height="8" rx="0.5" stroke-dasharray="2 2"/>`,
  draft: `<path d="M7 20l4-16h2l4 16z" fill="none"/><line x1="5" y1="20" x2="19" y2="20"/>`,
  offsetFace: `<rect x="4" y="8" width="12" height="12" rx="1"/><path d="M8 4h12v12" stroke-dasharray="2 2"/><line x1="16" y1="8" x2="20" y2="4"/>`,
  thicken: `<path d="M4 14c4-6 12-6 16 0" fill="none"/><path d="M4 18c4-6 12-6 16 0" fill="none"/><line x1="4" y1="14" x2="4" y2="18"/><line x1="20" y1="14" x2="20" y2="18"/>`,
  texture: `<rect x="4" y="4" width="16" height="16" rx="1"/><line x1="4" y1="9.3" x2="20" y2="9.3"/><line x1="4" y1="14.7" x2="20" y2="14.7"/><line x1="9.3" y1="4" x2="9.3" y2="20"/><line x1="14.7" y1="4" x2="14.7" y2="20"/>`,
  pattern: `<rect x="4" y="4" width="5" height="5"/><rect x="15" y="4" width="5" height="5"/><rect x="4" y="15" width="5" height="5"/><rect x="15" y="15" width="5" height="5"/>`,
  simplifyMesh: `<polygon points="12,3 21,8 21,16 12,21 3,16 3,8"/><path d="M3 8l9 5 9-5M12 13v8"/>`,
  cleanUp: `<path d="M15 4l1.2 2.8L19 8l-2.8 1.2L15 12l-1.2-2.8L11 8l2.8-1.2z"/><path d="M4 20l5-5M7 20.5l3.5-3.5M4 16.5L7.5 13"/>`,
  computeAll: `<path d="M12 4a8 8 0 1 1-7.4 5"/><path d="M4 4v5h5"/>`,
  scale: `<path d="M4 10V4h6"/><path d="M20 14v6h-6"/><rect x="4" y="4" width="10" height="10" rx="0.5"/>`,
  move: `<path d="M12 3v18M3 12h18"/><path d="M12 3l-3 3m3-3l3 3M12 21l-3-3m3 3l3-3M3 12l3-3m-3 3l3 3M21 12l-3-3m3 3l-3 3"/>`,
  rotate: `<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/>`,
  copy: `<rect x="9" y="9" width="11" height="11" rx="1"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/>`,
  // insert / construct
  import: `<path d="M12 3v11m0 0l-4-4m4 4l4-4"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>`,
  datumPlane: `<path d="M3 9l9-4 9 4-9 4z"/><line x1="12" y1="13" x2="12" y2="20"/><circle cx="12" cy="20" r="1.4" fill="currentColor"/>`,
  primitive: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><line x1="12" y1="12" x2="12" y2="21"/>`,

  // file / general
  save: `<path d="M5 4h11l3 3v13H5z"/><rect x="8" y="4" width="6" height="5"/><rect x="8" y="13" width="8" height="5"/>`,
  open: `<path d="M3 7h6l2 2h10v9H3z"/>`,
  export: `<path d="M5 12v7h14v-7"/><path d="M12 15V4m0 0l-3 3m3-3l3 3"/>`,
  check: `<path d="M4 12l5 5L20 6"/>`,
  palette: `<rect x="4" y="4" width="16" height="16" rx="2"/><line x1="4" y1="9" x2="20" y2="9"/>`,
  offsetPlane: `<path d="M3 8l8-4 10 4-8 4z"/><path d="M3 15l8-4 10 4-8 4z" stroke-dasharray="2 2"/>`,

  // print pipeline
  print: `<path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="8" rx="1"/><rect x="7" y="14" width="10" height="6"/><circle cx="17" cy="12" r="0.9" fill="currentColor"/>`,
  slicer: `<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><path d="M11 14h5m0 0l-2-2m2 2l-2 2"/>`,
  printerSend: `<path d="M6 8V3h9l3 3v2"/><rect x="4" y="8" width="16" height="7" rx="1"/><path d="M8 15h5v6H8z"/><path d="M15 19h6m0 0l-2-2m2 2l-2 2"/>`,

  // sketch constraints
  horizontal: `<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="9" x2="3" y2="15"/><line x1="21" y1="9" x2="21" y2="15"/>`,
  vertical: `<line x1="12" y1="3" x2="12" y2="21"/><line x1="9" y1="3" x2="15" y2="3"/><line x1="9" y1="21" x2="15" y2="21"/>`,
  parallel: `<line x1="6" y1="20" x2="12" y2="4"/><line x1="13" y1="20" x2="19" y2="4"/>`,
  perpendicular: `<path d="M5 4v15h15"/><line x1="5" y1="14" x2="10" y2="14"/><line x1="10" y1="14" x2="10" y2="19"/>`,
  equal: `<line x1="5" y1="9" x2="19" y2="9"/><line x1="5" y1="15" x2="19" y2="15"/>`,
  tangent: `<circle cx="9" cy="14" r="5"/><line x1="3" y1="5" x2="21" y2="9"/>`,
  coincident: `<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>`,
  concentric: `<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor"/>`,
  symmetric: `<line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="2 2"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="12" r="2"/>`,
  midpoint: `<line x1="3" y1="12" x2="21" y2="12"/><circle cx="12" cy="12" r="2" fill="currentColor"/>`,
  collinear: `<line x1="3" y1="12" x2="10" y2="12"/><line x1="14" y1="12" x2="21" y2="12"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>`,
  fix: `<line x1="12" y1="4" x2="12" y2="14"/><path d="M8 4h8"/><path d="M9 14h6l-3 6z" fill="currentColor"/>`,

  // --- primitives & body ops -----------------------------------------------
  box: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><line x1="12" y1="12" x2="12" y2="21"/>`,
  cylinder: `<ellipse cx="12" cy="6.5" rx="7" ry="3"/><path d="M5 6.5v11a7 3 0 0 0 14 0v-11"/>`,
  sphere: `<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="8.5" ry="3.4"/>`,
  // Delete Face: a solid with one facet lifted away
  deleteFace: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5" stroke-dasharray="2 2"/><path d="M9 10l6 6M15 10l-6 6"/>`,
  removeBody: `<path d="M5 7h14"/><path d="M10 7V4.6a.6.6 0 0 1 .6-.6h2.8a.6.6 0 0 1 .6.6V7"/><path d="M6.5 7l.9 12a1 1 0 0 0 1 .95h7.2a1 1 0 0 0 1-.95l.9-12"/><line x1="10.5" y1="10.5" x2="10.5" y2="16.5"/><line x1="13.5" y1="10.5" x2="13.5" y2="16.5"/>`,

  // --- browser tree --------------------------------------------------------
  // The origin datum: a survey mark, not a crosshair cursor — it names a
  // location the model is measured from.
  origin: `<circle cx="12" cy="12" r="5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>`,
  plane: `<path d="M3 9l9-4 9 4-9 4z"/>`,
  body: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><line x1="12" y1="12" x2="12" y2="21"/>`,
  // An assembly node: a container holding parts, so a crate rather than a folder
  assembly: `<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 10h18"/><path d="M9 5v5M15 5v5"/>`,
  // The filament palette head — swatch strips, matching what the section holds
  filament: `<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M8.5 4v16M15.5 4v16"/>`,

  // --- eye / disclosure ----------------------------------------------------
  // Named for what they MEAN, not what they look like, so a pack is free to
  // draw "hidden" as a struck eye, a dimmed eye, or no eye at all.
  visible: `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.9"/>`,
  hidden: `<path d="M4.2 7.4A13.8 13.8 0 0 0 2.5 12S6 18.5 12 18.5c1.9 0 3.5-.65 4.8-1.5"/><path d="M9.9 6a8.4 8.4 0 0 1 2.1-.5c6 0 9.5 6.5 9.5 6.5a15.7 15.7 0 0 1-2.6 3.4"/><path d="M9.9 9.9a2.9 2.9 0 0 0 4.1 4.1"/><line x1="3.5" y1="3.5" x2="20.5" y2="20.5"/>`,
  caretRight: `<path d="M9.5 5.5l6.5 6.5-6.5 6.5"/>`,
  caretDown: `<path d="M5.5 9.5l6.5 6.5 6.5-6.5"/>`,
  caretUp: `<path d="M5.5 14.5l6.5-6.5 6.5 6.5"/>`,

  // --- general chrome ------------------------------------------------------
  close: `<path d="M6 6l12 12M18 6L6 18"/>`,
  // A dot, for "unsaved" and for a feature type this build has never heard of
  dot: `<circle cx="12" cy="12" r="4" fill="currentColor"/>`,
  warning: `<path d="M12 3.5L21.5 20H2.5z"/><line x1="12" y1="9.5" x2="12" y2="14"/><circle cx="12" cy="17" r="1.05" fill="currentColor"/>`,
  bug: `<rect x="8" y="8" width="8" height="11" rx="4"/><path d="M9.5 8a2.5 2.5 0 0 1 5 0"/><path d="M8 11H4.5M8 15H4.5M16 11h3.5M16 15h3.5"/><path d="M9.5 5.5L8 3.5M14.5 5.5L16 3.5"/>`,
  dice: `<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.4" fill="currentColor"/><circle cx="15" cy="15" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>`,
  undo: `<path d="M4 9h10a5.5 5.5 0 0 1 0 11h-6"/><path d="M8 5L4 9l4 4"/>`,
  redo: `<path d="M20 9H10a5.5 5.5 0 0 0 0 11h6"/><path d="M16 5l4 4-4 4"/>`,
  // Two-way sync, for pulling the printer's filament list into the palette
  sync: `<path d="M8 4v16"/><path d="M5 7l3-3 3 3"/><path d="M16 20V4"/><path d="M13 17l3 3 3-3"/>`,

  // --- timeline transport --------------------------------------------------
  skipStart: `<path d="M18 5.5v13L8 12z"/><line x1="6" y1="5.5" x2="6" y2="18.5"/>`,
  stepBack: `<path d="M15.5 5.5v13L6.5 12z"/>`,
  stepForward: `<path d="M8.5 5.5v13l9-6.5z"/>`,
  skipEnd: `<path d="M6 5.5v13L16 12z"/><line x1="18" y1="5.5" x2="18" y2="18.5"/>`,
};

/** The house pack: hairline strokes, open counters, nothing filled that doesn't
 *  have to be. Also the fallback every other pack resolves against, which is why
 *  it is the one pack that must stay complete. */
export const FORGE_PACK: IconPack = {
  id: "forge",
  label: "Forge (outline)",
  paths: FORGE_PATHS,
};

/** A heavier variant: the same shapes with their counters filled in, for people
 *  who find hairlines hard to pick out on a bright display or at a distance.
 *
 *  Deliberately NOT exhaustive. It redraws the marks that appear dozens of times
 *  on screen at small sizes — carets, the eye, checks, chips — where the weight
 *  difference is actually felt, and inherits the rest from Forge. Adding a mark
 *  here later needs no other change anywhere. */
export const ANVIL_PACK: IconPack = {
  id: "anvil",
  label: "Anvil (solid)",
  paths: {
    caretRight: `<path d="M9 5l7 7-7 7z" fill="currentColor" stroke-linejoin="round"/>`,
    caretDown: `<path d="M5 9l7 7 7-7z" fill="currentColor" stroke-linejoin="round"/>`,
    caretUp: `<path d="M5 15l7-7 7 7z" fill="currentColor" stroke-linejoin="round"/>`,
    visible: `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" fill="currentColor" fill-opacity="0.25"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/>`,
    hidden: `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" fill="currentColor" fill-opacity="0.15"/><line x1="3.5" y1="3.5" x2="20.5" y2="20.5" stroke-width="2.4"/>`,
    check: `<path d="M4 12l5 5L20 6" stroke-width="2.6"/>`,
    close: `<path d="M6 6l12 12M18 6L6 18" stroke-width="2.6"/>`,
    dot: `<circle cx="12" cy="12" r="5.5" fill="currentColor"/>`,
    warning: `<path d="M12 3.5L21.5 20H2.5z" fill="currentColor" fill-opacity="0.28"/><line x1="12" y1="9.5" x2="12" y2="14" stroke-width="2.2"/><circle cx="12" cy="17" r="1.3" fill="currentColor"/>`,
    body: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" fill="currentColor" fill-opacity="0.22"/><path d="M4 7.5l8 4.5 8-4.5"/><line x1="12" y1="12" x2="12" y2="21"/>`,
    plane: `<path d="M3 9l9-4 9 4-9 4z" fill="currentColor" fill-opacity="0.85"/>`,
    skipStart: `<path d="M18 5.5v13L8 12z" fill="currentColor"/><line x1="6" y1="5.5" x2="6" y2="18.5" stroke-width="2.4"/>`,
    stepBack: `<path d="M15.5 5.5v13L6.5 12z" fill="currentColor"/>`,
    stepForward: `<path d="M8.5 5.5v13l9-6.5z" fill="currentColor"/>`,
    skipEnd: `<path d="M6 5.5v13L16 12z" fill="currentColor"/><line x1="18" y1="5.5" x2="18" y2="18.5" stroke-width="2.4"/>`,
  },
};

/** The pack every lookup falls back to — see resolveIconPaths. */
export const DEFAULT_PACK_ID = FORGE_PACK.id;

const PACKS = new Map<string, IconPack>([
  [FORGE_PACK.id, FORGE_PACK],
  [ANVIL_PACK.id, ANVIL_PACK],
]);

/** Pack resolution, as a pure function of the whole registry — the part with the
 *  actual rule in it, and therefore the part under test.
 *
 *  Three tiers, in order: the active pack, the default pack, then the empty
 *  string. The last one is not an oversight. An icon name that no pack knows is
 *  a typo at a call site, and rendering an empty <svg> keeps the button the same
 *  size with the same label instead of throwing during a render — a missing mark
 *  is a cosmetic bug, a crashed panel is a lost document. */
export function resolveIconPaths(
  packs: ReadonlyMap<string, IconPack>,
  activeId: string,
  name: string,
  defaultId: string = DEFAULT_PACK_ID,
): string {
  return (
    packs.get(activeId)?.paths[name] ?? packs.get(defaultId)?.paths[name] ?? ""
  );
}

// --- the active pack, as a user setting --------------------------------------
//
// Persisted the way every other display preference in this app is (ui/units.ts,
// ui/welcome.ts, io/recentFiles.ts): a `neocad.*` localStorage key read once
// at module load, plus a listener set so the live UI re-renders instead of
// waiting for a reload.

const KEY = "neocad.iconPack";
const LEGACY_KEY = "sindricad.iconPack";

/** Narrow an untrusted string — a stored setting, a `<select>` value — to a
 *  registered pack id, or null. Every boundary that can set the active pack goes
 *  through here: an unknown id would make EVERY lookup fall through to the
 *  default pack, which looks exactly like the setting silently not working. */
export function asIconPackId(v: unknown): string | null {
  return typeof v === "string" && PACKS.has(v) ? v : null;
}

function readStored(): string {
  const raw = readSetting(KEY, LEGACY_KEY);
  return asIconPackId(raw) ?? DEFAULT_PACK_ID;
}

let activePackId = readStored();
const listeners = new Set<() => void>();

export function getIconPack(): string {
  return activePackId;
}

export function setIconPack(id: string) {
  const next = asIconPackId(id);
  if (!next || next === activePackId) return;
  activePackId = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private mode / no storage: the choice just doesn't survive the session */
  }
  for (const fn of listeners) fn();
}

/** Subscribe to pack changes; returns the unsubscribe. */
export function onIconPackChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Every registered pack, for the settings menu. */
export function iconPacks(): IconPack[] {
  return [...PACKS.values()];
}

/** Add a pack at runtime (or replace one by id). Exists so a pack can ship
 *  separately from this file without every consumer learning about it. */
export function registerIconPack(pack: IconPack) {
  PACKS.set(pack.id, pack);
}

/** The raw path markup for one icon in the ACTIVE pack, for Icon.vue's v-html.
 *  Every value in every pack is a compile-time constant — no document or network
 *  data reaches it — which is what makes that v-html the ONE sanctioned one in
 *  the app. */
export function iconPaths(name: string): string {
  return resolveIconPaths(PACKS, activePackId, name);
}

/** One complete `<svg>` as markup, for the rare caller that has a string slot
 *  rather than a component slot. Prefer <Icon>; prefer iconElement() in
 *  imperative DOM code. */
export function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${iconPaths(name)}</svg>`;
}

/** An `<svg>` ELEMENT, for the handful of surfaces still built with
 *  document.createElement (the sketch dimension box).
 *
 *  The innerHTML here is the same sanctioned exception Icon.vue's v-html is, and
 *  for the same reason: the only thing that reaches it is the constant table
 *  above. It is a function rather than an inlined snippet at each call site so
 *  there is exactly one place to audit. */
export function iconElement(name: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  // The same class and marker Icon.vue puts on its <svg>, and not decoration:
  // `.icon { flex: 0 0 auto }` is what stops an icon collapsing when its slot is
  // a flex container. Without it the confirm/cancel marks on the heads-up box
  // laid out 0px wide inside their `display: inline-flex` buttons and drew as
  // two empty squares — the paths were there and correct the whole time.
  svg.setAttribute("class", "icon");
  svg.setAttribute("data-icon", name);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML = iconPaths(name);
  return svg;
}
