import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { clean as cleanVersion, gt as versionGreaterThan, valid as validVersion } from 'semver';

import type {
  PortableUpdateArchitecture,
  PortableUpdateCandidateView,
  PortableUpdatePlatform,
  PortableUpdateView,
} from '../core/portable-update';

const RELEASE_API_URL =
  'https://api.github.com/repos/LonExplorer-coder/xianyu-order-manager/releases/latest';
const RELEASE_DOWNLOAD_PATH_PREFIX =
  '/LonExplorer-coder/xianyu-order-manager/releases/download/';
const JSON_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const UPDATE_ARCHIVE_LIMIT_BYTES = 1024 * 1024 * 1024;
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'xianyu-order-manager-updater',
};

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

interface PortableUpdateServiceOptions {
  currentVersion: string;
  platform: PortableUpdatePlatform;
  architecture: PortableUpdateArchitecture;
  updatesDirectory: string;
  fetcher?: Fetcher;
}

interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  browserDownloadUrl: string;
}

interface PortableEvidence {
  version: string;
  platform: PortableUpdatePlatform;
  architecture: PortableUpdateArchitecture;
  archiveFile: string;
  archiveSha256: string;
  raw: string;
}

interface InternalCandidate {
  view: PortableUpdateCandidateView;
  archive: ReleaseAsset;
  evidence: ReleaseAsset;
  parsedEvidence: PortableEvidence;
}

export interface PreparedPortableUpdate {
  candidate: PortableUpdateCandidateView;
  archivePath: string;
  evidencePath: string;
}

export class PortableUpdateService {
  private readonly currentVersion: string;
  private readonly platform: PortableUpdatePlatform;
  private readonly architecture: PortableUpdateArchitecture;
  private readonly updatesDirectory: string;
  private readonly fetcher: Fetcher;
  private candidate: InternalCandidate | null = null;
  private view: PortableUpdateView;

  public constructor(options: PortableUpdateServiceOptions) {
    const currentVersion = cleanVersion(options.currentVersion);
    if (!currentVersion || !validVersion(currentVersion)) {
      throw new Error('当前应用版本格式无效，无法检查更新');
    }
    this.currentVersion = currentVersion;
    this.platform = options.platform;
    this.architecture = options.architecture;
    this.updatesDirectory = resolve(options.updatesDirectory);
    this.fetcher = options.fetcher ?? fetch;
    this.view = {
      currentVersion,
      status: 'idle',
      candidate: null,
      downloaded: null,
    };
  }

  public getView(): PortableUpdateView {
    return structuredClone(this.view);
  }

  public async checkForUpdate(): Promise<PortableUpdateView> {
    this.candidate = null;
    this.view = {
      currentVersion: this.currentVersion,
      status: 'idle',
      candidate: null,
      downloaded: null,
    };
    const release = parseLatestRelease(await fetchLimitedJson(
      this.fetcher,
      RELEASE_API_URL,
      JSON_RESPONSE_LIMIT_BYTES,
      GITHUB_HEADERS,
    ));
    if (release.draft || release.prerelease) {
      throw new Error('GitHub latest release 不是可安装的正式发布');
    }
    const releaseVersion = cleanVersion(release.tagName);
    if (!releaseVersion || !validVersion(releaseVersion)) {
      throw new Error('GitHub 发布版本格式无效');
    }
    if (!versionGreaterThan(releaseVersion, this.currentVersion)) {
      this.candidate = null;
      this.view = {
        currentVersion: this.currentVersion,
        status: 'up_to_date',
        candidate: null,
        downloaded: null,
      };
      return this.getView();
    }

    const archiveFile = portableArchiveFile(
      this.platform,
      this.architecture,
      releaseVersion,
    );
    const evidenceFile = `portable-${this.platform}-${this.architecture}.json`;
    const archive = requireReleaseAsset(release.assets, archiveFile, '便携版 ZIP');
    const evidence = requireReleaseAsset(release.assets, evidenceFile, '更新证据');
    validateReleaseAsset(archive, UPDATE_ARCHIVE_LIMIT_BYTES);
    validateReleaseAsset(evidence, JSON_RESPONSE_LIMIT_BYTES);
    const evidenceResponse = await fetchLimitedText(
      this.fetcher,
      evidence.browserDownloadUrl,
      JSON_RESPONSE_LIMIT_BYTES,
    );
    const parsedEvidence = parsePortableEvidence(evidenceResponse, {
      version: releaseVersion,
      platform: this.platform,
      architecture: this.architecture,
      archiveFile,
    });
    const candidateId = createHash('sha256').update(JSON.stringify({
      releaseId: release.id,
      releaseVersion,
      archiveId: archive.id,
      evidenceId: evidence.id,
      archiveSha256: parsedEvidence.archiveSha256,
    })).digest('hex');
    const candidateView: PortableUpdateCandidateView = {
      id: candidateId,
      version: releaseVersion,
      name: release.name || `闲鱼订单管理 ${releaseVersion}`,
      releaseNotes: release.body,
      publishedAt: release.publishedAt,
      releaseUrl: release.htmlUrl,
      archiveFile,
      archiveBytes: archive.size,
    };
    this.candidate = {
      view: candidateView,
      archive,
      evidence,
      parsedEvidence,
    };
    this.view = {
      currentVersion: this.currentVersion,
      status: 'available',
      candidate: candidateView,
      downloaded: null,
    };
    return this.getView();
  }

  public async downloadUpdate(candidateId: string): Promise<PortableUpdateView> {
    const candidate = this.requireCandidate(candidateId);
    const versionDirectory = join(this.updatesDirectory, candidate.view.version);
    const finalPath = join(versionDirectory, candidate.view.archiveFile);
    const partialPath = `${finalPath}.part`;
    await rm(versionDirectory, { recursive: true, force: true });
    await mkdir(versionDirectory, { recursive: true });
    try {
      await writeFile(
        join(versionDirectory, `portable-${this.platform}-${this.architecture}.json`),
        candidate.parsedEvidence.raw,
        'utf8',
      );
      const response = await this.fetcher(candidate.archive.browserDownloadUrl, {
        headers: GITHUB_HEADERS,
        redirect: 'follow',
      });
      if (!response.ok || !response.body) {
        throw new Error(`更新 ZIP 下载失败（HTTP ${response.status}）`);
      }
      const declaredLength = optionalContentLength(response.headers.get('content-length'));
      if (declaredLength !== null && declaredLength !== candidate.archive.size) {
        throw new Error('更新 ZIP 下载大小与 GitHub Release 记录不一致');
      }
      const hash = createHash('sha256');
      let downloadedBytes = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          downloadedBytes += chunk.length;
          if (downloadedBytes > UPDATE_ARCHIVE_LIMIT_BYTES) {
            callback(new Error('更新 ZIP 超过 1 GB 安全上限'));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        meter,
        createWriteStream(partialPath, { flags: 'wx' }),
      );
      if (downloadedBytes !== candidate.archive.size) {
        throw new Error('更新 ZIP 下载大小与 GitHub Release 记录不一致');
      }
      const archiveSha256 = hash.digest('hex');
      if (archiveSha256 !== candidate.parsedEvidence.archiveSha256) {
        throw new Error('更新 ZIP 的 SHA-256 与更新证据不一致');
      }
      await rename(partialPath, finalPath);
      this.view = {
        currentVersion: this.currentVersion,
        status: 'downloaded',
        candidate: candidate.view,
        downloaded: {
          archivePath: finalPath,
          archiveSha256,
          archiveBytes: downloadedBytes,
        },
      };
      return this.getView();
    } catch (error) {
      await rm(versionDirectory, { recursive: true, force: true }).catch(() => undefined);
      this.view = {
        currentVersion: this.currentVersion,
        status: 'available',
        candidate: candidate.view,
        downloaded: null,
      };
      throw error;
    }
  }

  public async verifyDownloadedUpdate(candidateId: string): Promise<PreparedPortableUpdate> {
    const candidate = this.requireCandidate(candidateId);
    if (
      this.view.status !== 'downloaded'
      || this.view.candidate?.id !== candidateId
      || !this.view.downloaded
    ) {
      throw new Error('更新候选尚未完成下载与 SHA-256 验证');
    }
    const archiveStats = await stat(this.view.downloaded.archivePath);
    if (!archiveStats.isFile() || archiveStats.size !== candidate.archive.size) {
      throw new Error('已下载更新 ZIP 大小发生变化，请重新下载');
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(this.view.downloaded.archivePath)) {
      hash.update(chunk);
    }
    if (hash.digest('hex') !== candidate.parsedEvidence.archiveSha256) {
      throw new Error('已下载更新 ZIP 的 SHA-256 发生变化，请重新下载');
    }
    const versionDirectory = join(this.updatesDirectory, candidate.view.version);
    return {
      candidate: structuredClone(candidate.view),
      archivePath: this.view.downloaded.archivePath,
      evidencePath: join(
        versionDirectory,
        `portable-${this.platform}-${this.architecture}.json`,
      ),
    };
  }

  private requireCandidate(candidateId: string): InternalCandidate {
    if (!this.candidate || this.candidate.view.id !== candidateId) {
      throw new Error('更新候选已变化，请重新检查更新');
    }
    return this.candidate;
  }
}

function parseLatestRelease(value: unknown) {
  const record = requireRecord(value, 'GitHub 发布');
  const assets = requireArray(record.assets, 'GitHub 发布资产').map((asset) => {
    const item = requireRecord(asset, 'GitHub 发布资产');
    return {
      id: requirePositiveInteger(item.id, 'GitHub 发布资产 ID'),
      name: requireString(item.name, 'GitHub 发布资产名称'),
      size: requireNonNegativeInteger(item.size, 'GitHub 发布资产大小'),
      browserDownloadUrl: requireString(
        item.browser_download_url,
        'GitHub 发布资产下载地址',
      ),
    } satisfies ReleaseAsset;
  });
  return {
    id: requirePositiveInteger(record.id, 'GitHub 发布 ID'),
    tagName: requireString(record.tag_name, 'GitHub 发布标签'),
    name: optionalString(record.name),
    body: optionalString(record.body),
    draft: requireBoolean(record.draft, 'GitHub 发布草稿状态'),
    prerelease: requireBoolean(record.prerelease, 'GitHub 预发布状态'),
    publishedAt: requireString(record.published_at, 'GitHub 发布时间'),
    htmlUrl: requireGithubReleaseUrl(record.html_url, 'GitHub 发布页面'),
    assets,
  };
}

function parsePortableEvidence(
  raw: string,
  expected: {
    version: string;
    platform: PortableUpdatePlatform;
    architecture: PortableUpdateArchitecture;
    archiveFile: string;
  },
): PortableEvidence {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('更新证据不是有效 JSON', { cause: error });
  }
  const record = requireRecord(value, '更新证据');
  if (record.schemaVersion !== 1) throw new Error('更新证据版本不受支持');
  if (record.version !== expected.version) throw new Error('更新证据版本与发布标签不一致');
  if (record.platform !== expected.platform || record.architecture !== expected.architecture) {
    throw new Error('更新证据平台或架构与当前应用不一致');
  }
  if (record.archiveFile !== expected.archiveFile) {
    throw new Error('更新证据 ZIP 文件名与发布资产不一致');
  }
  const archiveSha256 = requireString(record.archiveSha256, '更新证据 SHA-256').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(archiveSha256) || new Set(archiveSha256).size < 2) {
    throw new Error('更新证据 SHA-256 格式无效');
  }
  if (record.gitDirty !== false) throw new Error('更新证据来自非干净工作树');
  const checks = requireRecord(record.checks, '更新证据验收项');
  for (const key of [
    'archiveExtracted',
    'packagedCredentialStore',
    'packagedScreenshotCompression',
    'dataDirectorySelected',
    'orderImported',
    'firstProgramDirectoryRemoved',
    'replacementProgramReadExistingOrder',
    'updateCandidateBackupSmoke',
  ]) {
    if (checks[key] !== true) throw new Error(`更新证据缺少已通过验收项：${key}`);
  }
  return {
    version: expected.version,
    platform: expected.platform,
    architecture: expected.architecture,
    archiveFile: expected.archiveFile,
    archiveSha256,
    raw,
  };
}

async function fetchLimitedJson(
  fetcher: Fetcher,
  url: string,
  limit: number,
  headers?: HeadersInit,
): Promise<unknown> {
  const text = await fetchLimitedText(fetcher, url, limit, headers);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error('GitHub 更新响应不是有效 JSON', { cause: error });
  }
}

async function fetchLimitedText(
  fetcher: Fetcher,
  url: string,
  limit: number,
  headers: HeadersInit = GITHUB_HEADERS,
): Promise<string> {
  validateGithubDownloadUrl(url, url === RELEASE_API_URL);
  const response = await fetcher(url, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`GitHub 更新请求失败（HTTP ${response.status}）`);
  const declaredLength = optionalContentLength(response.headers.get('content-length'));
  if (declaredLength !== null && declaredLength > limit) {
    throw new Error('GitHub 更新响应超过安全大小限制');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > limit) throw new Error('GitHub 更新响应超过安全大小限制');
  return text;
}

function validateReleaseAsset(asset: ReleaseAsset, maximumBytes: number): void {
  if (asset.size <= 0 || asset.size > maximumBytes) {
    throw new Error(`GitHub 更新资产大小无效：${asset.name}`);
  }
  validateGithubDownloadUrl(asset.browserDownloadUrl, false);
}

function validateGithubDownloadUrl(value: string, api: boolean): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('GitHub 更新地址无效', { cause: error });
  }
  if (url.protocol !== 'https:') throw new Error('GitHub 更新地址必须使用 HTTPS');
  if (api) {
    if (url.hostname !== 'api.github.com' || url.href !== RELEASE_API_URL) {
      throw new Error('GitHub 更新 API 地址不受信任');
    }
    return;
  }
  if (url.hostname !== 'github.com' || !url.pathname.startsWith(RELEASE_DOWNLOAD_PATH_PREFIX)) {
    throw new Error('GitHub 更新资产地址不受信任');
  }
}

function requireReleaseAsset(
  assets: ReleaseAsset[],
  name: string,
  label: string,
): ReleaseAsset {
  const matches = assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) throw new Error(`GitHub 正式发布缺少唯一${label}：${name}`);
  return matches[0];
}

function portableArchiveFile(
  platform: PortableUpdatePlatform,
  architecture: PortableUpdateArchitecture,
  version: string,
): string {
  return `XianyuOrderManager-${platform}-${architecture}-${version}.zip`;
}

function optionalContentLength(value: string | null): number | null {
  if (value === null) return null;
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('下载大小响应头格式无效');
  return length;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}格式无效`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label}格式无效`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000) {
    throw new Error(`${label}格式无效`);
  }
  return value.trim();
}

function optionalString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > 100_000) throw new Error('GitHub 发布文本格式无效');
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}格式无效`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label}格式无效`);
  return value as number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label}格式无效`);
  return value as number;
}

function requireGithubReleaseUrl(value: unknown, label: string): string {
  const url = requireString(value, label);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(`${label}格式无效`, { cause: error });
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'github.com'
    || !parsed.pathname.startsWith('/LonExplorer-coder/xianyu-order-manager/releases/')
  ) {
    throw new Error(`${label}不受信任`);
  }
  return url;
}
