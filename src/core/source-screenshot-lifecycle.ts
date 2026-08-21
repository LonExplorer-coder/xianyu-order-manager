export type SourceScreenshotStorageState = 'original' | 'compressed' | 'deleted';
export type SourceScreenshotCleanupAfterDays = 180 | 365 | null;

export interface SourceScreenshotLifecycleSettings {
  cleanupAfterDays: SourceScreenshotCleanupAfterDays;
}

export interface SourceScreenshotImageSize {
  width: number;
  height: number;
}

export interface CompressedSourceScreenshot {
  bytes: Buffer;
  mimeType: 'image/jpeg';
  sourceSize: SourceScreenshotImageSize;
  outputSize: SourceScreenshotImageSize;
}

export interface SourceScreenshotCompressor {
  compress(bytes: Buffer, mimeType: string): Promise<CompressedSourceScreenshot>;
}

export interface SourceScreenshotCompressionResult {
  compressedCount: number;
  skippedCount: number;
  failedCount: number;
  releasedBytes: number;
}

export interface SourceScreenshotCleanupCandidate {
  screenshotId: string;
  originalName: string;
  createdAt: string;
  currentBytes: number;
}

export interface SourceScreenshotCleanupPreview {
  enabled: boolean;
  cleanupAfterDays: SourceScreenshotCleanupAfterDays;
  candidateCount: number;
  estimatedBytes: number;
  candidates: SourceScreenshotCleanupCandidate[];
  previewToken: string | null;
}

export interface SourceScreenshotCleanupResult {
  deletedCount: number;
  releasedBytes: number;
}

export interface SourceScreenshotSingleDeletePreview {
  screenshotId: string;
  originalName: string;
  currentBytes: number;
}

export function isSourceScreenshotCleanupAfterDays(
  value: unknown,
): value is SourceScreenshotCleanupAfterDays {
  return value === null || value === 180 || value === 365;
}
