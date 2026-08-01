import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve } from 'node:path';

const MAX_PRIVATE_INPUT_BYTES = 50 * 1024 * 1024;
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPORT_JSON_NAME = 'stage-one-acceptance.json';
const REPORT_MARKDOWN_NAME = 'stage-one-acceptance.md';

class PublicError extends Error {}

try {
  const arguments_ = parseArguments(process.argv.slice(2));
  const manifestPath = resolve(arguments_.manifest);
  const capturePath = resolve(arguments_.capture);
  const outputDirectory = resolve(
    arguments_.outputDirectory ?? resolve(REPOSITORY_ROOT, 'out/release-evidence'),
  );

  assertPrivateIgnoredInput(manifestPath);
  assertPrivateIgnoredInput(capturePath);
  assertDistinctReportInputs(manifestPath, capturePath, outputDirectory);

  const manifestBytes = readPrivateInput(manifestPath);
  const captureBytes = readPrivateInput(capturePath);
  const manifestValue = parseJson(manifestBytes);
  const captureValue = parseJson(captureBytes);
  assertJsonObject(manifestValue);
  assertJsonObject(captureValue);

  const manifestSha256 = createHash('sha256')
    .update(manifestBytes)
    .digest('hex');
  if (captureValue.manifestSha256 !== manifestSha256) {
    throw new PublicError('清单指纹不匹配，请重新生成捕获文件');
  }
  if (captureValue.gitDirty !== false) {
    throw new PublicError('捕获时的 Git 工作区必须干净');
  }

  mkdirSync(outputDirectory, { recursive: true });
  const reportJsonPath = resolve(outputDirectory, REPORT_JSON_NAME);
  const reportMarkdownPath = resolve(outputDirectory, REPORT_MARKDOWN_NAME);
  rmSync(reportJsonPath, { force: true });
  rmSync(reportMarkdownPath, { force: true });

  runEvaluatorFromVerifiedSnapshot({
    manifestBytes,
    captureBytes,
    outputDirectory,
    manifestSha256,
  });

  const report = readGeneratedReport(reportJsonPath);
  readGeneratedMarkdown(reportMarkdownPath);
  if (report.status === 'passed') {
    console.log('第一阶段验收通过，已生成匿名汇总报告。');
  } else if (report.status === 'failed') {
    console.log('第一阶段验收未通过，已生成匿名汇总报告。');
    process.exitCode = 1;
  } else {
    throw new PublicError('验收报告格式无效');
  }
} catch (error) {
  const message = error instanceof PublicError
    ? error.message
    : '第一阶段验收输入无效或无法评分';
  console.error(message);
  process.exitCode = 1;
}

function parseArguments(values) {
  const normalizedValues = values[0] === '--' ? values.slice(1) : values;
  const parsed = {
    manifest: undefined,
    capture: undefined,
    outputDirectory: undefined,
  };
  for (let index = 0; index < normalizedValues.length; index += 2) {
    const option = normalizedValues[index];
    const value = normalizedValues[index + 1];
    if (!option || !value || value.startsWith('--')) {
      throw new PublicError(
        '用法：node scripts/verify-stage-one-acceptance.mjs --manifest <manifest.json> --capture <capture.json> [--output-dir <dir>]',
      );
    }
    if (option === '--manifest' && parsed.manifest === undefined) {
      parsed.manifest = value;
    } else if (option === '--capture' && parsed.capture === undefined) {
      parsed.capture = value;
    } else if (option === '--output-dir' && parsed.outputDirectory === undefined) {
      parsed.outputDirectory = value;
    } else {
      throw new PublicError(
        '用法：node scripts/verify-stage-one-acceptance.mjs --manifest <manifest.json> --capture <capture.json> [--output-dir <dir>]',
      );
    }
  }
  if (!parsed.manifest || !parsed.capture) {
    throw new PublicError(
      '用法：node scripts/verify-stage-one-acceptance.mjs --manifest <manifest.json> --capture <capture.json> [--output-dir <dir>]',
    );
  }
  return parsed;
}

function assertPrivateIgnoredInput(inputPath) {
  let repositoryRoot;
  try {
    repositoryRoot = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
  } catch {
    throw new PublicError('无法确认私有输入的 Git 安全状态');
  }
  const repositoryRelativePath = relative(repositoryRoot, inputPath);
  if (
    !repositoryRelativePath ||
    isAbsolute(repositoryRelativePath) ||
    repositoryRelativePath === '..' ||
    repositoryRelativePath.startsWith('../') ||
    repositoryRelativePath.startsWith('..\\')
  ) {
    throw new PublicError('私有输入必须位于 Git 忽略目录中');
  }
  const gitPath = repositoryRelativePath.replaceAll('\\', '/');

  let stats;
  try {
    stats = lstatSync(inputPath);
  } catch {
    throw new PublicError('私有输入文件不存在或无法读取');
  }
  if (!stats.isFile() || stats.size > MAX_PRIVATE_INPUT_BYTES) {
    throw new PublicError('私有输入必须是可读取的普通 JSON 文件');
  }

  const tracked = spawnSync(
    'git',
    ['ls-files', '--error-unmatch', '--', gitPath],
    { cwd: repositoryRoot, stdio: 'ignore' },
  );
  const ignored = spawnSync(
    'git',
    ['check-ignore', '-q', '--', gitPath],
    { cwd: repositoryRoot, stdio: 'ignore' },
  );
  if (
    tracked.error ||
    ignored.error ||
    ![0, 1].includes(tracked.status ?? -1) ||
    ![0, 1].includes(ignored.status ?? -1)
  ) {
    throw new PublicError('无法确认私有输入的 Git 安全状态');
  }
  if (tracked.status === 0 || ignored.status !== 0) {
    throw new PublicError('私有输入必须未被 Git 跟踪且已被 .gitignore 忽略');
  }
}

function assertDistinctReportInputs(
  manifestPath,
  capturePath,
  outputDirectory,
) {
  const reportPaths = new Set([
    resolve(outputDirectory, REPORT_JSON_NAME),
    resolve(outputDirectory, REPORT_MARKDOWN_NAME),
  ]);
  if (reportPaths.has(manifestPath) || reportPaths.has(capturePath)) {
    throw new PublicError('报告输出不能覆盖私有输入文件');
  }
}

function readPrivateInput(inputPath) {
  try {
    return readFileSync(inputPath);
  } catch {
    throw new PublicError('私有输入文件不存在或无法读取');
  }
}

function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new PublicError('私有输入不是有效的 JSON');
  }
}

function assertJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicError('私有输入 JSON 格式无效');
  }
}

function runTypeScriptEvaluator({
  manifestPath,
  capturePath,
  outputDirectory,
  manifestSha256,
}) {
  const vitestEntry = resolve(REPOSITORY_ROOT, 'node_modules/vitest/vitest.mjs');
  const result = spawnSync(
    process.execPath,
    [vitestEntry, 'run', 'test/stage-one-acceptance-cli.test.ts'],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
      env: {
        ...process.env,
        VITEST_MAX_WORKERS: '1',
        XIANYU_STAGE_ONE_ACCEPTANCE_WORKER: '1',
        XIANYU_STAGE_ONE_ACCEPTANCE_MANIFEST: manifestPath,
        XIANYU_STAGE_ONE_ACCEPTANCE_CAPTURE: capturePath,
        XIANYU_STAGE_ONE_ACCEPTANCE_OUTPUT_DIR: outputDirectory,
        XIANYU_STAGE_ONE_ACCEPTANCE_MANIFEST_SHA256: manifestSha256,
      },
    },
  );
  if (result.error || result.status !== 0) {
    throw new PublicError('私有验收数据格式无效或评分失败');
  }
}

function runEvaluatorFromVerifiedSnapshot({
  manifestBytes,
  captureBytes,
  outputDirectory,
  manifestSha256,
}) {
  const snapshotRoot = resolve(REPOSITORY_ROOT, 'out', 'private-verification');
  mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  const snapshotDirectory = mkdtempSync(join(snapshotRoot, 'run-'));
  const manifestPath = join(snapshotDirectory, 'manifest.json');
  const capturePath = join(snapshotDirectory, 'capture.json');
  try {
    writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
    writeFileSync(capturePath, captureBytes, { mode: 0o600 });
    runTypeScriptEvaluator({
      manifestPath,
      capturePath,
      outputDirectory,
      manifestSha256,
    });
  } finally {
    rmSync(snapshotDirectory, { recursive: true, force: true });
  }
}

function readGeneratedReport(reportPath) {
  let value;
  try {
    value = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    throw new PublicError('验收报告生成失败');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicError('验收报告格式无效');
  }
  return value;
}

function readGeneratedMarkdown(reportPath) {
  try {
    readFileSync(reportPath, 'utf8');
  } catch {
    throw new PublicError('验收报告生成失败');
  }
}
