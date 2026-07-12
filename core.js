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

/**
 * Median-cut color quantization.
 * Maps low-alpha pixels to palette index 0 (transparent).
 * Quantizes remaining opaque pixels to at most 15 colors.
 * Refines by mapping pixels to the nearest palette color.
 *
 * @param {Array<{r: number, g: number, b: number, a: number}>} pixels - 1024 pixels
 * @returns {{palette: Array<{r: number, g: number, b: number}>, indices: Uint8Array}}
 */
export function quantize(pixels, maxColors = 15) {
  const indices = new Uint8Array(1024); // Defaults to 0 (transparent)
  const opaquePixels = [];

  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    if (p.a >= 128) {
      opaquePixels.push({
        r: p.r,
        g: p.g,
        b: p.b,
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

  // Median cut
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

  // Refine pixel mapping: Map each opaque pixel to the nearest palette color (indices 1..15)
  for (const p of opaquePixels) {
    let minDistance = Infinity;
    let nearestIndex = 1;
    for (let j = 1; j < 16; j++) {
      const color = palette[j];
      const dr = p.r - color.r;
      const dg = p.g - color.g;
      const db = p.b - color.b;
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
 * @returns {Uint8Array} The packed banner.bin data
 */
export function packBanner(pixels, title, subtitle, author) {
  const banner = new Uint8Array(2112); // Exactly 0x840 bytes

  // 1. Version 0x0001 (NTR v1 banner)
  banner[0] = 0x01;
  banner[1] = 0x00;

  // 2. Quantize and pack icon
  const { palette, indices } = quantize(pixels, 15);
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
