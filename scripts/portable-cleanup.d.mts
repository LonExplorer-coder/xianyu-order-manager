export type RemoveDirectoryOptions = {
  label?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  remove?: (path: string) => Promise<void>;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
};

export type BestEffortRemoveDirectoryOptions = RemoveDirectoryOptions & {
  warn?: (message: string) => void;
};

export function removeDirectoryWithRetries(
  path: string,
  options?: RemoveDirectoryOptions,
): Promise<{ attempts: number }>;

export function removeDirectoryBestEffort(
  path: string,
  options?: BestEffortRemoveDirectoryOptions,
): Promise<boolean>;
