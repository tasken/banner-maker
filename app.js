import { packBannerIcon, quantize, createImageSource, downscaleRegion, decodeBanner, decodeIndexedIcon, getBannerFormat, indicesToRgba, pixelsToRgba } from './core.js?v=__COMMIT_HASH__';
import { createCanvas, drawCartridgePlaceholder, readImagePixels, saveFile, setActiveButton } from './dom.js?v=__COMMIT_HASH__';
import { resetCover } from './cover.js?v=__COMMIT_HASH__';

// DOM elements
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const errorBox = document.getElementById('error-box');
const errorMessage = document.getElementById('error-message');
const dropzonePrompt = document.getElementById('dropzone-prompt');
const dropzoneFilename = document.getElementById('dropzone-filename');
const inputTitle = document.getElementById('input-title');
const inputSubtitle = document.getElementById('input-subtitle');
const inputAuthor = document.getElementById('input-author');
const previewCanvas = document.getElementById('preview-canvas');
const resizeCanvas = document.getElementById('resize-canvas');
const downloadBtn = document.getElementById('download-btn');
const resetBtn = document.getElementById('reset-btn');

// Crop & Layout mode elements
const cropPreviewCanvas = document.getElementById('crop-preview-canvas');
const dropzonePreviewWrapper = document.getElementById('dropzone-preview-wrapper');
const cropControl = document.getElementById('crop-control');
const cropperWrapper = document.getElementById('cropper-wrapper');
const cropEditorImg = document.getElementById('crop-editor-img');
const btnModeCrop = document.getElementById('btn-mode-crop');
const btnModeFit = document.getElementById('btn-mode-fit');
const btnModeFill = document.getElementById('btn-mode-fill');
const btnPixelArtOff = document.getElementById('btn-pixelart-off');
const btnPixelArtOn = document.getElementById('btn-pixelart-on');
const transparencyInfo = document.getElementById('transparency-info');
const binLoadedInfo = document.getElementById('bin-loaded-info');
const binPreviewSlot = document.getElementById('bin-preview-slot');
const binLoadedText = document.getElementById('bin-loaded-text');
const btnRemoveBin = document.getElementById('btn-remove-bin');
const paletteNote = document.getElementById('palette-note');

// Mockup elements
const mockTitle = document.getElementById('mock-title');
const mockSubtitle = document.getElementById('mock-subtitle');
const mockAuthor = document.getElementById('mock-author');
const dsIconSlot = document.querySelector('.ds-icon-slot');
const btnScale1x = document.getElementById('btn-scale-1x');
const btnScale2x = document.getElementById('btn-scale-2x');

// Theme selectors
const btnThemeLight = document.getElementById('btn-theme-light');
const btnThemeSystem = document.getElementById('btn-theme-system');
const btnThemeDark = document.getElementById('btn-theme-dark');

function applyTheme(theme) {
  btnThemeLight.classList.toggle('active', theme === 'light');
  btnThemeSystem.classList.toggle('active', theme === 'system');
  btnThemeDark.classList.toggle('active', theme === 'dark');

  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
    localStorage.removeItem('theme-preference');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme-preference', theme);
  }
}

// Initialize theme
const savedTheme = localStorage.getItem('theme-preference') || 'system';
applyTheme(savedTheme);

btnThemeLight.addEventListener('click', () => applyTheme('light'));
btnThemeSystem.addEventListener('click', () => applyTheme('system'));
btnThemeDark.addEventListener('click', () => applyTheme('dark'));

// Tool tabs (ARIA tabs pattern). The active tab lives in the URL hash so a
// link can open the cover tool directly. Leaving a tab resets it, so each
// visit starts fresh (and no Cropper ever sits in a hidden panel).
const tabs = [
  { tab: document.getElementById('tab-banner'), panel: document.getElementById('panel-banner'), hash: '', reset: () => resetAll() },
  { tab: document.getElementById('tab-cover'), panel: document.getElementById('panel-cover'), hash: '#cover', reset: () => resetCover() }
];
let currentTab = -1;

function selectTab(index, { focus = false } = {}) {
  if (currentTab !== -1 && currentTab !== index) tabs[currentTab].reset();
  currentTab = index;
  tabs.forEach(({ tab, panel }, i) => {
    const selected = i === index;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    panel.classList.toggle('hidden', !selected);
  });
  if (focus) tabs[index].tab.focus();
  const { hash } = tabs[index];
  if (location.hash !== hash) {
    history.replaceState(null, '', hash || location.pathname + location.search);
  }
}

tabs.forEach(({ tab }, i) => tab.addEventListener('click', () => selectTab(i)));
tabs[0].tab.parentElement.addEventListener('keydown', (e) => {
  const current = tabs.findIndex(({ tab }) => tab === document.activeElement);
  if (current === -1) return;
  const next = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  selectTab((next + tabs.length) % tabs.length, { focus: true });
});
window.addEventListener('hashchange', () => selectTab(location.hash === '#cover' ? 1 : 0));
selectTab(location.hash === '#cover' ? 1 : 0);

// Both previews scale 32x32 pixel art up, so keep pixels crisp. The canvases
// are never resized, so this setting sticks.
const resizeCtx = resizeCanvas.getContext('2d');
const previewCtx = previewCanvas.getContext('2d');
const cropPreviewCtx = cropPreviewCanvas.getContext('2d');
previewCtx.imageSmoothingEnabled = false;
cropPreviewCtx.imageSmoothingEnabled = false;
const CROP_PREVIEW_SIZE = 96;

// State
let loadedImage = null;
let imageSource = null; // createImageSource() pyramid of loadedImage's pixels
let imageSourceScale = 1; // imageSource pixels per loadedImage pixel
let processImageFrame = 0;
let currentPixels = null; // 1024 RGBA objects
let indexedIcon = null; // decodeIndexedIcon() result when the upload is already a DS icon
let cropperInstance = null;
let layoutMode = 'crop'; // 'crop', 'fit' or 'fill'
let layoutChosen = false; // once the user picks Crop or Fit, new images keep it
let pixelArtEnhance = false;
let downloadConfirmTimeout = null;

// Setup Event Listeners
fileInput.addEventListener('change', handleFileSelect);

// Focus navigation accessibility for Dropzone
dropzone.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    fileInput.click();
  }
});
dropzone.addEventListener('click', () => {
  fileInput.click();
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    fileInput.files = files;
    handleFileSelect();
  }
});

// Update preview live when text changes
[inputTitle, inputSubtitle, inputAuthor].forEach(input => {
  input.addEventListener('input', () => {
    updateMockupText();
    if (loadedImage) {
      updateBannerData();
    }
  });
});

downloadBtn.addEventListener('click', triggerDownload);
resetBtn.addEventListener('click', resetAll);

// Lets the user discard the imported banner.bin (icon + text) entirely and
// go back to a blank slate, rather than being forced to pick a replacement.
btnRemoveBin.addEventListener('click', resetAll);

btnScale1x.addEventListener('click', () => setPreviewScale2x(false));
btnScale2x.addEventListener('click', () => setPreviewScale2x(true));

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
    processImage();
  });
});

[[btnPixelArtOff, false], [btnPixelArtOn, true]].forEach(([button, enhance]) => {
  button.addEventListener('click', () => {
    if (pixelArtEnhance === enhance) return;
    setPixelArtEnhance(enhance);
    if (loadedImage) updateBannerData();
  });
});

function setPreviewScale2x(enabled) {
  dsIconSlot.classList.toggle('scale-2x', enabled);
  setActiveButton(enabled ? btnScale2x : btnScale1x, enabled ? btnScale1x : btnScale2x);
}

function setLayoutMode(mode) {
  layoutMode = mode;
  [[btnModeCrop, 'crop'], [btnModeFit, 'fit'], [btnModeFill, 'fill']].forEach(([button, m]) => button.classList.toggle('active', m === mode));
  cropperWrapper.classList.toggle('hidden', mode !== 'crop');
}

function setPixelArtEnhance(enabled) {
  pixelArtEnhance = enabled;
  setActiveButton(enabled ? btnPixelArtOn : btnPixelArtOff, enabled ? btnPixelArtOff : btnPixelArtOn);
}

function initCropper() {
  destroyCropper();
  if (!loadedImage) return;

  cropperInstance = new Cropper(cropEditorImg, {
    aspectRatio: 1,
    viewMode: 1,
    dragMode: 'move',
    autoCropArea: 0.9,
    background: false,
    responsive: true,
    zoomable: true,
    ready() {
      // Cropper.js scales small images up to fill the viewport by default,
      // which blurs pixel-art icons. Cap the initial zoom at 100% (1 image
      // pixel = 1 CSS pixel) so nothing gets upscaled; larger images keep
      // their normal fit-to-container sizing. Users can still zoom in/out
      // freely with the mouse wheel or pinch either way.
      const imageData = cropperInstance.getImageData();
      if (imageData.width > imageData.naturalWidth) {
        cropperInstance.zoomTo(1);
      }
      processImage();
    },
    crop() {
      // Cropper fires this on every pointer move; sample at most once per frame.
      scheduleProcessImage();
    }
  });
}

function destroyCropper() {
  if (cropperInstance) {
    cropperInstance.destroy();
    cropperInstance = null;
  }
}

// Escapes a string for safe interpolation into innerHTML.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// msg is trusted markup (may contain <code> around exact filenames/values);
// any interpolated user-provided text must be passed through escapeHtml() first.
function showError(msg) {
  errorMessage.innerHTML = msg;
  errorBox.classList.remove('hidden');
}

function clearError() {
  errorMessage.textContent = '';
  errorBox.classList.add('hidden');
}

function formatHex(value) {
  return `0x${value.toString(16).toUpperCase().padStart(4, '0')}`;
}

function formatCount(value) {
  return value.toLocaleString('en-US');
}

// The DSi menu hides a banner (no icon, no title) when any CRC fails.
function crcBadgeHtml(crcChecks) {
  const failed = crcChecks.filter(c => !c.valid);
  if (failed.length === 0) {
    const values = crcChecks.map(c => `${c.name} ${formatHex(c.calculated)}`).join(', ');
    return `<span class="crc-badge valid" title="All checksums match (${values})">CRC OK</span>`;
  }
  const details = failed.map(c => `${c.name}: stored ${formatHex(c.embedded)}, expected ${formatHex(c.calculated)}`).join('; ');
  return `<span class="crc-badge warning" title="${details}. The DSi menu hides banners with a wrong checksum. Downloading writes a correct one.">CRC mismatch (fixed when you download)</span>`;
}

// Downloads are always static NTR v1 banners, so name what won't carry over.
function exportLossHtml(lostOnExport) {
  const lost = [];
  if (lostOnExport.translations) lost.push('the separate title for each language (one title is used for all)');
  if (lostOnExport.chineseKorean) lost.push('the Chinese and Korean titles');
  if (lostOnExport.animation) lost.push('the icon animation');
  if (lost.length === 0) return '';
  const list = lost.length === 1 ? lost[0] : `${lost.slice(0, -1).join(', ')} and ${lost[lost.length - 1]}`;
  return `<br>Downloads as a static NTR v1 banner, the kind flashcarts have room for, so ${list} won't be kept.`;
}

function hasTransparentPixel(rgba) {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 255) return true;
  }
  return false;
}

// Makes img the icon source for crop/fit. rgba is its pixel copy
// (width x height, possibly smaller than img); src loads the Cropper editor.
// icon is set when the upload is already a DS icon (see decodeIndexedIcon).
function setLoadedImage(img, src, rgba, width, height, icon = null) {
  loadedImage = img;
  indexedIcon = icon;
  imageSource = createImageSource(rgba, width, height);
  imageSourceScale = width / img.width;
  transparencyInfo.classList.toggle('hidden', !hasTransparentPixel(rgba));

  destroyCropper();
  cropControl.classList.remove('hidden');
  cropEditorImg.src = src;
}

function unloadImage() {
  loadedImage = null;
  indexedIcon = null;
  paletteNote.classList.add('hidden');
  imageSource = null;
  currentPixels = null;
  downloadBtn.disabled = true;
  clearCanvas();
  resetDropzonePrompt();
}

function handleFileSelect() {
  clearError();
  const file = fileInput.files[0];
  if (!file) return;

  if (file.name.toLowerCase().endsWith('.bin')) {
    handleBinSelect(file);
    return;
  }

  // Read and load image
  const reader = new FileReader();
  reader.onload = async function(event) {
    const icon = file.type === 'image/png' ? await decodeIndexedIcon(new Uint8Array(await file.arrayBuffer())) : null;
    const img = new Image();
    img.onload = function() {
      const { rgba, width, height } = readImagePixels(img);
      setLoadedImage(img, event.target.result, rgba, width, height, icon);

      // Keep the user's Crop/Fit choice; until they make one, a square image
      // fits as-is and anything else starts in crop mode.
      if (!layoutChosen) setLayoutMode(img.width === img.height ? 'fit' : 'crop');

      // Show file selection success state. The preview canvas may currently
      // be sitting inside the "banner loaded" card from a previous .bin
      // import, so make sure it's back in its home slot in the dropzone.
      dropzonePreviewWrapper.insertBefore(cropPreviewCanvas, dropzoneFilename);
      dropzonePrompt.classList.add('hidden');
      cropPreviewCanvas.classList.remove('hidden');
      dropzoneFilename.textContent = `✓ ${file.name}`;
      dropzoneFilename.classList.remove('hidden');

      // A plain image was uploaded, so any previous "editing existing
      // banner.bin" indicator no longer applies.
      binLoadedInfo.classList.add('hidden');
      binLoadedText.textContent = '';

      initCropper();
    };
    img.onerror = function() {
      showError("This image couldn't be opened. Try a PNG, JPG or WebP file.");
      unloadImage();
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

function handleBinSelect(file) {
  const reader = new FileReader();
  reader.onload = function(event) {
    try {
      const bytes = new Uint8Array(event.target.result);

      const format = getBannerFormat(bytes);
      if (!format) {
        const version = bytes.length >= 2 ? bytes[0] | (bytes[1] << 8) : 0;
        showError(`This file isn't a DS banner. Its version is <code>${formatHex(version)}</code>, but DS/DSi banners use <code>0x0001</code>, <code>0x0002</code>, <code>0x0003</code> or <code>0x0103</code>. Upload the <code>banner.bin</code> from a DS or DSi project.`);
        return;
      }
      if (bytes.length < format.size) {
        showError(`This <code>banner.bin</code> is incomplete. ${format.name} banners are <code>${formatCount(format.size)} bytes</code>, but this file has <code>${formatCount(bytes.length)}</code>. Export it again from its source, or upload a different file.`);
        return;
      }

      const parsed = decodeBanner(bytes);
      inputTitle.value = parsed.title;
      inputSubtitle.value = parsed.subtitle;
      inputAuthor.value = parsed.author;
      updateMockupText();

      // Turn the decoded icon into an image the editor can load
      const rgba = pixelsToRgba(parsed.pixels);
      const iconCanvas = createCanvas(32, 32);
      iconCanvas.getContext('2d').putImageData(new ImageData(rgba, 32, 32), 0, 0);
      const dataURL = iconCanvas.toDataURL('image/png');

      const img = new Image();
      img.onload = function() {
        setLoadedImage(img, dataURL, rgba, 32, 32);

        // Already a 32x32 square, so fit it as-is
        setLayoutMode('fit');

        // Keep the dropzone itself in its default, empty prompt state so
        // it's obvious the user can still click/drop a different image or
        // .bin there. The live preview instead moves into the "banner
        // loaded" card below, along with a Remove action, since only .bin
        // uploads show this indicator (plain image uploads never do).
        dropzonePrompt.classList.remove('hidden');
        dropzoneFilename.classList.add('hidden');
        dropzoneFilename.textContent = '';

        binPreviewSlot.appendChild(cropPreviewCanvas);
        cropPreviewCanvas.classList.remove('hidden');

        binLoadedText.innerHTML = `Editing existing <code>banner.bin</code> (${parsed.format.name}): icon, title & text imported from "${escapeHtml(file.name)}" ${crcBadgeHtml(parsed.crcChecks)}.${exportLossHtml(parsed.lostOnExport)}`;
        binLoadedInfo.classList.remove('hidden');

        // Populate currentPixels and the preview
        processImage();
      };

      img.onerror = function() {
        showError("The banner's icon couldn't be loaded. Try the file again, or upload a different <code>banner.bin</code>.");
      };

      img.src = dataURL;

    } catch (err) {
      console.error(err);
      showError("This <code>banner.bin</code> couldn't be read. It may be damaged. Upload a different file.");
    }
  };
  reader.readAsArrayBuffer(file);
}

function clearCanvas() {
  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
}

function updateMockupText() {
  const t = inputTitle.value.trim();
  const s = inputSubtitle.value.trim();
  const a = inputAuthor.value.trim();

  const hasAny = Boolean(t || s || a);

  // packBanner() omits empty subtitle/author lines entirely rather than
  // encoding a blank line (core.js), so mirror that here: only render
  // populated lines and let them re-center in the flex column, matching
  // how the real DS/DSi system menu displays the title block.
  mockTitle.textContent = t || (hasAny ? "" : "Untitled game");
  mockSubtitle.textContent = s;
  mockAuthor.textContent = a;

  mockTitle.classList.toggle('hidden', !t && hasAny);
  mockTitle.classList.toggle('mock-placeholder', !t && !hasAny);
  mockSubtitle.classList.toggle('hidden', !s);
  mockAuthor.classList.toggle('hidden', !a);
}

function scheduleProcessImage() {
  if (processImageFrame) return;
  processImageFrame = requestAnimationFrame(() => {
    processImageFrame = 0;
    processImage();
  });
}

// The square area of loadedImage that becomes the icon, in image pixels.
function cropRegion() {
  if (!cropperInstance) return null;
  const data = cropperInstance.getData(true);
  // aspectRatio is 1, but rounding can leave width and height 1px apart.
  const size = Math.min(data.width, data.height);
  return size > 0 ? { x: data.x, y: data.y, size } : null;
}

// Fill mode takes the largest centered square; the edges that stick out are cut.
function fillRegion() {
  const { width, height } = loadedImage;
  const size = Math.min(width, height);
  return { x: Math.floor((width - size) / 2), y: Math.floor((height - size) / 2), size };
}

// Fit mode centers the whole image in a square; the padding is transparent.
function fitRegion() {
  const { width, height } = loadedImage;
  const size = Math.max(width, height);
  return { x: -Math.floor((size - width) / 2), y: -Math.floor((size - height) / 2), size };
}

function processImage() {
  if (!loadedImage || !imageSource) return;

  const region = layoutMode === 'crop' ? cropRegion() : layoutMode === 'fill' ? fillRegion() : fitRegion();
  if (!region) return;

  // High-res preview of the region (96x96)
  const previewScale = CROP_PREVIEW_SIZE / region.size;
  cropPreviewCtx.clearRect(0, 0, CROP_PREVIEW_SIZE, CROP_PREVIEW_SIZE);
  cropPreviewCtx.drawImage(loadedImage, -region.x * previewScale, -region.y * previewScale, loadedImage.width * previewScale, loadedImage.height * previewScale);

  // Area-average the region down to 32x32
  currentPixels = downscaleRegion(imageSource, region.x * imageSourceScale, region.y * imageSourceScale, region.size * imageSourceScale);

  updateBannerData();
}

// A ready-made DS icon keeps its own palette, but only when used whole and
// unenhanced; cropping or pixel enhance needs a new palette.
function usesIndexedIcon() {
  // Such icons are always 32x32 squares, so Fit and Fill both use all of it.
  return Boolean(indexedIcon) && layoutMode !== 'crop' && !pixelArtEnhance;
}

function currentIcon() {
  return usesIndexedIcon() ? indexedIcon : quantize(currentPixels, 15, pixelArtEnhance);
}

function updateBannerData() {
  if (!currentPixels) return;

  const { palette, indices } = currentIcon();
  renderPreview(palette, indices);
  paletteNote.classList.toggle('hidden', !usesIndexedIcon());
  downloadBtn.disabled = false;
}

function renderPreview(palette, indices) {
  resizeCtx.putImageData(new ImageData(indicesToRgba(palette, indices), 32, 32), 0, 0);
  showIconPreview();
}

// Scales the 32x32 icon on resizeCanvas up onto the console mockup.
function showIconPreview() {
  clearCanvas();
  previewCtx.drawImage(resizeCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
}

function triggerDownload() {
  if (!currentPixels) return;

  saveFile(packBannerIcon(currentIcon(), inputTitle.value, inputSubtitle.value, inputAuthor.value), 'banner.bin');

  // Browsers don't reliably surface a visible signal that a download
  // succeeded, and this button is a documented step in external guides
  // (e.g. flashcart-guides' banner tutorial), so give a brief on-page
  // confirmation before reverting back to the normal label.
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

function resetAll() {
  fileInput.value = '';
  inputTitle.value = '';
  inputSubtitle.value = '';
  inputAuthor.value = '';
  unloadImage();
  updateMockupText();
  clearError();
  drawPlaceholderIcon();
  setPreviewScale2x(false);
  setPixelArtEnhance(false);
  layoutChosen = false;
}

function resetDropzonePrompt() {
  dropzonePrompt.classList.remove('hidden');
  // Return the preview canvas to its home slot in the dropzone, in case a
  // .bin import had moved it into the "banner loaded" card.
  dropzonePreviewWrapper.insertBefore(cropPreviewCanvas, dropzoneFilename);
  cropPreviewCanvas.classList.add('hidden');
  cropControl.classList.add('hidden');
  dropzoneFilename.classList.add('hidden');
  dropzoneFilename.textContent = '';

  transparencyInfo.classList.add('hidden');

  // Hide "editing existing banner.bin" indicator
  binLoadedInfo.classList.add('hidden');
  binLoadedText.textContent = '';

  cropPreviewCtx.clearRect(0, 0, CROP_PREVIEW_SIZE, CROP_PREVIEW_SIZE);

  // Destroy Cropper.js instance and clear image src
  destroyCropper();
  cropEditorImg.src = '';
}

function drawPlaceholderIcon() {
  resizeCtx.clearRect(0, 0, 32, 32);
  drawCartridgePlaceholder(resizeCtx);
  showIconPreview();
}

// Initial triggers
updateMockupText();
drawPlaceholderIcon();
