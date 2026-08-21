import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { PortableUpdateService } from '../src/main/portable-update-service';

describe('便携版更新检查与下载', () => {
  it('只把更高正式版本且 ZIP 与更新证据完整匹配的 GitHub Release 作为更新候选', async () => {
    const fixture = await updateFixture({ releaseVersion: '0.3.0' });
    const service = new PortableUpdateService(fixture.options);

    const view = await service.checkForUpdate();

    expect(view).toMatchObject({
      currentVersion: '0.2.68',
      status: 'available',
      candidate: {
        version: '0.3.0',
        name: '稳定版 0.3.0',
        archiveFile: 'XianyuOrderManager-darwin-arm64-0.3.0.zip',
        archiveBytes: fixture.archive.length,
        publishedAt: '2026-08-22T02:00:00.000Z',
      },
    });
    expect(view.candidate?.releaseNotes).toContain('更新说明');
    expect(fixture.fetcher).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/LonExplorer-coder/xianyu-order-manager/releases/latest',
      expect.objectContaining({ headers: expect.objectContaining({
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }) }),
    );
  });

  it('当前已是最新版时不下载资产，草稿、预发布或证据不匹配时拒绝形成候选', async () => {
    const current = await updateFixture({ releaseVersion: '0.2.68' });
    await expect(new PortableUpdateService(current.options).checkForUpdate())
      .resolves.toMatchObject({ status: 'up_to_date', candidate: null });
    expect(current.fetcher).toHaveBeenCalledTimes(1);

    for (const overrides of [
      { draft: true },
      { prerelease: true },
      { evidencePatch: { platform: 'win32' } },
      { evidencePatch: { archiveSha256: '0'.repeat(64) } },
    ]) {
      const invalid = await updateFixture({ releaseVersion: '0.3.0', ...overrides });
      await expect(new PortableUpdateService(invalid.options).checkForUpdate())
        .rejects.toThrow(/更新|发布|证据/u);
    }
  });

  it('用户触发下载后流式写入更新暂存区并按更新证据复算 SHA-256', async () => {
    const fixture = await updateFixture({ releaseVersion: '0.3.0' });
    const service = new PortableUpdateService(fixture.options);
    const available = await service.checkForUpdate();

    const downloaded = await service.downloadUpdate(available.candidate!.id);

    expect(downloaded).toMatchObject({
      status: 'downloaded',
      candidate: { version: '0.3.0' },
      downloaded: {
        archiveSha256: sha256(fixture.archive),
        archiveBytes: fixture.archive.length,
      },
    });
    expect(await readFile(downloaded.downloaded!.archivePath)).toEqual(fixture.archive);
    expect(downloaded.downloaded!.archivePath).toContain(join('updates', '0.3.0'));
    await expect(service.verifyDownloadedUpdate(downloaded.candidate!.id))
      .resolves.toMatchObject({ archivePath: downloaded.downloaded!.archivePath });
    await writeFile(downloaded.downloaded!.archivePath, 'changed-after-download');
    await expect(service.verifyDownloadedUpdate(downloaded.candidate!.id))
      .rejects.toThrow(/大小|SHA-256/u);
  });

  it('下载大小或 SHA-256 不匹配时删除未完成文件且不进入可应用状态', async () => {
    const fixture = await updateFixture({
      releaseVersion: '0.3.0',
      downloadedArchive: Buffer.from('tampered'),
    });
    const service = new PortableUpdateService(fixture.options);
    const available = await service.checkForUpdate();

    await expect(service.downloadUpdate(available.candidate!.id))
      .rejects.toThrow(/大小|SHA-256/u);
    expect(service.getView().status).toBe('available');
    await expect(access(join(
      fixture.updatesDirectory,
      '0.3.0',
      'XianyuOrderManager-darwin-arm64-0.3.0.zip',
    ))).rejects.toThrow();
  });
});

async function updateFixture(input: {
  releaseVersion: string;
  draft?: boolean;
  prerelease?: boolean;
  evidencePatch?: Record<string, unknown>;
  downloadedArchive?: Buffer;
}) {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-portable-update-'));
  const updatesDirectory = join(root, 'updates');
  const archive = Buffer.from('verified-portable-archive');
  const archiveFile = `XianyuOrderManager-darwin-arm64-${input.releaseVersion}.zip`;
  const evidenceFile = 'portable-darwin-arm64.json';
  const archiveUrl = `https://github.com/LonExplorer-coder/xianyu-order-manager/releases/download/v${input.releaseVersion}/${archiveFile}`;
  const evidenceUrl = `https://github.com/LonExplorer-coder/xianyu-order-manager/releases/download/v${input.releaseVersion}/${evidenceFile}`;
  const evidence = {
    schemaVersion: 1,
    version: input.releaseVersion,
    gitCommit: 'a'.repeat(40),
    gitDirty: false,
    platform: 'darwin',
    architecture: 'arm64',
    archiveFile,
    archiveSha256: sha256(archive),
    verifiedAt: '2026-08-22T02:00:00.000Z',
    checks: {
      archiveExtracted: true,
      packagedCredentialStore: true,
      packagedScreenshotCompression: true,
      dataDirectorySelected: true,
      orderImported: true,
      firstProgramDirectoryRemoved: true,
      replacementProgramReadExistingOrder: true,
      updateCandidateBackupSmoke: true,
    },
    ...input.evidencePatch,
  };
  const release = {
    id: 300,
    tag_name: `v${input.releaseVersion}`,
    name: `稳定版 ${input.releaseVersion}`,
    body: '本次更新说明',
    draft: input.draft ?? false,
    prerelease: input.prerelease ?? false,
    published_at: '2026-08-22T02:00:00.000Z',
    html_url: `https://github.com/LonExplorer-coder/xianyu-order-manager/releases/tag/v${input.releaseVersion}`,
    assets: [
      { id: 1, name: archiveFile, size: archive.length, browser_download_url: archiveUrl },
      { id: 2, name: evidenceFile, size: JSON.stringify(evidence).length, browser_download_url: evidenceUrl },
    ],
  };
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes('/releases/latest')) return jsonResponse(release);
    if (url === evidenceUrl) return jsonResponse(evidence);
    if (url === archiveUrl) {
      return new Response(new Uint8Array(input.downloadedArchive ?? archive), {
        status: 200,
        headers: { 'content-length': String((input.downloadedArchive ?? archive).length) },
      });
    }
    return new Response('not found', { status: 404 });
  });
  return {
    archive,
    updatesDirectory,
    fetcher,
    options: {
      currentVersion: '0.2.68',
      platform: 'darwin' as const,
      architecture: 'arm64' as const,
      updatesDirectory,
      fetcher,
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
