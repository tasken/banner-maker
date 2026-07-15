import { packBanner, quantize, downscaleBox, decodeBanner } from './core.js?v=__COMMIT_HASH__';

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
const btnPixelArtOff = document.getElementById('btn-pixelart-off');
const btnPixelArtOn = document.getElementById('btn-pixelart-on');
const transparencyInfo = document.getElementById('transparency-info');
const binLoadedInfo = document.getElementById('bin-loaded-info');
const binPreviewSlot = document.getElementById('bin-preview-slot');
const binLoadedText = document.getElementById('bin-loaded-text');
const btnRemoveBin = document.getElementById('btn-remove-bin');

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

const resizeCtx = resizeCanvas.getContext('2d');
const previewCtx = previewCanvas.getContext('2d');

// State
let loadedImage = null;
let currentPixels = null; // 1024 RGBA objects
let cropperInstance = null;
let layoutMode = 'crop'; // 'crop' or 'fit'
let loadedImageHasTransparency = false;
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

// Update preview/CRC live when text changes
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

btnScale1x.addEventListener('click', () => {
  dsIconSlot.classList.remove('scale-2x');
  btnScale1x.classList.add('active');
  btnScale2x.classList.remove('active');
});

btnScale2x.addEventListener('click', () => {
  dsIconSlot.classList.add('scale-2x');
  btnScale2x.classList.add('active');
  btnScale1x.classList.remove('active');
});

btnModeCrop.addEventListener('click', () => {
  if (layoutMode === 'crop') return;
  layoutMode = 'crop';
  btnModeCrop.classList.add('active');
  btnModeFit.classList.remove('active');
  cropperWrapper.classList.remove('hidden');
  initCropper();
});

btnModeFit.addEventListener('click', () => {
  if (layoutMode === 'fit') return;
  layoutMode = 'fit';
  btnModeFit.classList.add('active');
  btnModeCrop.classList.remove('active');
  cropperWrapper.classList.add('hidden');
  destroyCropper();
  processImage();
});

btnPixelArtOff.addEventListener('click', () => {
  if (!pixelArtEnhance) return;
  pixelArtEnhance = false;
  btnPixelArtOff.classList.add('active');
  btnPixelArtOn.classList.remove('active');
  if (loadedImage) updateBannerData();
});

btnPixelArtOn.addEventListener('click', () => {
  if (pixelArtEnhance) return;
  pixelArtEnhance = true;
  btnPixelArtOn.classList.add('active');
  btnPixelArtOff.classList.remove('active');
  if (loadedImage) updateBannerData();
});

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
      processImage();
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

// Warning logic removed for simple UI

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
  reader.onload = function(event) {
    const img = new Image();
    img.onload = function() {
      const size = Math.min(img.width, img.height);
      
      // Sanity check dimensions (use smaller side to prevent lag)
      if (size > 4096) {
        showError(`This image is too large (<code>${img.width}×${img.height}px</code>). To prevent performance lag, upload an image where the smaller side is under <code>4096px</code>.`);
        loadedImage = null;
        currentPixels = null;
        downloadBtn.disabled = true;
        clearCanvas();
        resetDropzonePrompt();
        return;
      }

      loadedImage = img;

      // Create a temporary off-screen canvas to check for transparency
      const scanCanvas = document.createElement('canvas');
      scanCanvas.width = img.width;
      scanCanvas.height = img.height;
      const scanCtx = scanCanvas.getContext('2d');
      scanCtx.drawImage(img, 0, 0);
      const scanData = scanCtx.getImageData(0, 0, img.width, img.height).data;
      
      loadedImageHasTransparency = false;
      for (let i = 3; i < scanData.length; i += 4) {
        if (scanData[i] < 255) {
          loadedImageHasTransparency = true;
          break;
        }
      }
      
      // Update info card visibility
      if (loadedImageHasTransparency) {
        transparencyInfo.classList.remove('hidden');
      } else {
        transparencyInfo.classList.add('hidden');
      }
      
      // Destroy previous cropper instance
      destroyCropper();

      // Show crop control panel
      cropControl.classList.remove('hidden');

      // Set image source for the Cropper editor
      cropEditorImg.src = event.target.result;

      // Default crop if image is squared should be to fit the full image
      if (img.width === img.height) {
        layoutMode = 'fit';
        btnModeCrop.classList.remove('active');
        btnModeFit.classList.add('active');
        cropperWrapper.classList.add('hidden');
      } else {
        layoutMode = 'crop';
        btnModeCrop.classList.add('active');
        btnModeFit.classList.remove('active');
        cropperWrapper.classList.remove('hidden');
      }

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

      // Initialize Cropper.js
      initCropper();
    };
    img.onerror = function() {
      showError("Failed to open the image. Please verify it is a valid PNG, JPG, or WebP graphic.");
      loadedImage = null;
      currentPixels = null;
      downloadBtn.disabled = true;
      clearCanvas();
      resetDropzonePrompt();
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

function handleBinSelect(file) {
  const reader = new FileReader();
  reader.onload = function(event) {
    try {
      const arrayBuffer = event.target.result;
      const bytes = new Uint8Array(arrayBuffer);

      // Sanity check size
      if (bytes.length < 2112) {
        showError("Invalid banner file size. A valid DS <code>banner.bin</code> must be at least <code>2112 bytes</code>.");
        return;
      }

      // Check version bytes (0x0001, 0x0002, 0x0003, etc.)
      const version = bytes[0] | (bytes[1] << 8);
      if (version === 0 || version > 0x0F00) {
        showError("Invalid banner file format. Version identifier not recognized.");
        return;
      }

      // Parse banner using the core function
      const parsed = decodeBanner(bytes);

      // Update metadata inputs in the DOM
      inputTitle.value = parsed.title;
      inputSubtitle.value = parsed.subtitle;
      inputAuthor.value = parsed.author;
      updateMockupText();

      // Convert the parsed pixels back to an Image so we can load it in the editor
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = 32;
      tempCanvas.height = 32;
      const tempCtx = tempCanvas.getContext('2d');
      const imgData = tempCtx.createImageData(32, 32);

      for (let i = 0; i < 1024; i++) {
        const p = parsed.pixels[i];
        const idx = i * 4;
        imgData.data[idx] = p.r;
        imgData.data[idx + 1] = p.g;
        imgData.data[idx + 2] = p.b;
        imgData.data[idx + 3] = p.a;
      }
      tempCtx.putImageData(imgData, 0, 0);

      const dataURL = tempCanvas.toDataURL('image/png');

      // Load the image just like standard images
      const img = new Image();
      img.onload = function() {
        loadedImage = img;

        // Transparency check
        loadedImageHasTransparency = false;
        for (let i = 0; i < parsed.pixels.length; i++) {
          if (parsed.pixels[i].a < 255) {
            loadedImageHasTransparency = true;
            break;
          }
        }

        // Update transparency info panel visibility
        if (loadedImageHasTransparency) {
          transparencyInfo.classList.remove('hidden');
        } else {
          transparencyInfo.classList.add('hidden');
        }

        // Destroy previous cropper instance
        destroyCropper();

        // Show crop control panel
        cropControl.classList.remove('hidden');
        cropEditorImg.src = dataURL;

        // Default to 'fit' layout mode since it's already 32x32 px square
        layoutMode = 'fit';
        btnModeCrop.classList.remove('active');
        btnModeFit.classList.add('active');
        cropperWrapper.classList.add('hidden');

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

        binLoadedText.innerHTML = `Editing existing <code>banner.bin</code>: icon, title & text imported from "${escapeHtml(file.name)}".`;
        binLoadedInfo.classList.remove('hidden');

        // Process image to populate currentPixels and trigger updateBannerData
        processImage();
      };

      img.onerror = function() {
        showError("Failed to convert binary banner icon to editable image.");
      };

      img.src = dataURL;

    } catch (err) {
      console.error(err);
      showError("Failed to parse the <code>banner.bin</code> file. Make sure it is a valid Nintendo DS banner.");
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

function processImage() {
  if (!loadedImage) return;

  const width = loadedImage.width;
  const height = loadedImage.height;
  const pCtx = cropPreviewCanvas.getContext('2d');
  pCtx.imageSmoothingEnabled = false;
  pCtx.mozImageSmoothingEnabled = false;
  pCtx.webkitImageSmoothingEnabled = false;

  if (layoutMode === 'crop') {
    // Get cropping coordinates from Cropper.js
    if (!cropperInstance) return;
    const data = cropperInstance.getData(true);
    const cropX = data.x;
    const cropY = data.y;
    const cropW = data.width;
    const cropH = data.height;

    // Draw the high-res crop preview thumbnail (96x96px)
    pCtx.clearRect(0, 0, 96, 96);
    pCtx.drawImage(loadedImage, cropX, cropY, cropW, cropH, 0, 0, 96, 96);

    // Create a temporary canvas at square cropped size to read pixels
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = cropW;
    srcCanvas.height = cropH;
    const srcCtx = srcCanvas.getContext('2d');
    srcCtx.imageSmoothingEnabled = false;
    srcCtx.mozImageSmoothingEnabled = false;
    srcCtx.webkitImageSmoothingEnabled = false;
    srcCtx.drawImage(loadedImage, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    const srcImgData = srcCtx.getImageData(0, 0, cropW, cropH);

    // Use area-averaging box scaling to downscale cleanly to 32x32
    currentPixels = downscaleBox(srcImgData.data, cropW);
  } else {
    // Fit Mode: scale entire image to fit 32x32 square and keep transparency
    const size = Math.max(width, height);

    // Setup 96x96 preview (clear to keep transparent)
    pCtx.clearRect(0, 0, 96, 96);

    // Create high-res fit canvas
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = size;
    srcCanvas.height = size;
    const srcCtx = srcCanvas.getContext('2d');
    srcCtx.imageSmoothingEnabled = false;
    srcCtx.mozImageSmoothingEnabled = false;
    srcCtx.webkitImageSmoothingEnabled = false;
    srcCtx.clearRect(0, 0, size, size);

    let scaleW, scaleH, destX, destY;
    if (width > height) {
      // Landscape
      scaleW = size;
      scaleH = size * (height / width);
      destX = 0;
      destY = Math.floor((size - scaleH) / 2);
    } else {
      // Portrait
      scaleH = size;
      scaleW = size * (width / height);
      destY = 0;
      destX = Math.floor((size - scaleW) / 2);
    }

    // Draw fitted image on high-res canvas
    srcCtx.drawImage(loadedImage, destX, destY, scaleW, scaleH);
    
    // Draw fitted image on 96x96 preview
    const previewScale = 96 / size;
    pCtx.drawImage(loadedImage, destX * previewScale, destY * previewScale, scaleW * previewScale, scaleH * previewScale);

    const srcImgData = srcCtx.getImageData(0, 0, size, size);
    currentPixels = downscaleBox(srcImgData.data, size);
  }

  updateBannerData();
}

function updateBannerData() {
  if (!currentPixels) return;

  // Perform quantization
  const { palette, indices } = quantize(currentPixels, 15, pixelArtEnhance);

  // Render quantized live preview
  renderPreview(palette, indices);

  // Generate binary package to compute live CRCs
  const title = inputTitle.value;
  const subtitle = inputSubtitle.value;
  const author = inputAuthor.value;

  const bannerBin = packBanner(currentPixels, title, subtitle, author, pixelArtEnhance);

  // Enable download
  downloadBtn.disabled = false;
}

function renderPreview(palette, indices) {
  // Create 32x32 buffer image data
  const buffer = resizeCtx.createImageData(32, 32);
  
  for (let i = 0; i < 1024; i++) {
    const paletteIndex = indices[i];
    const color = palette[paletteIndex];
    const bufferIdx = i * 4;

    if (paletteIndex === 0) {
      // Transparency
      buffer.data[bufferIdx] = 0;
      buffer.data[bufferIdx + 1] = 0;
      buffer.data[bufferIdx + 2] = 0;
      buffer.data[bufferIdx + 3] = 0;
    } else {
      buffer.data[bufferIdx] = color.r;
      buffer.data[bufferIdx + 1] = color.g;
      buffer.data[bufferIdx + 2] = color.b;
      buffer.data[bufferIdx + 3] = 255;
    }
  }

  // Draw 32x32 onto offscreen canvas
  resizeCtx.putImageData(buffer, 0, 0);

  // Clear preview canvas
  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  
  // Draw scaled-up crisp preview
  previewCtx.imageSmoothingEnabled = false;
  previewCtx.mozImageSmoothingEnabled = false;
  previewCtx.webkitImageSmoothingEnabled = false;
  
  previewCtx.drawImage(resizeCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
}


function triggerDownload() {
  if (!currentPixels) return;

  const title = inputTitle.value;
  const subtitle = inputSubtitle.value;
  const author = inputAuthor.value;

  const bannerBin = packBanner(currentPixels, title, subtitle, author, pixelArtEnhance);
  const blob = new Blob([bannerBin], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = 'banner.bin';
  document.body.appendChild(link);
  link.click();
  
  // Cleanup
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

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
  loadedImage = null;
  currentPixels = null;
  downloadBtn.disabled = true;
  clearCanvas();
  updateMockupText();
  clearError();
  resetDropzonePrompt();
  drawPlaceholderIcon();
  
  // Reset preview scale state to 1×
  dsIconSlot.classList.remove('scale-2x');
  btnScale1x.classList.add('active');
  btnScale2x.classList.remove('active');

  // Reset pixel enhance toggle to off
  pixelArtEnhance = false;
  btnPixelArtOff.classList.add('active');
  btnPixelArtOn.classList.remove('active');
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

  // Hide transparency info card
  loadedImageHasTransparency = false;
  transparencyInfo.classList.add('hidden');

  // Hide "editing existing banner.bin" indicator
  binLoadedInfo.classList.add('hidden');
  binLoadedText.textContent = '';

  // Clear the preview canvas
  const pCtx = cropPreviewCanvas.getContext('2d');
  pCtx.clearRect(0, 0, 96, 96);
  
  // Destroy Cropper.js instance and clear image src
  destroyCropper();
  cropEditorImg.src = '';
}

function drawPlaceholderIcon() {
  const ctx = resizeCtx;
  ctx.clearRect(0, 0, 32, 32);
  
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
  
  // Render this cartridge pattern onto the console mockup preview canvas!
  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  previewCtx.imageSmoothingEnabled = false;
  previewCtx.mozImageSmoothingEnabled = false;
  previewCtx.webkitImageSmoothingEnabled = false;
  previewCtx.drawImage(resizeCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
}

// Initial triggers
updateMockupText();
drawPlaceholderIcon();
