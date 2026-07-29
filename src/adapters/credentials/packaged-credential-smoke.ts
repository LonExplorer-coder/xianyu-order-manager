import { AsyncEntry } from '@napi-rs/keyring';
import { randomUUID } from 'node:crypto';

export async function runPackagedCredentialStoreSmoke(): Promise<void> {
  const marker = `temporary-${randomUUID()}`;
  const account = `packaged-credential-smoke-${randomUUID()}`;
  const entry = new AsyncEntry(
    'com.lonexplorer.xianyu-order-manager.smoke',
    account,
  );
  let operationError: unknown = null;
  let cleanupError: unknown = null;

  try {
    await entry.setPassword(marker);
    if ((await entry.getPassword()) !== marker) {
      throw new Error('系统凭据读回结果不一致');
    }
  } catch (error) {
    operationError = error;
  }

  try {
    await entry.deleteCredential();
    if ((await entry.getPassword()) !== null) {
      throw new Error('临时系统凭据未被清理');
    }
  } catch (error) {
    cleanupError = error;
  }

  if (operationError || cleanupError) {
    throw new Error(
      [
        operationError ? `operation: ${safeError(operationError, marker)}` : null,
        cleanupError
          ? `cleanup account=${account}: ${safeError(cleanupError, marker)}`
          : null,
      ]
        .filter(Boolean)
        .join('; '),
    );
  }
}

function safeError(error: unknown, marker: string): string {
  if (!(error instanceof Error)) return 'unknown error';
  const details = error as Error & { code?: unknown };
  const code = details.code === undefined ? '' : ` code=${String(details.code)}`;
  const cause = error.cause === undefined ? '' : ` cause=${safeError(error.cause, marker)}`;
  return `${error.name}: ${error.message.replaceAll(marker, '<redacted>')}${code}${cause}`;
}
