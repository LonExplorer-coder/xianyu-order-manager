import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { StageOneAcceptanceReport } from '../src/core/stage-one-acceptance';
import type { PortableAcceptanceEvidence } from '../src/core/stage-one-release';

describe('offline first-stage release evidence CLI', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('writes a passing aggregate JSON and Markdown report for matching clean evidence', () => {
    const fixture = writeFixture(temporaryDirectories);

    const result = runCli(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('发布证据验证通过');
    expect(readdirSync(fixture.outputDirectory).sort()).toEqual([
      'stage-one-release.json',
      'stage-one-release.md',
    ]);
    const report = readReport(fixture);
    const markdown = readFileSync(
      resolve(fixture.outputDirectory, 'stage-one-release.md'),
      'utf8',
    );
    expect(report.status).toBe('passed');
    expect(report.violations).toEqual([]);
    expect(report.continuousIntegration).toMatchObject({
      runId: fixture.ciRunId,
      workflowName: 'CI',
      url: fixture.ciUrl,
      gitCommit: fixture.evidenceCommit,
    });
    expect(report.continuousIntegration).not.toHaveProperty('jobs');
    expect(markdown).toContain(fixture.macSha256);
    expect(markdown).toContain(fixture.windowsSha256);
    expect(markdown).toContain(String(fixture.ciRunId));
    expect(markdown).toContain(fixture.ciUrl);
    expect(markdown).not.toContain(fixture.inputDirectory);
    expect(JSON.stringify(report) + markdown).not.toContain('私密收件人');
  });

  it('recomputes each archive hash and fails closed when an archive changed', () => {
    const fixture = writeFixture(temporaryDirectories);
    writeFileSync(fixture.macArchivePath, 'changed archive bytes', 'utf8');

    const result = runCli(fixture);

    expect(result.status).not.toBe(0);
    expect(readReport(fixture)).toMatchObject({
      status: 'failed',
      violations: expect.arrayContaining([
        { code: 'archive_sha256_mismatch', target: 'darwin-arm64' },
      ]),
    });
  });

  it('requires the evidence archive basename to match the supplied archive', () => {
    const fixture = writeFixture(temporaryDirectories, {
      macArchiveFile: 'different-mac-portable.zip',
    });

    const result = runCli(fixture);

    expect(result.status).not.toBe(0);
    expect(readReport(fixture)).toMatchObject({
      status: 'failed',
      violations: expect.arrayContaining([
        { code: 'archive_file_mismatch', target: 'darwin-arm64' },
      ]),
    });
  });

  it('fails when the aggregate report commit is not the current repository HEAD', () => {
    const fixture = writeFixture(temporaryDirectories, {
      evidenceCommit: 'f'.repeat(40),
    });

    const result = runCli(fixture);

    expect(result.status).not.toBe(0);
    expect(readReport(fixture)).toMatchObject({
      status: 'failed',
      violations: expect.arrayContaining([
        { code: 'repository_commit_mismatch' },
      ]),
    });
  });

  it('fails when the current repository worktree is dirty', () => {
    const fixture = writeFixture(temporaryDirectories);
    writeFileSync(resolve(fixture.repository, 'uncommitted.txt'), 'dirty', 'utf8');

    const result = runCli(fixture);

    expect(result.status).not.toBe(0);
    expect(readReport(fixture)).toMatchObject({
      status: 'failed',
      violations: expect.arrayContaining([
        { code: 'dirty_repository' },
      ]),
    });
  });

  it('keeps the core missing-target gate when both evidence files describe macOS', () => {
    const fixture = writeFixture(temporaryDirectories, {
      windowsTarget: { platform: 'darwin', architecture: 'arm64' },
    });

    const result = runCli(fixture);

    expect(result.status).not.toBe(0);
    expect(readReport(fixture)).toMatchObject({
      status: 'failed',
      violations: expect.arrayContaining([
        { code: 'missing_portable_target', target: 'win32-x64' },
      ]),
    });
  });

  it('fails when package.json and the aggregate acceptance version differ', () => {
    const fixture = writeFixture(temporaryDirectories, {
      evidenceVersion: '0.2.26',
    });

    const result = runCli(fixture);

    expect(result.status).not.toBe(0);
    expect(readReport(fixture)).toMatchObject({
      status: 'failed',
      violations: expect.arrayContaining([
        { code: 'package_version_mismatch' },
      ]),
    });
  });

  it('fails closed when the GitHub CLI query cannot be completed', () => {
    const fixture = writeFixture(temporaryDirectories, { ghFailure: true });

    const result = runCli(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('无法验证同提交 CI');
  });

  it('fails when the selected run is not the successful CI for the acceptance commit', () => {
    const fixture = writeFixture(temporaryDirectories, {
      ci: {
        workflowName: 'Portable',
        headSha: 'e'.repeat(40),
        conclusion: 'failure',
      },
    });

    const result = runCli(fixture);

    expect(result.status).not.toBe(0);
    expect(readReport(fixture).violations).toEqual(expect.arrayContaining([
      { code: 'ci_workflow_mismatch' },
      { code: 'ci_commit_mismatch' },
      { code: 'ci_run_failed' },
    ]));
  });

  it('fails when either required platform job is missing or unsuccessful', () => {
    const fixture = writeFixture(temporaryDirectories, {
      ci: {
        jobs: [
          { name: 'macos-latest', status: 'completed', conclusion: 'failure' },
        ],
      },
    });

    const result = runCli(fixture);

    expect(result.status).not.toBe(0);
    expect(readReport(fixture).violations).toEqual(expect.arrayContaining([
      { code: 'ci_job_failed', job: 'macos-latest' },
      { code: 'ci_job_missing', job: 'windows-latest' },
    ]));
    expect(readFileSync(
      resolve(fixture.outputDirectory, 'stage-one-release.md'),
      'utf8',
    )).toContain('ci_job_missing / windows-latest');
  });

  it('rejects a self-contradictory aggregate acceptance report before release', () => {
    const fixture = writeFixture(temporaryDirectories);
    const acceptance = JSON.parse(
      readFileSync(fixture.acceptancePath, 'utf8'),
    ) as StageOneAcceptanceReport;
    acceptance.otherFields.correct = 0;
    acceptance.otherFields.incorrect = acceptance.otherFields.total;
    acceptance.otherFields.accuracy = 1;
    writeJson(fixture.acceptancePath, acceptance);

    const result = runCli(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('验收汇总报告内部统计不一致');
  });

  it('rejects an additive report that omits multi-item and duplicate coverage', () => {
    const fixture = writeFixture(temporaryDirectories);
    const acceptance = JSON.parse(
      readFileSync(fixture.acceptancePath, 'utf8'),
    ) as StageOneAcceptanceReport;
    acceptance.dataset.multiItemCaseCount = 0;
    acceptance.dataset.totalExpectedItemCount = 30;
    acceptance.otherFields = {
      total: 30,
      correct: 30,
      incorrect: 0,
      accuracy: 1,
      threshold: 0.95,
    };
    acceptance.duplicateGroups = { total: 0, passed: 0, failed: 0 };
    writeJson(fixture.acceptancePath, acceptance);

    const result = runCli(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('验收汇总报告内部统计不一致');
  });
});

type ReleaseReport = {
  status: string;
  continuousIntegration: Record<string, unknown>;
  violations: Array<Record<string, string | number>>;
};

type ReleaseFixture = {
  repository: string;
  inputDirectory: string;
  cliPath: string;
  acceptancePath: string;
  macEvidencePath: string;
  macArchivePath: string;
  windowsEvidencePath: string;
  windowsArchivePath: string;
  outputDirectory: string;
  macSha256: string;
  windowsSha256: string;
  ciRunId: number;
  ciUrl: string;
  ciResponse: string;
  fakeGhDirectory: string;
  evidenceCommit: string;
  ghFailure: boolean;
};

type FixtureOverrides = {
  evidenceCommit?: string;
  evidenceVersion?: string;
  macArchiveFile?: string;
  ghFailure?: boolean;
  ci?: Partial<{
    workflowName: string;
    headSha: string;
    status: string;
    conclusion: string;
    jobs: Array<{ name: string; status: string; conclusion: string }>;
  }>;
  windowsTarget?: {
    platform: PortableAcceptanceEvidence['platform'];
    architecture: PortableAcceptanceEvidence['architecture'];
  };
};

function writeFixture(
  temporaryDirectories: string[],
  overrides: FixtureOverrides = {},
): ReleaseFixture {
  const root = mkdtempSync(resolve(tmpdir(), 'xianyu-stage-one-release-cli-'));
  temporaryDirectories.push(root);
  const repository = resolve(root, 'repository');
  const inputDirectory = resolve(root, 'inputs');
  const outputDirectory = resolve(root, 'reports');
  const fakeGhDirectory = resolve(root, 'fake-gh');
  mkdirSync(resolve(repository, 'scripts'), { recursive: true });
  mkdirSync(resolve(repository, 'src/core'), { recursive: true });
  mkdirSync(inputDirectory, { recursive: true });
  mkdirSync(fakeGhDirectory, { recursive: true });
  writeFakeGh(fakeGhDirectory);
  copyFileSync(
    resolve('scripts/verify-stage-one-release.mjs'),
    resolve(repository, 'scripts/verify-stage-one-release.mjs'),
  );
  copyFileSync(
    resolve('src/core/stage-one-release.ts'),
    resolve(repository, 'src/core/stage-one-release.ts'),
  );
  copyFileSync(
    resolve('src/core/stage-one-acceptance.ts'),
    resolve(repository, 'src/core/stage-one-acceptance.ts'),
  );
  writeFileSync(
    resolve(repository, 'package.json'),
    `${JSON.stringify({ version: '0.2.25', type: 'module' }, null, 2)}\n`,
    'utf8',
  );
  runGit(repository, ['init', '--quiet']);
  runGit(repository, ['config', 'user.email', 'tests@example.invalid']);
  runGit(repository, ['config', 'user.name', 'Stage One Tests']);
  runGit(repository, ['add', '.']);
  runGit(repository, ['commit', '--quiet', '-m', 'fixture']);
  const repositoryCommit = runGit(repository, ['rev-parse', 'HEAD']).trim();
  const evidenceCommit = overrides.evidenceCommit ?? repositoryCommit;
  const evidenceVersion = overrides.evidenceVersion ?? '0.2.25';
  const ciRunId = 30_676_614_358;
  const ciUrl = `https://github.com/example/project/actions/runs/${ciRunId}`;
  const ciResponse = JSON.stringify({
    databaseId: ciRunId,
    workflowName: overrides.ci?.workflowName ?? 'CI',
    headSha: overrides.ci?.headSha ?? evidenceCommit,
    status: overrides.ci?.status ?? 'completed',
    conclusion: overrides.ci?.conclusion ?? 'success',
    event: 'push',
    url: ciUrl,
    updatedAt: '2026-08-01T13:45:00Z',
    jobs: overrides.ci?.jobs ?? [
      { name: 'macos-latest', status: 'completed', conclusion: 'success' },
      { name: 'windows-latest', status: 'completed', conclusion: 'success' },
    ],
  });

  const macArchivePath = resolve(inputDirectory, 'mac-portable.zip');
  const windowsArchivePath = resolve(inputDirectory, 'windows-portable.zip');
  writeFileSync(macArchivePath, 'synthetic mac archive', 'utf8');
  writeFileSync(windowsArchivePath, 'synthetic windows archive', 'utf8');
  const macSha256 = sha256(readFileSync(macArchivePath));
  const windowsSha256 = sha256(readFileSync(windowsArchivePath));

  const acceptancePath = resolve(inputDirectory, 'stage-one-acceptance.json');
  const macEvidencePath = resolve(inputDirectory, 'portable-darwin-arm64.json');
  const windowsEvidencePath = resolve(inputDirectory, 'portable-win32-x64.json');
  writeJson(
    acceptancePath,
    acceptedReport(evidenceVersion, evidenceCommit),
  );
  writeJson(
    macEvidencePath,
    portableEvidence({
      version: evidenceVersion,
      commit: evidenceCommit,
      platform: 'darwin',
      architecture: 'arm64',
      archivePath: macArchivePath,
      archiveSha256: macSha256,
      archiveFile: overrides.macArchiveFile,
    }),
  );
  const windowsTarget = overrides.windowsTarget ?? {
    platform: 'win32' as const,
    architecture: 'x64' as const,
  };
  writeJson(
    windowsEvidencePath,
    portableEvidence({
      version: evidenceVersion,
      commit: evidenceCommit,
      ...windowsTarget,
      archivePath: windowsArchivePath,
      archiveSha256: windowsSha256,
    }),
  );

  return {
    repository,
    inputDirectory,
    cliPath: resolve(repository, 'scripts/verify-stage-one-release.mjs'),
    acceptancePath,
    macEvidencePath,
    macArchivePath,
    windowsEvidencePath,
    windowsArchivePath,
    outputDirectory,
    macSha256,
    windowsSha256,
    ciRunId,
    ciUrl,
    ciResponse,
    fakeGhDirectory,
    evidenceCommit,
    ghFailure: overrides.ghFailure ?? false,
  };
}

function runCli(fixture: ReleaseFixture) {
  return spawnSync(
    process.execPath,
    [
      fixture.cliPath,
      '--',
      '--ci-run', String(fixture.ciRunId),
      '--acceptance', fixture.acceptancePath,
      '--mac-evidence', fixture.macEvidencePath,
      '--mac-archive', fixture.macArchivePath,
      '--windows-evidence', fixture.windowsEvidencePath,
      '--windows-archive', fixture.windowsArchivePath,
      '--output-dir', fixture.outputDirectory,
    ],
    {
      cwd: fixture.repository,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${fixture.fakeGhDirectory}${delimiter}${process.env.PATH ?? ''}`,
        XIANYU_FAKE_GH_RESPONSE: fixture.ciResponse,
        XIANYU_FAKE_GH_FAILURE: fixture.ghFailure ? '1' : '0',
        XIANYU_FAKE_GH_EXPECTED_ARGUMENTS: JSON.stringify([
          'run',
          'view',
          String(fixture.ciRunId),
          '--json',
          'databaseId,headSha,status,conclusion,workflowName,event,url,updatedAt,jobs',
        ]),
      },
    },
  );
}

function readReport(fixture: ReleaseFixture): ReleaseReport {
  return JSON.parse(readFileSync(
    resolve(fixture.outputDirectory, 'stage-one-release.json'),
    'utf8',
  )) as ReleaseReport;
}

function acceptedReport(
  version: string,
  gitCommit: string,
): StageOneAcceptanceReport {
  return {
    schemaVersion: 1,
    status: 'passed',
    generatedAt: '2026-08-01T12:30:00.000Z',
    application: { version, gitCommit },
    recognition: {
      model: 'controlled-private-model',
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
    otherFields: {
      total: 540,
      correct: 540,
      incorrect: 0,
      accuracy: 1,
      threshold: 0.95,
    },
    itemCounts: { total: 30, correct: 30, blocked: 0, silentErrors: 0 },
    duplicateGroups: { total: 2, passed: 2, failed: 0 },
    fieldDifferences: [],
    violations: [],
  };
}

function portableEvidence(input: {
  version: string;
  commit: string;
  platform: PortableAcceptanceEvidence['platform'];
  architecture: PortableAcceptanceEvidence['architecture'];
  archivePath: string;
  archiveSha256: string;
  archiveFile?: string;
}): PortableAcceptanceEvidence {
  return {
    schemaVersion: 1,
    version: input.version,
    gitCommit: input.commit,
    gitDirty: false,
    platform: input.platform,
    architecture: input.architecture,
    archiveFile: input.archiveFile ?? basename(input.archivePath),
    archiveSha256: input.archiveSha256,
    verifiedAt: '2026-08-01T13:00:00.000Z',
    checks: {
      archiveExtracted: true,
      packagedCredentialStore: true,
      dataDirectorySelected: true,
      orderImported: true,
      firstProgramDirectoryRemoved: true,
      replacementProgramReadExistingOrder: true,
    },
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function runGit(repository: string, arguments_: string[]): string {
  return execFileSync('git', arguments_, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeFakeGh(directory: string): void {
  const script = resolve(directory, 'fake-gh.cjs');
  writeFileSync(script, [
    "const expected = JSON.parse(process.env.XIANYU_FAKE_GH_EXPECTED_ARGUMENTS || '[]');",
    "if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(3);",
    "if (process.env.XIANYU_FAKE_GH_FAILURE === '1') process.exit(2);",
    "process.stdout.write(process.env.XIANYU_FAKE_GH_RESPONSE || '');",
    '',
  ].join('\n'), 'utf8');
  writeFileSync(
    resolve(directory, 'gh'),
    `#!/usr/bin/env node\nrequire(${JSON.stringify(script)});\n`,
    { encoding: 'utf8', mode: 0o755 },
  );
  writeFileSync(
    resolve(directory, 'gh.cmd'),
    `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
    'utf8',
  );
}
