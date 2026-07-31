import { describe, expect, it, vi } from 'vitest';

import {
  createElectronSemanticRegionImageCropper,
  type ElectronNativeImageFactory,
  type ElectronNativeImageLike,
} from '../src/main/electron-semantic-region-image-cropper';

function source(mimeType: 'image/png' | 'image/jpeg') {
  return {
    absolutePath: '/private/order-image',
    originalName: '订单截图',
    mimeType,
    sha256: 'source-sha256',
    bytes: Uint8Array.from([10, 20, 30, 40]),
  };
}

function nativeImageFixture(input: {
  width?: number;
  height?: number;
  empty?: boolean;
} = {}) {
  const pngBytes = Buffer.from([1, 2, 3]);
  const jpegBytes = Buffer.from([4, 5, 6]);
  const cropped: ElectronNativeImageLike = {
    isEmpty: vi.fn(() => false),
    getSize: vi.fn(() => ({ width: input.width ?? 1_170, height: 1_531 })),
    crop: vi.fn(),
    toPNG: vi.fn(() => pngBytes),
    toJPEG: vi.fn(() => jpegBytes),
  };
  const original: ElectronNativeImageLike = {
    isEmpty: vi.fn(() => input.empty ?? false),
    getSize: vi.fn(() => ({
      width: input.width ?? 1_170,
      height: input.height ?? 2_532,
    })),
    crop: vi.fn(() => cropped),
    toPNG: vi.fn(),
    toJPEG: vi.fn(),
  };
  const factory: ElectronNativeImageFactory = {
    createFromBuffer: vi.fn(() => original),
  };
  return { factory, original, cropped, pngBytes, jpegBytes };
}

describe('Electron 语义区域图片裁剪', () => {
  it('按推广排除区起点裁掉 PNG 底部并保留无损编码', async () => {
    const fixture = nativeImageFixture();
    const cropper = createElectronSemanticRegionImageCropper(fixture.factory);

    const result = await cropper({
      source: source('image/png'),
      maximumY: 1_530.4,
    });

    expect(fixture.factory.createFromBuffer).toHaveBeenCalledOnce();
    expect(fixture.factory.createFromBuffer).toHaveBeenCalledWith(
      Buffer.from([10, 20, 30, 40]),
    );
    expect(fixture.original.crop).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 1_170,
      height: 1_530,
    });
    expect(fixture.cropped.toPNG).toHaveBeenCalledOnce();
    expect(fixture.cropped.toJPEG).not.toHaveBeenCalled();
    expect(result).toEqual({
      mimeType: 'image/png',
      bytes: fixture.pngBytes,
    });
  });

  it('对 JPEG 使用高质量 JPEG 编码以控制请求体积', async () => {
    const fixture = nativeImageFixture();
    const cropper = createElectronSemanticRegionImageCropper(fixture.factory);

    const result = await cropper({
      source: source('image/jpeg'),
      maximumY: 1_500,
    });

    expect(fixture.cropped.toJPEG).toHaveBeenCalledWith(95);
    expect(fixture.cropped.toPNG).not.toHaveBeenCalled();
    expect(result).toEqual({
      mimeType: 'image/jpeg',
      bytes: fixture.jpegBytes,
    });
  });

  it('解码失败或边界没有实际裁掉底部时拒绝生成伪裁剪图', async () => {
    const emptyFixture = nativeImageFixture({ empty: true });
    const emptyCropper = createElectronSemanticRegionImageCropper(
      emptyFixture.factory,
    );
    await expect(emptyCropper({
      source: source('image/png'),
      maximumY: 1_500,
    })).rejects.toThrow('无法解码');

    const invalidBoundaryFixture = nativeImageFixture({ height: 1_500 });
    const invalidBoundaryCropper = createElectronSemanticRegionImageCropper(
      invalidBoundaryFixture.factory,
    );
    await expect(invalidBoundaryCropper({
      source: source('image/png'),
      maximumY: 1_500,
    })).rejects.toThrow('裁剪边界无效');
  });
});
