export type MobileUploadStatus =
  | { enabled: false }
  | MobileUploadSessionView;

export interface MobileUploadSessionView {
  enabled: true;
  url: string;
  qrDataUrl: string;
  accessCode: string;
  expiresAt: string;
}

export const MOBILE_UPLOAD_SESSION_DURATION_MS = 10 * 60 * 1000;
export const MOBILE_UPLOAD_MAX_FILES = 50;
