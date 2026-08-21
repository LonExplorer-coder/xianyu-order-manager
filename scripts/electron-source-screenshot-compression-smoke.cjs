const { app, nativeImage } = require('electron');

void app.whenReady().then(() => {
  const width = 320;
  const height = 640;
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const textStripe = y % 28 >= 8 && y % 28 <= 12 && x > 24 && x < 296;
      const texture = (x * 13 + y * 17 + ((x * y) % 97)) % 96;
      const value = textStripe ? 24 : 150 + texture;
      bitmap[offset] = value;
      bitmap[offset + 1] = textStripe ? 24 : Math.min(255, value + (x % 19));
      bitmap[offset + 2] = textStripe ? 24 : Math.max(0, value - (y % 23));
      bitmap[offset + 3] = 255;
    }
  }
  const source = nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 });
  const originalPng = source.toPNG();
  const decoded = nativeImage.createFromBuffer(originalPng);
  if (decoded.isEmpty()) throw new Error('Electron 无法解码合成来源截图');
  const jpeg = decoded.toJPEG(92);
  const verified = nativeImage.createFromBuffer(jpeg);
  if (verified.isEmpty()) throw new Error('Electron 无法复验压缩来源截图');
  const outputSize = verified.getSize();
  if (outputSize.width !== width || outputSize.height !== height) {
    throw new Error(`压缩前后像素尺寸不一致：${width}x${height} -> ${outputSize.width}x${outputSize.height}`);
  }
  if (jpeg.length >= originalPng.length) {
    throw new Error(`高质量 JPEG 未减少合成来源截图体积：${originalPng.length} -> ${jpeg.length}`);
  }
  process.stdout.write(
    `Electron source screenshot compression smoke passed: ${originalPng.length} -> ${jpeg.length} bytes\n`,
  );
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
