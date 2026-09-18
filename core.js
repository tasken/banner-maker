/**
 * Core business logic for DS Banner Maker.
 * DOM-independent pure functions for Node.js testing and Browser support.
 * Writes NTR v1 banner.bin files (2112 bytes / 0x840); reads NTR v1-v3 and
 * DSi animated banners.
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

// 4x4 ordered (Bayer) dither matrix, values 0..15.
const BAYER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
];
const DITHER_STRENGTH = 24; // Max +/- offset applied per channel before nearest-color lookup

/**
 * Perceptual weighted color distance squared.
 * Uses 2*dr^2 + 4*dg^2 + 3*db^2 matching human eye and retro DS LCD sensitivity.
 */
// Index 0 is transparent (its color is never shown), then the given colors,
// then black for unused entries: always 16 colors.
function buildPalette(colors) {
  const palette = [{ r: 255, g: 0, b: 255 }, ...colors];
  while (palette.length < 16) {
    palette.push({ r: 0, g: 0, b: 0 });
  }
  return palette;
}

function colorDistanceSq(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

/**
 * Median-cut color quantization in native 15-bit RGB555 color space.
 * Maps low-alpha pixels to palette index 0 (transparent).
 * Quantizes remaining opaque pixels to at most 15 unique hardware colors.
 * Refines by mapping pixels to the nearest palette color using perceptual distance.
 *
 * @param {Array<{r: number, g: number, b: number, a: number}>} pixels - 1024 pixels
 * @param {number} [maxColors=15]
 * @param {boolean} [enhance=false] - Boosts contrast/saturation and applies ordered dithering.
 * @returns {{palette: Array<{r: number, g: number, b: number}>, indices: Uint8Array}}
 */
export function quantize(pixels, maxColors = 15, enhance = false) {
  const indices = new Uint8Array(1024); // Defaults to 0 (transparent)
  const opaquePixels = [];

  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    if (p.a >= 128) {
      const color = enhance ? boostPixelArtColor(p.r, p.g, p.b) : p;
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
    return { palette: buildPalette([]), indices };
  }

  // Fast path: if image already fits within maxColors unique 15-bit colors,
  // map directly without median cut loss.
  const uniqueColors = new Map();
  let withinBudget = true;
  for (const p of opaquePixels) {
    if (!uniqueColors.has(p.key15)) {
      if (uniqueColors.size >= maxColors) {
        withinBudget = false;
        break;
      }
      uniqueColors.set(p.key15, { r: p.r, g: p.g, b: p.b });
    }
  }

  if (withinBudget) {
    const palette = buildPalette([...uniqueColors.values()]);
    const keyToIndex = new Map();
    for (const key15 of uniqueColors.keys()) {
      keyToIndex.set(key15, keyToIndex.size + 1);
    }

    for (const p of opaquePixels) {
      indices[p.originalIndex] = keyToIndex.get(p.key15);
    }

    return { palette, indices };
  }

  // Median cut across 15-bit color space
  let buckets = [opaquePixels];

  while (buckets.length < maxColors) {
    let splitBucketIndex = -1;
    let maxRange = -1;
    let channelToSplit = 'r';

    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i];
      if (bucket.length <= 1) continue;

      let minR = 255, maxR = 0;
      let minG = 255, maxG = 0;
      let minB = 255, maxB = 0;

      for (const p of bucket) {
        if (p.r < minR) minR = p.r;
        if (p.r > maxR) maxR = p.r;
        if (p.g < minG) minG = p.g;
        if (p.g > maxG) maxG = p.g;
        if (p.b < minB) minB = p.b;
        if (p.b > maxB) maxB = p.b;
      }

      // Weight green channel slightly higher when selecting split channel
      const rRange = (maxR - minR) * 1.0;
      const gRange = (maxG - minG) * 1.2;
      const bRange = (maxB - minB) * 0.8;
      const localMaxRange = Math.max(rRange, gRange, bRange);

      if (localMaxRange > maxRange) {
        maxRange = localMaxRange;
        splitBucketIndex = i;
        if (rRange >= gRange && rRange >= bRange) {
          channelToSplit = 'r';
        } else if (gRange >= rRange && gRange >= bRange) {
          channelToSplit = 'g';
        } else {
          channelToSplit = 'b';
        }
      }
    }

    if (splitBucketIndex === -1 || maxRange === 0) {
      break;
    }

    const bucketToSplit = buckets[splitBucketIndex];
    bucketToSplit.sort((a, b) => a[channelToSplit] - b[channelToSplit]);
    const median = Math.floor(bucketToSplit.length / 2);
    const part1 = bucketToSplit.slice(0, median);
    const part2 = bucketToSplit.slice(median);

    buckets.splice(splitBucketIndex, 1, part1, part2);
  }

  // Each bucket's average color, snapped to RGB555
  const palette = buildPalette(buckets.map(bucket => {
    let sumR = 0, sumG = 0, sumB = 0;
    for (const p of bucket) {
      sumR += p.r;
      sumG += p.g;
      sumB += p.b;
    }
    const snapped = snapToRgb555(
      Math.round(sumR / bucket.length),
      Math.round(sumG / bucket.length),
      Math.round(sumB / bucket.length)
    );
    return { r: snapped.r, g: snapped.g, b: snapped.b };
  }));

  // Refine pixel mapping using perceptual distance
  for (const p of opaquePixels) {
    let searchR = p.r, searchG = p.g, searchB = p.b;
    if (enhance) {
      const x = p.originalIndex % 32;
      const y = (p.originalIndex / 32) | 0;
      const threshold = (BAYER_4X4[y & 3][x & 3] / 16 - 0.5) * DITHER_STRENGTH;
      searchR = clamp255(p.r + threshold);
      searchG = clamp255(p.g + threshold);
      searchB = clamp255(p.b + threshold);
    }

    let minDistance = Infinity;
    let nearestIndex = 1;
    for (let j = 1; j < 16; j++) {
      const color = palette[j];
      const dist = colorDistanceSq(searchR, searchG, searchB, color.r, color.g, color.b);
      if (dist < minDistance) {
        minDistance = dist;
        nearestIndex = j;
      }
    }
    indices[p.originalIndex] = nearestIndex;
  }

  return { palette, indices };
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
 * Renders palette indices as RGBA. Index 0 is transparent (0, 0, 0, 0);
 * every other index is its opaque palette color.
 * @param {Array<{r: number, g: number, b: number}>} palette
 * @param {Uint8Array} indices - 1024 pixel indices
 * @returns {Uint8ClampedArray} 32x32 RGBA pixels
 */
export function indicesToRgba(palette, indices) {
  const rgba = new Uint8ClampedArray(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] === 0) continue;
    const color = palette[indices[i]];
    rgba[i * 4] = color.r;
    rgba[i * 4 + 1] = color.g;
    rgba[i * 4 + 2] = color.b;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
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
  const banner = new Uint8Array(NTR_V1_SIZE);
  writeU16(banner, 0x00, 0x0001); // Version: NTR v1

  // Icon: 15 colors plus transparent index 0
  const { palette, indices } = quantize(pixels, 15, enhance);
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

// A region keeps at least this many source samples per axis (8 per icon
// pixel) when downscaleRegion picks a smaller pyramid level.
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
  // Use the smallest level that still keeps PYRAMID_MIN_SAMPLES across the region.
  let level = source.levels[0];
  for (let i = 1; i < source.levels.length; i++) {
    const candidate = source.levels[i];
    if (size * (candidate.width / source.width) < PYRAMID_MIN_SAMPLES) break;
    level = candidate;
  }
  const sx = level.width / source.width;
  const sy = level.height / source.height;
  return toPixelObjects(resampleBox(level.data, level.width, level.height, x * sx, y * sy, size * sx, size * sy, 32, 32));
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
