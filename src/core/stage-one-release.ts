import type { StageOneAcceptanceReport } from './stage-one-acceptance';

export const PORTABLE_ACCEPTANCE_CHECKS = [
  'archiveExtracted',
  'packagedCredentialStore',
  'dataDirectorySelected',
  'orderImported',
  'firstProgramDirectoryRemoved',
  'replacementProgramReadExistingOrder',
] as const;

export type PortableAcceptanceCheck = (typeof PORTABLE_ACCEPTANCE_CHECKS)[number];

export type PortableAcceptanceEvidence = {
  schemaVersion: 1;
  version: string;
  gitCommit: string;
  gitDirty: boolean;
  platform: 'darwin' | 'win32';
  architecture: 'arm64' | 'x64';
  archiveFile: string;
  archiveSha256: string;
  verifiedAt: string;
  checks: Record<PortableAcceptanceCheck, boolean>;
};

export type StageOneCiJobEvidence = {
  name: string;
  status: string;
  conclusion: string;
};

export type StageOneCiRunEvidence = {
  runId: number;
  workflowName: string;
  headSha: string;
  status: string;
  conclusion: string;
  event: string;
  url: string;
  updatedAt: string;
  verifiedAt: string;
  jobs: StageOneCiJobEvidence[];
};

export type StageOneReleaseViolation =
  | { code: 'private_acceptance_failed' }
  | { code: 'missing_portable_target'; target: PortableTarget }
  | { code: 'unexpected_portable_target'; target: string }
  | { code: 'duplicate_portable_target'; target: PortableTarget }
  | { code: 'version_mismatch'; target: PortableTarget }
  | { code: 'git_commit_mismatch'; target: PortableTarget }
  | { code: 'dirty_portable_build'; target: PortableTarget }
  | { code: 'ci_evidence_invalid' }
  | { code: 'ci_workflow_mismatch' }
  | { code: 'ci_commit_mismatch' }
  | { code: 'ci_run_not_completed' }
  | { code: 'ci_run_failed' }
  | { code: 'ci_job_missing'; job: RequiredCiJob }
  | { code: 'ci_job_failed'; job: RequiredCiJob }
  | {
    code: 'portable_check_failed';
    target: PortableTarget;
    check: PortableAcceptanceCheck;
  };

export type StageOneReleaseEvidence = {
  schemaVersion: 1;
  status: 'passed' | 'failed';
  generatedAt: string;
  version: string;
  gitCommit: string;
  continuousIntegration: {
    runId: number;
    workflowName: string;
    event: string;
    url: string;
    gitCommit: string;
    updatedAt: string;
    verifiedAt: string;
  };
  privateAcceptance: {
    manifestSha256: string;
    caseCount: number;
    distinctScreenshotCount: number;
    multiItemCaseCount: number;
    totalExpectedItemCount: number;
    duplicateGroupCount: number;
    otherFieldAccuracy: number;
    criticalSilentErrors: number;
    itemCountSilentErrors: number;
  };
  artifacts: Array<{
    platform: PortableAcceptanceEvidence['platform'];
    architecture: PortableAcceptanceEvidence['architecture'];
    archiveFile: string;
    archiveSha256: string;
    verifiedAt: string;
  }>;
  violations: StageOneReleaseViolation[];
};

export type AssembleStageOneReleaseEvidenceInput = {
  acceptance: StageOneAcceptanceReport;
  portable: PortableAcceptanceEvidence[];
  ci: StageOneCiRunEvidence;
  generatedAt?: string;
};

const PORTABLE_TARGETS = ['darwin-arm64', 'win32-x64'] as const;
type PortableTarget = (typeof PORTABLE_TARGETS)[number];
const REQUIRED_CI_JOBS = ['macos-latest', 'windows-latest'] as const;
type RequiredCiJob = (typeof REQUIRED_CI_JOBS)[number];
const REQUIRED_OTHER_FIELD_ACCURACY_THRESHOLD = 0.95;

export function assembleStageOneReleaseEvidence(
  input: AssembleStageOneReleaseEvidenceInput,
): StageOneReleaseEvidence {
  const violations: StageOneReleaseViolation[] = [];
  if (!privateAcceptancePassed(input.acceptance)) {
    violations.push({ code: 'private_acceptance_failed' });
  }
  violations.push(...ciViolations(input.ci, input.acceptance.application.gitCommit));

  const evidenceByTarget = new Map<PortableTarget, PortableAcceptanceEvidence>();
  for (const evidence of input.portable) {
    const target = `${evidence.platform}-${evidence.architecture}`;
    if (!isPortableTarget(target)) {
      violations.push({ code: 'unexpected_portable_target', target });
      continue;
    }
    if (evidenceByTarget.has(target)) {
      violations.push({ code: 'duplicate_portable_target', target });
      continue;
    }
    evidenceByTarget.set(target, evidence);
    if (evidence.version !== input.acceptance.application.version) {
      violations.push({ code: 'version_mismatch', target });
    }
    if (evidence.gitCommit !== input.acceptance.application.gitCommit) {
      violations.push({ code: 'git_commit_mismatch', target });
    }
    if (evidence.gitDirty) {
      violations.push({ code: 'dirty_portable_build', target });
    }
    for (const check of PORTABLE_ACCEPTANCE_CHECKS) {
      if (evidence.checks[check] !== true) {
        violations.push({ code: 'portable_check_failed', target, check });
      }
    }
  }
  for (const target of PORTABLE_TARGETS) {
    if (!evidenceByTarget.has(target)) {
      violations.push({ code: 'missing_portable_target', target });
    }
  }

  return {
    schemaVersion: 1,
    status: violations.length === 0 ? 'passed' : 'failed',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    version: input.acceptance.application.version,
    gitCommit: input.acceptance.application.gitCommit,
    continuousIntegration: {
      runId: input.ci.runId,
      workflowName: input.ci.workflowName,
      event: input.ci.event,
      url: input.ci.url,
      gitCommit: input.ci.headSha,
      updatedAt: input.ci.updatedAt,
      verifiedAt: input.ci.verifiedAt,
    },
    privateAcceptance: {
      manifestSha256: input.acceptance.dataset.manifestSha256,
      caseCount: input.acceptance.dataset.caseCount,
      distinctScreenshotCount: input.acceptance.dataset.distinctScreenshotCount,
      multiItemCaseCount: input.acceptance.dataset.multiItemCaseCount,
      totalExpectedItemCount: input.acceptance.dataset.totalExpectedItemCount,
      duplicateGroupCount: input.acceptance.duplicateGroups.total,
      otherFieldAccuracy: input.acceptance.otherFields.accuracy,
      criticalSilentErrors: input.acceptance.criticalFields.silentErrors,
      itemCountSilentErrors: input.acceptance.itemCounts.silentErrors,
    },
    artifacts: PORTABLE_TARGETS.flatMap((target) => {
      const evidence = evidenceByTarget.get(target);
      return evidence ? [{
        platform: evidence.platform,
        architecture: evidence.architecture,
        archiveFile: evidence.archiveFile,
        archiveSha256: evidence.archiveSha256,
        verifiedAt: evidence.verifiedAt,
      }] : [];
    }),
    violations,
  };
}

function privateAcceptancePassed(report: StageOneAcceptanceReport): boolean {
  return isStageOneAcceptanceReportInternallyConsistent(report) &&
    report.status === 'passed' &&
    report.violations.length === 0 &&
    report.dataset.caseCount >= 30 &&
    report.dataset.distinctScreenshotCount >= 30 &&
    report.criticalFields.silentErrors === 0 &&
    report.itemCounts.silentErrors === 0 &&
    report.duplicateGroups.failed === 0 &&
    report.otherFields.accuracy >= REQUIRED_OTHER_FIELD_ACCURACY_THRESHOLD;
}

export function isStageOneAcceptanceReportInternallyConsistent(
  report: StageOneAcceptanceReport,
): boolean {
  const caseCount = report.dataset.caseCount;
  if (
    !isNonNegativeInteger(caseCount) ||
    !isNonNegativeInteger(report.dataset.distinctScreenshotCount) ||
    report.dataset.distinctScreenshotCount > caseCount ||
    !isNonNegativeInteger(report.dataset.multiItemCaseCount) ||
    report.dataset.multiItemCaseCount < 1 ||
    report.dataset.multiItemCaseCount > caseCount ||
    !isNonNegativeInteger(report.dataset.totalExpectedItemCount) ||
    report.dataset.totalExpectedItemCount < caseCount + report.dataset.multiItemCaseCount ||
    !Array.isArray(report.violations) ||
    !Array.isArray(report.fieldDifferences) ||
    report.status !== (report.violations.length === 0 ? 'passed' : 'failed') ||
    report.otherFields.threshold !== REQUIRED_OTHER_FIELD_ACCURACY_THRESHOLD ||
    report.fieldDifferences.length !== report.otherFields.incorrect ||
    report.criticalFields.total !== caseCount * 3 ||
    report.itemCounts.total !== caseCount ||
    report.otherFields.total < report.dataset.totalExpectedItemCount ||
    report.duplicateGroups.total < 2 ||
    !summaryAddsUp(report.criticalFields, ['correct', 'blocked', 'silentErrors']) ||
    !summaryAddsUp(report.itemCounts, ['correct', 'blocked', 'silentErrors']) ||
    !summaryAddsUp(report.otherFields, ['correct', 'incorrect']) ||
    !summaryAddsUp(report.duplicateGroups, ['passed', 'failed'])
  ) {
    return false;
  }
  const expectedAccuracy = report.otherFields.total === 0
    ? 0
    : report.otherFields.correct / report.otherFields.total;
  return Number.isFinite(report.otherFields.accuracy) &&
    report.otherFields.accuracy === expectedAccuracy;
}

function ciViolations(
  evidence: StageOneCiRunEvidence,
  expectedCommit: string,
): StageOneReleaseViolation[] {
  if (!isValidCiEvidenceShape(evidence)) {
    return [{ code: 'ci_evidence_invalid' }];
  }
  const violations: StageOneReleaseViolation[] = [];
  if (evidence.workflowName !== 'CI') {
    violations.push({ code: 'ci_workflow_mismatch' });
  }
  if (evidence.headSha !== expectedCommit) {
    violations.push({ code: 'ci_commit_mismatch' });
  }
  if (evidence.status !== 'completed') {
    violations.push({ code: 'ci_run_not_completed' });
  }
  if (evidence.conclusion !== 'success') {
    violations.push({ code: 'ci_run_failed' });
  }
  for (const job of REQUIRED_CI_JOBS) {
    const matches = evidence.jobs.filter(({ name }) => name === job);
    if (matches.length === 0) {
      violations.push({ code: 'ci_job_missing', job });
    } else if (
      matches.length !== 1 ||
      matches[0].status !== 'completed' ||
      matches[0].conclusion !== 'success'
    ) {
      violations.push({ code: 'ci_job_failed', job });
    }
  }
  return violations;
}

function isValidCiEvidenceShape(evidence: StageOneCiRunEvidence): boolean {
  return Number.isSafeInteger(evidence.runId) &&
    evidence.runId > 0 &&
    isNonEmptyString(evidence.workflowName) &&
    isNonEmptyString(evidence.headSha) &&
    isNonEmptyString(evidence.status) &&
    typeof evidence.conclusion === 'string' &&
    isNonEmptyString(evidence.event) &&
    isNonEmptyString(evidence.url) &&
    isNonEmptyString(evidence.updatedAt) &&
    isNonEmptyString(evidence.verifiedAt) &&
    Array.isArray(evidence.jobs) &&
    evidence.jobs.every((job) => (
      isNonEmptyString(job.name) &&
      isNonEmptyString(job.status) &&
      typeof job.conclusion === 'string'
    ));
}

function summaryAddsUp(
  summary: Record<string, unknown>,
  components: string[],
): boolean {
  if (!isNonNegativeInteger(summary.total)) return false;
  if (!components.every((key) => isNonNegativeInteger(summary[key]))) return false;
  return components.reduce((sum, key) => sum + Number(summary[key]), 0) === summary.total;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPortableTarget(value: string): value is PortableTarget {
  return (PORTABLE_TARGETS as readonly string[]).includes(value);
}
