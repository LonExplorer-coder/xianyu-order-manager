import { rm } from 'node:fs/promises';

const RETRYABLE_REMOVE_CODES = new Set([
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'ENOTEMPTY',
  'EPERM',
]);

export async function removeDirectoryWithRetries(path, options = {}) {
  const {
    label = '目录',
    timeoutMs = 30_000,
    retryDelayMs = 250,
    remove = removeDirectory,
    now = Date.now,
    wait = waitFor,
  } = options;
  const deadline = now() + timeoutMs;
  let attempts = 0;

  while (true) {
    attempts += 1;
    try {
      await remove(path);
      return { attempts };
    } catch (error) {
      const code = fileErrorCode(error);
      if (code === 'ENOENT') return { attempts };
      const remainingMs = deadline - now();
      if (!RETRYABLE_REMOVE_CODES.has(code) || remainingMs <= 0 || retryDelayMs <= 0) {
        throw removeFailure(path, label, code, attempts, error);
      }
      await wait(Math.min(retryDelayMs, remainingMs));
    }
  }
}

export async function removeDirectoryBestEffort(path, options = {}) {
  const {
    warn = console.warn,
    ...removeOptions
  } = options;
  const label = removeOptions.label ?? '目录';
  try {
    await removeDirectoryWithRetries(path, removeOptions);
    return true;
  } catch (error) {
    warn(`${label}清理失败，已交由操作系统回收：${errorMessage(error)}`);
    return false;
  }
}

async function removeDirectory(path) {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 0,
  });
}

function waitFor(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function fileErrorCode(error) {
  return error && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN';
}

function removeFailure(path, label, code, attempts, cause) {
  return new Error(
    `${label}删除失败：${code}（已尝试 ${attempts} 次）：${path}`,
    { cause },
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
