import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { RecognitionResult } from '../src/core/contracts';
import {
  evaluateStageOneAcceptance,
  parseStageOneAcceptanceCapture,
  parseStageOneAcceptanceManifest,
  renderStageOneAcceptanceMarkdown,
  type StageOneAcceptanceCapture,
  type StageOneAcceptanceManifest,
  type StageOneAcceptanceObservation,
} from '../src/core/stage-one-acceptance';

const WORKER_MODE = process.env.XIANYU_STAGE_ONE_ACCEPTANCE_WORKER === '1';

if (WORKER_MODE) {
  describe('first-stage acceptance report worker', () => {
    it('parses, evaluates, and writes only anonymous aggregate reports', () => {
      const manifestPath = requiredWorkerEnvironment(
        'XIANYU_STAGE_ONE_ACCEPTANCE_MANIFEST',
      );
      const capturePath = requiredWorkerEnvironment(
        'XIANYU_STAGE_ONE_ACCEPTANCE_CAPTURE',
      );
      const outputDirectory = requiredWorkerEnvironment(
        'XIANYU_STAGE_ONE_ACCEPTANCE_OUTPUT_DIR',
      );
      const manifestSha256 = requiredWorkerEnvironment(
        'XIANYU_STAGE_ONE_ACCEPTANCE_MANIFEST_SHA256',
      );

      const manifest = parseStageOneAcceptanceManifest(
        JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown,
      );
      const capture = parseStageOneAcceptanceCapture(
        JSON.parse(readFileSync(capturePath, 'utf8')) as unknown,
      );
      const report = evaluateStageOneAcceptance({
        manifest,
        observations: capture.observations,
        manifestSha256,
        applicationVersion: capture.applicationVersion,
        gitCommit: capture.gitCommit,
        model: capture.model,
        region: capture.region,
        capturedAt: capture.capturedAt,
      });

      mkdirSync(outputDirectory, { recursive: true });
      writeFileSync(
        resolve(outputDirectory, 'stage-one-acceptance.json'),
        `${JSON.stringify(report, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      writeFileSync(
        resolve(outputDirectory, 'stage-one-acceptance.md'),
        renderStageOneAcceptanceMarkdown(report),
        { encoding: 'utf8', mode: 0o600 },
      );
    });
  });
} else {
  describe('offline first-stage acceptance CLI', () => {
    const temporaryDirectories: string[] = [];

    afterEach(() => {
      for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('writes only the two anonymous aggregate reports when all gates pass', () => {
      const fixture = writePrivateFixture(temporaryDirectories);

      const result = runCli(fixture);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('验收通过');
      expect(result.stdout + result.stderr).not.toContain('私密收件人');
      expect(result.stdout + result.stderr).not.toContain('13900000000');
      expect(result.stdout + result.stderr).not.toContain('images/case-001.png');
      expect(readdirSync(fixture.outputDirectory).sort()).toEqual([
        'stage-one-acceptance.json',
        'stage-one-acceptance.md',
      ]);

      const report = JSON.parse(readFileSync(
        resolve(fixture.outputDirectory, 'stage-one-acceptance.json'),
        'utf8',
      )) as { status: string };
      const markdown = readFileSync(
        resolve(fixture.outputDirectory, 'stage-one-acceptance.md'),
        'utf8',
      );
      expect(report.status).toBe('passed');
      expect(markdown).toContain('结论：通过');
      expect(JSON.stringify(report) + markdown).not.toContain('私密收件人');
      expect(JSON.stringify(report) + markdown).not.toContain('13900000000');
      expect(JSON.stringify(report) + markdown).not.toContain('images/case-001.png');
    });

    it('rejects a capture whose manifest hash does not match the raw manifest file', () => {
      const fixture = writePrivateFixture(temporaryDirectories, {
        manifestSha256: 'f'.repeat(64),
      });

      const result = runCli(fixture);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('清单指纹不匹配');
      expect(result.stderr).not.toContain(fixture.manifestPath);
      expect(result.stderr).not.toContain('私密收件人');
    });

    it('rejects captures made from a dirty worktree', () => {
      const fixture = writePrivateFixture(temporaryDirectories, {
        gitDirty: true,
      });

      const result = runCli(fixture);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('捕获时的 Git 工作区必须干净');
      expect(result.stderr).not.toContain(fixture.capturePath);
    });

    it('rejects tracked and unignored inputs before parsing their contents', () => {
      const fixture = writePrivateFixture(temporaryDirectories);
      const unignoredRoot = mkdtempSync(resolve('test-data/stage-one-cli-unignored-'));
      temporaryDirectories.push(unignoredRoot);
      const unignoredManifest = resolve(unignoredRoot, 'manifest.json');
      writeFileSync(
        unignoredManifest,
        readFileSync(fixture.manifestPath),
      );

      for (const manifestPath of [resolve('package.json'), unignoredManifest]) {
        const result = runCli({ ...fixture, manifestPath });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          '私有输入必须未被 Git 跟踪且已被 .gitignore 忽略',
        );
        expect(result.stderr).not.toContain(manifestPath);
      }
    });

    it('writes a failed aggregate report and exits nonzero below the accuracy threshold', () => {
      const fixture = writePrivateFixture(temporaryDirectories, {
        mutateCapture: (capture) => {
          capture.observations = capture.observations.map((entry) => ({
            ...entry,
            result: entry.result
              ? { ...entry.result, buyerNickname: '错误昵称' }
              : null,
          }));
        },
      });

      const result = runCli(fixture);

      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain('验收未通过');
      const report = JSON.parse(readFileSync(
        resolve(fixture.outputDirectory, 'stage-one-acceptance.json'),
        'utf8',
      )) as { status: string; violations: Array<{ code: string }> };
      expect(report.status).toBe('failed');
      expect(report.violations).toContainEqual({
        code: 'other_field_accuracy_below_threshold',
      });
      expect(result.stdout + result.stderr + JSON.stringify(report)).not.toContain(
        '错误昵称',
      );
    });
  });
}

type PrivateFixture = {
  manifestPath: string;
  capturePath: string;
  outputDirectory: string;
};

type FixtureOverrides = {
  manifestSha256?: string;
  gitDirty?: boolean;
  mutateCapture?: (capture: StageOneAcceptanceCapture) => void;
};

function writePrivateFixture(
  temporaryDirectories: string[],
  overrides: FixtureOverrides = {},
): PrivateFixture {
  mkdirSync(resolve('test-data/private'), { recursive: true });
  const root = mkdtempSync(resolve('test-data/private/stage-one-cli-'));
  temporaryDirectories.push(root);
  const manifestPath = resolve(root, 'manifest.json');
  const capturePath = resolve(root, 'capture.json');
  const outputDirectory = resolve(root, 'reports');
  const manifest = manifestWithCases(30);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestText, 'utf8');
  const manifestSha256 = createHash('sha256').update(manifestText).digest('hex');
  const capture: StageOneAcceptanceCapture = {
    schemaVersion: 1,
    manifestSha256: overrides.manifestSha256 ?? manifestSha256,
    applicationVersion: '0.2.25',
    gitCommit: 'b'.repeat(40),
    gitDirty: overrides.gitDirty ?? false,
    model: 'controlled-offline',
    region: 'cn-beijing',
    capturedAt: '2026-08-01T12:00:00.000Z',
    observations: manifest.cases.map((testCase, index) => observation(
      testCase.id,
      testCase.screenshotSha256,
      recognition(index),
      persistedOrderId(index),
      passingOutcome(index),
    )),
  };
  overrides.mutateCapture?.(capture);
  writeFileSync(capturePath, `${JSON.stringify(capture, null, 2)}\n`, 'utf8');
  return { manifestPath, capturePath, outputDirectory };
}

function runCli(fixture: PrivateFixture) {
  return spawnSync(
    process.execPath,
    [
      resolve('scripts/verify-stage-one-acceptance.mjs'),
      '--',
      '--manifest',
      fixture.manifestPath,
      '--capture',
      fixture.capturePath,
      '--output-dir',
      fixture.outputDirectory,
    ],
    { cwd: resolve('.'), encoding: 'utf8' },
  );
}

function requiredWorkerEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing worker environment: ${name}`);
  return value;
}

function manifestWithCases(count: number): StageOneAcceptanceManifest {
  return {
    schemaVersion: 1,
    datasetId: 'stage-one-private',
    datasetVersion: '2026-08-01',
    cases: Array.from({ length: count }, (_, index) => ({
      id: `case-${String(index + 1).padStart(3, '0')}`,
      screenshot: `images/case-${String(index + 1).padStart(3, '0')}.png`,
      screenshotSha256: index.toString(16).padStart(64, '0'),
      tags: index === 0 ? ['expanded', 'multi-item'] : ['collapsed'],
      ...(index < 4
        ? { duplicateGroup: `duplicate-order-${Math.floor(index / 2) + 1}` }
        : {}),
      expected: expectedOrder(index),
    })),
  };
}

function expectedOrder(
  index: number,
): StageOneAcceptanceManifest['cases'][number]['expected'] {
  const result = recognition(index);
  if (result.amountCents === null) throw new Error('Synthetic order lacks amount');
  return {
    orderNumber: result.orderNumber,
    phoneNormalized: result.phoneNormalized,
    amountCents: result.amountCents,
    alipayTransactionNumber: result.alipayTransactionNumber,
    buyerNickname: result.buyerNickname,
    recipient: result.recipient,
    addressOriginal: result.addressOriginal,
    addressNormalized: result.addressNormalized,
    province: result.province,
    city: result.city,
    district: result.district,
    orderedAtNormalized: result.orderedAtNormalized,
    paidAtNormalized: result.paidAtNormalized,
    productTotalCents: result.productTotalCents,
    shippingFeeCents: result.shippingFeeCents,
    platformTransactionStatus: result.platformTransactionStatus,
    fulfillmentStatus: result.fulfillmentStatus,
    items: result.items.map((item) => ({
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
    })),
  };
}

function recognition(index: number): RecognitionResult {
  const sourceIndex = canonicalOrderIndex(index);
  return {
    platform: 'xianyu',
    sellerAccount: '私密卖家',
    orderNumber: `PRIVATE-ORDER-${String(sourceIndex + 1).padStart(4, '0')}`,
    alipayTransactionNumber: `PRIVATE-ALI-${String(sourceIndex + 1).padStart(4, '0')}`,
    buyerNickname: '私密买家',
    recipient: '私密收件人',
    phone: '13900000000',
    phoneNormalized: '13900000000',
    addressOriginal: '广东省深圳市南山区私密路1号',
    addressNormalized: '广东省深圳市南山区私密路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-01 10:00:00',
    orderedAtNormalized: '2026-08-01T10:00:00+08:00',
    paidAtOriginal: '2026-08-01 10:00:08',
    paidAtNormalized: '2026-08-01T10:00:08+08:00',
    productTotalCents: 1_600,
    shippingFeeCents: 0,
    amountCents: 1_600,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [
      {
        sourceTitle: '私密商品',
        sourceSpec: '私密规格',
        unitPriceCents: 800,
        quantity: 2,
        quantityInferred: false,
      },
      ...(sourceIndex === 0
        ? [{
          sourceTitle: '私密商品二',
          sourceSpec: '私密规格二',
          unitPriceCents: 400,
          quantity: 1,
          quantityInferred: false,
        }]
        : []),
    ],
  };
}

function observation(
  caseId: string,
  screenshotSha256: string,
  result: RecognitionResult,
  persistedOrderId: string,
  outcome: StageOneAcceptanceObservation['outcome'],
): StageOneAcceptanceObservation {
  return {
    caseId,
    screenshotSha256,
    outcome,
    result,
    reviewIssues: [],
    persistedOrderId,
  };
}

function canonicalOrderIndex(index: number): number {
  if (index === 1) return 0;
  if (index === 3) return 2;
  return index;
}

function persistedOrderId(index: number): string {
  return `order-${canonicalOrderIndex(index)}`;
}

function passingOutcome(
  index: number,
): StageOneAcceptanceObservation['outcome'] {
  return index === 1 || index === 3 ? 'duplicate_skipped' : 'imported';
}
