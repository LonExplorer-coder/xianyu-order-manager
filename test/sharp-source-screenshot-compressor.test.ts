import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { SharpSourceScreenshotCompressor } from '../src/main/sharp-source-screenshot-compressor';

describe('Sharp 来源截图压缩适配器', () => {
  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpeg'],
    ['image/webp', 'webp'],
  ] as const)('异步解码 %s 并以 92 质量、4:4:4 色度生成同尺寸 JPEG', async (mimeType, format) => {
    const source = await sharp({
      create: {
        width: 320,
        height: 640,
        channels: 3,
        background: { r: 245, g: 242, b: 232 },
      },
    })[format]().toBuffer();

    const result = await new SharpSourceScreenshotCompressor().compress(source, mimeType);
    const metadata = await sharp(result.bytes).metadata();

    expect(result.mimeType).toBe('image/jpeg');
    expect(result.sourceSize).toEqual({ width: 320, height: 640 });
    expect(result.outputSize).toEqual({ width: 320, height: 640 });
    expect(metadata).toMatchObject({
      format: 'jpeg',
      width: 320,
      height: 640,
      chromaSubsampling: '4:4:4',
    });
  });

  it('损坏内容或不支持格式时失败，不返回可替换内容', async () => {
    const compressor = new SharpSourceScreenshotCompressor();
    await expect(compressor.compress(Buffer.from('broken'), 'image/png')).rejects.toThrow();
    await expect(compressor.compress(Buffer.from('content'), 'image/gif'))
      .rejects.toThrow('图片格式不支持压缩');
  });
});
