import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SystemApiKeyStore } from '../src/adapters/credentials/system-api-key-store';
import type {
  OrderDraft,
  OrderReviewIssueCode,
  RecognitionBatchItem,
  RecognitionBatchView,
  RecognitionResult,
} from '../src/core/contracts';
import {
  evaluateStageOneAcceptance,
  parseStageOneAcceptanceCapture,
  parseStageOneAcceptanceManifest,
  renderStageOneAcceptanceMarkdown,
  STAGE_ONE_MINIMUM_CASES,
  type StageOneAcceptanceCapture,
  type StageOneAcceptanceCase,
  type StageOneAcceptanceManifest,
  type StageOneAcceptanceObservation,
  type StageOneAcceptanceReport,
} from '../src/core/stage-one-acceptance';
import type { DesktopSession } from '../src/main/desktop-session';
import { createConfiguredDesktopSession } from '../src/main/production-session';

const PRIVATE_CAPTURE_ENABLED = process.env.XIANYU_PRIVATE_STAGE_ONE_CAPTURE === '1';
const MAX_SCREENSHOT_BYTES = 7_500_000;
const SCREENSHOT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const privateCaptureSuite = PRIVATE_CAPTURE_ENABLED ? describe : describe.skip;

describe('第一阶段私有截图捕获入口安全门', () => {
  it('未明确确认付费 OCR 时在读取清单前拒绝运行', () => {
    const privateSentinel = join(
      repositoryRoot,
      'private-data',
      'stage-one',
      '不存在且不能回显的清单.json',
    );
    const result = spawnSync(
      process.execPath,
      [
        join(repositoryRoot, 'scripts', 'run-private-stage-one-capture.mjs'),
        '--',
        '--manifest',
        privateSentinel,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('第一阶段私有验收未完成');
    expect(result.stderr).not.toContain(privateSentinel);
  });

  it('即使确认付费也会在创建生产会话前拒绝受 Git 跟踪的清单', () => {
    const trackedManifest = join(repositoryRoot, 'package.json');
    const result = spawnSync(
      process.execPath,
      [
        join(repositoryRoot, 'scripts', 'run-private-stage-one-capture.mjs'),
        '--manifest',
        trackedManifest,
        '--confirm-paid-services',
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('第一阶段私有验收未完成');
    expect(result.stderr).not.toContain(trackedManifest);
  });

  it('提交前基础设施失败时保留缺失观察，而不伪造成安全业务拦截', async () => {
    const testCase = {
      id: 'case-001',
      screenshot: 'images/001.png',
      screenshotSha256: 'a'.repeat(64),
      tags: [],
      expected: {} as StageOneAcceptanceCase['expected'],
    } satisfies StageOneAcceptanceCase;
    const session = {
      submitSourceScreenshots: async () => {
        throw new Error('synthetic infrastructure failure');
      },
    } as unknown as DesktopSession;

    await expect(captureObservations(
      session,
      { schemaVersion: 1, datasetId: 'private', datasetVersion: 'v1', cases: [testCase] },
      ['/ignored-before-read.png'],
    )).resolves.toEqual([]);
  });

  it('完全相同图片在付费前跳过时沿用先前正式订单而不伪装成失败', () => {
    const testCase = {
      id: 'case-031',
      screenshot: 'images/031.png',
      screenshotSha256: 'a'.repeat(64),
      tags: ['identical-image'],
      expected: {} as StageOneAcceptanceCase['expected'],
    } satisfies StageOneAcceptanceCase;
    const previousResult = syntheticRecognitionResult();
    const result = observationForItem(
      {} as DesktopSession,
      testCase,
      {
        id: 'item-031',
        batchId: 'batch-031',
        sourceName: '031.png',
        status: 'duplicate_skipped',
        resolution: 'identical_image',
      },
      [{
        caseId: 'case-001',
        screenshotSha256: testCase.screenshotSha256,
        outcome: 'imported',
        result: previousResult,
        reviewIssues: [],
        persistedOrderId: 'order-001',
      }],
    );

    expect(result).toMatchObject({
      caseId: 'case-031',
      outcome: 'duplicate_skipped',
      result: previousResult,
      persistedOrderId: 'order-001',
    });
  });

  it('批次表面成功但无法形成可追溯观察时立即停止后续付费调用', async () => {
    const cases = [1, 2].map((number) => ({
      id: `case-00${number}`,
      screenshot: `images/00${number}.png`,
      screenshotSha256: String(number).repeat(64),
      tags: [],
      expected: {} as StageOneAcceptanceCase['expected'],
    } satisfies StageOneAcceptanceCase));
    let submissions = 0;
    let latestBatchId = '';
    const session = {
      submitSourceScreenshots: async () => {
        submissions += 1;
        latestBatchId = `batch-${submissions}`;
        return { id: latestBatchId, drafts: [] };
      },
      waitForCurrentRecognitionWork: async () => undefined,
      listRecognitionBatches: () => [{
        id: latestBatchId,
        items: [{
          id: `item-${submissions}`,
          batchId: latestBatchId,
          sourceName: `${submissions}.png`,
          status: 'imported',
        }],
        totalCount: 1,
        processedCount: 1,
        counts: {} as RecognitionBatchView['counts'],
        createdAt: '2026-08-01T12:00:00.000Z',
      }],
    } as unknown as DesktopSession;

    const observations = await captureObservations(
      session,
      { schemaVersion: 1, datasetId: 'private', datasetVersion: 'v1', cases },
      ['/first.png', '/second.png'],
    );

    expect(submissions).toBe(1);
    expect(observations).toHaveLength(1);
    expect(observations[0].outcome).toBe('failed');
  });
});

privateCaptureSuite('第一阶段付费私有截图验收', () => {
  it('通过生产识别链路捕获并生成脱敏验收报告', async () => {
    if (process.env.XIANYU_PRIVATE_STAGE_ONE_CONFIRM_PAID_SERVICES !== '1') {
      throw new Error('未明确确认本次验收会调用付费识别服务');
    }
    const paths = await privateCapturePaths();
    const prepared = await preparePrivateRun(paths);
    const packageMetadata = JSON.parse(
      await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { version: string };
    const gitCommit = gitOutput(['rev-parse', 'HEAD']);
    const capturedAt = new Date().toISOString();
    let session: DesktopSession | undefined;
    let observations: StageOneAcceptanceObservation[] = [];
    let model = 'qwen3.5-ocr';
    let region = 'cn-beijing';

    try {
      session = createPrivateProductionSession(prepared.configDirectory);
      const ocrSettings = await session.getOcrSettings();
      if (!ocrSettings.apiKeyConfigured) {
        throw new Error('系统凭据库中未配置百炼 API Key');
      }
      model = ocrSettings.model;
      region = ocrSettings.region;
      const candidateSettings = await session.getCandidateVerificationSettings();
      if (candidateSettings.enabled && !candidateSettings.apiKeyConfigured) {
        throw new Error('已启用候选裁决，但系统凭据库中缺少对应 API Key');
      }
      const state = session.useDataDirectory(prepared.workspaceDirectory);
      if (state.kind !== 'ready') throw new Error('私有验收数据目录无法打开');
      session.saveOrderIntakeSettings({ automaticImportEnabled: true });

      observations = await captureObservations(
        session,
        prepared.manifest,
        prepared.screenshotPaths,
      );
    } finally {
      session?.close();
    }

    const capture = parseStageOneAcceptanceCapture({
      schemaVersion: 1,
      manifestSha256: prepared.manifestSha256,
      applicationVersion: packageMetadata.version,
      gitCommit,
      gitDirty: false,
      model,
      region,
      capturedAt,
      observations,
    } satisfies StageOneAcceptanceCapture);
    await writePrivateJson(join(paths.runDirectory, 'capture.json'), capture);

    const report = evaluateStageOneAcceptance({
      manifest: prepared.manifest,
      observations: capture.observations,
      manifestSha256: capture.manifestSha256,
      applicationVersion: capture.applicationVersion,
      gitCommit: capture.gitCommit,
      model: capture.model,
      region: capture.region,
      capturedAt: capture.capturedAt,
    });
    await writeAggregateReports(report);
    expect(report.status).toBe('passed');
  }, 60 * 60_000);
});

type PrivateCapturePaths = {
  manifestPath: string;
  manifestDirectory: string;
  expectedManifestSha256: string;
  runDirectory: string;
  sourceConfigDirectory: string;
};

type PreparedPrivateRun = {
  manifest: StageOneAcceptanceManifest;
  manifestSha256: string;
  screenshotPaths: string[];
  configDirectory: string;
  workspaceDirectory: string;
};

async function privateCapturePaths(): Promise<PrivateCapturePaths> {
  const manifestPath = requiredAbsoluteEnvironmentPath(
    'XIANYU_PRIVATE_STAGE_ONE_MANIFEST',
  );
  const runDirectory = requiredAbsoluteEnvironmentPath(
    'XIANYU_PRIVATE_STAGE_ONE_RUN_DIRECTORY',
  );
  const sourceConfigDirectory = requiredAbsoluteEnvironmentPath(
    'XIANYU_PRIVATE_STAGE_ONE_SOURCE_CONFIG',
  );
  const canonicalManifestPath = await realpath(manifestPath);
  const manifestDirectory = dirname(canonicalManifestPath);
  const canonicalRunDirectory = await realpath(runDirectory);
  const runsRoot = join(manifestDirectory, 'runs');
  const relationship = relative(runsRoot, canonicalRunDirectory);
  if (!relationship || escapesDirectory(relationship)) {
    throw new Error('私有运行目录必须位于金标清单目录的 runs 子目录');
  }
  return {
    manifestPath: canonicalManifestPath,
    manifestDirectory,
    expectedManifestSha256: requiredSha256EnvironmentValue(
      'XIANYU_PRIVATE_STAGE_ONE_EXPECTED_MANIFEST_SHA256',
    ),
    runDirectory: canonicalRunDirectory,
    sourceConfigDirectory: await realpath(sourceConfigDirectory),
  };
}

async function preparePrivateRun(
  paths: PrivateCapturePaths,
): Promise<PreparedPrivateRun> {
  assertCleanGit();
  const manifestBytes = await readFile(paths.manifestPath);
  if (sha256(manifestBytes) !== paths.expectedManifestSha256) {
    throw new Error('金标清单在付费确认后发生变化');
  }
  let untrustedManifest: unknown;
  try {
    untrustedManifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('金标清单 JSON 无法解析');
  }
  const manifest = parseStageOneAcceptanceManifest(untrustedManifest);
  if (manifest.cases.length < STAGE_ONE_MINIMUM_CASES) {
    throw new Error(`金标清单至少需要 ${STAGE_ONE_MINIMUM_CASES} 个案例`);
  }
  if (
    new Set(manifest.cases.map(({ screenshotSha256 }) => screenshotSha256)).size <
    STAGE_ONE_MINIMUM_CASES
  ) {
    throw new Error(`金标清单至少需要 ${STAGE_ONE_MINIMUM_CASES} 张不同截图`);
  }

  const screenshotPaths: string[] = [];
  const stagedInputDirectory = join(paths.runDirectory, 'inputs');
  await mkdir(stagedInputDirectory, { recursive: true, mode: 0o700 });
  for (const testCase of manifest.cases) {
    screenshotPaths.push(await verifyAndStageScreenshot(
      paths.manifestDirectory,
      stagedInputDirectory,
      testCase,
    ));
  }

  // Repeat the cleanliness gate immediately before credentials/session setup.
  // No production recognizer exists before this point, so no paid call can have happened.
  assertCleanGit();
  const configDirectory = join(paths.runDirectory, 'config');
  const workspaceDirectory = join(paths.runDirectory, 'workspace');
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await mkdir(workspaceDirectory, { recursive: true, mode: 0o700 });
  await copyConfigurationFile(
    paths.sourceConfigDirectory,
    configDirectory,
    'ocr-settings.json',
    true,
  );
  await copyConfigurationFile(
    paths.sourceConfigDirectory,
    configDirectory,
    'candidate-verification-settings.json',
    false,
  );

  return {
    manifest,
    manifestSha256: sha256(manifestBytes),
    screenshotPaths,
    configDirectory,
    workspaceDirectory,
  };
}

async function verifyAndStageScreenshot(
  manifestDirectory: string,
  stagedInputDirectory: string,
  testCase: StageOneAcceptanceCase,
): Promise<string> {
  const segments = testCase.screenshot.split(/[\\/]/u);
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('金标清单中的截图路径不安全');
  }
  const screenshotPath = await realpath(join(manifestDirectory, ...segments));
  const relationship = relative(manifestDirectory, screenshotPath);
  if (!relationship || escapesDirectory(relationship)) {
    throw new Error('金标截图必须位于清单目录内');
  }
  const metadata = await stat(screenshotPath);
  if (!metadata.isFile()) throw new Error('金标截图必须是文件');
  if (!SCREENSHOT_EXTENSIONS.has(extname(screenshotPath).toLowerCase())) {
    throw new Error('金标截图类型不受支持');
  }
  if (metadata.size > MAX_SCREENSHOT_BYTES) {
    throw new Error('金标截图不能超过 7.5 MB');
  }
  const screenshotBytes = await readFile(screenshotPath);
  if (!hasExpectedImageSignature(screenshotBytes, extname(screenshotPath))) {
    throw new Error('金标截图内容与文件类型不一致');
  }
  if (sha256(screenshotBytes) !== testCase.screenshotSha256) {
    throw new Error('金标截图 SHA-256 与清单不一致');
  }
  const stagedPath = join(
    stagedInputDirectory,
    `${testCase.id}${extname(screenshotPath).toLowerCase()}`,
  );
  await writeFile(stagedPath, screenshotBytes, {
    flag: 'wx',
    mode: 0o600,
  });
  return stagedPath;
}

function hasExpectedImageSignature(bytes: Uint8Array, extension: string): boolean {
  const normalizedExtension = extension.toLowerCase();
  if (normalizedExtension === '.png') {
    return bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  }
  if (normalizedExtension === '.jpg' || normalizedExtension === '.jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (normalizedExtension === '.webp') {
    return bytes.length >= 12 &&
      Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
      Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP';
  }
  return false;
}

async function copyConfigurationFile(
  sourceDirectory: string,
  destinationDirectory: string,
  filename: string,
  required: boolean,
): Promise<void> {
  const source = join(sourceDirectory, filename);
  try {
    const metadata = await stat(source);
    if (!metadata.isFile()) throw new Error('设置项不是文件');
    await copyFile(source, join(destinationDirectory, filename));
  } catch (error) {
    if (!required && isMissingFile(error)) return;
    throw new Error(required ? '缺少已保存的 OCR 设置' : '无法复制候选裁决设置');
  }
}

function createPrivateProductionSession(configDirectory: string): DesktopSession {
  return createConfiguredDesktopSession({
    configDirectory,
    apiKeyStore: new SystemApiKeyStore(),
    candidateVerificationApiKeyStores: {
      deepseek: new SystemApiKeyStore({
        accountName: 'candidate-verification-deepseek-api-key',
        secretLabel: 'DeepSeek 候选裁决 API Key',
      }),
      'aliyun-bailian': new SystemApiKeyStore({
        accountName: 'candidate-verification-aliyun-bailian-api-key',
        secretLabel: '百炼候选裁决 API Key',
      }),
      'openai-compatible': new SystemApiKeyStore({
        accountName: 'candidate-verification-openai-compatible-api-key',
        secretLabel: '自定义候选裁决 API Key',
      }),
    },
  });
}

async function captureObservations(
  session: DesktopSession,
  manifest: StageOneAcceptanceManifest,
  screenshotPaths: string[],
): Promise<StageOneAcceptanceObservation[]> {
  const observations: StageOneAcceptanceObservation[] = [];
  // One screenshot per submission keeps every paid call inside the product's
  // <=50 contract while allowing a retry/failed result to close the session
  // before the 30-second automatic retry timer can create another paid call.
  for (let offset = 0; offset < manifest.cases.length; offset += 1) {
    const cases = manifest.cases.slice(offset, offset + 1);
    const sources = screenshotPaths.slice(offset, offset + 1);
    try {
      const submitted = await session.submitSourceScreenshots(sources);
      await session.waitForCurrentRecognitionWork();
      const completed = session.listRecognitionBatches().find(({ id }) => (
        id === submitted.id
      ));
      if (!completed || completed.items.length !== cases.length) {
        break;
      }
      let observationFailed = false;
      for (const [index, testCase] of cases.entries()) {
        const observation = observationForItem(
          session,
          testCase,
          completed.items[index],
          observations,
        );
        observations.push(observation);
        if (observation.outcome === 'failed') observationFailed = true;
      }
      if (
        observationFailed ||
        completed.items.some(({ status }) => isFailedOrRetryStatus(status))
      ) {
        break;
      }
    } catch {
      break;
    }
  }
  return observations;
}

type FailedOrRetryStatus =
  | 'waiting_retry'
  | 'failed'
  | 'waiting_recognition'
  | 'recognizing'
  | 'validating';

function isFailedOrRetryStatus(
  status: RecognitionBatchItem['status'],
): status is FailedOrRetryStatus {
  return status === 'waiting_retry' ||
    status === 'failed' ||
    status === 'waiting_recognition' ||
    status === 'recognizing' ||
    status === 'validating';
}

function observationForItem(
  session: DesktopSession,
  testCase: StageOneAcceptanceCase,
  item: RecognitionBatchItem,
  previousObservations: readonly StageOneAcceptanceObservation[],
): StageOneAcceptanceObservation {
  if (isFailedOrRetryStatus(item.status)) {
    return failedObservation(testCase, item.reviewIssues ?? []);
  }
  if (item.status === 'cancelled') {
    return baseObservation(testCase, 'cancelled', null, item.reviewIssues ?? []);
  }
  if (!item.draftId) {
    if (item.status === 'duplicate_skipped' && item.resolution === 'identical_image') {
      const previous = previousObservations.find((observation) => (
        observation.screenshotSha256 === testCase.screenshotSha256 &&
        observation.result !== null &&
        Boolean(observation.persistedOrderId)
      ));
      if (previous?.persistedOrderId && previous.result) {
        return {
          ...baseObservation(
            testCase,
            'duplicate_skipped',
            previous.result,
            item.reviewIssues ?? [],
          ),
          persistedOrderId: previous.persistedOrderId,
        };
      }
    }
    return failedObservation(testCase, item.reviewIssues ?? []);
  }

  let draft: OrderDraft;
  try {
    draft = session.getDraft(item.draftId);
  } catch {
    return failedObservation(testCase, item.reviewIssues ?? []);
  }
  const result = recognitionResultFromDraft(draft);
  const outcome = item.status;
  const persistedOrderId = outcome === 'imported' || outcome === 'duplicate_skipped'
    ? findPersistedOrderId(session, result)
    : undefined;
  if ((outcome === 'imported' || outcome === 'duplicate_skipped') && !persistedOrderId) {
    return failedObservation(testCase, item.reviewIssues ?? []);
  }
  return {
    ...baseObservation(
      testCase,
      outcome,
      result,
      item.reviewIssues ?? draft.reviewIssues ?? [],
    ),
    ...(persistedOrderId ? { persistedOrderId } : {}),
  };
}

function findPersistedOrderId(
  session: DesktopSession,
  result: RecognitionResult,
): string | undefined {
  return session.listOrders().find((order) => (
    order.platform === result.platform &&
    order.sellerAccount === result.sellerAccount &&
    order.orderNumber === result.orderNumber
  ))?.id;
}

function recognitionResultFromDraft(draft: OrderDraft): RecognitionResult {
  return {
    platform: draft.platform,
    sellerAccount: draft.sellerAccount,
    orderNumber: draft.orderNumber,
    alipayTransactionNumber: draft.alipayTransactionNumber,
    buyerNickname: draft.buyerNickname,
    recipient: draft.recipient,
    phone: draft.phone,
    phoneNormalized: draft.phoneNormalized,
    addressOriginal: draft.addressOriginal,
    addressNormalized: draft.addressNormalized,
    province: draft.province,
    city: draft.city,
    district: draft.district,
    orderedAtOriginal: draft.orderedAtOriginal,
    orderedAtNormalized: draft.orderedAtNormalized,
    paidAtOriginal: draft.paidAtOriginal,
    paidAtNormalized: draft.paidAtNormalized,
    productTotalCents: draft.productTotalCents,
    shippingFeeCents: draft.shippingFeeCents,
    amountCents: draft.amountCents,
    platformTransactionStatus: draft.platformTransactionStatus,
    fulfillmentStatus: (
      draft.fulfillmentStatus === 'partially_shipped'
      || draft.fulfillmentStatus === 'delivered'
      || draft.fulfillmentStatus === 'returned'
    ) ? 'shipped' : draft.fulfillmentStatus,
    items: draft.items.map((item) => ({
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
      quantityInferred: item.quantityInferred,
      ...(item.quantitySource ? { quantitySource: item.quantitySource } : {}),
    })),
  };
}

function failedObservation(
  testCase: StageOneAcceptanceCase,
  reviewIssues: readonly OrderReviewIssueCode[],
): StageOneAcceptanceObservation {
  return baseObservation(testCase, 'failed', null, reviewIssues);
}

function baseObservation(
  testCase: StageOneAcceptanceCase,
  outcome: StageOneAcceptanceObservation['outcome'],
  result: RecognitionResult | null,
  reviewIssues: readonly OrderReviewIssueCode[],
): StageOneAcceptanceObservation {
  return {
    caseId: testCase.id,
    screenshotSha256: testCase.screenshotSha256,
    outcome,
    result,
    reviewIssues: [...reviewIssues],
  };
}

async function writePrivateJson(
  destination: string,
  value: StageOneAcceptanceCapture,
): Promise<void> {
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function writeAggregateReports(report: StageOneAcceptanceReport): Promise<void> {
  const outputDirectory = join(repositoryRoot, 'out', 'release-evidence');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    join(outputDirectory, 'stage-one-acceptance.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await writeFile(
    join(outputDirectory, 'stage-one-acceptance.md'),
    renderStageOneAcceptanceMarkdown(report),
    { encoding: 'utf8', mode: 0o600 },
  );
}

function requiredAbsoluteEnvironmentPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !isAbsolute(value)) throw new Error('私有验收运行参数无效');
  return resolve(value);
}

function requiredSha256EnvironmentValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error('私有验收运行参数无效');
  }
  return value;
}

function assertCleanGit(): void {
  if (gitOutput(['status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new Error('付费识别验收只允许在干净 Git 提交上运行');
  }
}

function gitOutput(argumentsList: string[]): string {
  return execFileSync('git', argumentsList, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  }).trim();
}

function escapesDirectory(relationship: string): boolean {
  return relationship === '..' ||
    relationship.startsWith(`..${sep}`) ||
    isAbsolute(relationship);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function syntheticRecognitionResult(): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '验收账号',
    orderNumber: 'SYNTHETIC-ORDER-001',
    alipayTransactionNumber: '',
    buyerNickname: '',
    recipient: '测试收件人',
    phone: '13900000000',
    phoneNormalized: '13900000000',
    addressOriginal: '广东省深圳市南山区测试路1号',
    addressNormalized: '广东省深圳市南山区测试路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '',
    orderedAtNormalized: '',
    paidAtOriginal: '',
    paidAtNormalized: '',
    productTotalCents: 800,
    shippingFeeCents: 0,
    amountCents: 800,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '合成商品',
      sourceSpec: '标准款',
      unitPriceCents: 800,
      quantity: 1,
      quantityInferred: true,
    }],
  };
}
