/**
 * Core business logic for DS Banner Maker.
 * DOM-independent pure functions for Node.js testing and Browser support.
 * Writes NTR v1 banner.bin files (2112 bytes / 0x840); reads NTR v1-v3 and
 * DSi animated banners.
 * Also writes Pico Launcher cover.bmp files (128 x 96, 8 bpp).
 */

/**
 * GBATEK swiCRC16 algorithm.
 * @param {Uint8Array} data
 * @param {number} [initial=0xFFFF]
 * @returns {number} 16-bit unsigned integer CRC
 */
export function crc16(data, initial = 0xFFFF) {
  let crc = initial & 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      const carry = (crc & 0x0001) !== 0;
      crc = crc >>> 1;
      if (carry) {
        crc ^= 0xA001;
      }
    }
  }
  return crc;
}

// Icon/Title layout (GBATEK "DS Cartridge Icon/Title", TwlSDK BannerHeader)
const NTR_V1_SIZE = 0x840;
const ICON_BITMAP = 0x20; // 512 bytes: 4bpp, 4x4 tiles of 8x8 pixels
const ICON_BITMAP_SIZE = 0x200;
const ICON_PALETTE = 0x220; // 16 RGB555 colors, index 0 = transparent
const ICON_PALETTE_SIZE = 0x20;
const TITLE_SLOTS = 0x240; // UTF-16LE, 128 code units per language slot
const TITLE_SLOT_SIZE = 0x100;
const ANIM_BITMAPS = 0x1240; // DSi animated only: 8 bitmaps
const ANIM_PALETTES = 0x2240; // 8 palettes
const ANIM_SEQUENCE = 0x2340; // 64 u16 tokens

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function writeU16(bytes, offset, value) {
  bytes[offset] = value & 0xFF;
  bytes[offset + 1] = (value >> 8) & 0xFF;
}

/**
 * Convert string to UTF-16LE bytes.
 * @param {string} str
 * @returns {Uint8Array}
 */
export function stringToUtf16Le(str) {
  const buf = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    writeU16(buf, i * 2, str.charCodeAt(i));
  }
  return buf;
}

/**
 * Convert UTF-16LE bytes to string, terminating on first NUL code unit.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function utf16LeToString(bytes) {
  let str = "";
  for (let i = 0; i < bytes.length; i += 2) {
    const code = readU16(bytes, i);
    if (code === 0) break;
    str += String.fromCharCode(code);
  }
  return str.trim();
}

/**
 * Convert 8-bit channel (0..255) to native Nintendo DS 5-bit channel (0..31).
 * Uses half-up rounding: (v * 31 + 127) / 255.
 * @param {number} v
 * @returns {number} 0..31
 */
export function rgb8To5(v) {
  return Math.min(31, Math.max(0, ((v * 31 + 127) / 255) | 0));
}

/**
 * Expands a 5-bit channel (0..31) to 8-bit (0..255) by bit replication:
 * (v << 3) | (v >> 2). Maps 0 to 0 and 31 to 255. The console itself outputs
 * 6-bit channels to its 18-bit LCD (2D engine: 0 stays 0, else v * 2 + 1), so
 * this is the standard display approximation, not an exact hardware value.
 * @param {number} v
 * @returns {number} 0..255
 */
export function rgb5To8(v) {
  return (v << 3) | (v >> 2);
}

/**
 * Snaps 24-bit RGB values to the native Nintendo DS 15-bit RGB555 color space.
 * @param {number} r 0..255
 * @param {number} g 0..255
 * @param {number} b 0..255
 * @returns {{r: number, g: number, b: number, r5: number, g5: number, b5: number, key15: number}}
 */
export function snapToRgb555(r, g, b) {
  const r5 = rgb8To5(r);
  const g5 = rgb8To5(g);
  const b5 = rgb8To5(b);
  return {
    r: rgb5To8(r5),
    g: rgb5To8(g5),
    b: rgb5To8(b5),
    r5,
    g5,
    b5,
    key15: r5 | (g5 << 5) | (b5 << 10)
  };
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Pushes a color's contrast and saturation up a bit, so flat/washed-out
 * source photos read more like punchy, hand-picked pixel art colors once
 * quantized down to 15 colors.
 */
function boostPixelArtColor(r, g, b) {
  const CONTRAST = 1.15;
  const SATURATION = 1.3;

  const cr = clamp255((r - 127.5) * CONTRAST + 127.5);
  const cg = clamp255((g - 127.5) * CONTRAST + 127.5);
  const cb = clamp255((b - 127.5) * CONTRAST + 127.5);

  const lum = 0.299 * cr + 0.587 * cg + 0.114 * cb;
  return {
    r: Math.round(clamp255(lum + (cr - lum) * SATURATION)),
    g: Math.round(clamp255(lum + (cg - lum) * SATURATION)),
    b: Math.round(clamp255(lum + (cb - lum) * SATURATION))
  };
}

// Floyd-Steinberg error diffusion: [dx, dy, share] for the pixel ahead and
// the three below. dx is mirrored on right-to-left rows.
const ERROR_DIFFUSION = [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]];
// Diffuse 80% of each pixel's error, which keeps flat areas calm and stops
// error from streaking across the image.
const DITHER_DAMPING = 0.8;

// With a transparent slot, index 0 is transparent (its color is never shown)
// and the given colors follow it. Unused entries are black, so the palette
// always has size entries (16 for icons, 256 for covers).
function buildPalette(colors, size = 16, transparent = true) {
  const palette = transparent ? [{ r: 255, g: 0, b: 255 }, ...colors] : [...colors];
  while (palette.length < size) {
    palette.push({ r: 0, g: 0, b: 0 });
  }
  return palette;
}

/**
 * Perceptual weighted color distance squared.
 * Uses 2*dr^2 + 4*dg^2 + 3*db^2 matching human eye and retro DS LCD sensitivity.
 */
function colorDistanceSq(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

const CHANNEL_WEIGHTS = { r: 2, g: 4, b: 3 }; // Same weights as colorDistanceSq

// The quantizer helpers below work on unique colors: {r, g, b, key15, count},
// where count is how many pixels have that color.

function weightedMean(colors) {
  let n = 0, r = 0, g = 0, b = 0;
  for (const c of colors) {
    n += c.count;
    r += c.r * c.count;
    g += c.g * c.count;
    b += c.b * c.count;
  }
  return { r: r / n, g: g / n, b: b / n };
}

// Pixel-weighted squared distance of the colors from their mean.
function bucketError(colors) {
  const m = weightedMean(colors);
  let error = 0;
  for (const c of colors) {
    error += c.count * colorDistanceSq(c.r, c.g, c.b, m.r, m.g, m.b);
  }
  return error;
}

function nearestIndex(color, centers) {
  let nearest = 0;
  let minDistance = Infinity;
  for (let k = 0; k < centers.length; k++) {
    const d = colorDistanceSq(color.r, color.g, color.b, centers[k].r, centers[k].g, centers[k].b);
    if (d < minDistance) {
      minDistance = d;
      nearest = k;
    }
  }
  return nearest;
}

// Splits the colors into up to maxBuckets groups. Repeatedly halves the group
// with the largest error, at its pixel-weighted median along the channel it
// varies most in. Splits fall between colors, never through one, so two
// groups can't average to the same color.
function medianCut(colors, maxBuckets) {
  const buckets = [colors];
  while (buckets.length < maxBuckets) {
    let splitIndex = -1;
    let maxError = 0;
    buckets.forEach((bucket, i) => {
      if (bucket.length < 2) return;
      const error = bucketError(bucket);
      if (error > maxError) {
        maxError = error;
        splitIndex = i;
      }
    });
    if (splitIndex === -1) break;

    const bucket = buckets[splitIndex];
    const mean = weightedMean(bucket);
    let channel = 'r';
    let maxSpread = -1;
    for (const ch of ['r', 'g', 'b']) {
      let spread = 0;
      for (const c of bucket) spread += c.count * (c[ch] - mean[ch]) ** 2;
      spread *= CHANNEL_WEIGHTS[ch];
      if (spread > maxSpread) {
        maxSpread = spread;
        channel = ch;
      }
    }

    bucket.sort((a, b) => a[channel] - b[channel]);
    const total = bucket.reduce((sum, c) => sum + c.count, 0);
    let cut = 1;
    let seen = 0;
    for (let j = 0; j < bucket.length - 1; j++) {
      seen += bucket[j].count;
      cut = j + 1;
      if (seen >= total / 2) break;
    }
    buckets.splice(splitIndex, 1, bucket.slice(0, cut), bucket.slice(cut));
  }
  return buckets;
}

// Lloyd's k-means over the unique colors: moves each center to the weighted
// mean of the colors nearest to it. A center left with no colors restarts at
// the color that is currently served worst.
function refineCenters(colors, centers, iterations = 8) {
  const assignment = new Int32Array(colors.length);
  for (let it = 0; it < iterations; it++) {
    let changed = false;
    colors.forEach((c, j) => {
      const k = nearestIndex(c, centers);
      if (assignment[j] !== k) {
        assignment[j] = k;
        changed = true;
      }
    });

    const groups = centers.map(() => []);
    colors.forEach((c, j) => groups[assignment[j]].push(c));
    groups.forEach((group, k) => {
      centers[k] = group.length ? weightedMean(group) : null;
    });

    for (let k = 0; k < centers.length; k++) {
      if (centers[k]) continue;
      let worst = 0;
      let worstError = -1;
      colors.forEach((c, j) => {
        const m = centers[assignment[j]];
        const error = m ? c.count * colorDistanceSq(c.r, c.g, c.b, m.r, m.g, m.b) : 0;
        if (error > worstError) {
          worstError = error;
          worst = j;
        }
      });
      centers[k] = { r: colors[worst].r, g: colors[worst].g, b: colors[worst].b };
      assignment[worst] = k;
      changed = true;
    }

    if (!changed && it > 0) break;
  }
}

// Snaps the centers to RGB555. A center that lands on an existing entry is
// replaced by the color served worst by the palette so far, so every slot
// shows a different color.
function snapDistinct(centers, colors) {
  const palette = [];
  const keys = new Set();
  for (const m of centers) {
    const s = snapToRgb555(Math.round(m.r), Math.round(m.g), Math.round(m.b));
    if (keys.has(s.key15)) continue;
    keys.add(s.key15);
    palette.push({ r: s.r, g: s.g, b: s.b });
  }

  while (palette.length < centers.length) {
    let worst = null;
    let worstError = -1;
    for (const c of colors) {
      if (keys.has(c.key15)) continue;
      const nearest = palette[nearestIndex(c, palette)];
      const error = c.count * colorDistanceSq(c.r, c.g, c.b, nearest.r, nearest.g, nearest.b);
      if (error > worstError) {
        worstError = error;
        worst = c;
      }
    }
    if (!worst) break;
    keys.add(worst.key15);
    palette.push({ r: worst.r, g: worst.g, b: worst.b });
  }
  return palette;
}

/**
 * Color quantization in native 15-bit RGB555 color space, for any image size.
 * Images with at most `colors` RGB555 colors keep them exactly. Otherwise a
 * pixel-weighted median cut over the unique colors seeds `colors` centers,
 * k-means refines them, and every pixel maps to the nearest palette color by
 * perceptual distance (with serpentine Floyd-Steinberg when dither is set).
 *
 * @param {Array<{r: number, g: number, b: number, a: number}>} pixels - width * height pixels, row-major
 * @param {number} width
 * @param {number} height
 * @param {object} [options]
 * @param {number} [options.colors=15] - Palette colors, not counting the transparent slot
 * @param {boolean} [options.transparent=true] - Reserve index 0 for pixels under 50% alpha.
 *   When false, alpha is ignored and indices run 0..colors-1.
 * @param {boolean} [options.dither=false] - Error-diffusion dithering
 * @param {boolean} [options.boost=false] - Contrast/saturation boost before quantizing
 * @returns {{palette: Array<{r: number, g: number, b: number}>, indices: Uint8Array}}
 *   colors (+1 with transparent) palette entries, padded with black
 */
export function quantizeImage(pixels, width, height, { colors: maxColors = 15, transparent = true, dither = false, boost = false } = {}) {
  const count = width * height;
  const offset = transparent ? 1 : 0; // index of the first real color
  const paletteSize = maxColors + offset;
  const indices = new Uint8Array(count); // Defaults to 0 (transparent)
  const opaquePixels = [];

  for (let i = 0; i < count; i++) {
    const p = pixels[i];
    if (!transparent || p.a >= 128) {
      const color = boost ? boostPixelArtColor(p.r, p.g, p.b) : p;
      // Snap to native RGB555 hardware space so colors that collapse on DS aren't duplicated
      const snapped = snapToRgb555(color.r, color.g, color.b);
      opaquePixels.push({
        r: snapped.r,
        g: snapped.g,
        b: snapped.b,
        key15: snapped.key15,
        originalIndex: i
      });
    }
  }

  // If no opaque pixels, every index stays 0 (transparent)
  if (opaquePixels.length === 0) {
    return { palette: buildPalette([], paletteSize, transparent), indices };
  }

  // Unique colors with pixel counts, in first-seen order
  const colors = [];
  const colorsByKey = new Map();
  for (const p of opaquePixels) {
    const c = colorsByKey.get(p.key15);
    if (c) {
      c.count++;
    } else {
      const color = { r: p.r, g: p.g, b: p.b, key15: p.key15, count: 1 };
      colorsByKey.set(p.key15, color);
      colors.push(color);
    }
  }

  // Fast path: the image already fits, so map it exactly
  if (colors.length <= maxColors) {
    const keyToIndex = new Map(colors.map((c, k) => [c.key15, k + offset]));
    for (const p of opaquePixels) {
      indices[p.originalIndex] = keyToIndex.get(p.key15);
    }
    return { palette: buildPalette(colors.map(c => ({ r: c.r, g: c.g, b: c.b })), paletteSize, transparent), indices };
  }

  const centers = medianCut(colors, maxColors).map(weightedMean);
  refineCenters(colors, centers);
  const paletteColors = snapDistinct(centers, colors);
  const palette = buildPalette(paletteColors, paletteSize, transparent);

  // Map every opaque pixel to its nearest palette color
  if (dither) {
    diffuseErrors(opaquePixels, paletteColors, indices, width, height, offset);
  } else {
    for (const p of opaquePixels) {
      indices[p.originalIndex] = offset + nearestIndex(p, paletteColors);
    }
  }

  return { palette, indices };
}

/**
 * Quantizes a 32x32 icon: 15 colors plus transparent index 0.
 * @param {Array<{r: number, g: number, b: number, a: number}>} pixels - 1024 pixels
 * @param {number} [maxColors=15]
 * @param {boolean} [enhance=false] - Boosts contrast/saturation and applies error-diffusion dithering.
 * @returns {{palette: Array<{r: number, g: number, b: number}>, indices: Uint8Array}}
 */
export function quantize(pixels, maxColors = 15, enhance = false) {
  return quantizeImage(pixels, 32, 32, { colors: maxColors, transparent: true, dither: enhance, boost: enhance });
}

// Serpentine Floyd-Steinberg dithering: maps each opaque pixel to its nearest
// palette color after adding the error its already-mapped neighbors passed
// on. Transparent pixels neither take nor pass on error. offset is the index
// of paletteColors[0] in the final palette.
function diffuseErrors(opaquePixels, paletteColors, indices, width, height, offset) {
  const pixelAt = new Array(width * height).fill(null);
  for (const p of opaquePixels) pixelAt[p.originalIndex] = p;
  const error = new Float64Array(width * height * 3);

  for (let y = 0; y < height; y++) {
    const dir = y % 2 === 0 ? 1 : -1;
    for (let step = 0; step < width; step++) {
      const x = dir === 1 ? step : width - 1 - step;
      const i = y * width + x;
      const p = pixelAt[i];
      if (!p) continue;

      const want = { r: p.r + error[i * 3], g: p.g + error[i * 3 + 1], b: p.b + error[i * 3 + 2] };
      const k = nearestIndex(want, paletteColors);
      indices[i] = k + offset;

      const errR = (want.r - paletteColors[k].r) * DITHER_DAMPING;
      const errG = (want.g - paletteColors[k].g) * DITHER_DAMPING;
      const errB = (want.b - paletteColors[k].b) * DITHER_DAMPING;
      for (const [dx, dy, share] of ERROR_DIFFUSION) {
        const nx = x + dx * dir;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (!pixelAt[j]) continue;
        error[j * 3] += errR * share;
        error[j * 3 + 1] += errG * share;
        error[j * 3 + 2] += errB * share;
      }
    }
  }
}

// TILED_PIXEL[i] is the 32x32 pixel index held in the low nibble of tiled
// bitmap byte i; the high nibble holds the pixel to its right. Tiles are
// 8x8, stored row by row, 4 bytes per tile row.
const TILED_PIXEL = (() => {
  const map = new Uint16Array(ICON_BITMAP_SIZE);
  let byteIndex = 0;
  for (let tileRow = 0; tileRow < 4; tileRow++) {
    for (let tileCol = 0; tileCol < 4; tileCol++) {
      for (let pixelRow = 0; pixelRow < 8; pixelRow++) {
        for (let pixelCol = 0; pixelCol < 8; pixelCol += 2) {
          map[byteIndex++] = (tileRow * 8 + pixelRow) * 32 + tileCol * 8 + pixelCol;
        }
      }
    }
  }
  return map;
})();

/**
 * Packs 32x32 pixel indices into a tile-encoded 4bpp bitmap (512 bytes).
 * @param {Uint8Array} indices - 1024 pixel indices (0..15)
 * @returns {Uint8Array} 512 bytes
 */
export function tileEncode(indices) {
  const bitmap = new Uint8Array(ICON_BITMAP_SIZE);
  for (let i = 0; i < bitmap.length; i++) {
    const p = TILED_PIXEL[i];
    bitmap[i] = (indices[p] & 0x0F) | ((indices[p + 1] & 0x0F) << 4);
  }
  return bitmap;
}

/**
 * Unpacks a tile-encoded 4bpp bitmap (512 bytes) into 32x32 pixel indices.
 * @param {Uint8Array} bitmap - 512 bytes
 * @returns {Uint8Array} 1024 pixel indices (0..15)
 */
export function tileDecode(bitmap) {
  const indices = new Uint8Array(1024);
  for (let i = 0; i < ICON_BITMAP_SIZE; i++) {
    const p = TILED_PIXEL[i];
    indices[p] = bitmap[i] & 0x0F;
    indices[p + 1] = (bitmap[i] >> 4) & 0x0F;
  }
  return indices;
}

/**
 * Converts an RGB palette to 16 little-endian RGB555 values (32 bytes).
 * Rounds each 8-bit channel to the nearest 5-bit value.
 * @param {Array<{r: number, g: number, b: number}>} palette
 * @returns {Uint8Array} 32 bytes
 */
export function paletteToRgb555(palette) {
  const bytes = new Uint8Array(ICON_PALETTE_SIZE);
  for (let i = 0; i < 16; i++) {
    const color = palette[i] || { r: 0, g: 0, b: 0 };
    writeU16(bytes, i * 2, snapToRgb555(color.r, color.g, color.b).key15);
  }
  return bytes;
}

/**
 * Converts 16 little-endian RGB555 values (32 bytes) to an RGB palette.
 * Expands channels with rgb5To8 bit replication.
 * @param {Uint8Array} bytes - 32 bytes
 * @returns {Array<{r: number, g: number, b: number}>} 16 RGB colors
 */
export function rgb555ToPalette(bytes) {
  const palette = [];
  for (let i = 0; i < 16; i++) {
    const val = readU16(bytes, i * 2);
    palette.push({
      r: rgb5To8(val & 0x1F),
      g: rgb5To8((val >> 5) & 0x1F),
      b: rgb5To8((val >> 10) & 0x1F)
    });
  }
  return palette;
}

/**
 * Renders palette indices as RGBA. By default index 0 is transparent
 * (0, 0, 0, 0) and every other index is its opaque palette color. With
 * transparent: false every index, 0 included, is opaque (cover previews).
 * @param {Array<{r: number, g: number, b: number}>} palette
 * @param {Uint8Array} indices - Pixel indices, row-major
 * @param {{transparent?: boolean}} [options]
 * @returns {Uint8ClampedArray} RGBA pixels, 4 bytes per index
 */
export function indicesToRgba(palette, indices, { transparent = true } = {}) {
  const rgba = new Uint8ClampedArray(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    if (transparent && indices[i] === 0) continue;
    const color = palette[indices[i]];
    rgba[i * 4] = color.r;
    rgba[i * 4 + 1] = color.g;
    rgba[i * 4 + 2] = color.b;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/**
 * Reads a PNG that is already a DS icon: 32x32, indexed color, at most 16
 * palette entries. This is what the flashcart guide's GIMP steps produce,
 * where the color moved to palette entry 0 is meant to be transparent.
 * Browsers never expose a PNG's palette to canvas code, so the file is parsed
 * here. Every pixel keeps its palette index, and entry 0 becomes transparent.
 *
 * @param {Uint8Array} bytes - The PNG file
 * @returns {Promise<{palette: Array<{r: number, g: number, b: number}>, indices: Uint8Array} | null>}
 *   16 RGB555-snapped palette colors and 1024 indices, or null when the file
 *   is not such a PNG, is interlaced, or marks an entry other than 0 as
 *   transparent (that image is better served by the normal RGBA path).
 */
export async function decodeIndexedIcon(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8 || signature.some((b, i) => bytes[i] !== b)) return null;

  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let header = null;
    let plte = null;
    let trns = null;
    const idat = [];
    for (let o = 8; o + 12 <= bytes.length; ) {
      const length = view.getUint32(o);
      const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
      const data = bytes.subarray(o + 8, o + 8 + length);
      if (type === 'IHDR') header = { width: view.getUint32(o + 8), height: view.getUint32(o + 12), bitDepth: data[8], colorType: data[9], interlace: data[12] };
      else if (type === 'PLTE') plte = data;
      else if (type === 'tRNS') trns = data;
      else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      o += 12 + length;
    }
    if (!header || !plte || header.colorType !== 3 || header.interlace !== 0) return null;
    if (header.width !== 32 || header.height !== 32) return null;
    const entries = plte.length / 3;
    if (entries > 16 || (trns && trns.some((a, i) => i > 0 && a < 255))) return null;

    // IDAT is a zlib stream
    const inflated = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'));
    const raw = new Uint8Array(await new Response(inflated).arrayBuffer());

    // Undo the per-row filters (1 byte per filter unit at these bit depths)
    const { bitDepth } = header;
    const rowBytes = Math.ceil(32 * bitDepth / 8);
    if (raw.length < 32 * (rowBytes + 1)) return null;
    const indices = new Uint8Array(1024);
    let prev = new Uint8Array(rowBytes);
    for (let y = 0; y < 32; y++) {
      const filter = raw[y * (rowBytes + 1)];
      if (filter > 4) return null;
      const row = raw.slice(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
      for (let i = 0; i < rowBytes; i++) {
        const left = i > 0 ? row[i - 1] : 0;
        const up = prev[i];
        const upLeft = i > 0 ? prev[i - 1] : 0;
        if (filter === 1) row[i] += left;
        else if (filter === 2) row[i] += up;
        else if (filter === 3) row[i] += (left + up) >> 1;
        else if (filter === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
          row[i] += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        }
      }
      for (let x = 0; x < 32; x++) {
        const bit = x * bitDepth;
        const index = (row[bit >> 3] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
        if (index >= entries) return null;
        indices[y * 32 + x] = index;
      }
      prev = row;
    }

    const palette = [];
    for (let k = 0; k < 16; k++) {
      const s = k < entries ? snapToRgb555(plte[k * 3], plte[k * 3 + 1], plte[k * 3 + 2]) : { r: 0, g: 0, b: 0 };
      palette.push({ r: s.r, g: s.g, b: s.b });
    }
    return { palette, indices };
  } catch {
    return null;
  }
}

/**
 * Assembles a complete NTR v1 banner.bin structure (2112 bytes / 0x840).
 * Replicates the Title, Subtitle, and Author metadata across all 6 system menu language slots.
 *
 * @param {Array<{r: number, g: number, b: number, a: number}>} pixels - 32x32 RGBA pixels
 * @param {string} title
 * @param {string} subtitle
 * @param {string} author
 * @param {boolean} [enhance=false] - Optional contrast and dither enhancement
 * @returns {Uint8Array} The packed 2112-byte banner.bin
 */
export function packBanner(pixels, title, subtitle, author, enhance = false) {
  // Icon: 15 colors plus transparent index 0
  return packBannerIcon(quantize(pixels, 15, enhance), title, subtitle, author);
}

/**
 * Assembles an NTR v1 banner.bin from an icon that already has its palette,
 * such as one from quantize() or decodeIndexedIcon().
 *
 * @param {{palette: Array<{r: number, g: number, b: number}>, indices: Uint8Array}} icon
 *   16 palette colors (index 0 is transparent) and 1024 pixel indices
 * @param {string} title
 * @param {string} subtitle
 * @param {string} author
 * @returns {Uint8Array} The packed 2112-byte banner.bin
 */
export function packBannerIcon(icon, title, subtitle, author) {
  const banner = new Uint8Array(NTR_V1_SIZE);
  writeU16(banner, 0x00, 0x0001); // Version: NTR v1

  const { palette, indices } = icon;
  banner.set(tileEncode(indices), ICON_BITMAP);
  banner.set(paletteToRgb555(palette), ICON_PALETTE);

  // Title text: non-empty lines joined by LF, at most 127 code units so the
  // slot always ends with a NUL, replicated into language slots 0..5
  const titleString = [title, subtitle, author]
    .map(line => (line ? line.trim() : ''))
    .filter(Boolean)
    .join('\n')
    .slice(0, 127);
  const titleBytes = stringToUtf16Le(titleString);
  for (let slot = 0; slot < 6; slot++) {
    banner.set(titleBytes, TITLE_SLOTS + slot * TITLE_SLOT_SIZE);
  }

  writeU16(banner, 0x02, crc16(banner.subarray(ICON_BITMAP, NTR_V1_SIZE)));
  return banner;
}

/**
 * Area-averaging (box-filter) resampler shared by downscaleBox and the
 * downscale pyramid. Samples the source region [rx, rx + rw) x [ry, ry + rh)
 * into a dw x dh RGBA grid.
 *
 * Color is weighted by overlap area * alpha, so fully transparent pixels never
 * pull their hidden RGB (usually black or white) into anti-aliased edges.
 * Region parts outside the source count as fully transparent area.
 *
 * @returns {Uint8ClampedArray} dw * dh RGBA pixels (unpremultiplied)
 */
function resampleBox(src, srcW, srcH, rx, ry, rw, rh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const ratioX = rw / dw;
  const ratioY = rh / dh;
  let o = 0;

  for (let dy = 0; dy < dh; dy++) {
    const yStart = ry + dy * ratioY;
    const yEnd = ry + (dy + 1) * ratioY;
    const syStart = Math.floor(yStart);
    const syEnd = Math.ceil(yEnd);

    for (let dx = 0; dx < dw; dx++) {
      const xStart = rx + dx * ratioX;
      const xEnd = rx + (dx + 1) * ratioX;
      const sxStart = Math.floor(xStart);
      const sxEnd = Math.ceil(xEnd);

      let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
      let sumWeight = 0;
      let sumAlphaWeight = 0;

      for (let sy = syStart; sy < syEnd; sy++) {
        const overlapY = Math.min(sy + 1, yEnd) - Math.max(sy, yStart);
        const rowInside = sy >= 0 && sy < srcH;

        for (let sx = sxStart; sx < sxEnd; sx++) {
          const overlapX = Math.min(sx + 1, xEnd) - Math.max(sx, xStart);
          const weight = overlapX * overlapY;
          sumWeight += weight;
          if (!rowInside || sx < 0 || sx >= srcW) continue;

          const srcIdx = (sy * srcW + sx) * 4;
          const srcA = src[srcIdx + 3];
          if (srcA > 0) {
            // Weight color contribution by both area overlap and pixel alpha
            const alphaWeight = weight * (srcA / 255);
            sumR += src[srcIdx] * alphaWeight;
            sumG += src[srcIdx + 1] * alphaWeight;
            sumB += src[srcIdx + 2] * alphaWeight;
            sumA += srcA * weight;
            sumAlphaWeight += alphaWeight;
          }
        }
      }

      if (sumAlphaWeight > 0) {
        out[o] = Math.round(sumR / sumAlphaWeight);
        out[o + 1] = Math.round(sumG / sumAlphaWeight);
        out[o + 2] = Math.round(sumB / sumAlphaWeight);
      }
      out[o + 3] = sumWeight > 0 ? Math.round(sumA / sumWeight) : 0;
      o += 4;
    }
  }

  return out;
}

/**
 * Flattens {r, g, b, a} pixel objects into RGBA bytes (ImageData layout).
 * @param {Array<{r: number, g: number, b: number, a: number}>} pixels
 * @returns {Uint8ClampedArray}
 */
export function pixelsToRgba(pixels) {
  const rgba = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach((p, i) => rgba.set([p.r, p.g, p.b, p.a], i * 4));
  return rgba;
}

function toPixelObjects(rgba) {
  const pixels = new Array(rgba.length / 4);
  for (let i = 0; i < pixels.length; i++) {
    const o = i * 4;
    pixels[i] = { r: rgba[o], g: rgba[o + 1], b: rgba[o + 2], a: rgba[o + 3] };
  }
  return pixels;
}

/**
 * Area-averaging (box-filter) downscaler to resize a square image to 32x32.
 * Preserves anti-aliased edge colors without baking in a white halo outline.
 *
 * @param {Uint8ClampedArray} srcData - Raw RGBA source pixel data
 * @param {number} srcSize - Width/Height of the square source image
 * @returns {Array<{r: number, g: number, b: number, a: number}>} 1024 resized pixels
 */
export function downscaleBox(srcData, srcSize) {
  return toPixelObjects(resampleBox(srcData, srcSize, srcSize, 0, 0, srcSize, srcSize, 32, 32));
}

// A region keeps at least this many source samples per output pixel on each
// axis when downscaleRegionRect picks a smaller pyramid level.
const SAMPLES_PER_PIXEL = 8;

// createImageSource stops halving once a level's longest side drops below
// twice this (8 samples for each of an icon's 32 pixels).
const PYRAMID_MIN_SAMPLES = 256;

/**
 * Prepares an RGBA image for repeated downscaleRegion calls (e.g. while a
 * crop box is dragged). Builds a pyramid of half-size levels with the same
 * alpha-weighted box filter, so a large region costs about as much as a
 * 256-512 px one. Level 0 is the source data itself (not copied).
 *
 * @param {Uint8ClampedArray} rgba - Raw RGBA pixel data
 * @param {number} width
 * @param {number} height
 * @returns {{width: number, height: number, levels: Array<{data: Uint8ClampedArray, width: number, height: number}>}}
 */
export function createImageSource(rgba, width, height) {
  const levels = [{ data: rgba, width, height }];
  let level = levels[0];
  while (Math.max(level.width, level.height) >= PYRAMID_MIN_SAMPLES * 2) {
    const w = Math.ceil(level.width / 2);
    const h = Math.ceil(level.height / 2);
    const data = resampleBox(level.data, level.width, level.height, 0, 0, level.width, level.height, w, h);
    level = { data, width: w, height: h };
    levels.push(level);
  }
  return { width, height, levels };
}

/**
 * Downscales a square region of an image source to 32x32. The region is in
 * source pixel coordinates and may extend past the image edges (that area is
 * transparent, which is how Fit mode pads non-square images).
 *
 * @param {ReturnType<typeof createImageSource>} source
 * @param {number} x - Region left edge
 * @param {number} y - Region top edge
 * @param {number} size - Region width and height
 * @returns {Array<{r: number, g: number, b: number, a: number}>} 1024 resized pixels
 */
export function downscaleRegion(source, x, y, size) {
  return downscaleRegionRect(source, x, y, size, size, 32, 32);
}

/**
 * Downscales a rectangular region of an image source to outW x outH, with the
 * same alpha-weighted box filter. The region may extend past the image edges
 * (that area is transparent).
 *
 * @param {ReturnType<typeof createImageSource>} source
 * @param {number} x - Region left edge
 * @param {number} y - Region top edge
 * @param {number} w - Region width
 * @param {number} h - Region height
 * @param {number} outW
 * @param {number} outH
 * @param {{nearest?: boolean}} [options] - nearest: sample the source pixel under
 *   each output pixel's center instead of averaging, for enlarging pixel art
 *   without blending in-between colors
 * @returns {Array<{r: number, g: number, b: number, a: number}>} outW * outH pixels, row-major
 */
export function downscaleRegionRect(source, x, y, w, h, outW, outH, { nearest = false } = {}) {
  if (nearest) {
    const { data, width, height } = source.levels[0];
    const s = width / source.width;
    return toPixelObjects(sampleNearest(data, width, height, x * s, y * s, w * s, h * s, outW, outH));
  }
  // Use the smallest level that still keeps SAMPLES_PER_PIXEL samples per
  // output pixel across and down the region.
  let level = source.levels[0];
  for (let i = 1; i < source.levels.length; i++) {
    const candidate = source.levels[i];
    const scale = candidate.width / source.width;
    if (w * scale < SAMPLES_PER_PIXEL * outW || h * scale < SAMPLES_PER_PIXEL * outH) break;
    level = candidate;
  }
  const sx = level.width / source.width;
  const sy = level.height / source.height;
  return toPixelObjects(resampleBox(level.data, level.width, level.height, x * sx, y * sy, w * sx, h * sy, outW, outH));
}

// Nearest-neighbor counterpart of resampleBox: each output pixel copies the
// source pixel under its center. Outside the source is fully transparent.
function sampleNearest(src, srcW, srcH, rx, ry, rw, rh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let dy = 0; dy < dh; dy++) {
    const sy = Math.floor(ry + ((dy + 0.5) * rh) / dh);
    if (sy < 0 || sy >= srcH) continue;
    for (let dx = 0; dx < dw; dx++) {
      const sx = Math.floor(rx + ((dx + 0.5) * rw) / dw);
      if (sx < 0 || sx >= srcW) continue;
      const i = (sy * srcW + sx) * 4;
      out.set(src.subarray(i, i + 4), (dy * dw + dx) * 4);
    }
  }
  return out;
}

/**
 * Composites pixels over a solid background, for outputs with no
 * transparency (covers). Partly transparent edges blend into it; fully
 * transparent pixels become the background.
 * @param {Array<{r: number, g: number, b: number, a: number}>} pixels
 * @param {{r: number, g: number, b: number}} background
 * @returns {Array<{r: number, g: number, b: number, a: number}>} opaque pixels
 */
export function flattenOver(pixels, background) {
  return pixels.map(p => ({
    r: Math.round((p.r * p.a + background.r * (255 - p.a)) / 255),
    g: Math.round((p.g * p.a + background.g * (255 - p.a)) / 255),
    b: Math.round((p.b * p.a + background.b * (255 - p.a)) / 255),
    a: 255
  }));
}

// Icon/Title versions the DS/DSi system menus accept (GBATEK "DS Cartridge
// Icon/Title"; TwlSDK BannerHeader). The low byte is the NTR version (1..3),
// the high byte is the platform (0 = NTR, 1 = TWL animated icon).
const BANNER_FORMATS = {
  0x0001: { name: 'NTR v1', size: NTR_V1_SIZE, titleSlots: 6 },
  0x0002: { name: 'NTR v2 (+ Chinese)', size: 0x940, titleSlots: 7 },
  0x0003: { name: 'NTR v3 (+ Chinese, Korean)', size: 0xA40, titleSlots: 8 },
  0x0103: { name: 'DSi animated', size: 0x23C0, titleSlots: 8 }
};

/**
 * Identifies the banner format from its version field.
 * @param {Uint8Array} bannerBytes
 * @returns {{version: number, name: string, size: number, titleSlots: number} | null}
 *   null when the version is not one of 0x0001, 0x0002, 0x0003, 0x0103.
 */
export function getBannerFormat(bannerBytes) {
  if (bannerBytes.length < 2) return null;
  const version = readU16(bannerBytes, 0);
  const format = BANNER_FORMATS[version];
  return format ? { version, ...format } : null;
}

/**
 * Checks every CRC16 the banner's version requires, like the DSi system
 * menu's BANNER_CheckBanner does. The console discards the whole banner
 * (no icon, no title) when any of them fails.
 *
 * @param {Uint8Array} bannerBytes - At least the format's full size
 * @param {{version: number}} format - From getBannerFormat()
 * @returns {Array<{name: string, offset: number, start: number, end: number, embedded: number, calculated: number, valid: boolean}>}
 */
export function checkBannerCrcs(bannerBytes, format) {
  const ranges = [{ name: 'v1', offset: 0x02, start: ICON_BITMAP, end: NTR_V1_SIZE }];
  const ntrVersion = format.version & 0xFF;
  if (ntrVersion >= 2) ranges.push({ name: 'v2', offset: 0x04, start: ICON_BITMAP, end: 0x940 });
  if (ntrVersion >= 3) ranges.push({ name: 'v3', offset: 0x06, start: ICON_BITMAP, end: 0xA40 });
  if (format.version === 0x0103) ranges.push({ name: 'animation', offset: 0x08, start: ANIM_BITMAPS, end: 0x23C0 });

  return ranges.map(r => {
    const embedded = readU16(bannerBytes, r.offset);
    const calculated = crc16(bannerBytes.subarray(r.start, r.end));
    return { ...r, embedded, calculated, valid: embedded === calculated };
  });
}

// True when a DSi animated banner shows something other than its static
// icon. Sequence tokens: bits 0-7 duration (0 = end), 8-10 bitmap,
// 11-13 palette, 14 hflip, 15 vflip. A single frame that repeats the static
// icon (common for "non-animated" DSi banners) counts as no animation.
function hasVisibleAnimation(bannerBytes) {
  const frames = new Set();
  for (let i = 0; i < 64; i++) {
    const token = readU16(bannerBytes, ANIM_SEQUENCE + i * 2);
    if ((token & 0xFF) === 0) break;
    frames.add(token >> 8);
  }
  if (frames.size !== 1) return frames.size > 1;

  const frame = [...frames][0];
  if (frame & 0xC0) return true; // flipped
  const bitmap = ANIM_BITMAPS + (frame & 0x07) * ICON_BITMAP_SIZE;
  const pltt = ANIM_PALETTES + ((frame >> 3) & 0x07) * ICON_PALETTE_SIZE;
  return !sameIconPixels(bannerBytes, ICON_BITMAP, ICON_PALETTE, bitmap, pltt);
}

// Compares two 4bpp icons by visible color (15-bit), ignoring unused palette
// entries and the color stored in the transparent entry 0.
function sameIconPixels(bytes, bitmapA, plttA, bitmapB, plttB) {
  const color = (pltt, idx) => idx === 0 ? -1 : readU16(bytes, pltt + idx * 2) & 0x7FFF;
  for (let i = 0; i < ICON_BITMAP_SIZE; i++) {
    const a = bytes[bitmapA + i];
    const b = bytes[bitmapB + i];
    if (color(plttA, a & 0x0F) !== color(plttB, b & 0x0F)) return false;
    if (color(plttA, a >> 4) !== color(plttB, b >> 4)) return false;
  }
  return true;
}

function readTitleSlot(bannerBytes, slot) {
  const offset = TITLE_SLOTS + slot * TITLE_SLOT_SIZE;
  return utf16LeToString(bannerBytes.subarray(offset, offset + TITLE_SLOT_SIZE));
}

/**
 * Decodes a banner.bin Uint8Array back into its constituent parts:
 * - 32x32 RGBA pixels array (the static icon, which every format has)
 * - Title / Subtitle / Author strings
 * - Format and CRC validation for every CRC the version requires
 * - What an NTR v1 re-export (packBanner) would not keep
 *
 * @param {Uint8Array} bannerBytes - At least getBannerFormat(bytes).size bytes
 * @returns {{
 *   pixels: Array<{r: number, g: number, b: number, a: number}>,
 *   title: string,
 *   subtitle: string,
 *   author: string,
 *   format: {version: number, name: string, size: number, titleSlots: number},
 *   crcChecks: ReturnType<typeof checkBannerCrcs>,
 *   crcValid: boolean,
 *   calculatedCrc: number,
 *   embeddedCrc: number,
 *   lostOnExport: {translations: boolean, chineseKorean: boolean, animation: boolean}
 * }}
 * @throws {Error} When the version is unknown or the file is shorter than its version requires.
 */
export function decodeBanner(bannerBytes) {
  const format = getBannerFormat(bannerBytes);
  if (!format) {
    throw new Error('Unknown banner version');
  }
  if (bannerBytes.length < format.size) {
    throw new Error(`Truncated ${format.name} banner`);
  }

  // 1. Static icon (every format has one)
  const palette = rgb555ToPalette(bannerBytes.subarray(ICON_PALETTE, ICON_PALETTE + ICON_PALETTE_SIZE));
  const indices = tileDecode(bannerBytes.subarray(ICON_BITMAP, ICON_BITMAP + ICON_BITMAP_SIZE));
  const pixels = toPixelObjects(indicesToRgba(palette, indices));

  // 2. Decode titles. Check English first (slot 1), then Japanese (slot 0),
  // then the remaining slots this version defines.
  const slotTexts = [];
  for (let slot = 0; slot < format.titleSlots; slot++) {
    slotTexts.push(readTitleSlot(bannerBytes, slot));
  }
  const searchOrder = [1, 0, 2, 3, 4, 5, 6, 7].filter(slot => slot < format.titleSlots);
  let titleString = "";
  for (const slot of searchOrder) {
    if (slotTexts[slot]) {
      titleString = slotTexts[slot];
      break;
    }
  }

  // Split lines
  const lines = titleString.split('\n');
  const title = lines[0] ? lines[0].trim() : "";
  const subtitle = lines[1] ? lines[1].trim() : "";
  const author = lines.slice(2).join('\n').trim();

  // 3. Checksum verification
  const crcChecks = checkBannerCrcs(bannerBytes, format);
  const crcValid = crcChecks.every(c => c.valid);

  // 4. packBanner writes one text to slots 0..5 and no animation
  const ntrTexts = slotTexts.slice(0, 6).filter(Boolean);
  const lostOnExport = {
    translations: new Set(ntrTexts).size > 1,
    chineseKorean: slotTexts.slice(6).some(Boolean),
    animation: format.version === 0x0103 && hasVisibleAnimation(bannerBytes)
  };

  return {
    pixels, title, subtitle, author,
    format, crcChecks, crcValid,
    calculatedCrc: crcChecks[0].calculated,
    embeddedCrc: crcChecks[0].embedded,
    lostOnExport
  };
}

/**
 * Picks a cover background for an image. With see-through areas (logos,
 * cut-out art) it picks the color that contrasts with the visible content, so
 * the art stays readable. Otherwise it matches the image's outer edge, so Fit
 * bars and padding blend in. Light vs dark is Rec. 709 luma against 50%.
 *
 * @param {Uint8ClampedArray} rgba - width * height RGBA pixels
 * @param {number} width
 * @param {number} height
 * @returns {'black' | 'white'}
 */
export function pickBackground(rgba, width, height) {
  let seeThrough = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 128) seeThrough++;
  }
  const transparent = seeThrough > width * height * 0.02;

  let sum = 0;
  let count = 0;
  const add = (x, y) => {
    const i = (y * width + x) * 4;
    if (rgba[i + 3] < 128) return;
    sum += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
    count++;
  };
  if (transparent) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) add(x, y);
  } else {
    for (let x = 0; x < width; x++) { add(x, 0); add(x, height - 1); }
    for (let y = 1; y < height - 1; y++) { add(0, y); add(width - 1, y); }
  }
  if (count === 0) return 'black';
  const light = sum / count >= 128;
  return transparent === light ? 'black' : 'white';
}

// Pico Launcher cover (pico-launcher BmpFileCover.cpp, BmpHeader.h): a
// 128 x 96, 8 bpp BMP with a 40-byte BITMAPINFOHEADER and 256 colors. Only
// the left 106 x 96 are shown. Rows must be stored bottom-up: Pico copies
// them as-is and never flips a top-down file.
export const COVER_SIZE = Object.freeze({ width: 106, height: 96 });
const COVER_BMP_WIDTH = 128;
const COVER_PALETTE_OFFSET = 14 + 40;
const COVER_DATA_OFFSET = COVER_PALETTE_OFFSET + 256 * 4; // 1078

/**
 * Encodes a Pico Launcher cover BMP.
 *
 * @param {Array<{r: number, g: number, b: number}>} palette - Up to 256 colors,
 *   snapped to RGB555 on write; missing entries are black
 * @param {Uint8Array} indices - 106 x 96 palette indices, row-major from the top-left
 * @returns {Uint8Array} The 13,366-byte cover.bmp
 */
export function encodeCoverBmp(palette, indices) {
  const { width, height } = COVER_SIZE;
  if (indices.length !== width * height) {
    throw new RangeError(`Cover needs ${width * height} indices, got ${indices.length}`);
  }
  if (palette.length > 256) {
    throw new RangeError(`Cover palette holds 256 colors, got ${palette.length}`);
  }

  const imageSize = COVER_BMP_WIDTH * height; // rows are 128 bytes, already 4-byte aligned
  const bmp = new Uint8Array(COVER_DATA_OFFSET + imageSize);
  const view = new DataView(bmp.buffer);

  // BITMAPFILEHEADER
  bmp[0] = 0x42; // 'B'
  bmp[1] = 0x4D; // 'M'
  view.setUint32(2, bmp.length, true);
  view.setUint32(10, COVER_DATA_OFFSET, true);

  // BITMAPINFOHEADER
  view.setUint32(14, 40, true);
  view.setInt32(18, COVER_BMP_WIDTH, true);
  view.setInt32(22, height, true); // positive: bottom-up rows
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 8, true); // bits per pixel
  view.setUint32(30, 0, true); // BI_RGB, no compression
  view.setUint32(34, imageSize, true);
  view.setInt32(38, 2835, true); // 72 dpi, like Pico's own covers
  view.setInt32(42, 2835, true);
  view.setUint32(46, 256, true); // colors used

  // Palette (BGRx). The darkest entry fills the unused right-hand columns,
  // which Pico still copies to VRAM (14 tiles, 112 px, per row).
  let padIndex = 0;
  let padLum = Infinity;
  for (let k = 0; k < 256; k++) {
    const c = palette[k] || { r: 0, g: 0, b: 0 };
    const s = snapToRgb555(c.r, c.g, c.b);
    const o = COVER_PALETTE_OFFSET + k * 4;
    bmp[o] = s.b;
    bmp[o + 1] = s.g;
    bmp[o + 2] = s.r;
    if (s.r + s.g + s.b < padLum) {
      padLum = s.r + s.g + s.b;
      padIndex = k;
    }
  }

  // Pixels, bottom row first
  for (let y = 0; y < height; y++) {
    const row = COVER_DATA_OFFSET + (height - 1 - y) * COVER_BMP_WIDTH;
    bmp.set(indices.subarray(y * width, (y + 1) * width), row);
    bmp.fill(padIndex, row + width, row + COVER_BMP_WIDTH);
  }
  return bmp;
}
