import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  isSourceScreenshotCleanupAfterDays,
  type SourceScreenshotCleanupAfterDays,
  type SourceScreenshotCleanupCandidate,
  type SourceScreenshotCleanupPreview,
  type SourceScreenshotCleanupResult,
  type SourceScreenshotCompressor,
  type SourceScreenshotCompressionResult,
  type SourceScreenshotLifecycleSettings,
  type SourceScreenshotSingleDeletePreview,
  type SourceScreenshotStorageState,
} from '../core/source-screenshot-lifecycle';

const COMPRESSION_AFTER_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

interface SourceScreenshotLifecycleServiceOptions {
  dataDirectory: string;
  database: DatabaseSync;
  compressor: SourceScreenshotCompressor;
  now?: () => Date;
}

interface ScreenshotRow {
  id: string;
  original_name: string;
  relative_path: string;
  original_relative_path: string | null;
  delete_source_relative_path: string | null;
  mime_type: string;
  storage_state: SourceScreenshotStorageState;
  original_bytes: number | null;
  current_bytes: number | null;
  created_at: string;
}

export class SourceScreenshotLifecycleService {
  private readonly dataDirectory: string;
  private readonly database: DatabaseSync;
  private readonly compressor: SourceScreenshotCompressor;
  private readonly now: () => Date;

  public constructor(options: SourceScreenshotLifecycleServiceOptions) {
    this.dataDirectory = resolve(options.dataDirectory);
    this.database = options.database;
    this.compressor = options.compressor;
    this.now = options.now ?? (() => new Date());
  }

  public getSettings(): SourceScreenshotLifecycleSettings {
    const row = this.database.prepare(`
      SELECT cleanup_after_days
      FROM source_screenshot_lifecycle_settings
      WHERE id = 1
    `).get() as { cleanup_after_days: number | null } | undefined;
    const cleanupAfterDays = row?.cleanup_after_days ?? null;
    if (!isSourceScreenshotCleanupAfterDays(cleanupAfterDays)) {
      throw new Error('来源截图清理策略格式无效');
    }
    return { cleanupAfterDays };
  }

  public saveSettings(
    settings: SourceScreenshotLifecycleSettings,
  ): SourceScreenshotLifecycleSettings {
    if (!isSourceScreenshotCleanupAfterDays(settings.cleanupAfterDays)) {
      throw new Error('来源截图清理策略只能选择永不清理、180 天或 365 天');
    }
    this.database.prepare(`
      INSERT INTO source_screenshot_lifecycle_settings (id, cleanup_after_days, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        cleanup_after_days = excluded.cleanup_after_days,
        updated_at = excluded.updated_at
    `).run(settings.cleanupAfterDays, this.now().toISOString());
    return this.getSettings();
  }

  public async runAutomaticCompression(): Promise<SourceScreenshotCompressionResult> {
    await this.removeDeletedArtifacts();
    await this.removeRetainedOriginalCopies();
    const cutoff = this.now().getTime() - (COMPRESSION_AFTER_DAYS * DAY_MS);
    const candidates = this.listRows().filter((row) => (
      row.storage_state === 'original' && instant(row.created_at) <= cutoff
    ));
    const result: SourceScreenshotCompressionResult = {
      compressedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      releasedBytes: 0,
    };
    for (const row of candidates) {
      try {
        const outcome = await this.compressOne(row);
        if (outcome === null) {
          result.skippedCount += 1;
        } else {
          result.compressedCount += 1;
          result.releasedBytes += outcome;
        }
      } catch {
        result.failedCount += 1;
      }
      await new Promise<void>((resolveYield) => setImmediate(resolveYield));
    }
    return result;
  }

  public async previewCleanup(): Promise<SourceScreenshotCleanupPreview> {
    await this.removeDeletedArtifacts();
    const { cleanupAfterDays } = this.getSettings();
    if (cleanupAfterDays === null) return disabledCleanupPreview();
    const candidates = await this.cleanupCandidates(cleanupAfterDays);
    return cleanupPreview(cleanupAfterDays, candidates);
  }

  public async confirmCleanup(previewToken: string): Promise<SourceScreenshotCleanupResult> {
    const current = await this.previewCleanup();
    if (!current.enabled || current.previewToken !== previewToken) {
      throw new Error('来源截图清理预览已过期，请重新预览后确认');
    }
    let deletedCount = 0;
    let releasedBytes = 0;
    for (const candidate of current.candidates) {
      const released = await this.deleteScreenshot(candidate.screenshotId);
      deletedCount += released.deletedCount;
      releasedBytes += released.releasedBytes;
    }
    return { deletedCount, releasedBytes };
  }

  public async previewSingleDelete(
    screenshotId: string,
  ): Promise<SourceScreenshotSingleDeletePreview> {
    const row = this.requireActiveRow(screenshotId);
    return {
      screenshotId: row.id,
      originalName: row.original_name,
      currentBytes: await this.fileBytes(row),
    };
  }

  public async deleteScreenshot(screenshotId: string): Promise<SourceScreenshotCleanupResult> {
    const row = this.requireActiveRow(screenshotId);
    const sourcePath = this.resolveStoredPath(row.relative_path);
    const currentBytes = await this.fileBytes(row);
    const holdingRelativePath = currentBytes > 0
      ? `.source-screenshot-trash/${randomUUID()}.image`
      : row.relative_path;
    const holdingPath = this.resolveStoredPath(holdingRelativePath);
    let holdingCreated = false;
    try {
      if (currentBytes > 0) {
        const recoverableBytes = await readFile(sourcePath);
        await mkdir(dirname(holdingPath), { recursive: true });
        await writeFile(holdingPath, recoverableBytes, { flag: 'wx' });
        if (!(await readFile(holdingPath)).equals(recoverableBytes)) {
          throw new Error('来源截图清理回滚副本校验失败');
        }
        holdingCreated = true;
      }
      this.database.exec('BEGIN IMMEDIATE;');
      try {
        const update = this.database.prepare(`
          UPDATE source_screenshots
          SET storage_state = 'deleted',
              delete_source_relative_path = relative_path,
              relative_path = ?,
              original_bytes = COALESCE(original_bytes, ?),
              current_bytes = 0,
              deleted_at = ?
          WHERE id = ? AND storage_state <> 'deleted'
        `).run(holdingRelativePath, currentBytes, this.now().toISOString(), row.id);
        if (update.changes !== 1) throw new Error('来源截图存储状态已变化，请重新预览');
        this.database.exec('COMMIT;');
      } catch (error) {
        rollbackQuietly(this.database);
        throw error;
      }
    } catch (error) {
      if (holdingCreated) await rm(holdingPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await unlink(sourcePath).catch(() => undefined);
    if (holdingCreated) await unlink(holdingPath).catch(() => undefined);
    await this.removeOriginalCopy(row);
    return { deletedCount: 1, releasedBytes: currentBytes };
  }

  private async compressOne(row: ScreenshotRow): Promise<number | null> {
    const sourcePath = this.resolveStoredPath(row.relative_path);
    const original = await readFile(sourcePath);
    const compressed = await this.compressor.compress(original, row.mime_type);
    if (
      compressed.bytes.length === 0
      || compressed.sourceSize.width <= 0
      || compressed.sourceSize.height <= 0
      || compressed.outputSize.width !== compressed.sourceSize.width
      || compressed.outputSize.height !== compressed.sourceSize.height
    ) {
      throw new Error('来源截图压缩结果尺寸复验失败');
    }
    if (compressed.bytes.length >= original.length) return null;

    const finalRelativePath = `screenshots/${row.id}.compressed.jpg`;
    const finalPath = this.resolveStoredPath(finalRelativePath);
    const temporaryPath = `${finalPath}.tmp-${randomUUID()}`;
    await mkdir(dirname(finalPath), { recursive: true });
    await rm(finalPath, { force: true });
    try {
      await writeFile(temporaryPath, compressed.bytes, { flag: 'wx' });
      if (!(await readFile(temporaryPath)).equals(compressed.bytes)) {
        throw new Error('来源截图压缩文件写入校验失败');
      }
      await rename(temporaryPath, finalPath);
      this.database.exec('BEGIN IMMEDIATE;');
      try {
        const update = this.database.prepare(`
          UPDATE source_screenshots
          SET storage_state = 'compressed',
              original_relative_path = relative_path,
              delete_source_relative_path = NULL,
              relative_path = ?,
              mime_type = ?,
              original_bytes = ?,
              current_bytes = ?,
              compressed_at = ?,
              deleted_at = NULL
          WHERE id = ? AND storage_state = 'original'
        `).run(
          finalRelativePath,
          compressed.mimeType,
          original.length,
          compressed.bytes.length,
          this.now().toISOString(),
          row.id,
        );
        if (update.changes !== 1) throw new Error('来源截图存储状态已变化，请重试');
        this.database.exec('COMMIT;');
      } catch (error) {
        rollbackQuietly(this.database);
        throw error;
      }
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      await rm(finalPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await unlink(sourcePath).catch(() => undefined);
    return original.length - compressed.bytes.length;
  }

  private async cleanupCandidates(
    cleanupAfterDays: Exclude<SourceScreenshotCleanupAfterDays, null>,
  ): Promise<SourceScreenshotCleanupCandidate[]> {
    const cutoff = this.now().getTime() - (cleanupAfterDays * DAY_MS);
    const candidates: SourceScreenshotCleanupCandidate[] = [];
    for (const row of this.listRows()) {
      if (row.storage_state === 'deleted' || instant(row.created_at) > cutoff) continue;
      candidates.push({
        screenshotId: row.id,
        originalName: row.original_name,
        createdAt: row.created_at,
        currentBytes: await this.fileBytes(row),
      });
    }
    return candidates.sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt)
      || left.screenshotId.localeCompare(right.screenshotId)
    ));
  }

  private listRows(): ScreenshotRow[] {
    return this.database.prepare(`
      SELECT id, original_name, relative_path, original_relative_path,
        delete_source_relative_path,
        mime_type, storage_state, original_bytes, current_bytes, created_at
      FROM source_screenshots
      ORDER BY created_at, id
    `).all() as unknown as ScreenshotRow[];
  }

  private requireActiveRow(screenshotId: string): ScreenshotRow {
    const row = this.database.prepare(`
      SELECT id, original_name, relative_path, original_relative_path,
        delete_source_relative_path,
        mime_type, storage_state, original_bytes, current_bytes, created_at
      FROM source_screenshots
      WHERE id = ?
    `).get(screenshotId) as unknown as ScreenshotRow | undefined;
    if (!row) throw new Error('未找到来源截图');
    if (row.storage_state === 'deleted') throw new Error('来源截图已清理');
    return row;
  }

  private async fileBytes(row: ScreenshotRow): Promise<number> {
    try {
      return (await stat(this.resolveStoredPath(row.relative_path))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  private async removeRetainedOriginalCopies(): Promise<void> {
    for (const row of this.listRows()) {
      if (row.storage_state === 'compressed') await this.removeOriginalCopy(row);
    }
  }

  private async removeDeletedArtifacts(): Promise<void> {
    for (const row of this.listRows()) {
      if (row.storage_state !== 'deleted') continue;
      await unlink(this.resolveStoredPath(row.relative_path)).catch(() => undefined);
      if (row.delete_source_relative_path) {
        await unlink(this.resolveStoredPath(row.delete_source_relative_path))
          .catch(() => undefined);
      }
      await this.removeOriginalCopy(row);
    }
    await rm(this.resolveStoredPath('.source-screenshot-trash'), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }

  private async removeOriginalCopy(row: ScreenshotRow): Promise<void> {
    if (!row.original_relative_path || row.original_relative_path === row.relative_path) return;
    await unlink(this.resolveStoredPath(row.original_relative_path)).catch(() => undefined);
  }

  private resolveStoredPath(relativePath: string): string {
    if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\\')) {
      throw new Error('来源截图路径无效');
    }
    const resolvedPath = resolve(this.dataDirectory, relativePath);
    if (!resolvedPath.startsWith(`${this.dataDirectory}${sep}`)) {
      throw new Error('来源截图路径超出数据目录');
    }
    return resolvedPath;
  }
}

function cleanupPreview(
  cleanupAfterDays: Exclude<SourceScreenshotCleanupAfterDays, null>,
  candidates: SourceScreenshotCleanupCandidate[],
): SourceScreenshotCleanupPreview {
  const estimatedBytes = candidates.reduce((sum, candidate) => sum + candidate.currentBytes, 0);
  const tokenPayload = JSON.stringify({ cleanupAfterDays, candidates });
  return {
    enabled: true,
    cleanupAfterDays,
    candidateCount: candidates.length,
    estimatedBytes,
    candidates,
    previewToken: createHash('sha256').update(tokenPayload).digest('hex'),
  };
}

function disabledCleanupPreview(): SourceScreenshotCleanupPreview {
  return {
    enabled: false,
    cleanupAfterDays: null,
    candidateCount: 0,
    estimatedBytes: 0,
    candidates: [],
    previewToken: null,
  };
}

function instant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('来源截图时间格式无效');
  return parsed;
}

function rollbackQuietly(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK;');
  } catch {
    // Preserve the original failure.
  }
}
