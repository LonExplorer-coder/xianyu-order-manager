import { describe, expect, it } from 'vitest';

import type { StageOneAcceptanceReport } from '../src/core/stage-one-acceptance';
import {
  assembleStageOneReleaseEvidence,
  type StageOneCiRunEvidence,
  type PortableAcceptanceEvidence,
} from '../src/core/stage-one-release';

describe('第一阶段发布证据汇总', () => {
  it('只在私有金标与同一提交的双平台便携证据全部通过时放行', () => {
    const report = assembleStageOneReleaseEvidence({
      acceptance: acceptedPrivateReport(),
      portable: [portableEvidence('darwin', 'arm64'), portableEvidence('win32', 'x64')],
      ci: successfulCiEvidence(),
      generatedAt: '2026-08-01T14:00:00.000Z',
    });

    expect(report).toEqual({
      schemaVersion: 1,
      status: 'passed',
      generatedAt: '2026-08-01T14:00:00.000Z',
      version: '0.2.25',
      gitCommit: 'b'.repeat(40),
      continuousIntegration: {
        runId: 30_676_614_358,
        workflowName: 'CI',
        event: 'push',
        url: 'https://github.com/example/project/actions/runs/30676614358',
        gitCommit: 'b'.repeat(40),
        updatedAt: '2026-08-01T13:45:00.000Z',
        verifiedAt: '2026-08-01T13:50:00.000Z',
      },
      privateAcceptance: {
        manifestSha256: 'a'.repeat(64),
        caseCount: 30,
        distinctScreenshotCount: 30,
        multiItemCaseCount: 2,
        totalExpectedItemCount: 32,
        duplicateGroupCount: 2,
        otherFieldAccuracy: 1,
        criticalSilentErrors: 0,
        itemCountSilentErrors: 0,
      },
      artifacts: [
        {
          platform: 'darwin',
          architecture: 'arm64',
          archiveFile: 'XianyuOrderManager-darwin-arm64-0.2.25.zip',
          archiveSha256: 'd'.repeat(64),
          verifiedAt: '2026-08-01T13:00:00.000Z',
        },
        {
          platform: 'win32',
          architecture: 'x64',
          archiveFile: 'XianyuOrderManager-win32-x64-0.2.25.zip',
          archiveSha256: 'e'.repeat(64),
          verifiedAt: '2026-08-01T13:00:00.000Z',
        },
      ],
      violations: [],
    });
  });

  it('拒绝缺少平台、不同提交、脏构建或任一便携检查失败', () => {
    const windows = portableEvidence('win32', 'x64');
    windows.gitCommit = 'c'.repeat(40);
    windows.gitDirty = true;
    windows.checks.replacementProgramReadExistingOrder = false;

    const report = assembleStageOneReleaseEvidence({
      acceptance: acceptedPrivateReport(),
      portable: [windows],
      ci: successfulCiEvidence(),
      generatedAt: '2026-08-01T14:00:00.000Z',
    });

    expect(report.status).toBe('failed');
    expect(report.violations).toEqual(expect.arrayContaining([
      { code: 'missing_portable_target', target: 'darwin-arm64' },
      { code: 'git_commit_mismatch', target: 'win32-x64' },
      { code: 'dirty_portable_build', target: 'win32-x64' },
      {
        code: 'portable_check_failed',
        target: 'win32-x64',
        check: 'replacementProgramReadExistingOrder',
      },
    ]));
  });

  it('私有验收不通过时即使便携包完整也不会生成可发布结论', () => {
    const acceptance = acceptedPrivateReport();
    acceptance.status = 'failed';
    acceptance.criticalFields.silentErrors = 1;
    const report = assembleStageOneReleaseEvidence({
      acceptance,
      portable: [portableEvidence('darwin', 'arm64'), portableEvidence('win32', 'x64')],
      ci: successfulCiEvidence(),
      generatedAt: '2026-08-01T14:00:00.000Z',
    });

    expect(report.status).toBe('failed');
    expect(report.violations).toContainEqual({ code: 'private_acceptance_failed' });
  });

  it.each([
    ['95% threshold', (report: StageOneAcceptanceReport) => {
      report.otherFields.threshold = 0.9;
    }],
    ['derived accuracy', (report: StageOneAcceptanceReport) => {
      report.otherFields.correct = 0;
      report.otherFields.incorrect = report.otherFields.total;
      report.otherFields.accuracy = 1;
    }],
    ['critical total', (report: StageOneAcceptanceReport) => {
      report.criticalFields.total = 89;
      report.criticalFields.correct = 89;
    }],
    ['item-count total', (report: StageOneAcceptanceReport) => {
      report.itemCounts.total = 29;
      report.itemCounts.correct = 29;
    }],
    ['multi-item coverage', (report: StageOneAcceptanceReport) => {
      report.dataset.multiItemCaseCount = 0;
    }],
    ['expected item denominator', (report: StageOneAcceptanceReport) => {
      report.otherFields.total = 1;
      report.otherFields.correct = 1;
    }],
    ['duplicate coverage', (report: StageOneAcceptanceReport) => {
      report.duplicateGroups = { total: 0, passed: 0, failed: 0 };
    }],
    ['status and violations', (report: StageOneAcceptanceReport) => {
      report.status = 'failed';
    }],
    ['field-difference count', (report: StageOneAcceptanceReport) => {
      report.fieldDifferences.push({ caseId: 'case-001', field: 'buyerNickname' });
    }],
  ])('rejects internally inconsistent private acceptance: %s', (_label, mutate) => {
    const acceptance = acceptedPrivateReport();
    mutate(acceptance);

    const report = assembleStageOneReleaseEvidence({
      acceptance,
      portable: [portableEvidence('darwin', 'arm64'), portableEvidence('win32', 'x64')],
      ci: successfulCiEvidence(),
      generatedAt: '2026-08-01T14:00:00.000Z',
    });

    expect(report.status).toBe('failed');
    expect(report.violations).toContainEqual({ code: 'private_acceptance_failed' });
  });

  it('rejects CI from another workflow or commit and requires successful macOS and Windows jobs', () => {
    const ci = successfulCiEvidence();
    ci.workflowName = 'Portable';
    ci.headSha = 'c'.repeat(40);
    ci.jobs = [{ name: 'macos-latest', status: 'completed', conclusion: 'failure' }];

    const report = assembleStageOneReleaseEvidence({
      acceptance: acceptedPrivateReport(),
      portable: [portableEvidence('darwin', 'arm64'), portableEvidence('win32', 'x64')],
      ci,
      generatedAt: '2026-08-01T14:00:00.000Z',
    });

    expect(report.status).toBe('failed');
    expect(report.violations).toEqual(expect.arrayContaining([
      { code: 'ci_workflow_mismatch' },
      { code: 'ci_commit_mismatch' },
      { code: 'ci_job_failed', job: 'macos-latest' },
      { code: 'ci_job_missing', job: 'windows-latest' },
    ]));
  });
});

function acceptedPrivateReport(): StageOneAcceptanceReport {
  return {
    schemaVersion: 1,
    status: 'passed',
    generatedAt: '2026-08-01T12:30:00.000Z',
    application: { version: '0.2.25', gitCommit: 'b'.repeat(40) },
    recognition: {
      model: 'qwen3.5-ocr',
      region: 'cn-beijing',
      capturedAt: '2026-08-01T12:00:00.000Z',
    },
    dataset: {
      id: 'stage-one-private',
      version: '2026-08-01',
      caseCount: 30,
      distinctScreenshotCount: 30,
      multiItemCaseCount: 2,
      totalExpectedItemCount: 32,
      manifestSha256: 'a'.repeat(64),
    },
    criticalFields: { total: 90, correct: 90, blocked: 0, silentErrors: 0 },
    otherFields: { total: 540, correct: 540, incorrect: 0, accuracy: 1, threshold: 0.95 },
    itemCounts: { total: 30, correct: 30, blocked: 0, silentErrors: 0 },
    duplicateGroups: { total: 2, passed: 2, failed: 0 },
    fieldDifferences: [],
    violations: [],
  };
}

function portableEvidence(
  platform: PortableAcceptanceEvidence['platform'],
  architecture: PortableAcceptanceEvidence['architecture'],
): PortableAcceptanceEvidence {
  return {
    schemaVersion: 1,
    version: '0.2.25',
    gitCommit: 'b'.repeat(40),
    gitDirty: false,
    platform,
    architecture,
    archiveFile: `XianyuOrderManager-${platform}-${architecture}-0.2.25.zip`,
    archiveSha256: platform === 'darwin' ? 'd'.repeat(64) : 'e'.repeat(64),
    verifiedAt: '2026-08-01T13:00:00.000Z',
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
  };
}

function successfulCiEvidence(): StageOneCiRunEvidence {
  return {
    runId: 30_676_614_358,
    workflowName: 'CI',
    headSha: 'b'.repeat(40),
    status: 'completed',
    conclusion: 'success',
    event: 'push',
    url: 'https://github.com/example/project/actions/runs/30676614358',
    updatedAt: '2026-08-01T13:45:00.000Z',
    verifiedAt: '2026-08-01T13:50:00.000Z',
    jobs: [
      { name: 'macos-latest', status: 'completed', conclusion: 'success' },
      { name: 'windows-latest', status: 'completed', conclusion: 'success' },
    ],
  };
}
