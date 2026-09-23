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
