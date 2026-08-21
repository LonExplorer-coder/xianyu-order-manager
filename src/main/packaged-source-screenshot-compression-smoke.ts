import sharp from 'sharp';

import { SharpSourceScreenshotCompressor } from './sharp-source-screenshot-compressor';

export async function runPackagedSourceScreenshotCompressionSmoke(): Promise<{
  originalBytes: number;
  compressedBytes: number;
}> {
  const width = 320;
  const height = 640;
  const raw = Buffer.alloc(width * height * 3);
  for (let index = 0; index < raw.length; index += 3) {
    const pixel = index / 3;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const texture = (x * 13 + y * 17 + ((x * y) % 97)) % 96;
    raw[index] = 150 + texture;
    raw[index + 1] = Math.min(255, raw[index] + (x % 19));
    raw[index + 2] = Math.max(0, raw[index] - (y % 23));
  }
  const source = await sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  const result = await new SharpSourceScreenshotCompressor().compress(source, 'image/png');
  if (
    result.sourceSize.width !== width
    || result.sourceSize.height !== height
    || result.outputSize.width !== width
    || result.outputSize.height !== height
    || result.bytes.length >= source.length
  ) {
    throw new Error('打包后来源截图压缩结果不符合尺寸与体积要求');
  }
  return { originalBytes: source.length, compressedBytes: result.bytes.length };
}
