import { nativeImage } from 'electron';

import type {
  CompressedSourceScreenshot,
  SourceScreenshotCompressor,
} from '../core/source-screenshot-lifecycle';

const SOURCE_SCREENSHOT_JPEG_QUALITY = 92;

export class ElectronSourceScreenshotCompressor implements SourceScreenshotCompressor {
  public async compress(
    bytes: Buffer,
    mimeType: string,
  ): Promise<CompressedSourceScreenshot> {
    const source = mimeType === 'image/webp'
      ? nativeImage.createFromDataURL(`data:image/webp;base64,${bytes.toString('base64')}`)
      : nativeImage.createFromBuffer(bytes);
    if (source.isEmpty()) throw new Error('无法解码来源截图');
    const sourceSize = source.getSize();
    const compressedBytes = source.toJPEG(SOURCE_SCREENSHOT_JPEG_QUALITY);
    const output = nativeImage.createFromBuffer(compressedBytes);
    if (output.isEmpty()) throw new Error('无法复验来源截图压缩结果');
    return {
      bytes: compressedBytes,
      mimeType: 'image/jpeg',
      sourceSize,
      outputSize: output.getSize(),
    };
  }
}
