# DS Banner Maker

A simple web tool to create custom icons and metadata banners (`banner.bin`) for Nintendo DS and DSi homebrew games.

**[Try it online →](https://tasken.github.io/banner-maker/)**

## How to use

1. Drop an **icon image** onto the upload area, or drop an existing `banner.bin` file to re-edit its icon and text.
   - Images are automatically resized to 32×32 and reduced to 16 colors.
   - `.bin` files pre-fill the Title/Subtitle/Author fields and the icon straight from the file.
2. Pick a layout mode: `Crop` to crop the image 1:1, or `Fit` to scale the whole image with padding.
3. Optionally turn on `Pixel enhance` to dither colors and boost contrast/saturation, so busy photos quantize down closer to hand-drawn pixel art instead of a muddy blur.
4. Fill in the **Game title**, and optionally a **Subtitle** and **Author**.
5. Click `Download banner.bin`, then replace the file in your homebrew project's source before compiling.

> [!TIP]
> Uploading a new image or `.bin` replaces whatever is currently loaded. If you imported a `banner.bin` and want to start from a blank slate instead, use the `Remove` button next to it.

> [!NOTE]
> DS icons only support **16 colors**, with index `0` reserved for transparency. This tool downscales and quantizes any image automatically, but starting from an image that's already close to 32×32 with a limited palette gives the sharpest results.

## Features

- **Crop & Fit support**: Crop your image 1:1 visually or scale it to fit.
- **Edit existing banners**: Upload an existing `banner.bin` to re-edit its icon, title, subtitle, and author.
- **Integrity validation**: Inspects and validates CRC16 checksums upon importing existing banner files.
- **Hardware-accurate quantization**: Snaps colors to Nintendo DS native 15-bit RGB555 color space with perceptual distance weighting and accurate `(v << 3) | (v >> 2)` bit expansion.
- **Halo-free downscaling**: Box filter weights color by alpha to prevent white outline fringe artifacts.
- **Pixel enhance**: Optional dithering plus contrast/saturation boost so photos quantize closer to genuine pixel art.
- **Transparency**: Fully preserves transparent backgrounds (renders as hardware transparency on-console) and blends semi-transparent edges against white to prevent halos.
- **Checksums**: Automatically calculates and embeds valid CRC16 checks.
- **No dependencies**: Built entirely using standard HTML, CSS, and vanilla JavaScript (aside from Cropper.js via CDN).

## Local Development

1. Start a simple HTTP server in this directory:

   ```bash
   python3 -m http.server 8080
   ```

2. Open `http://localhost:8080` in your browser.

There's no build step, package manager, or test suite. `index.html`, `index.css`, `app.js`, and `core.js` are the entire app.

## Contributing

Found a bug or want to add a feature? Open an issue, or fork the repository and submit a pull request. Contributions are welcome.

## License

MIT License. Feel free to use and modify it!
