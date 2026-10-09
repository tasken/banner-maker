// DOM helpers shared by the Banner and Pico cover tabs.

// Longest side of the pixel copy an image is sampled from. Keeps the canvas
// under iOS Safari's 16,777,216 px limit (4096 x 4096). Neither output needs
// more: a 1/128-wide crop still covers a 32x32 icon's 32 pixels, and a
// 1/38-wide crop still covers a cover's 106.
export const MAX_SOURCE_SIDE = 4096;

export function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// Reads img's pixels once, downsized to MAX_SOURCE_SIDE on the longest side.
export function readImagePixels(img) {
  const scale = Math.min(1, MAX_SOURCE_SIDE / Math.max(img.width, img.height));
  const canvas = createCanvas(Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { rgba: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
}

function animatedImageType(file) {
  const declaredType = file.type.toLowerCase();
  const extensionType = /\.gif$/i.test(file.name) ? 'image/gif' : /\.webp$/i.test(file.name) ? 'image/webp' : '';
  return declaredType === 'image/gif' || declaredType === 'image/webp'
    ? declaredType
    : extensionType || declaredType;
}

// Number of frames in a GIF or WebP, or null when this browser can't tell
// (no ImageDecoder, as on plain-HTTP pages, or an unreadable file).
export async function countImageFrames(file) {
  const Decoder = globalThis.ImageDecoder;
  const type = animatedImageType(file);
  try {
    if (!Decoder || !type || !await Decoder.isTypeSupported(type)) return null;
    const decoder = new Decoder({ data: await file.arrayBuffer(), type });
    try {
      await decoder.tracks.ready;
      return decoder.tracks.selectedTrack?.frameCount ?? null;
    } finally {
      decoder.close();
    }
  } catch {
    return null;
  }
}

// Reads up to 64 evenly spaced frames of an animated GIF or WebP, with each
// frame's share of the playback time in 60 Hz ticks (unrounded, so short
// frames keep their exact time until the final sequence is built). Needs the browser's
// ImageDecoder, which Chrome only exposes on HTTPS or localhost pages.
export async function readAnimatedImageFrames(file, onProgress = () => {}) {
  const type = animatedImageType(file);
  const Decoder = globalThis.ImageDecoder;
  if (!Decoder || typeof Decoder.isTypeSupported !== 'function') {
    throw new Error(globalThis.isSecureContext === false
      ? 'Animated banners only work when this page is opened over HTTPS. Open the online version, or upload a still image.'
      : 'This browser cannot read animated images. Try the latest Chrome or Edge, or upload a still image.');
  }
  if (!type || !await Decoder.isTypeSupported(type)) {
    throw new Error('This browser cannot read animation frames from this file. Try an animated GIF or WebP in the latest Chrome or Edge.');
  }

  const decoder = new Decoder({ data: await file.arrayBuffer(), type });
  try {
    await decoder.tracks.ready;
    const frameCount = decoder.tracks.selectedTrack?.frameCount ?? 0;
    if (frameCount < 2) return [];
    if (frameCount > 512) {
      throw new RangeError('This animation has more than 512 frames. Shorten it and upload it again.');
    }

    const sampleCount = Math.min(64, frameCount);
    // Keeps all kept frames together under about 4 million pixels.
    const maxSide = Math.max(128, Math.min(512, Math.floor(Math.sqrt(4_194_304 / sampleCount))));
    const buckets = Array.from({ length: sampleCount }, () => ({ durationUs: 0, frame: null }));
    const sampleIndices = buckets.map((_, bucket) => {
      const start = Math.ceil(bucket * frameCount / sampleCount);
      const end = Math.ceil((bucket + 1) * frameCount / sampleCount);
      return Math.floor((start + end - 1) / 2);
    });

    for (let index = 0; index < frameCount; index++) {
      const { image } = await decoder.decode({ frameIndex: index });
      try {
        const bucketIndex = Math.min(sampleCount - 1, Math.floor(index * sampleCount / frameCount));
        const bucket = buckets[bucketIndex];
        bucket.durationUs += Number.isFinite(image.duration) && image.duration > 0 ? image.duration : 100_000;

        if (index === sampleIndices[bucketIndex]) {
          const sourceWidth = image.displayWidth || image.codedWidth;
          const sourceHeight = image.displayHeight || image.codedHeight;
          const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
          const width = Math.max(1, Math.round(sourceWidth * scale));
          const height = Math.max(1, Math.round(sourceHeight * scale));
          const canvas = createCanvas(width, height);
          const context = canvas.getContext('2d', { willReadFrequently: true });
          context.imageSmoothingQuality = 'high';
          context.drawImage(image, 0, 0, width, height);
          bucket.frame = { rgba: context.getImageData(0, 0, width, height).data, width, height };
        }
      } finally {
        image.close();
      }
      onProgress(index + 1, frameCount);
    }

    return buckets.map(({ durationUs, frame }, index) => {
      if (!frame) throw new Error(`Could not decode animation frame ${sampleIndices[index] + 1}`);
      return {
        ...frame,
        durationTicks: durationUs * 60 / 1_000_000
      };
    });
  } finally {
    decoder.close();
  }
}

export function saveFile(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Segmented controls: exactly one button is active.
export function setActiveButton(active, inactive) {
  active.classList.add('active');
  inactive.classList.remove('active');
}

// The empty-preview placeholder both tabs show: a 32x32 pixel-art cartridge
// drawn at (0, 0) of ctx.
export function drawCartridgePlaceholder(ctx) {
  // Draw a cute retro game cartridge outline
  ctx.fillStyle = '#475569'; // slate-600 (cartridge body)
  ctx.fillRect(4, 4, 24, 24);

  // Label sticker border
  ctx.fillStyle = '#1e293b'; // slate-800
  ctx.fillRect(6, 6, 20, 16);

  // D-Pad icon inside label (cyan accent)
  ctx.fillStyle = '#22d3ee';
  ctx.fillRect(9, 13, 5, 2);
  ctx.fillRect(10, 12, 3, 4);

  // Pixelated face buttons (red and yellow)
  ctx.fillStyle = '#ef4444'; // Red button
  ctx.fillRect(19, 13, 2, 2);
  ctx.fillStyle = '#eab308'; // Yellow button
  ctx.fillRect(17, 15, 2, 2);

  // Bottom cartridge pins
  ctx.fillStyle = '#0f172a'; // slate-900 (groove)
  ctx.fillRect(6, 22, 20, 2);
  ctx.fillStyle = '#94a3b8'; // silver pins
  for (let x = 8; x < 24; x += 4) {
    ctx.fillRect(x, 24, 2, 2);
  }
}
