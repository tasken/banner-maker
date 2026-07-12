# DS Banner Maker

A simple web tool to create custom icons and metadata banners (`banner.bin`) for Nintendo DS and DSi homebrew games.

Try it online: https://tasken.github.io/banner-maker/

## How to use

1. Upload your icon image.
2. Crop or fit the image.
3. Enter your game's Title, Subtitle, and Author.
4. Download the `banner.bin` file and replace it in your homebrew project before compiling.

## Features

- **Crop & Fit support**: Crop your image 1:1 visually or scale it to fit.
- **Transparency**: Fully preserves transparent backgrounds (renders as hardware transparency on-console) and blends semi-transparent edges against white to prevent halos.
- **Auto-quantization**: Automatically converts your image to the required 15-color palette and encodes it into 8x8 tiles (NTR v1 format).
- **Checksums**: Automatically calculates and embeds valid CRC16 checks.
- **No dependencies**: Built entirely using standard HTML, CSS, and vanilla JavaScript.

## Local Development

To run the project locally, start a simple HTTP server in this directory:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

## License

MIT License. Feel free to use and modify it!
