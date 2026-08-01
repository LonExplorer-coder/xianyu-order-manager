import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, resolve } from 'node:path';

import {
  assembleStageOneReleaseEvidence,
  isStageOneAcceptanceReportInternallyConsistent,
  PORTABLE_ACCEPTANCE_CHECKS,
} from '../src/core/stage-one-release.ts';

const MAX_JSON_INPUT_BYTES = 10 * 1024 * 1024;
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPORT_JSON_NAME = 'stage-one-release.json';
const REPORT_MARKDOWN_NAME = 'stage-one-release.md';
const USAGE =
  '用法：node scripts/verify-stage-one-release.mjs ' +
  '--ci-run <GitHub Actions run ID> ' +
  '--acceptance <stage-one-acceptance.json> ' +
  '--mac-evidence <portable-darwin-arm64.json> --mac-archive <ZIP> ' +
  '--windows-evidence <portable-win32-x64.json> --windows-archive <ZIP> ' +
  '[--output-dir <dir>]';

class PublicError extends Error {}

try {
  const arguments_ = parseArguments(process.argv.slice(2));
  const input = {
    acceptancePath: resolve(arguments_.acceptance),
    macEvidencePath: resolve(arguments_.macEvidence),
    macArchivePath: resolve(arguments_.macArchive),
    windowsEvidencePath: resolve(arguments_.windowsEvidence),
    windowsArchivePath: resolve(arguments_.windowsArchive),
  };
  const outputDirectory = resolve(
    arguments_.outputDirectory ?? resolve(REPOSITORY_ROOT, 'out/release-evidence'),
  );
  const reportJsonPath = resolve(outputDirectory, REPORT_JSON_NAME);
  const reportMarkdownPath = resolve(outputDirectory, REPORT_MARKDOWN_NAME);
  assertReportsDoNotOverwriteInputs(input, reportJsonPath, reportMarkdownPath);
  rmSync(reportJsonPath, { force: true });
  rmSync(reportMarkdownPath, { force: true });

  const acceptance = parseAcceptanceReport(readJsonInput(input.acceptancePath));
  const macEvidence = parsePortableEvidence(readJsonInput(input.macEvidencePath));
  const windowsEvidence = parsePortableEvidence(
    readJsonInput(input.windowsEvidencePath),
  );
  const packageVersion = readPackageVersion();
  const repository = readRepositoryState();
  const ci = readCiRunEvidence(arguments_.ciRun);

  const cliViolations = [
    ...await archiveViolations(
      macEvidence,
      input.macArchivePath,
      `${macEvidence.platform}-${macEvidence.architecture}`,
    ),
    ...await archiveViolations(
      windowsEvidence,
      input.windowsArchivePath,
      `${windowsEvidence.platform}-${windowsEvidence.architecture}`,
    ),
  ];
  if (repository.head !== acceptance.application.gitCommit) {
    cliViolations.push({ code: 'repository_commit_mismatch' });
  }
  if (repository.dirty) {
    cliViolations.push({ code: 'dirty_repository' });
  }
  if (packageVersion !== acceptance.application.version) {
    cliViolations.push({ code: 'package_version_mismatch' });
  }

  const assembled = assembleStageOneReleaseEvidence({
    acceptance,
    portable: [macEvidence, windowsEvidence],
    ci,
  });
  const violations = [...assembled.violations, ...cliViolations];
  const report = {
    ...assembled,
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
  };

  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    reportJsonPath,
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  writeFileSync(
    reportMarkdownPath,
    renderReleaseMarkdown(report),
    { encoding: 'utf8', mode: 0o600 },
  );

  if (report.status === 'passed') {
    console.log('第一阶段发布证据验证通过。');
  } else {
    console.log('第一阶段发布证据验证未通过。');
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof PublicError
    ? error.message
    : '第一阶段发布证据输入无效或无法验证';
  console.error(message);
  process.exitCode = 1;
}

function parseArguments(values) {
  const normalizedValues = values[0] === '--' ? values.slice(1) : values;
  const parsed = {
    ciRun: undefined,
    acceptance: undefined,
    macEvidence: undefined,
    macArchive: undefined,
    windowsEvidence: undefined,
    windowsArchive: undefined,
    outputDirectory: undefined,
  };
  for (let index = 0; index < normalizedValues.length; index += 2) {
    const option = normalizedValues[index];
    const value = normalizedValues[index + 1];
    if (!option || !value || value.startsWith('--')) throw new PublicError(USAGE);
    if (option === '--ci-run' && parsed.ciRun === undefined) {
      parsed.ciRun = value;
    } else if (option === '--acceptance' && parsed.acceptance === undefined) {
      parsed.acceptance = value;
    } else if (option === '--mac-evidence' && parsed.macEvidence === undefined) {
      parsed.macEvidence = value;
    } else if (option === '--mac-archive' && parsed.macArchive === undefined) {
      parsed.macArchive = value;
    } else if (
      option === '--windows-evidence' &&
      parsed.windowsEvidence === undefined
    ) {
      parsed.windowsEvidence = value;
    } else if (
      option === '--windows-archive' &&
      parsed.windowsArchive === undefined
    ) {
      parsed.windowsArchive = value;
    } else if (option === '--output-dir' && parsed.outputDirectory === undefined) {
      parsed.outputDirectory = value;
    } else {
      throw new PublicError(USAGE);
    }
  }
  if (
    !parsed.ciRun ||
    !parsed.acceptance ||
    !parsed.macEvidence ||
    !parsed.macArchive ||
    !parsed.windowsEvidence ||
    !parsed.windowsArchive
  ) {
    throw new PublicError(USAGE);
  }
  if (!/^[1-9][0-9]*$/u.test(parsed.ciRun)) throw new PublicError(USAGE);
  const ciRun = Number(parsed.ciRun);
  if (!Number.isSafeInteger(ciRun)) throw new PublicError(USAGE);
  return { ...parsed, ciRun };
}

function assertReportsDoNotOverwriteInputs(input, ...reportPaths) {
  const inputs = new Set(Object.values(input).map((path) => resolve(path)));
  if (reportPaths.some((path) => inputs.has(resolve(path)))) {
    throw new PublicError('发布报告输出不能覆盖验收输入或便携包');
  }
}

function readJsonInput(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new PublicError('发布证据 JSON 不存在或无法读取');
  }
  if (!stats.isFile() || stats.size > MAX_JSON_INPUT_BYTES) {
    throw new PublicError('发布证据必须是大小受限的普通 JSON 文件');
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new PublicError('发布证据不是有效的 JSON');
  }
}

function parseAcceptanceReport(value) {
  requireRecord(value, '第一阶段验收汇总报告格式无效');
  requireExactKeys(value, [
    'schemaVersion',
    'status',
    'generatedAt',
    'application',
    'recognition',
    'dataset',
    'criticalFields',
    'otherFields',
    'itemCounts',
    'duplicateGroups',
    'fieldDifferences',
    'violations',
  ]);
  requireRecord(value.application);
  requireExactKeys(value.application, ['version', 'gitCommit']);
  requireRecord(value.recognition);
  requireExactKeys(value.recognition, ['model', 'region', 'capturedAt']);
  requireRecord(value.dataset);
  requireExactKeys(value.dataset, [
    'id',
    'version',
    'caseCount',
    'distinctScreenshotCount',
    'multiItemCaseCount',
    'totalExpectedItemCount',
    'manifestSha256',
  ]);
  requireRecord(value.criticalFields);
  requireExactKeys(value.criticalFields, [
    'total',
    'correct',
    'blocked',
    'silentErrors',
  ]);
  requireRecord(value.otherFields);
  requireExactKeys(value.otherFields, [
    'total',
    'correct',
    'incorrect',
    'accuracy',
    'threshold',
  ]);
  requireRecord(value.itemCounts);
  requireExactKeys(value.itemCounts, [
    'total',
    'correct',
    'blocked',
    'silentErrors',
  ]);
  requireRecord(value.duplicateGroups);
  requireExactKeys(value.duplicateGroups, ['total', 'passed', 'failed']);

  const countTripletsValid =
    isCountSummary(value.criticalFields, ['correct', 'blocked', 'silentErrors']) &&
    isCountSummary(value.itemCounts, ['correct', 'blocked', 'silentErrors']) &&
    isCountSummary(value.duplicateGroups, ['passed', 'failed']);
  const otherFieldsValid =
    isNonNegativeInteger(value.otherFields.total) &&
    isNonNegativeInteger(value.otherFields.correct) &&
    isNonNegativeInteger(value.otherFields.incorrect) &&
    value.otherFields.correct + value.otherFields.incorrect === value.otherFields.total &&
    isRatio(value.otherFields.accuracy) &&
    isRatio(value.otherFields.threshold);
  if (
    value.schemaVersion !== 1 ||
    !['passed', 'failed'].includes(value.status) ||
    !isIsoDateTime(value.generatedAt) ||
    !isVersion(value.application.version) ||
    !isGitCommit(value.application.gitCommit) ||
    !isBoundedString(value.recognition.model, 200) ||
    !isBoundedString(value.recognition.region, 100) ||
    !isIsoDateTime(value.recognition.capturedAt) ||
    !isIdentifier(value.dataset.id) ||
    !isBoundedString(value.dataset.version, 100) ||
    !isNonNegativeInteger(value.dataset.caseCount) ||
    !isNonNegativeInteger(value.dataset.distinctScreenshotCount) ||
    value.dataset.distinctScreenshotCount > value.dataset.caseCount ||
    !isNonNegativeInteger(value.dataset.multiItemCaseCount) ||
    !isNonNegativeInteger(value.dataset.totalExpectedItemCount) ||
    !isSha256(value.dataset.manifestSha256) ||
    !countTripletsValid ||
    !otherFieldsValid ||
    !Array.isArray(value.fieldDifferences) ||
    value.fieldDifferences.length > 100_000 ||
    !value.fieldDifferences.every(isAggregateFieldDifference) ||
    !Array.isArray(value.violations) ||
    value.violations.length > 10_000 ||
    !value.violations.every(isAcceptanceViolation)
  ) {
    throw new PublicError('第一阶段验收汇总报告格式无效');
  }
  if (!isStageOneAcceptanceReportInternallyConsistent(value)) {
    throw new PublicError('第一阶段验收汇总报告内部统计不一致');
  }
  return value;
}

function parsePortableEvidence(value) {
  requireRecord(value, '便携版验收证据格式无效');
  requireExactKeys(value, [
    'schemaVersion',
    'version',
    'gitCommit',
    'gitDirty',
    'platform',
    'architecture',
    'archiveFile',
    'archiveSha256',
    'verifiedAt',
    'checks',
  ]);
  requireRecord(value.checks);
  requireExactKeys(value.checks, [...PORTABLE_ACCEPTANCE_CHECKS]);
  if (
    value.schemaVersion !== 1 ||
    !isVersion(value.version) ||
    !isGitCommit(value.gitCommit) ||
    typeof value.gitDirty !== 'boolean' ||
    !['darwin', 'win32'].includes(value.platform) ||
    !['arm64', 'x64'].includes(value.architecture) ||
    !isArchiveFileName(value.archiveFile) ||
    !isSha256(value.archiveSha256) ||
    !isIsoDateTime(value.verifiedAt) ||
    !PORTABLE_ACCEPTANCE_CHECKS.every(
      (check) => typeof value.checks[check] === 'boolean',
    )
  ) {
    throw new PublicError('便携版验收证据格式无效');
  }
  return value;
}

function readPackageVersion() {
  try {
    const value = JSON.parse(readFileSync(
      resolve(REPOSITORY_ROOT, 'package.json'),
      'utf8',
    ));
    if (!isRecord(value) || !isVersion(value.version)) throw new Error();
    return value.version;
  } catch {
    throw new PublicError('无法确认当前应用版本');
  }
}

function readRepositoryState() {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const status = execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    if (!isGitCommit(head)) throw new Error();
    return { head, dirty: status.trim().length > 0 };
  } catch {
    throw new PublicError('无法确认当前 Git 提交与工作区状态');
  }
}

function readCiRunEvidence(runId) {
  const fields =
    'databaseId,headSha,status,conclusion,workflowName,event,url,updatedAt,jobs';
  let value;
  try {
    const output = execFileSync(
      'gh',
      ['run', 'view', String(runId), '--json', fields],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        maxBuffer: 5 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: process.platform === 'win32',
      },
    );
    value = JSON.parse(output);
  } catch {
    throw new PublicError('无法验证同提交 CI，请确认 gh 已登录且运行编号有效');
  }
  if (
    !isRecord(value) ||
    value.databaseId !== runId ||
    !isGitCommit(value.headSha) ||
    !isBoundedString(value.workflowName, 200) ||
    !isBoundedString(value.status, 100) ||
    !(typeof value.conclusion === 'string' || value.conclusion === null) ||
    !isIdentifier(value.event) ||
    !isPublicGithubUrl(value.url) ||
    !isIsoDateTime(value.updatedAt) ||
    !Array.isArray(value.jobs) ||
    value.jobs.length > 1_000 ||
    !value.jobs.every(isCiJob)
  ) {
    throw new PublicError('无法验证同提交 CI，GitHub Actions 返回格式无效');
  }
  return {
    runId: value.databaseId,
    workflowName: value.workflowName,
    headSha: value.headSha,
    status: value.status,
    conclusion: value.conclusion ?? '',
    event: value.event,
    url: value.url,
    updatedAt: value.updatedAt,
    verifiedAt: new Date().toISOString(),
    jobs: value.jobs.map((job) => ({
      name: job.name,
      status: job.status,
      conclusion: job.conclusion ?? '',
    })),
  };
}

async function archiveViolations(evidence, archivePath, target) {
  const violations = [];
  let stats;
  try {
    stats = lstatSync(archivePath);
  } catch {
    throw new PublicError('便携版 ZIP 不存在或无法读取');
  }
  if (!stats.isFile()) {
    throw new PublicError('便携版 ZIP 必须是普通文件');
  }
  if (basename(archivePath) !== evidence.archiveFile) {
    violations.push({ code: 'archive_file_mismatch', target });
  }
  const archiveSha256 = await sha256File(archivePath);
  if (archiveSha256 !== evidence.archiveSha256) {
    violations.push({ code: 'archive_sha256_mismatch', target });
  }
  return violations;
}

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', () => rejectHash(new PublicError('便携版 ZIP 无法读取')));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function renderReleaseMarkdown(report) {
  const conclusion = report.status === 'passed' ? '通过' : '不通过';
  const lines = [
    '# 第一阶段核心可用版发布证据',
    '',
    `- 结论：${conclusion}`,
    `- 应用版本：${report.version}`,
    `- Git 提交：${report.gitCommit}`,
    `- 生成时间：${report.generatedAt}`,
    `- 私有验收清单 SHA-256：${report.privateAcceptance.manifestSha256}`,
    '',
    '## 同提交 CI',
    '',
    `- 运行编号：${report.continuousIntegration.runId}`,
    `- 工作流：${report.continuousIntegration.workflowName}`,
    `- Git 提交：${report.continuousIntegration.gitCommit}`,
    `- 运行地址：${report.continuousIntegration.url}`,
    `- 验证时间：${report.continuousIntegration.verifiedAt}`,
    '',
    '## 便携版指纹',
    '',
  ];
  if (report.artifacts.length === 0) {
    lines.push('- 无');
  } else {
    for (const artifact of report.artifacts) {
      lines.push(
        `- ${artifact.platform}-${artifact.architecture}：` +
        `${artifact.archiveFile} / SHA-256 ${artifact.archiveSha256} / ` +
        `${artifact.verifiedAt}`,
      );
    }
  }
  lines.push('', '## 违规项', '');
  if (report.violations.length === 0) {
    lines.push('- 无');
  } else {
    for (const violation of report.violations) {
      lines.push(`- ${formatViolation(violation)}`);
    }
  }
  lines.push(
    '',
    '> 本报告只包含发布元数据、指纹与违规代码，不包含截图、订单字段值或 OCR 原文。',
    '',
  );
  return lines.join('\n');
}

function formatViolation(violation) {
  const details = [violation.code];
  if (typeof violation.target === 'string') details.push(violation.target);
  if (typeof violation.job === 'string') details.push(violation.job);
  if (typeof violation.check === 'string') details.push(violation.check);
  return details.join(' / ');
}

function isCountSummary(value, components) {
  return isNonNegativeInteger(value.total) &&
    components.every((key) => isNonNegativeInteger(value[key])) &&
    components.reduce((sum, key) => sum + value[key], 0) === value.total;
}

function isAggregateFieldDifference(value) {
  if (!isRecord(value)) return false;
  try {
    requireExactKeys(value, ['caseId', 'field']);
  } catch {
    return false;
  }
  return isIdentifier(value.caseId) &&
    typeof value.field === 'string' &&
    /^(?:[A-Za-z][A-Za-z0-9]*|items\[[0-9]{1,3}\]\.[A-Za-z][A-Za-z0-9]*)$/u
      .test(value.field);
}

function isAcceptanceViolation(value) {
  if (!isRecord(value) || typeof value.code !== 'string') return false;
  const simpleCodes = new Set([
    'insufficient_cases',
    'insufficient_distinct_screenshots',
    'other_field_accuracy_below_threshold',
    'insufficient_duplicate_groups',
    'missing_multi_item_case',
  ]);
  const caseCodes = new Set([
    'duplicate_case_id',
    'missing_observation',
    'duplicate_observation',
    'unexpected_observation',
    'screenshot_hash_mismatch',
    'item_count_silent_error',
  ]);
  const groupCodes = new Set([
    'duplicate_group_incomplete',
    'duplicate_group_created_multiple_orders',
    'duplicate_group_not_resolved',
  ]);
  try {
    if (simpleCodes.has(value.code)) {
      requireExactKeys(value, ['code']);
      return true;
    }
    if (caseCodes.has(value.code)) {
      requireExactKeys(value, ['code', 'caseId']);
      return isIdentifier(value.caseId);
    }
    if (groupCodes.has(value.code)) {
      requireExactKeys(value, ['code', 'groupId']);
      return isIdentifier(value.groupId);
    }
    if (value.code === 'critical_field_silent_error') {
      requireExactKeys(value, ['code', 'caseId', 'field']);
      return isIdentifier(value.caseId) &&
        ['orderNumber', 'phoneNormalized', 'amountCents'].includes(value.field);
    }
  } catch {
    return false;
  }
  return false;
}

function isCiJob(value) {
  return isRecord(value) &&
    isBoundedString(value.name, 200) &&
    isBoundedString(value.status, 100) &&
    (typeof value.conclusion === 'string' || value.conclusion === null) &&
    (value.conclusion === null || value.conclusion.length <= 100);
}

function isPublicGithubUrl(value) {
  if (typeof value !== 'string' || value.length > 2_000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com';
  } catch {
    return false;
  }
}

function requireRecord(value, message = '发布证据 JSON 格式无效') {
  if (!isRecord(value)) throw new PublicError(message);
}

function requireExactKeys(value, expectedKeys) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new PublicError('发布证据 JSON 含有缺失或未允许的字段');
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isBoundedString(value, maximumLength) {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximumLength;
}

function isIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(value);
}

function isVersion(value) {
  return typeof value === 'string' &&
    /^[0-9A-Za-z][0-9A-Za-z.+-]{0,99}$/u.test(value);
}

function isArchiveFileName(value) {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,250}\.zip$/u.test(value) &&
    basename(value) === value;
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isGitCommit(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
}

function isIsoDateTime(value) {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value));
}
