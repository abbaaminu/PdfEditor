const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIcoModule = require('png-to-ico');

const pngToIco = pngToIcoModule.default || pngToIcoModule;
const rootDir = path.resolve(__dirname, '..');
const sourcePath = path.join(rootDir, 'assets', 'icon.svg');
const outputPath = path.join(rootDir, 'assets', 'icon.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];

async function generateIcon() {
  const source = fs.readFileSync(sourcePath);
  const pngBuffers = await Promise.all(
    sizes.map((size) => sharp(source).resize(size, size).png().toBuffer())
  );
  const icoBuffer = await pngToIco(pngBuffers);
  fs.writeFileSync(outputPath, icoBuffer);
  console.log(`Generated ${path.relative(rootDir, outputPath)} (${icoBuffer.length} bytes).`);

  // Large PNG used as the icon source for macOS (icns conversion) and Linux
  // (AppImage/deb). electron-builder requires at least 512x512 for both.
  const iconPngPath = path.join(rootDir, 'assets', 'icon.png');
  const pngBuffer = await sharp(source).resize(1024, 1024).png().toBuffer();
  fs.writeFileSync(iconPngPath, pngBuffer);
  console.log(
    `Generated ${path.relative(rootDir, iconPngPath)} (${pngBuffer.length} bytes).`
  );
}

generateIcon().catch((error) => {
  console.error(`Failed to generate ${path.relative(rootDir, outputPath)}: ${error.message}`);
  process.exitCode = 1;
});
