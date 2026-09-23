import { COVER_SIZE, createImageSource, downscaleRegionRect, encodeCoverBmp, flattenOver, indicesToRgba, pickBackground, pixelsToRgba, quantizeImage } from './core.js?v=__COMMIT_HASH__';
import { createCanvas, drawCartridgePlaceholder, readImagePixels, saveFile, setActiveButton } from './dom.js?v=__COMMIT_HASH__';

// Pico cover tab: any image in, a 128 x 96 cover.bmp out. Its state is
// separate from the Banner tab.
const { width: COVER_W, height: COVER_H } = COVER_SIZE;
const COVER_ASPECT = COVER_W / COVER_H;
// Pico covers have no transparency (coverflow draws palette color 0 solid),
// so transparent areas and Fit padding take this color.
const BACKGROUNDS = { black: { r: 0, g: 0, b: 0 }, white: { r: 255, g: 255, b: 255 } };

const dropzone = document.getElementById('cover-dropzone');
const fileInput = document.getElementById('cover-file-input');
const dropzonePrompt = document.getElementById('cover-dropzone-prompt');
const dropzoneFilename = document.getElementById('cover-dropzone-filename');
const errorBox = document.getElementById('cover-error-box');
const errorMessage = document.getElementById('cover-error-message');
const cropControl = document.getElementById('cover-crop-control');
const cropperWrapper = document.getElementById('cover-cropper-wrapper');
const cropEditorImg = document.getElementById('cover-crop-editor-img');
const btnModeCrop = document.getElementById('cover-btn-mode-crop');
const btnModeFit = document.getElementById('cover-btn-mode-fit');
const btnModeFill = document.getElementById('cover-btn-mode-fill');
const paddingRow = document.getElementById('cover-padding-row');
const paddingButtons = [0, 5, 10, 15].map(px => [px, document.getElementById(`cover-btn-pad-${px}`)]);
const btnBgBlack = document.getElementById('cover-btn-bg-black');
const btnBgWhite = document.getElementById('cover-btn-bg-white');
const btnDitherOff = document.getElementById('cover-btn-dither-off');
const btnDitherOn = document.getElementById('cover-btn-dither-on');
const btnScale1x = document.getElementById('cover-btn-scale-1x');
const btnScale2x = document.getElementById('cover-btn-scale-2x');
const preview = document.getElementById('cover-preview');
const previewCanvas = document.getElementById('cover-preview-canvas');
const previewHelp = document.getElementById('cover-preview-help');
const resetBtn = document.getElementById('cover-reset-btn');
const downloadBtn = document.getElementById('cover-download-btn');

const previewCtx = previewCanvas.getContext('2d');
previewCtx.imageSmoothingEnabled = false;

let loadedImage = null;
let imageSource = null; // createImageSource() pyramid of loadedImage's pixels
let imageSourceScale = 1; // imageSource pixels per loadedImage pixel
let cropperInstance = null;
let layoutMode = 'crop'; // 'crop', 'fit' or 'fill'
let layoutChosen = false; // once the user picks Crop or Fit, new images keep it
let dither = true;
let padding = 0; // Fit mode margin in cover pixels, on every side
let background = 'black'; // key of BACKGROUNDS
let backgroundChosen = false; // until the user picks one, each upload picks it (pickBackground)
let processFrame = 0;
let fullPassTimer = 0;
let loadToken = 0; // bumped per upload; stale loads check it and bail
let currentCover = null; // quantizeImage() result
let downloadConfirmTimeout = null;

fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    fileInput.click();
  }
});
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  handleFile(e.dataTransfer.files[0]);
});

btnModeCrop.addEventListener('click', () => {
  layoutChosen = true;
  if (layoutMode === 'crop') return;
  setLayoutMode('crop');
  initCropper();
});
[[btnModeFit, 'fit'], [btnModeFill, 'fill']].forEach(([button, mode]) => {
  button.addEventListener('click', () => {
    layoutChosen = true;
    if (layoutMode === mode) return;
    setLayoutMode(mode);
    destroyCropper();
    processCover();
  });
});
paddingButtons.forEach(([px, button]) => {
  button.addEventListener('click', () => {
    if (padding === px) return;
    setPadding(px);
    processCover();
  });
});
[[btnBgBlack, 'black'], [btnBgWhite, 'white']].forEach(([button, value]) => {
  button.addEventListener('click', () => {
    backgroundChosen = true;
    if (background === value) return;
    setBackground(value);
    processCover();
  });
});
[[btnDitherOff, false], [btnDitherOn, true]].forEach(([button, value]) => {
  button.addEventListener('click', () => {
    if (dither === value) return;
    setDither(value);
    processCover();
  });
});
btnScale1x.addEventListener('click', () => setPreviewScale2x(false));
btnScale2x.addEventListener('click', () => setPreviewScale2x(true));
resetBtn.addEventListener('click', resetCover);
downloadBtn.addEventListener('click', triggerDownload);

function setLayoutMode(mode) {
  layoutMode = mode;
  [[btnModeCrop, 'crop'], [btnModeFit, 'fit'], [btnModeFill, 'fill']].forEach(([button, m]) => button.classList.toggle('active', m === mode));
  cropperWrapper.classList.toggle('hidden', mode !== 'crop');
  paddingRow.classList.toggle('hidden', mode !== 'fit');
}

function setPadding(px) {
  padding = px;
  paddingButtons.forEach(([value, button]) => button.classList.toggle('active', value === px));
}

function setBackground(value) {
  background = value;
  const black = value === 'black';
  setActiveButton(black ? btnBgBlack : btnBgWhite, black ? btnBgWhite : btnBgBlack);
}

function setDither(enabled) {
  dither = enabled;
  setActiveButton(enabled ? btnDitherOn : btnDitherOff, enabled ? btnDitherOff : btnDitherOn);
}

function setPreviewScale2x(enabled) {
  preview.classList.toggle('scale-2x', enabled);
  setActiveButton(enabled ? btnScale2x : btnScale1x, enabled ? btnScale1x : btnScale2x);
}

function showError(msg) {
  errorMessage.innerHTML = msg; // trusted markup only, never file names
  errorBox.classList.remove('hidden');
}

function clearError() {
  errorMessage.textContent = '';
  errorBox.classList.add('hidden');
}

function initCropper() {
  destroyCropper();
  if (!loadedImage) return;

  cropperInstance = new Cropper(cropEditorImg, {
    aspectRatio: COVER_ASPECT,
    viewMode: 1,
    dragMode: 'move',
    autoCropArea: 0.9,
    background: false,
    responsive: true,
    zoomable: true,
    ready() {
      // Same as the Banner tab: never upscale small images on open.
      const imageData = cropperInstance.getImageData();
      if (imageData.width > imageData.naturalWidth) {
        cropperInstance.zoomTo(1);
      }
      processCover();
    },
    crop() {
      // A full 256-color pass can take over 100 ms on busy images, too slow
      // for every pointer move. Dragging shows the plain resize; the full
      // pass runs when the drag ends or the box sits still for a moment
      // (wheel, pinch and keyboard zoom never fire cropend).
      schedulePreviewOnly();
      scheduleFullPass();
    },
    cropend() {
      runFullPassNow();
    }
  });
}

function destroyCropper() {
  if (cropperInstance) {
    cropperInstance.destroy();
    cropperInstance = null;
  }
}

function handleFile(file) {
  clearError();
  if (!file) return;
  const token = ++loadToken;

  if (file.name.toLowerCase().endsWith('.bin')) {
    showError('<code>banner.bin</code> files go in the Banner tab. Upload an image here.');
    return;
  }

  const reader = new FileReader();
  reader.onload = (event) => {
    if (token !== loadToken) return;
    const img = new Image();
    img.onload = () => {
      // A newer upload started while this one loaded: keep the newer one.
      if (token !== loadToken) return;
      const { rgba, width, height } = readImagePixels(img);
      loadedImage = img;
      imageSource = createImageSource(rgba, width, height);
      imageSourceScale = width / img.width;
      if (!backgroundChosen) setBackground(pickBackground(rgba, width, height));

      dropzonePrompt.classList.add('hidden');
      dropzoneFilename.textContent = `✓ ${file.name}`;
      dropzoneFilename.classList.remove('hidden');
      cropControl.classList.remove('hidden');

      // Keep the user's Crop/Fit choice; until they make one, an image
      // already shaped like a cover fits as-is and anything else is cropped.
      const shapedLikeCover = Math.abs(img.width / img.height - COVER_ASPECT) < 0.01;
      if (!layoutChosen) setLayoutMode(shapedLikeCover ? 'fit' : 'crop');
      destroyCropper();
      cropEditorImg.src = event.target.result;
      if (layoutMode !== 'crop') {
        processCover();
      } else {
        initCropper();
      }
    };
    img.onerror = () => {
      if (token !== loadToken) return;
      unloadImage();
      showError("This file isn't an image we can open. Upload a PNG, JPG or WebP.");
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

function schedulePreviewOnly() {
  if (processFrame) return;
  processFrame = requestAnimationFrame(() => {
    processFrame = 0;
    const region = cropRegion();
    if (!region || !imageSource) return;
    previewCtx.putImageData(new ImageData(pixelsToRgba(coverPixels(region)), COVER_W, COVER_H), 0, 0);
  });
}

function scheduleFullPass() {
  clearTimeout(fullPassTimer);
  fullPassTimer = setTimeout(runFullPassNow, 200);
}

function runFullPassNow() {
  clearTimeout(fullPassTimer);
  fullPassTimer = 0;
  processCover();
}

// The area of loadedImage that becomes the cover, in image pixels.
function cropRegion() {
  if (!cropperInstance) return null;
  const data = cropperInstance.getData(true);
  return data.width > 0 && data.height > 0 ? { x: data.x, y: data.y, w: data.width, h: data.height } : null;
}

// Fill mode takes the largest centered 106:96 area; the edges that stick out are cut.
function fillRegion() {
  const { width, height } = loadedImage;
  const w = Math.min(width, height * COVER_ASPECT);
  const h = w / COVER_ASPECT;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

// Fit mode centers the whole image inside the cover, less `padding` pixels on
// every side; everything around it is the background.
function fitRegion() {
  const { width, height } = loadedImage;
  const scale = Math.min((COVER_W - 2 * padding) / width, (COVER_H - 2 * padding) / height); // cover px per image px
  const w = COVER_W / scale;
  const h = COVER_H / scale;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

// The region resized to 106 x 96 and flattened over the background. A region with
// fewer source pixels than the cover (small pixel art) is enlarged by nearest
// pixel, so no in-between colors are invented.
function coverPixels(region) {
  const s = imageSourceScale;
  const nearest = region.w * s < COVER_W || region.h * s < COVER_H;
  return flattenOver(downscaleRegionRect(imageSource, region.x * s, region.y * s, region.w * s, region.h * s, COVER_W, COVER_H, { nearest }), BACKGROUNDS[background]);
}

function processCover() {
  // The full pass supersedes any plain-resize frame still queued, which
  // would otherwise paint over the 256-color preview.
  cancelAnimationFrame(processFrame);
  processFrame = 0;
  if (!loadedImage || !imageSource) return;
  const region = layoutMode === 'crop' ? cropRegion() : layoutMode === 'fill' ? fillRegion() : fitRegion();
  if (!region) return;

  currentCover = quantizeImage(coverPixels(region), COVER_W, COVER_H, { colors: 256, transparent: false, dither });
  const rgba = indicesToRgba(currentCover.palette, currentCover.indices, { transparent: false });
  previewCtx.putImageData(new ImageData(rgba, COVER_W, COVER_H), 0, 0);
  previewHelp.textContent = 'This is the part Pico Launcher shows, reduced to 256\u00a0colors.';
  downloadBtn.disabled = false;
}

function unloadImage() {
  clearTimeout(fullPassTimer);
  fullPassTimer = 0;
  loadedImage = null;
  imageSource = null;
  currentCover = null;
  downloadBtn.disabled = true;
  destroyCropper();
  cropEditorImg.src = '';
  cropControl.classList.add('hidden');
  dropzonePrompt.classList.remove('hidden');
  dropzoneFilename.classList.add('hidden');
  dropzoneFilename.textContent = '';
  drawPreviewPlaceholder();
  previewHelp.textContent = 'Upload an image to see your cover\u00a0here.';
}

// Same cartridge as the Banner tab's empty preview, 3x (96 px tall), centered.
function drawPreviewPlaceholder() {
  const icon = createCanvas(32, 32);
  drawCartridgePlaceholder(icon.getContext('2d'));
  previewCtx.clearRect(0, 0, COVER_W, COVER_H);
  previewCtx.drawImage(icon, (COVER_W - 96) / 2, 0, 96, 96);
}

export function resetCover() {
  fileInput.value = '';
  unloadImage();
  clearError();
  setLayoutMode('crop');
  layoutChosen = false;
  setBackground('black');
  backgroundChosen = false;
  setPadding(0);
  setDither(true);
  setPreviewScale2x(false);
}

function triggerDownload() {
  // Never save a cover that lags behind the crop box.
  if (fullPassTimer) runFullPassNow();
  if (!currentCover) return;
  saveFile(encodeCoverBmp(currentCover.palette, currentCover.indices), 'cover.bmp');

  // Same brief confirmation as the Banner tab's download button.
  clearTimeout(downloadConfirmTimeout);
  const originalLabel = downloadBtn.dataset.originalLabel || downloadBtn.textContent;
  downloadBtn.dataset.originalLabel = originalLabel;
  downloadBtn.textContent = 'Downloaded ✓';
  downloadBtn.classList.add('success');
  downloadConfirmTimeout = setTimeout(() => {
    downloadBtn.textContent = originalLabel;
    downloadBtn.classList.remove('success');
  }, 1800);
}

drawPreviewPlaceholder();
