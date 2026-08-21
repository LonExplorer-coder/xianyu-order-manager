import sharp from 'sharp';

import type {
  CompressedSourceScreenshot,
  SourceScreenshotCompressor,
} from '../core/source-screenshot-lifecycle';

const SOURCE_SCREENSHOT_JPEG_QUALITY = 92;
const SUPPORTED_SOURCE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export class SharpSourceScreenshotCompressor implements SourceScreenshotCompressor {
  public async compress(
    bytes: Buffer,
    mimeType: string,
  ): Promise<CompressedSourceScreenshot> {
    if (!SUPPORTED_SOURCE_MIME_TYPES.has(mimeType)) {
      throw new Error('来源截图图片格式不支持压缩');
    }
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
    const sourceSize = metadata.autoOrient ?? {
      width: metadata.width,
      height: metadata.height,
    };
    if (!sourceSize.width || !sourceSize.height) throw new Error('无法解码来源截图');

    const { data, info } = await sharp(bytes, { failOn: 'error' })
      .autoOrient()
      .jpeg({
        quality: SOURCE_SCREENSHOT_JPEG_QUALITY,
        chromaSubsampling: '4:4:4',
        progressive: true,
      })
      .toBuffer({ resolveWithObject: true });
    const outputMetadata = await sharp(data, { failOn: 'error' }).metadata();
    if (
      outputMetadata.format !== 'jpeg'
      || !outputMetadata.width
      || !outputMetadata.height
      || info.width !== outputMetadata.width
      || info.height !== outputMetadata.height
    ) {
      throw new Error('无法复验来源截图压缩结果');
    }
    return {
      bytes: data,
      mimeType: 'image/jpeg',
      sourceSize: { width: sourceSize.width, height: sourceSize.height },
      outputSize: { width: outputMetadata.width, height: outputMetadata.height },
    };
  }
}
