# DS Banner Maker

Make the icon and title (`banner.bin`) that the DS and DSi menus show for your homebrew game or flashcart.

**[Try it online →](https://tasken.github.io/banner-maker/)**

## How to use

1. Drop an image, or an existing `banner.bin`, onto the upload area.
2. Pick `Crop` to choose a square, or `Fit` to use the whole image with transparent padding.
3. Using a photo? Turn on `Pixel enhance` to boost contrast and dither colors so it reads like pixel art.
4. Fill in the **Game title**, plus an optional **Subtitle** and **Author / Publisher**.
5. Click `Download banner.bin`.

Then add the file to your homebrew project before building, or flash it to your cart with the [flashcart banner guide](https://sanrax.github.io/flashcart-guides/tutorials/icon-change/).

> [!WARNING]
> Stock DSi and 3DS consoles block flashcarts with a changed banner. Read the guide before flashing.

> [!TIP]
> Made a 32×32 PNG with a 16-color palette, like in the guide's GIMP steps? Upload it in `Fit` mode with `Pixel enhance` off and its colors are kept exactly. The first palette color becomes transparent.

## Features

- **Any image in**: resized to 32×32 and reduced to 16 colors, the first one transparent. Colors are picked in the DS's 15-bit RGB555 space, weighted for how the eye sees them.
- **Edit existing banners**: loads the icon and text from any `banner.bin` (NTR v1–v3 or DSi animated) and checks every checksum the DSi menu checks. Downloads are always static NTR v1, so Chinese/Korean titles and icon animations aren't kept.
- **Flashcart-ready**: every download is a 2,112-byte NTR v1 banner with a valid CRC16, the format Cart-Flasher's `Write DS banner` accepts.
- **Clean edges**: pixels under 50% opacity become transparent, and the rest keep their own color, so edges don't get halos.
- **Runs in your browser**: plain HTML, CSS and JavaScript, plus Cropper.js. Your files never leave your device.

## Local development

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`. There's no build step and nothing to install.

## Contributing

Found a bug or have an idea? Open an issue or a pull request.

## License

MIT
