/**
 * Core business logic for DS Banner Maker.
 * DOM-independent pure functions for Node.js testing and Browser support.
 * Targets Nintendo DS NTR v1 banner.bin format (2112 bytes / 0x840).
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

/**
 * Convert UTF-16LE bytes to string, terminating on first NUL code unit.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function utf16LeToString(bytes) {
  let str = "";
  for (let i = 0; i < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
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
 * Hardware-accurate expansion of 5-bit channel (0..31) to 8-bit channel (0..255).
 * Uses Nintendo DS GXRgba hardware bit replication: (v << 3) | (v >> 2).
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

  // If no opaque pixels, return transparent magenta palette and zero indices
  if (opaquePixels.length === 0) {
    const palette = [{ r: 255, g: 0, b: 255 }];
    while (palette.length < 16) {
      palette.push({ r: 0, g: 0, b: 0 });
    }
    return { palette, indices };
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
    const palette = [{ r: 255, g: 0, b: 255 }]; // index 0 transparent
    const keyToIndex = new Map();
    for (const [key15, color] of uniqueColors) {
      keyToIndex.set(key15, palette.length);
      palette.push(color);
    }
    while (palette.length < 16) {
      palette.push({ r: 0, g: 0, b: 0 });
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

  // Build the palette (index 0 is transparent magenta), snapping averages to RGB555
  const palette = [{ r: 255, g: 0, b: 255 }];
  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i];
    let sumR = 0, sumG = 0, sumB = 0;
    for (const p of bucket) {
      sumR += p.r;
      sumG += p.g;
      sumB += p.b;
    }
    const avgR = Math.round(sumR / bucket.length);
    const avgG = Math.round(sumG / bucket.length);
    const avgB = Math.round(sumB / bucket.length);
    const snapped = snapToRgb555(avgR, avgG, avgB);
    palette.push({ r: snapped.r, g: snapped.g, b: snapped.b });
  }

  // Pad palette to 16 colors
  while (palette.length < 16) {
    palette.push({ r: 0, g: 0, b: 0 });
  }

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
 * Unpacks a tile-encoded 4bpp bitmap (512 bytes) into 32x32 pixel indices.
 * @param {Uint8Array} bitmap - 512 bytes
 * @returns {Uint8Array} 1024 pixel indices (0..15)
 */
export function tileDecode(bitmap) {
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
  return indices;
}

/**
 * Converts an RGB palette to 16 little-endian RGB555 values (32 bytes).
 * Uses hardware-accurate 5-bit conversion.
 * @param {Array<{r: number, g: number, b: number}>} palette
 * @returns {Uint8Array} 32 bytes
 */
export function paletteToRgb555(palette) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 16; i++) {
    const color = palette[i] || { r: 0, g: 0, b: 0 };
    const r5 = rgb8To5(color.r);
    const g5 = rgb8To5(color.g);
    const b5 = rgb8To5(color.b);
    const val = r5 | (g5 << 5) | (b5 << 10);
    bytes[i * 2] = val & 0xFF;
    bytes[i * 2 + 1] = (val >> 8) & 0xFF;
  }
  return bytes;
}

/**
 * Converts 16 little-endian RGB555 values (32 bytes) to an RGB palette.
 * Uses hardware-accurate bit replication for 5-bit to 8-bit expansion.
 * @param {Uint8Array} bytes - 32 bytes
 * @returns {Array<{r: number, g: number, b: number}>} 16 RGB colors
 */
export function rgb555ToPalette(bytes) {
  const palette = [];
  for (let i = 0; i < 16; i++) {
    const offset = i * 2;
    const val = bytes[offset] | (bytes[offset + 1] << 8);
    const r5 = val & 0x1F;
    const g5 = (val >> 5) & 0x1F;
    const b5 = (val >> 10) & 0x1F;
    palette.push({
      r: rgb5To8(r5),
      g: rgb5To8(g5),
      b: rgb5To8(b5)
    });
  }
  return palette;
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
  const banner = new Uint8Array(2112); // Exactly 0x840 bytes

  // 1. Version 0x0001 (NTR v1 banner)
  banner[0] = 0x01;
  banner[1] = 0x00;

  // 2. Quantize and pack icon
  const { palette, indices } = quantize(pixels, 15, enhance);
  const iconBitmap = tileEncode(indices);
  const iconPalette = paletteToRgb555(palette);

  // 3. Write icon at offset 0x20
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
  titleBlock.set(titleBytes.subarray(0, 254)); // Ensure 2 bytes NUL termination space
  for (let i = 0; i < 6; i++) {
    banner.set(titleBlock, 0x240 + i * 256);
  }

  // 5. Compute version1Crc: CRC16 over [0x20, 0x840)
  const v1CrcVal = crc16(banner.subarray(0x20, 0x840));
  banner[0x02] = v1CrcVal & 0xFF;
  banner[0x03] = (v1CrcVal >> 8) & 0xFF;

  return banner;
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
      let sumAlphaWeight = 0;

      for (let sy = syStart; sy < syEnd; sy++) {
        if (sy < 0 || sy >= srcSize) continue;
        const overlapY = Math.min(sy + 1, yEnd) - Math.max(sy, yStart);

        for (let sx = sxStart; sx < sxEnd; sx++) {
          if (sx < 0 || sx >= srcSize) continue;
          const overlapX = Math.min(sx + 1, xEnd) - Math.max(sx, xStart);
          const weight = overlapX * overlapY;
          const srcIdx = (sy * srcSize + sx) * 4;

          const srcA = srcData[srcIdx + 3];
          if (srcA > 0) {
            // Weight color contribution by both area overlap and pixel alpha
            const alphaWeight = weight * (srcA / 255);
            sumR += srcData[srcIdx] * alphaWeight;
            sumG += srcData[srcIdx + 1] * alphaWeight;
            sumB += srcData[srcIdx + 2] * alphaWeight;
            sumA += srcA * weight;
            sumAlphaWeight += alphaWeight;
          }
          sumWeight += weight;
        }
      }

      const avgA = sumWeight > 0 ? Math.round(sumA / sumWeight) : 0;

      destPixels.push({
        r: sumAlphaWeight > 0 ? Math.round(sumR / sumAlphaWeight) : 0,
        g: sumAlphaWeight > 0 ? Math.round(sumG / sumAlphaWeight) : 0,
        b: sumAlphaWeight > 0 ? Math.round(sumB / sumAlphaWeight) : 0,
        a: avgA
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
 * - CRC validity check
 *
 * @param {Uint8Array} bannerBytes
 * @returns {{
 *   pixels: Array<{r: number, g: number, b: number, a: number}>,
 *   title: string,
 *   subtitle: string,
 *   author: string,
 *   crcValid: boolean,
 *   calculatedCrc: number,
 *   embeddedCrc: number
 * }}
 */
export function decodeBanner(bannerBytes) {
  // 1. Decode palette (32 bytes at offset 0x220) using hardware-accurate bit expansion
  const palette = rgb555ToPalette(bannerBytes.subarray(0x220, 0x240));

  // 2. Decode tile-encoded indices (512 bytes at offset 0x20)
  const indices = tileDecode(bannerBytes.subarray(0x20, 0x220));

  // 3. Map indices to pixels (RGBA)
  const pixels = [];
  for (let i = 0; i < 1024; i++) {
    const idx = indices[i];
    const color = palette[idx];
    if (idx === 0) {
      // Index 0 is hardware transparency
      pixels.push({ r: 0, g: 0, b: 0, a: 0 });
    } else {
      pixels.push({ r: color.r, g: color.g, b: color.b, a: 255 });
    }
  }

  // 4. Decode titles. Check English first (slot 1), then Japanese (slot 0), then others
  let titleString = "";
  const searchOrder = [1, 0, 2, 3, 4, 5];
  for (const langIdx of searchOrder) {
    const offset = 0x240 + langIdx * 256;
    if (offset + 256 <= bannerBytes.length) {
      const str = utf16LeToString(bannerBytes.subarray(offset, offset + 256));
      if (str) {
        titleString = str;
        break;
      }
    }
  }

  if (!titleString) {
    for (let langIdx = 6; langIdx < 16; langIdx++) {
      const offset = 0x240 + langIdx * 256;
      if (offset + 256 <= bannerBytes.length) {
        const str = utf16LeToString(bannerBytes.subarray(offset, offset + 256));
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

  // 5. Checksum verification
  const calculatedCrc = crc16(bannerBytes.subarray(0x20, 0x840));
  const embeddedCrc = bannerBytes[2] | (bannerBytes[3] << 8);
  const crcValid = (calculatedCrc === embeddedCrc);

  return { pixels, title, subtitle, author, crcValid, calculatedCrc, embeddedCrc };
}

/**
 * Generates a Banner Spec File (.bsf) in UTF-16LE format with BOM.
 * Compatible with SDK makebanner and devkitPro ndstool.
 *
 * @param {string} title
 * @param {string} subtitle
 * @param {string} author
 * @returns {Uint8Array} UTF-16LE bytes with BOM
 */
export function generateBsf(title = "", subtitle = "", author = "") {
  const lines = [
    "#BSF --- Banner Spec File",
    "#---------------------------------------------------------",
    "# This file must be written in charset UTF-16LE",
    "#---------------------------------------------------------",
    "",
    "Version:\t1",
    ""
  ];

  const tags = ['JP', 'EN', 'FR', 'GE', 'IT', 'SP'];
  const t = title.trim();
  const s = subtitle.trim();
  const a = author.trim();

  for (const tag of tags) {
    if (t || s || a) {
      lines.push(`${tag}:\t${t}`);
      if (s || a) lines.push(`\t${s}`);
      if (a) lines.push(`\t${a}`);
    } else {
      lines.push(`${tag}:\t`);
    }
    lines.push("");
  }

  const text = lines.join('\r\n');
  const textBytes = stringToUtf16Le(text);
  const out = new Uint8Array(2 + textBytes.length);
  out[0] = 0xFF; // BOM
  out[1] = 0xFE;
  out.set(textBytes, 2);
  return out;
}

/**
 * Parses a Banner Spec File (.bsf) in UTF-16LE or string format into Title, Subtitle, Author.
 *
 * @param {Uint8Array|string} content
 * @returns {{title: string, subtitle: string, author: string}}
 */
export function parseBsf(content) {
  let text = "";
  if (typeof content === 'string') {
    text = content;
  } else if (content instanceof Uint8Array || (content && content.buffer)) {
    const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
    } else if (bytes.length >= 2 && bytes[1] === 0x00) {
      text = new TextDecoder('utf-16le').decode(bytes);
    } else {
      text = new TextDecoder('utf-8').decode(bytes);
    }
  }

  const lines = text.split(/\r?\n/);
  let title = "";
  let subtitle = "";
  let author = "";

  const langOrder = ['en', 'jp', 'fr', 'ge', 'it', 'sp'];
  const dataByLang = {};

  let currentLang = null;
  let currentField = 0;

  for (let rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const langMatch = trimmed.match(/^([A-Za-z]{2})\s*:\s*(.*)$/);
    if (langMatch) {
      currentLang = langMatch[1].toLowerCase();
      currentField = 0;
      if (!dataByLang[currentLang]) dataByLang[currentLang] = [];
      const remainder = langMatch[2].trim().replace(/^"|"$/g, '');
      if (remainder) {
        dataByLang[currentLang].push(remainder);
        currentField = 1;
      }
      continue;
    }

    if (currentLang && currentField < 3) {
      const clean = trimmed.replace(/^"|"$/g, '');
      dataByLang[currentLang].push(clean);
      currentField++;
    }
  }

  // Find first populated language
  for (const l of langOrder) {
    if (dataByLang[l] && dataByLang[l].length > 0) {
      title = dataByLang[l][0] || "";
      subtitle = dataByLang[l][1] || "";
      author = dataByLang[l][2] || "";
      break;
    }
  }

  // Fallback if not in standard list
  if (!title) {
    for (const l of Object.keys(dataByLang)) {
      if (dataByLang[l] && dataByLang[l].length > 0) {
        title = dataByLang[l][0] || "";
        subtitle = dataByLang[l][1] || "";
        author = dataByLang[l][2] || "";
        break;
      }
    }
  }

  return { title, subtitle, author };
}
