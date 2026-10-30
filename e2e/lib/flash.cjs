// Flash and blackout analysis of a run of shown frames, for e2e/pathtrace_flash_e2e.cjs.
// WCAG 2.3.1 general flash: a flash is a pair of opposing changes of at least 10 percent
// of full relative luminance where the darker image is below 0.80, over a quarter of the frame.

const FLASH_DELTA = 0.1;
const FLASH_DARKER_BELOW = 0.8;
const FLASH_AREA = 0.25;
const FLASHES_ALLOWED = 3;
// sRGB 6 of 255, below any lit surface or background the app draws.
const NEAR_BLACK = 0.002;

/** Mean relative luminance per cell of an RGBA image, row 0 first as given. Self contained,
 *  it also runs in a page. */
function toGrid(rgba, width, height, cols, rows) {
  const LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
    const c = i / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const sum = new Float32Array(cols * rows);
  const count = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const cy = Math.min(rows - 1, Math.floor((y * rows) / height));
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const cell = cy * cols + Math.min(cols - 1, Math.floor((x * cols) / width));
      sum[cell] += 0.2126 * LINEAR[rgba[i]] + 0.7152 * LINEAR[rgba[i + 1]] + 0.0722 * LINEAR[rgba[i + 2]];
      count[cell]++;
    }
  }
  return sum.map((v, i) => (count[i] ? v / count[i] : 0));
}

function mean(lum) {
  let s = 0;
  for (const v of lum) s += v;
  return lum.length ? s / lum.length : 0;
}

/** Rows that are near black across nine tenths of their cells, in from the top and the bottom. */
function blackEdges(lum, cols) {
  const rows = lum.length / cols;
  const dark = (r) => {
    let n = 0;
    for (let c = 0; c < cols; c++) if (lum[r * cols + c] < NEAR_BLACK) n++;
    return n >= 0.9 * cols;
  };
  let top = 0;
  while (top < rows && dark(top)) top++;
  let bottom = 0;
  while (bottom < rows - top && dark(rows - 1 - bottom)) bottom++;
  return { top, bottom, share: (top + bottom) / rows };
}

/** A straight edge between lit rows and rows with no sample, the partial frame of the bug. */
function isBand(lum, cols, atLeast = 0.1) {
  const e = blackEdges(lum, cols);
  return e.share >= atLeast && e.share < 1;
}

/** Share of cells that changed by a lot, in the WCAG sense, from one frame to the next. */
function changedShare(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) >= FLASH_DELTA && Math.min(a[i], b[i]) < FLASH_DARKER_BELOW) n++;
  }
  return a.length ? n / a.length : 0;
}

/** Share of cells that were lit and went near black. */
function blackedShare(prev, cur) {
  let n = 0;
  for (let i = 0; i < prev.length; i++) if (prev[i] >= 5 * NEAR_BLACK && cur[i] < NEAR_BLACK) n++;
  return prev.length ? n / prev.length : 0;
}

/** Times of the opposing luminance changes of one cell across the frames. */
function transitions(frames, cell) {
  const out = [];
  let dir = 0;
  let lo = frames[0].lum[cell];
  let hi = lo;
  for (const f of frames) {
    const v = f.lum[cell];
    if (dir !== 1 && v - lo >= FLASH_DELTA && lo < FLASH_DARKER_BELOW) {
      dir = 1;
      hi = v;
      out.push(f.t);
    } else if (dir !== -1 && hi - v >= FLASH_DELTA && v < FLASH_DARKER_BELOW) {
      dir = -1;
      lo = v;
      out.push(f.t);
    }
    if (dir !== -1) hi = Math.max(hi, v);
    if (dir !== 1) lo = Math.min(lo, v);
  }
  return out;
}

/** The most flashes in any one second over at least a quarter of the frame. A half
 *  counts: seven changes in a second are over the limit of three flashes. */
function flashesPerSecond(frames) {
  if (frames.length < 2) return 0;
  const cells = frames[0].lum.length;
  const times = [];
  for (let c = 0; c < cells; c++) times.push(transitions(frames, c));
  const need = Math.max(1, Math.ceil(FLASH_AREA * cells));
  const starts = new Int32Array(cells);
  const ends = new Int32Array(cells);
  const counts = new Int32Array(cells);
  let worst = 0;
  for (const f of frames) {
    for (let c = 0; c < cells; c++) {
      const list = times[c];
      while (ends[c] < list.length && list[ends[c]] <= f.t) ends[c]++;
      while (starts[c] < ends[c] && list[starts[c]] <= f.t - 1000) starts[c]++;
      counts[c] = ends[c] - starts[c];
    }
    worst = Math.max(worst, counts.slice().sort((a, b) => b - a)[need - 1]);
  }
  return worst / 2;
}

/** frames: [{ t: ms, lum: cells of relative luminance }], in shown order. */
function analyse(frames, cols) {
  const means = frames.map((f) => mean(f.lum));
  let bands = 0;
  let blackFrames = 0;
  let maxChanged = 0;
  let maxBlacked = 0;
  const bad = [];
  frames.forEach((f, i) => {
    const band = isBand(f.lum, cols);
    if (band) bands++;
    const prev = frames[i - 1];
    const changed = prev ? changedShare(prev.lum, f.lum) : 0;
    const blacked = prev ? blackedShare(prev.lum, f.lum) : 0;
    maxChanged = Math.max(maxChanged, changed);
    maxBlacked = Math.max(maxBlacked, blacked);
    const mostlyBlack = blacked >= 0.5;
    if (mostlyBlack) blackFrames++;
    if (band || mostlyBlack) bad.push({ i, t: f.t, band, blacked: +blacked.toFixed(3), mean: +means[i].toFixed(4) });
  });
  const flashes = flashesPerSecond(frames);
  return {
    frames: frames.length,
    meanLow: means.length ? +Math.min(...means).toFixed(4) : 0,
    meanHigh: means.length ? +Math.max(...means).toFixed(4) : 0,
    bands,
    blackFrames,
    maxChanged: +maxChanged.toFixed(3),
    maxBlacked: +maxBlacked.toFixed(3),
    flashes,
    overLimit: flashes > FLASHES_ALLOWED,
    bad,
  };
}

module.exports = {
  toGrid,
  toGridSource: toGrid.toString(),
  mean,
  blackEdges,
  isBand,
  changedShare,
  blackedShare,
  flashesPerSecond,
  analyse,
};
