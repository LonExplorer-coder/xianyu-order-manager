import { describe, expect, it, vi } from 'vitest';

const electronBoundary = vi.hoisted(() => ({
  createFromBuffer: vi.fn(),
  createFromDataURL: vi.fn(),
}));

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: electronBoundary.createFromBuffer,
    createFromDataURL: electronBoundary.createFromDataURL,
  },
}));

import { ElectronSourceScreenshotCompressor } from '../src/main/electron-source-screenshot-compressor';

describe('Electron 来源截图压缩适配器', () => {
  it('以 92 质量编码 JPEG 并重新解码确认像素尺寸不变', async () => {
    const toJPEG = vi.fn(() => Buffer.from('compressed-jpeg'));
    electronBoundary.createFromBuffer
      .mockReturnValueOnce({
        isEmpty: () => false,
        getSize: () => ({ width: 1170, height: 2532 }),
        toJPEG,
      })
      .mockReturnValueOnce({
        isEmpty: () => false,
        getSize: () => ({ width: 1170, height: 2532 }),
      });

    const result = await new ElectronSourceScreenshotCompressor()
      .compress(Buffer.from('source-image'), 'image/png');

    expect(toJPEG).toHaveBeenCalledWith(92);
    expect(result).toEqual({
      bytes: Buffer.from('compressed-jpeg'),
      mimeType: 'image/jpeg',
      sourceSize: { width: 1170, height: 2532 },
      outputSize: { width: 1170, height: 2532 },
    });
    expect(electronBoundary.createFromBuffer).toHaveBeenNthCalledWith(
      2,
      Buffer.from('compressed-jpeg'),
    );
  });

  it('原图或压缩结果无法解码时失败，不返回可替换内容', async () => {
    electronBoundary.createFromBuffer.mockReturnValueOnce({ isEmpty: () => true });
    await expect(new ElectronSourceScreenshotCompressor().compress(
      Buffer.from('broken'),
      'image/png',
    ))
      .rejects.toThrow('无法解码来源截图');

    electronBoundary.createFromBuffer
      .mockReturnValueOnce({
        isEmpty: () => false,
        getSize: () => ({ width: 1170, height: 2532 }),
        toJPEG: () => Buffer.from('broken-compressed'),
      })
      .mockReturnValueOnce({ isEmpty: () => true });
    await expect(new ElectronSourceScreenshotCompressor().compress(
      Buffer.from('source'),
      'image/png',
    ))
      .rejects.toThrow('无法复验来源截图压缩结果');
  });

  it('WebP 通过带 MIME 类型的数据地址解码后再压缩', async () => {
    electronBoundary.createFromDataURL.mockReturnValueOnce({
      isEmpty: () => false,
      getSize: () => ({ width: 100, height: 200 }),
      toJPEG: () => Buffer.from('webp-to-jpeg'),
    });
    electronBoundary.createFromBuffer.mockReturnValueOnce({
      isEmpty: () => false,
      getSize: () => ({ width: 100, height: 200 }),
    });

    await new ElectronSourceScreenshotCompressor().compress(
      Buffer.from('webp-source'),
      'image/webp',
    );

    expect(electronBoundary.createFromDataURL).toHaveBeenCalledWith(
      `data:image/webp;base64,${Buffer.from('webp-source').toString('base64')}`,
    );
  });
});
