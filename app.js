import { fitAnimationSteps, packAnimatedBanner, packBannerIcon, planAnimation, quantize, createImageSource, downscaleRegion, downscaleRegionRect, decodeBanner, decodeIndexedIcon, getBannerFormat, indicesToRgba, pixelsToRgba } from './core.js?v=__COMMIT_HASH__';
import { countImageFrames, createCanvas, drawCartridgePlaceholder, readAnimatedImageFrames, readImagePixels, saveFile, setActiveButton } from './dom.js?v=__COMMIT_HASH__';
import { coverLauncherFromHash, resetCover, selectLauncher } from './cover.js?v=__COMMIT_HASH__';

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
const bannerFormatGroup = document.getElementById('banner-format-group');
const btnFormatStatic = document.getElementById('btn-format-static');
const btnFormatAnimated = document.getElementById('btn-format-animated');
const animationSpeedGroup = document.getElementById('animation-speed-group');
const speedButtons = [...animationSpeedGroup.querySelectorAll('[data-speed]')];
const animationStatus = document.getElementById('animation-status');

// Crop & Layout mode elements
const cropPreviewCanvas = document.getElementById('crop-preview-canvas');
const cropPreviewAnim = document.getElementById('crop-preview-anim');
const cropPreviewAnimImg = document.getElementById('crop-preview-anim-img');
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
// link can open the cover tool directly (#cover, or #cover-akmenu for the
// AKMenu-Next placement help). Leaving a tab resets it, so each
// visit starts fresh (and no Cropper ever sits in a hidden panel).
const tabs = [
  { tab: document.getElementById('tab-banner'), panel: document.getElementById('panel-banner'), reset: () => resetAll() },
  { tab: document.getElementById('tab-cover'), panel: document.getElementById('panel-cover'), reset: () => resetCover() }
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
  if (index === 1) {
    selectLauncher(coverLauncherFromHash(location.hash) ?? 'pico');
  } else if (location.hash) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

const tabFromHash = () => (coverLauncherFromHash(location.hash) ? 1 : 0);

tabs.forEach(({ tab }, i) => tab.addEventListener('click', () => selectTab(i)));
tabs[0].tab.parentElement.addEventListener('keydown', (e) => {
  const current = tabs.findIndex(({ tab }) => tab === document.activeElement);
  if (current === -1) return;
  const next = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  selectTab((next + tabs.length) % tabs.length, { focus: true });
});
window.addEventListener('hashchange', () => selectTab(tabFromHash()));
selectTab(tabFromHash());

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
let imageLoadToken = 0;
let animationDecodeToken = 0;
let animationProcessToken = 0;
let animationProcessTimeout = null;
let animationPreviewTimeout = null;
let animationFile = null;
let animationFrames = null;
let animationImages = []; // up to 8 icons
let animationSteps = []; // { image, durationTicks } per source frame, at normal speed
let animatedOutput = false;
let animationSpeed = 1;

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
      updateBannerData({ processAnimation: false });
    }
  });
});

downloadBtn.addEventListener('click', triggerDownload);
resetBtn.addEventListener('click', resetAll);
btnFormatStatic.addEventListener('click', () => setAnimatedOutput(false));
btnFormatAnimated.addEventListener('click', () => setAnimatedOutput(true));
speedButtons.forEach(button => button.addEventListener('click', () => setAnimationSpeed(Number(button.dataset.speed))));

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

function setAnimationSpeed(speed) {
  animationSpeed = speed;
  speedButtons.forEach(button => {
    const active = Number(button.dataset.speed) === speed;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (animatedOutput && animationImages.length) {
    stopAnimationPreview();
    showAnimationFrame(0);
  }
}

// The steps the banner plays at the chosen speed, fitted to its sequence.
function playbackSteps() {
  return fitAnimationSteps(animationSteps.map(({ image, durationTicks }) => ({
    image,
    durationTicks: durationTicks / animationSpeed
  })));
}

function setAnimatedOutput(enabled) {
  animatedOutput = enabled;
  animationSpeedGroup.classList.toggle('hidden', !enabled);
  setActiveButton(enabled ? btnFormatAnimated : btnFormatStatic, enabled ? btnFormatStatic : btnFormatAnimated);
  btnFormatStatic.setAttribute('aria-pressed', String(!enabled));
  btnFormatAnimated.setAttribute('aria-pressed', String(enabled));
  clearError();

  if (!enabled) {
    animationDecodeToken++;
    animationProcessToken++;
    clearTimeout(animationProcessTimeout);
    animationProcessTimeout = null;
    stopAnimationPreview();
    animationStatus.textContent = '';
    animationStatus.classList.add('hidden');
    downloadBtn.disabled = !currentPixels;
    if (currentPixels) {
      const icon = currentIcon();
      renderPreview(icon.palette, icon.indices);
    }
    return;
  }

  if (animationFrames) {
    scheduleAnimationProcessing();
    return;
  }

  if (!animationFile) {
    setAnimatedOutput(false);
    return;
  }

  const token = ++animationDecodeToken;
  downloadBtn.disabled = true;
  // Only long animations take long enough to need a progress line.
  readAnimatedImageFrames(animationFile, (current, total) => {
    if (token === animationDecodeToken && current % 16 === 0) {
      animationStatus.textContent = `Reading animation frames (${current} of ${total})...`;
      animationStatus.classList.remove('hidden');
    }
  }).then(frames => {
    if (token !== animationDecodeToken || !animatedOutput) return;
    if (frames.length < 2) throw new Error('This file contains only one frame. Choose an animated GIF or WebP.');
    animationFrames = frames.map(frame => ({
      ...frame,
      source: createImageSource(frame.rgba, frame.width, frame.height)
    }));
    scheduleAnimationProcessing();
  }).catch(err => {
    if (token !== animationDecodeToken) return;
    console.error(err);
    setAnimatedOutput(false);
    showError(escapeHtml(err.message || 'This animation couldn\'t be read. Upload a different file, or use Static.'));
  });
}

function clearAnimationState() {
  imageLoadToken++;
  animationDecodeToken++;
  animationProcessToken++;
  clearTimeout(animationProcessTimeout);
  animationProcessTimeout = null;
  stopAnimationPreview();
  animationFile = null;
  animationFrames = null;
  animationImages = [];
  animationSteps = [];
  animatedOutput = false;
  bannerFormatGroup.classList.add('hidden');
  animationSpeedGroup.classList.add('hidden');
  hideAnimatedCropPreview();
  animationStatus.textContent = '';
  animationStatus.classList.add('hidden');
  setActiveButton(btnFormatStatic, btnFormatAnimated);
  btnFormatStatic.setAttribute('aria-pressed', 'true');
  btnFormatAnimated.setAttribute('aria-pressed', 'false');
}

function hideAnimatedCropPreview() {
  cropPreviewAnim.classList.add('hidden');
  cropPreviewAnimImg.removeAttribute('src');
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

// Re-exporting an imported banner as static NTR v1 names what won't carry over.
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
  clearAnimationState();
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

  clearAnimationState();
  const token = imageLoadToken;
  if (file.name.toLowerCase().endsWith('.bin')) {
    handleBinSelect(file, token);
    return;
  }

  animationFile = isAnimatedImageFile(file) ? file : null;

  // Read and load image
  const reader = new FileReader();
  reader.onload = async function(event) {
    if (token !== imageLoadToken) return;
    const icon = file.type === 'image/png' ? await decodeIndexedIcon(new Uint8Array(await file.arrayBuffer())) : null;
    if (token !== imageLoadToken) return;
    const img = new Image();
    img.onload = function() {
      if (token !== imageLoadToken) return;
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
      // A canvas only ever draws an animation's first frame, so animated
      // uploads preview in an <img>, which the browser plays.
      if (animationFile) cropPreviewAnimImg.src = event.target.result;
      cropPreviewAnim.classList.toggle('hidden', !animationFile);
      cropPreviewCanvas.classList.toggle('hidden', Boolean(animationFile));
      dropzoneFilename.textContent = `✓ ${file.name}`;
      dropzoneFilename.classList.remove('hidden');

      // A plain image was uploaded, so any previous "editing existing
      // banner.bin" indicator no longer applies.
      binLoadedInfo.classList.add('hidden');
      binLoadedText.textContent = '';

      initCropper();
      if (animationFile) detectAnimation(file, token);
    };
    img.onerror = function() {
      if (token !== imageLoadToken) return;
      showError("This image couldn't be opened. Try a PNG, JPG, GIF or WebP file.");
      unloadImage();
    };
    img.src = event.target.result;
  };
  reader.onerror = function() {
    if (token !== imageLoadToken) return;
    showError("This image couldn't be read. Try a different file.");
    unloadImage();
  };
  reader.readAsDataURL(file);
}

// Animated uploads switch to the Animated type on their own; a still GIF or
// WebP hides the Type option. If this browser can't count frames, the option
// stays on Static, and choosing Animated explains why it can't work.
async function detectAnimation(file, token) {
  const frames = await countImageFrames(file);
  if (token !== imageLoadToken || animationFile !== file) return;
  if (frames === 1) {
    animationFile = null;
    return;
  }
  bannerFormatGroup.classList.remove('hidden');
  if (frames >= 2) setAnimatedOutput(true);
}

function isAnimatedImageFile(file) {
  const type = file.type.toLowerCase();
  return type === 'image/gif' || type === 'image/webp' || /\.(gif|webp)$/i.test(file.name);
}

function handleBinSelect(file, token) {
  const reader = new FileReader();
  reader.onload = function(event) {
    if (token !== imageLoadToken) return;
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
        if (token !== imageLoadToken) return;
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
        if (token !== imageLoadToken) return;
        showError("The banner's icon couldn't be loaded. Try the file again, or upload a different <code>banner.bin</code>.");
      };

      img.src = dataURL;

    } catch (err) {
      console.error(err);
      showError("This <code>banner.bin</code> couldn't be read. It may be damaged. Upload a different file.");
    }
  };
  reader.onerror = function() {
    if (token !== imageLoadToken) return;
    showError("This <code>banner.bin</code> couldn't be read. Upload a different file.");
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

function scheduleAnimationProcessing() {
  if (!animatedOutput || !animationFrames || !currentPixels || !loadedImage) return;
  clearTimeout(animationProcessTimeout);
  animationProcessToken++;
  const token = animationProcessToken;
  stopAnimationPreview();
  downloadBtn.disabled = true;

  animationProcessTimeout = setTimeout(() => {
    animationProcessTimeout = null;
    if (token !== animationProcessToken || !animatedOutput) return;
    try {
      const region = layoutMode === 'crop' ? cropRegion() : layoutMode === 'fill' ? fillRegion() : fitRegion();
      if (!region) return;
      const framePixels = animationFrames.map(({ source, width, height }) => {
        const scaleX = width / loadedImage.width;
        const scaleY = height / loadedImage.height;
        return downscaleRegionRect(
          source,
          region.x * scaleX,
          region.y * scaleY,
          region.size * scaleX,
          region.size * scaleY,
          32,
          32
        );
      });
      const plan = planAnimation(framePixels, animationFrames.map(frame => frame.durationTicks));
      animationImages = plan.images.map(frame => quantize(framePixels[frame], 15, pixelArtEnhance));
      animationSteps = plan.steps.map((image, frame) => ({ image, durationTicks: animationFrames[frame].durationTicks }));
      if (playbackSteps().length < 2) {
        animationImages = [];
        animationSteps = [];
        throw new Error('This part of the animation doesn\'t change. Choose a different area, or use Static.');
      }
      downloadBtn.disabled = false;
      animationStatus.textContent = '';
      animationStatus.classList.add('hidden');
      showAnimationFrame(0);
    } catch (err) {
      console.error(err);
      setAnimatedOutput(false);
      showError(escapeHtml(err.message || 'This animation couldn\'t be made into a banner. Try a different area, or use Static.'));
    }
  }, 200);
}

function stopAnimationPreview() {
  clearTimeout(animationPreviewTimeout);
  animationPreviewTimeout = null;
}

function showAnimationFrame(index) {
  if (!animatedOutput || animationImages.length === 0) return;
  const steps = playbackSteps();
  const step = steps[index % steps.length];
  const icon = animationImages[step.image];
  renderPreview(icon.palette, icon.indices);
  animationPreviewTimeout = setTimeout(
    () => showAnimationFrame((index + 1) % steps.length),
    Math.max(17, step.durationTicks * 1000 / 60)
  );
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
  if (animationFile) {
    const scale = (cropPreviewAnim.clientWidth || CROP_PREVIEW_SIZE) / region.size;
    Object.assign(cropPreviewAnimImg.style, {
      left: `${-region.x * scale}px`,
      top: `${-region.y * scale}px`,
      width: `${loadedImage.width * scale}px`,
      height: `${loadedImage.height * scale}px`
    });
  }

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

function updateBannerData({ processAnimation = true } = {}) {
  if (!currentPixels) return;

  paletteNote.classList.toggle('hidden', !usesIndexedIcon());
  if (animatedOutput) {
    if (animationImages.length === 0) {
      const icon = currentIcon();
      renderPreview(icon.palette, icon.indices);
    }
    downloadBtn.disabled = animationImages.length === 0 || animationProcessTimeout !== null;
    if (processAnimation) scheduleAnimationProcessing();
  } else {
    const icon = currentIcon();
    renderPreview(icon.palette, icon.indices);
    downloadBtn.disabled = false;
  }
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
  if (animatedOutput && animationImages.length === 0) return;

  try {
    const bytes = animatedOutput
      ? packAnimatedBanner(
        animationImages[0],
        animationImages,
        playbackSteps(),
        inputTitle.value, inputSubtitle.value, inputAuthor.value
      )
      : packBannerIcon(currentIcon(), inputTitle.value, inputSubtitle.value, inputAuthor.value);
    saveFile(bytes, 'banner.bin');
  } catch (err) {
    console.error(err);
    showError(escapeHtml(err.message || 'The banner couldn\'t be made. Try again, or upload a different image.'));
    return;
  }

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
  setAnimationSpeed(1);
  layoutChosen = false;
}

function resetDropzonePrompt() {
  dropzonePrompt.classList.remove('hidden');
  // Return the preview canvas to its home slot in the dropzone, in case a
  // .bin import had moved it into the "banner loaded" card.
  dropzonePreviewWrapper.insertBefore(cropPreviewCanvas, dropzoneFilename);
  cropPreviewCanvas.classList.add('hidden');
  hideAnimatedCropPreview();
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
