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
