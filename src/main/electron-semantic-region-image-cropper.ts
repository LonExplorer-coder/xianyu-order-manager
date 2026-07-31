import type {
  SemanticRegionImageCropper,
} from '../adapters/recognition/bailian-ocr-client';

type ImageSize = {
  width: number;
  height: number;
};

type CropRectangle = ImageSize & {
  x: number;
  y: number;
};

export type ElectronNativeImageLike = {
  isEmpty(): boolean;
  getSize(): ImageSize;
  crop(rectangle: CropRectangle): ElectronNativeImageLike;
  toPNG(): Buffer;
  toJPEG(quality: number): Buffer;
};

export type ElectronNativeImageFactory = {
  createFromBuffer(buffer: Buffer): ElectronNativeImageLike;
};

export function createElectronSemanticRegionImageCropper(
  nativeImage: ElectronNativeImageFactory,
): SemanticRegionImageCropper {
  return async ({ source, maximumY }) => {
    const original = nativeImage.createFromBuffer(Buffer.from(source.bytes));
    if (original.isEmpty()) {
      throw new Error('无法解码待识别的订单截图');
    }
    const { width, height } = original.getSize();
    // Electron crop rectangles are half-open in practice: height N keeps rows
    // 0..N-1. Flooring therefore guarantees that no pixel at/after the
    // promotion boundary can enter the second OCR request.
    const cropHeight = Math.floor(maximumY);
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 2 ||
      !Number.isFinite(maximumY) ||
      cropHeight < 1 ||
      cropHeight >= height
    ) {
      throw new Error('订单截图的语义区域裁剪边界无效');
    }
    const cropped = original.crop({
      x: 0,
      y: 0,
      width,
      height: cropHeight,
    });
    if (cropped.isEmpty()) {
      throw new Error('订单截图裁剪后没有有效图片内容');
    }
    const output = source.mimeType === 'image/jpeg'
      ? { mimeType: 'image/jpeg' as const, bytes: cropped.toJPEG(95) }
      : { mimeType: 'image/png' as const, bytes: cropped.toPNG() };
    if (output.bytes.byteLength === 0) {
      throw new Error('订单截图裁剪后无法生成图片');
    }
    return output;
  };
}
