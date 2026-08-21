export const SOURCE_SCREENSHOT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;
export const SOURCE_SCREENSHOT_MAX_BYTES = 7_500_000;

export const SOURCE_SCREENSHOT_MIME_BY_EXTENSION = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);
