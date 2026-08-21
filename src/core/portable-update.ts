export type PortableUpdatePlatform = 'darwin' | 'win32';
export type PortableUpdateArchitecture = 'arm64' | 'x64';

export interface PortableUpdateCandidateView {
  id: string;
  version: string;
  name: string;
  releaseNotes: string;
  publishedAt: string;
  releaseUrl: string;
  archiveFile: string;
  archiveBytes: number;
}

export interface DownloadedPortableUpdateView {
  archivePath: string;
  archiveSha256: string;
  archiveBytes: number;
}

export type PortableUpdateStatus = 'idle' | 'up_to_date' | 'available' | 'downloaded';

export interface PortableUpdateLastApplyResult {
  status: 'applying' | 'succeeded' | 'failed';
  version: string;
  message: string;
  occurredAt: string;
}

export interface PortableUpdateView {
  currentVersion: string;
  status: PortableUpdateStatus;
  candidate: PortableUpdateCandidateView | null;
  downloaded: DownloadedPortableUpdateView | null;
  lastApplyResult?: PortableUpdateLastApplyResult | null;
}

export interface PortableUpdateApplyResult {
  started: true;
  version: string;
  backupDirectory: string;
}
