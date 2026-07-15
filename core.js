/**
 * Core business logic for DS Banner Maker.
 * DOM-independent pure functions for Node.js testing and Browser support.
 */

/**
 * GBATEK swiCRC16 algorithm.
 * @param {Uint8Array} data
 * @returns {number} 16-bit unsigned integer CRC
 */
export function crc16(data) {
  let crc = 0xFFFF;
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

/**
 * Convert string to UTF-16LE bytes.
 * @param {string} str
 * @returns {Uint8Array}
 */
export function stringToUtf16Le(str) {
  const buf = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    buf[i * 2] = code & 0xFF;
    buf[i * 2 + 1] = (code >> 8) & 0xFF;
  }
  return buf;
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
 * Median-cut color quantization.
 * Maps low-alpha pixels to palette index 0 (transparent).
 * Quantizes remaining opaque pixels to at most 15 colors.
 * Refines by mapping pixels to the nearest palette color.
 *
 * @param {Array<{r: number, g: number, b: number, a: number}>} pixels - 1024 pixels
 * @param {number} [maxColors=15]
 * @param {boolean} [enhance=false] - Boosts contrast/saturation before quantizing and
 *   applies ordered dithering during palette assignment, so busy source images (photos,
 *   gradients) read closer to hand-drawn pixel art instead of flat/muddy blends. Has no
 *   effect on images that already fit within maxColors unique colors.
 * @returns {{palette: Array<{r: number, g: number, b: number}>, indices: Uint8Array}}
 */
export function quantize(pixels, maxColors = 15, enhance = false) {
  const indices = new Uint8Array(1024); // Defaults to 0 (transparent)
  const opaquePixels = [];

  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    if (p.a >= 128) {
      const color = enhance ? boostPixelArtColor(p.r, p.g, p.b) : p;
      opaquePixels.push({
        r: color.r,
        g: color.g,
        b: color.b,
        originalIndex: i
      });
    }
  }

  // If no opaque pixels, return transparent magenta palette and zero indices
  if (opaquePixels.length === 0) {
    const palette = [{ r: 255, g: 0, b: 255 }];
    while (palette.length < 16) {
      palette.push({ r: 0, g: 0, b: 0 });
    }
    return { palette, indices };
  }

  // Fast path: if the image already uses at most maxColors unique colors,
  // map them directly instead of quantizing, so no colors are blended/lost.
  const uniqueColors = new Map();
  let withinBudget = true;
  for (const p of opaquePixels) {
    const key = (p.r << 16) | (p.g << 8) | p.b;
    if (!uniqueColors.has(key)) {
      if (uniqueColors.size >= maxColors) {
        withinBudget = false;
        break;
      }
      uniqueColors.set(key, { r: p.r, g: p.g, b: p.b });
    }
  }

  if (withinBudget) {
    const palette = [{ r: 255, g: 0, b: 255 }];
    const keyToIndex = new Map();
    for (const [key, color] of uniqueColors) {
      keyToIndex.set(key, palette.length);
      palette.push(color);
    }
    while (palette.length < 16) {
      palette.push({ r: 0, g: 0, b: 0 });
    }

    for (const p of opaquePixels) {
      const key = (p.r << 16) | (p.g << 8) | p.b;
      indices[p.originalIndex] = keyToIndex.get(key);
    }

    return { palette, indices };
  }

  // Median cut (only reached when the image has more than maxColors unique colors)
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

      const rRange = maxR - minR;
      const gRange = maxG - minG;
      const bRange = maxB - minB;
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

  // Build the palette (index 0 is transparent magenta)
  const palette = [{ r: 255, g: 0, b: 255 }];
  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i];
    let sumR = 0, sumG = 0, sumB = 0;
    for (const p of bucket) {
      sumR += p.r;
      sumG += p.g;
      sumB += p.b;
    }
    palette.push({
      r: Math.round(sumR / bucket.length),
      g: Math.round(sumG / bucket.length),
      b: Math.round(sumB / bucket.length)
    });
  }

  // Pad palette to 16 colors
  while (palette.length < 16) {
    palette.push({ r: 0, g: 0, b: 0 });
  }

  // Refine pixel mapping: Map each opaque pixel to the nearest palette color (indices 1..15).
  // With enhance on, nudge each pixel's color by an ordered-dither offset first, so runs of
  // similar colors alternate between two nearby palette entries instead of flattening to one.
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
      const dr = searchR - color.r;
      const dg = searchG - color.g;
      const db = searchB - color.b;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < minDistance) {
        minDistance = dist;
        nearestIndex = j;
      }
    }
    indices[p.originalIndex] = nearestIndex;
  }

  return { palette, indices };
}

/**
 * Packs 32x32 pixel indices into a tile-encoded 4bpp bitmap (512 bytes).
 * @param {Uint8Array} indices - 1024 pixel indices (0..15)
 * @returns {Uint8Array} 512 bytes
 */
export function tileEncode(indices) {
  const bitmap = new Uint8Array(512);
  let byteIndex = 0;

  for (let tileRow = 0; tileRow < 4; tileRow++) {
    for (let tileCol = 0; tileCol < 4; tileCol++) {
      for (let pixelRow = 0; pixelRow < 8; pixelRow++) {
        const y = tileRow * 8 + pixelRow;
        for (let pixelCol = 0; pixelCol < 8; pixelCol += 2) {
          const x1 = tileCol * 8 + pixelCol;
          const x2 = x1 + 1;
          const idx1 = indices[y * 32 + x1];
          const idx2 = indices[y * 32 + x2];
          bitmap[byteIndex++] = (idx1 & 0x0F) | ((idx2 & 0x0F) << 4);
        }
      }
    }
  }
  return bitmap;
}

/**
 * Converts an RGB palette to 16 little-endian RGB555 values (32 bytes).
 * @param {Array<{r: number, g: number, b: number}>} palette
 * @returns {Uint8Array} 32 bytes
 */
export function paletteToRgb555(palette) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 16; i++) {
    const color = palette[i] || { r: 0, g: 0, b: 0 };
    const r5 = Math.round((color.r * 31) / 255);
    const g5 = Math.round((color.g * 31) / 255);
    const b5 = Math.round((color.b * 31) / 255);
    const val = r5 | (g5 << 5) | (b5 << 10);
    bytes[i * 2] = val & 0xFF;
    bytes[i * 2 + 1] = (val >> 8) & 0xFF;
  }
  return bytes;
}

/**
 * Assembles a complete banner.bin structure (2112 bytes) with updated CRCs.
 *
 * @param {Array<{r: number, g: number, b: number, a: number}>} pixels - 32x32 RGBA pixels
 * @param {string} title
 * @param {string} subtitle
 * @param {string} author
 * @param {boolean} [enhance=false] - See quantize()'s enhance param.
 * @returns {Uint8Array} The packed banner.bin data
 */
export function packBanner(pixels, title, subtitle, author, enhance = false) {
  const banner = new Uint8Array(2112); // Exactly 0x840 bytes

  // 1. Version 0x0001 (NTR v1 banner)
  banner[0] = 0x01;
  banner[1] = 0x00;

  // 2. Quantize and pack icon
  const { palette, indices } = quantize(pixels, 15, enhance);
  const iconBitmap = tileEncode(indices);
  const iconPalette = paletteToRgb555(palette);

  // 3. Write legacy/static icon (offset 0x20)
  banner.set(iconBitmap, 0x20);
  banner.set(iconPalette, 0x220);

  // 4. Encode title blocks (offset 0x240)
  const lines = [];
  if (title && title.trim()) lines.push(title.trim());
  if (subtitle && subtitle.trim()) lines.push(subtitle.trim());
  if (author && author.trim()) lines.push(author.trim());
  let titleString = lines.join('\n');
  if (titleString.length > 127) {
    titleString = titleString.slice(0, 127);
  }
  const titleBytes = stringToUtf16Le(titleString);

  // Replicate into language slots 0..5 (each slot 256 bytes)
  const titleBlock = new Uint8Array(256);
  titleBlock.set(titleBytes.subarray(0, 254)); // Ensure NUL termination space
  for (let i = 0; i < 6; i++) {
    banner.set(titleBlock, 0x240 + i * 256);
  }

  // 5. Compute version1Crc: CRC over [0x20, 0x840)
  const v1CrcVal = crc16(banner.subarray(0x20, 0x840));
  banner[0x02] = v1CrcVal & 0xFF;
  banner[0x03] = (v1CrcVal >> 8) & 0xFF;

  return banner;
}

/**
 * Area-averaging (box-filter) downscaler to resize a square image to 32x32.
 * Accounts for fractional pixel overlaps to prevent aliasing.
 *
 * @param {Uint8ClampedArray} srcData - Raw RGBA source pixel data
 * @param {number} srcSize - Width/Height of the square source image
 * @returns {Array<{r: number, g: number, b: number, a: number}>} 1024 resized pixels
 */
export function downscaleBox(srcData, srcSize) {
  const destSize = 32;
  const ratio = srcSize / destSize;
  const destPixels = [];

  for (let dy = 0; dy < destSize; dy++) {
    const yStart = dy * ratio;
    const yEnd = (dy + 1) * ratio;
    const syStart = Math.floor(yStart);
    const syEnd = Math.ceil(yEnd);

    for (let dx = 0; dx < destSize; dx++) {
      const xStart = dx * ratio;
      const xEnd = (dx + 1) * ratio;
      const sxStart = Math.floor(xStart);
      const sxEnd = Math.ceil(xEnd);

      let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
      let sumWeight = 0;

      for (let sy = syStart; sy < syEnd; sy++) {
        if (sy < 0 || sy >= srcSize) continue;
        const overlapY = Math.min(sy + 1, yEnd) - Math.max(sy, yStart);

        for (let sx = sxStart; sx < sxEnd; sx++) {
          if (sx < 0 || sx >= srcSize) continue;
          const overlapX = Math.min(sx + 1, xEnd) - Math.max(sx, xStart);
          
          const weight = overlapX * overlapY;
          const srcIdx = (sy * srcSize + sx) * 4;

          const srcA = srcData[srcIdx + 3];
          let r = 255, g = 255, b = 255, a = 0;
          
          if (srcA > 0) {
            // Semi-transparent or fully opaque: Alpha blend the source pixel with a solid white background
            const alpha = srcA / 255;
            r = srcData[srcIdx] * alpha + 255 * (1 - alpha);
            g = srcData[srcIdx + 1] * alpha + 255 * (1 - alpha);
            b = srcData[srcIdx + 2] * alpha + 255 * (1 - alpha);
            a = srcA;
          }

          sumR += r * weight;
          sumG += g * weight;
          sumB += b * weight;
          sumA += a * weight;
          sumWeight += weight;
        }
      }

      destPixels.push({
        r: sumWeight > 0 ? Math.round(sumR / sumWeight) : 255,
        g: sumWeight > 0 ? Math.round(sumG / sumWeight) : 255,
        b: sumWeight > 0 ? Math.round(sumB / sumWeight) : 255,
        a: sumWeight > 0 ? Math.round(sumA / sumWeight) : 0
      });
    }
  }

  return destPixels;
}

/**
 * Decodes a banner.bin Uint8Array (at least 2112 bytes) back into its constituent parts:
 * - 32x32 RGBA pixels array
 * - Title string
 * - Subtitle string
 * - Author string
 *
 * @param {Uint8Array} bannerBytes
 * @returns {{pixels: Array<{r: number, g: number, b: number, a: number}>, title: string, subtitle: string, author: string}}
 */
export function decodeBanner(bannerBytes) {
  // 1. Decode palette (32 bytes at offset 0x220)
  const palette = [];
  for (let i = 0; i < 16; i++) {
    const offset = 0x220 + i * 2;
    const val = bannerBytes[offset] | (bannerBytes[offset + 1] << 8);
    const r5 = val & 0x1F;
    const g5 = (val >> 5) & 0x1F;
    const b5 = (val >> 10) & 0x1F;
    // Map 5-bit channel (0..31) to 8-bit channel (0..255)
    const r = Math.round((r5 * 255) / 31);
    const g = Math.round((g5 * 255) / 31);
    const b = Math.round((b5 * 255) / 31);
    palette.push({ r, g, b });
  }

  // 2. Decode tile-encoded indices (512 bytes at offset 0x20)
  const bitmap = bannerBytes.subarray(0x20, 0x220);
  const indices = new Uint8Array(1024);
  let byteIndex = 0;
  for (let tileRow = 0; tileRow < 4; tileRow++) {
    for (let tileCol = 0; tileCol < 4; tileCol++) {
      for (let pixelRow = 0; pixelRow < 8; pixelRow++) {
        const y = tileRow * 8 + pixelRow;
        for (let pixelCol = 0; pixelCol < 8; pixelCol += 2) {
          const byteVal = bitmap[byteIndex++];
          const idx1 = byteVal & 0x0F;
          const idx2 = (byteVal >> 4) & 0x0F;
          const x1 = tileCol * 8 + pixelCol;
          const x2 = x1 + 1;
          indices[y * 32 + x1] = idx1;
          indices[y * 32 + x2] = idx2;
        }
      }
    }
  }

  // 3. Map indices to pixels (RGBA)
  const pixels = [];
  for (let i = 0; i < 1024; i++) {
    const idx = indices[i];
    const color = palette[idx];
    if (idx === 0) {
      // Index 0 is transparent hardware color
      pixels.push({ r: 0, g: 0, b: 0, a: 0 });
    } else {
      pixels.push({ r: color.r, g: color.g, b: color.b, a: 255 });
    }
  }

  // Helper to decode a 256-byte UTF-16LE block to a string
  function decodeUtf16Le(bytes) {
    let str = "";
    for (let i = 0; i < bytes.length; i += 2) {
      const code = bytes[i] | (bytes[i + 1] << 8);
      if (code === 0) break; // NUL terminator
      str += String.fromCharCode(code);
    }
    return str.trim();
  }

  // 4. Decode titles. We try English (Language slot 1) first, then Japanese (slot 0),
  // then other standard NTR slots: French (2), German (3), Italian (4), Spanish (5).
  let titleString = "";
  const searchOrder = [1, 0, 2, 3, 4, 5];
  for (const langIdx of searchOrder) {
    const offset = 0x240 + langIdx * 256;
    if (offset + 256 <= bannerBytes.length) {
      const str = decodeUtf16Le(bannerBytes.subarray(offset, offset + 256));
      if (str) {
        titleString = str;
        break;
      }
    }
  }

  // Fallback to check extra slots if they exist (Chinese = 6, Korean = 7, etc.)
  if (!titleString) {
    for (let langIdx = 6; langIdx < 16; langIdx++) {
      const offset = 0x240 + langIdx * 256;
      if (offset + 256 <= bannerBytes.length) {
        const str = decodeUtf16Le(bannerBytes.subarray(offset, offset + 256));
        if (str) {
          titleString = str;
          break;
        }
      }
    }
  }

  // Split lines
  const lines = titleString.split('\n');
  const title = lines[0] ? lines[0].trim() : "";
  const subtitle = lines[1] ? lines[1].trim() : "";
  const author = lines.slice(2).join('\n') ? lines.slice(2).join('\n').trim() : "";

  return { pixels, title, subtitle, author };
}

