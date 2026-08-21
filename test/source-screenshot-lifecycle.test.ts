import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { SourceScreenshotCompressor } from '../src/core/source-screenshot-lifecycle';
import { SourceScreenshotLifecycleService } from '../src/main/source-screenshot-lifecycle-service';
import { Workspace } from '../src/main/workspace';

describe('来源截图文件生命周期', () => {
  it('只把超过 90 天且通过尺寸复验的更小图片替换为高质量压缩图', async () => {
    const fixture = await lifecycleFixture();
    const compressor: SourceScreenshotCompressor = {
      compress: vi.fn(async (bytes) => {
        const marker = bytes.toString();
        if (marker === 'broken-original') throw new Error('无法解码来源截图');
        if (marker === 'mismatched-original') {
          return compressed(Buffer.from('tiny'), { width: 100, height: 200 }, { width: 99, height: 200 });
        }
        return compressed(Buffer.from('jpeg'), { width: 100, height: 200 });
      }),
    };
    const service = new SourceScreenshotLifecycleService({
      dataDirectory: fixture.dataDirectory,
      database: fixture.workspace.database,
      compressor,
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    });

    const result = await service.runAutomaticCompression();

    expect(result).toEqual({
      compressedCount: 1,
      skippedCount: 0,
      failedCount: 2,
      releasedBytes: Buffer.byteLength('old-original-content') - Buffer.byteLength('jpeg'),
    });
    const old = screenshotRow(fixture.workspace, 'old');
    expect(old).toMatchObject({
      storage_state: 'compressed',
      mime_type: 'image/jpeg',
      original_relative_path: 'screenshots/old.png',
      original_bytes: Buffer.byteLength('old-original-content'),
      current_bytes: Buffer.byteLength('jpeg'),
      compressed_at: '2026-08-21T12:00:00.000Z',
      deleted_at: null,
    });
    expect(await readFile(join(fixture.dataDirectory, old.relative_path), 'utf8')).toBe('jpeg');
    await expect(access(join(fixture.dataDirectory, 'screenshots/old.png'))).rejects.toThrow();

    expect(screenshotRow(fixture.workspace, 'recent').storage_state).toBe('original');
    expect(await readFile(join(fixture.dataDirectory, 'screenshots/recent.png'), 'utf8'))
      .toBe('recent-original');
    for (const id of ['broken', 'mismatched']) {
      const row = screenshotRow(fixture.workspace, id);
      expect(row.storage_state).toBe('original');
      expect(row.relative_path).toBe(`screenshots/${id}.png`);
      expect(await readFile(join(fixture.dataDirectory, row.relative_path), 'utf8'))
        .toContain('original');
    }
    fixture.workspace.close();
  });

  it('默认永不清理，选择 180 天后先预览预计空间并以同一预览二次确认', async () => {
    const fixture = await lifecycleFixture();
    const service = new SourceScreenshotLifecycleService({
      dataDirectory: fixture.dataDirectory,
      database: fixture.workspace.database,
      compressor: unusedCompressor(),
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    });

    expect(service.getSettings()).toEqual({ cleanupAfterDays: null });
    expect(await service.previewCleanup()).toEqual({
      enabled: false,
      cleanupAfterDays: null,
      candidateCount: 0,
      estimatedBytes: 0,
      candidates: [],
      previewToken: null,
    });

    expect(service.saveSettings({ cleanupAfterDays: 180 }))
      .toEqual({ cleanupAfterDays: 180 });
    const preview = await service.previewCleanup();
    expect(preview.enabled).toBe(true);
    expect(preview.candidates.map(({ screenshotId }) => screenshotId).sort())
      .toEqual(['broken', 'mismatched', 'old']);
    expect(preview.candidateCount).toBe(3);
    expect(preview.estimatedBytes).toBe(
      Buffer.byteLength('old-original-content')
      + Buffer.byteLength('broken-original')
      + Buffer.byteLength('mismatched-original'),
    );

    const deleted = await service.confirmCleanup(preview.previewToken!);

    expect(deleted).toEqual({
      deletedCount: 3,
      releasedBytes: preview.estimatedBytes,
    });
    for (const id of ['broken', 'mismatched', 'old']) {
      const row = screenshotRow(fixture.workspace, id);
      expect(row.storage_state).toBe('deleted');
      expect(row.current_bytes).toBe(0);
      expect(row.deleted_at).toBe('2026-08-21T12:00:00.000Z');
      await expect(access(join(fixture.dataDirectory, row.relative_path))).rejects.toThrow();
    }
    expect(screenshotRow(fixture.workspace, 'recent').storage_state).toBe('original');
    expect(fixture.workspace.database.prepare(
      'SELECT COUNT(*) AS count FROM source_screenshots',
    ).get()).toEqual({ count: 4 });
    fixture.workspace.close();
  });

  it('预览过期或数据库更新失败时拒绝删除并恢复来源截图文件', async () => {
    const fixture = await lifecycleFixture();
    const service = new SourceScreenshotLifecycleService({
      dataDirectory: fixture.dataDirectory,
      database: fixture.workspace.database,
      compressor: unusedCompressor(),
      now: () => new Date('2026-08-21T12:00:00.000Z'),
    });
    service.saveSettings({ cleanupAfterDays: 180 });
    const preview = await service.previewCleanup();
    service.saveSettings({ cleanupAfterDays: 365 });

    await expect(service.confirmCleanup(preview.previewToken!))
      .rejects.toThrow('来源截图清理预览已过期');
    expect(screenshotRow(fixture.workspace, 'old').storage_state).toBe('original');

    fixture.workspace.database.exec(`
      CREATE TRIGGER test_reject_screenshot_delete
      BEFORE UPDATE OF storage_state ON source_screenshots
      WHEN NEW.id = 'old' AND NEW.storage_state = 'deleted'
      BEGIN
        SELECT RAISE(ABORT, 'test delete rejected');
      END;
    `);
    const single = await service.previewSingleDelete('old');
    await expect(service.deleteScreenshot(single.screenshotId))
      .rejects.toThrow('test delete rejected');
    expect(await readFile(join(fixture.dataDirectory, 'screenshots/old.png'), 'utf8'))
      .toBe('old-original-content');
    expect(screenshotRow(fixture.workspace, 'old').storage_state).toBe('original');
    fixture.workspace.close();
  });
});

async function lifecycleFixture() {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-screenshot-lifecycle-'));
  const workspace = Workspace.open(dataDirectory);
  await mkdir(join(dataDirectory, 'screenshots'), { recursive: true });
  workspace.database.prepare(`
    INSERT INTO recognition_batches (id, platform, seller_account, status, created_at)
    VALUES ('batch', 'xianyu', '生命周期测试账号', 'completed', ?)
  `).run('2026-01-01T00:00:00.000Z');
  const rows = [
    ['old', 'old-original-content', '2026-01-01T00:00:00.000Z'],
    ['broken', 'broken-original', '2026-01-02T00:00:00.000Z'],
    ['mismatched', 'mismatched-original', '2026-01-03T00:00:00.000Z'],
    ['recent', 'recent-original', '2026-08-01T00:00:00.000Z'],
  ] as const;
  for (const [id, content, createdAt] of rows) {
    const relativePath = `screenshots/${id}.png`;
    await writeFile(join(dataDirectory, relativePath), content);
    workspace.database.prepare(`
      INSERT INTO source_screenshots (
        id, batch_id, original_name, relative_path, content_sha256, mime_type, created_at
      ) VALUES (?, 'batch', ?, ?, ?, 'image/png', ?)
    `).run(id, `${id}.png`, relativePath, `sha-${id}`, createdAt);
  }
  return { dataDirectory, workspace };
}

function screenshotRow(workspace: Workspace, id: string) {
  return workspace.database.prepare(`
    SELECT storage_state, relative_path, original_relative_path, mime_type,
      original_bytes, current_bytes, compressed_at, deleted_at
    FROM source_screenshots
    WHERE id = ?
  `).get(id) as {
    storage_state: string;
    relative_path: string;
    original_relative_path: string | null;
    mime_type: string;
    original_bytes: number | null;
    current_bytes: number | null;
    compressed_at: string | null;
    deleted_at: string | null;
  };
}

function compressed(
  bytes: Buffer,
  sourceSize = { width: 100, height: 200 },
  outputSize = sourceSize,
) {
  return { bytes, mimeType: 'image/jpeg' as const, sourceSize, outputSize };
}

function unusedCompressor(): SourceScreenshotCompressor {
  return { compress: vi.fn(async () => { throw new Error('不应压缩'); }) };
}
