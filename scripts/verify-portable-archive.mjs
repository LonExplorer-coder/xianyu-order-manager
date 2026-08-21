import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import {
  removeDirectoryBestEffort,
  removeDirectoryWithRetries,
} from './portable-cleanup.mjs';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const target = portableTarget();
const archivePath = resolve(process.argv[2] ?? defaultArchivePath(target));
if (!existsSync(archivePath) || !statSync(archivePath).isFile()) {
  throw new Error(`找不到便携版 ZIP：${archivePath}`);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'xianyu-portable-archive-'));
const extractionDirectory = join(temporaryRoot, 'archive');
const externalDirectory = join(temporaryRoot, 'external-data');
const configDirectory = join(externalDirectory, 'bootstrap');
const dataDirectory = join(externalDirectory, 'orders');
let completed = false;

try {
  extractArchive(archivePath, extractionDirectory, target.platform);
  const sourceProgram = findProgram(extractionDirectory, target.platform);
  verifyProgramStructure(sourceProgram, target);

  const firstInstall = stageProgram(sourceProgram, join(temporaryRoot, 'program-a'), target.platform);
  assertExternalDirectory(firstInstall.root, externalDirectory);
  runPackagedApplication(firstInstall.executable, {
    XIANYU_PACKAGED_CREDENTIAL_SMOKE: '1',
  }, '系统凭据库');
  runPackagedApplication(firstInstall.executable, {
    XIANYU_PACKAGED_SCREENSHOT_COMPRESSION_SMOKE: '1',
  }, '来源截图压缩运行库');
  runPortablePhase(firstInstall.executable, 'write', configDirectory, dataDirectory);

  const updateBackupRoot = join(externalDirectory, 'update-backups');
  runPackagedApplication(firstInstall.executable, {
    XIANYU_UPDATE_BACKUP_SMOKE: '1',
    XIANYU_UPDATE_DATA_DIRECTORY: dataDirectory,
    XIANYU_UPDATE_BACKUP_ROOT_DIRECTORY: updateBackupRoot,
  }, '更新前完整备份');
  const updateBackups = readdirSync(updateBackupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('xianyu-backup-'));
  if (updateBackups.length !== 1) throw new Error('更新前完整备份产物数量异常');
  const updateBackupDirectory = join(updateBackupRoot, updateBackups[0].name);
  runPackagedApplication(firstInstall.executable, {
    XIANYU_UPDATE_CANDIDATE_SMOKE: '1',
    XIANYU_UPDATE_BACKUP_DIRECTORY: updateBackupDirectory,
    XIANYU_UPDATE_HEALTH_DATA_DIRECTORY: join(externalDirectory, 'update-health-data'),
  }, '更新候选隔离恢复');

  await removeDirectoryWithRetries(firstInstall.root, {
    label: '第一份便携程序目录',
    timeoutMs: 30_000,
  });
  if (existsSync(firstInstall.root)) throw new Error('无法删除第一份便携程序目录');
  for (const requiredPath of [
    join(configDirectory, 'bootstrap.json'),
    join(dataDirectory, 'xianyu-order-manager.sqlite3'),
  ]) {
    if (!existsSync(requiredPath)) {
      throw new Error(`删除程序目录后独立数据丢失：${basename(requiredPath)}`);
    }
  }

  const secondInstall = stageProgram(sourceProgram, join(temporaryRoot, 'program-b'), target.platform);
  runPortablePhase(secondInstall.executable, 'read', configDirectory, dataDirectory);

  const archiveSha256 = createHash('sha256')
    .update(readFileSync(archivePath))
    .digest('hex');
  const evidence = writeEvidence({
    archivePath,
    archiveSha256,
    target,
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
  });
  completed = true;
  console.log(
    `便携版 ZIP 验证通过：${basename(archivePath)}\n` +
    `SHA-256：${archiveSha256}\n` +
    `证据：${evidence}`,
  );
} finally {
  if (process.env.XIANYU_KEEP_PORTABLE_SMOKE_TEMP === '1' && !completed) {
    console.error(`已保留失败现场：${temporaryRoot}`);
  } else {
    await removeDirectoryBestEffort(temporaryRoot, {
      label: '便携验证临时目录',
      timeoutMs: 10_000,
    });
  }
}

function portableTarget() {
  if (process.platform === 'darwin') return { platform: 'darwin', arch: 'arm64' };
  if (process.platform === 'win32') return { platform: 'win32', arch: 'x64' };
  throw new Error('便携版 ZIP 验证只支持 macOS 和 Windows');
}

function defaultArchivePath(target) {
  return join(
    'out',
    'make',
    'zip',
    target.platform,
    target.arch,
    `XianyuOrderManager-${target.platform}-${target.arch}-${packageJson.version}.zip`,
  );
}

function extractArchive(archive, destination, platform) {
  mkdirSync(destination, { recursive: true });
  if (platform === 'darwin') {
    execFileSync('ditto', ['-x', '-k', archive, destination], { stdio: 'inherit' });
    return;
  }
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Expand-Archive -LiteralPath $env:XIANYU_VERIFY_ARCHIVE -DestinationPath $env:XIANYU_VERIFY_DESTINATION -Force',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        XIANYU_VERIFY_ARCHIVE: archive,
        XIANYU_VERIFY_DESTINATION: destination,
      },
    },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    throw new Error(`Windows ZIP 解压失败：${result.error?.message ?? result.status}`);
  }
}

function findProgram(extractionDirectory, platform) {
  if (platform === 'darwin') {
    const appPath = join(extractionDirectory, 'XianyuOrderManager.app');
    if (!existsSync(appPath)) throw new Error('ZIP 中缺少 XianyuOrderManager.app');
    return appPath;
  }
  const queue = [extractionDirectory];
  while (queue.length > 0) {
    const directory = queue.shift();
    if (
      existsSync(join(directory, 'XianyuOrderManager.exe')) &&
      existsSync(join(directory, 'resources', 'app.asar'))
    ) {
      return directory;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) queue.push(join(directory, entry.name));
    }
  }
  throw new Error('ZIP 中缺少完整的 XianyuOrderManager.exe 程序目录');
}

function verifyProgramStructure(program, target) {
  const resources = target.platform === 'darwin'
    ? join(program, 'Contents', 'Resources')
    : join(program, 'resources');
  const keyringBinary = target.platform === 'darwin'
    ? join(
        resources,
        'app.asar.unpacked',
        'node_modules',
        '@napi-rs',
        'keyring-darwin-arm64',
        'keyring.darwin-arm64.node',
      )
    : join(
        resources,
        'app.asar.unpacked',
        'node_modules',
        '@napi-rs',
        'keyring-win32-x64-msvc',
        'keyring.win32-x64-msvc.node',
      );
  const sharpBinary = target.platform === 'darwin'
    ? join(
        resources,
        'app.asar.unpacked',
        'node_modules',
        '@img',
        'sharp-darwin-arm64',
        'lib',
        `sharp-darwin-arm64-${packageJson.dependencies.sharp}.node`,
      )
    : join(
        resources,
        'app.asar.unpacked',
        'node_modules',
        '@img',
        'sharp-win32-x64',
        'lib',
        `sharp-win32-x64-${packageJson.dependencies.sharp}.node`,
      );
  const requiredPaths = [join(resources, 'app.asar'), keyringBinary, sharpBinary];
  if (target.platform === 'darwin') {
    const libvipsDirectory = join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      '@img',
      'sharp-libvips-darwin-arm64',
      'lib',
    );
    const libvipsFile = existsSync(libvipsDirectory)
      ? readdirSync(libvipsDirectory).find((name) => (
        name.startsWith('libvips-cpp.') && name.endsWith('.dylib')
      ))
      : undefined;
    if (!libvipsFile) throw new Error('便携版缺少 Sharp libvips 运行库');
    requiredPaths.push(join(libvipsDirectory, libvipsFile));
  }
  for (const requiredPath of requiredPaths) {
    if (!existsSync(requiredPath)) {
      throw new Error(`便携版缺少运行文件：${relative(program, requiredPath)}`);
    }
  }
}

function stageProgram(sourceProgram, stageRoot, platform) {
  mkdirSync(stageRoot, { recursive: true });
  const destination = join(stageRoot, basename(sourceProgram));
  cpSync(sourceProgram, destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  const executable = platform === 'darwin'
    ? join(destination, 'Contents', 'MacOS', 'XianyuOrderManager')
    : join(destination, 'XianyuOrderManager.exe');
  if (!existsSync(executable)) throw new Error('复制后的便携程序缺少可执行文件');
  return { root: stageRoot, executable };
}

function assertExternalDirectory(programRoot, externalDataRoot) {
  const fromProgram = relative(resolve(programRoot), resolve(externalDataRoot));
  if (!fromProgram || (!fromProgram.startsWith(`..${sep}`) && fromProgram !== '..')) {
    throw new Error('便携版冒烟数据目录错误地位于程序目录内');
  }
}

function runPortablePhase(executable, phase, configDirectory, dataDirectory) {
  runPackagedApplication(executable, {
    XIANYU_PACKAGED_PORTABLE_SMOKE: phase,
    XIANYU_PORTABLE_SMOKE_CONFIG_DIRECTORY: configDirectory,
    XIANYU_PORTABLE_SMOKE_DATA_DIRECTORY: dataDirectory,
  }, `便携数据 ${phase}`);
}

function runPackagedApplication(executable, additions, label) {
  const environment = { ...process.env };
  delete environment.XIANYU_PACKAGED_CREDENTIAL_SMOKE;
  delete environment.XIANYU_PACKAGED_SCREENSHOT_COMPRESSION_SMOKE;
  delete environment.XIANYU_PACKAGED_PORTABLE_SMOKE;
  delete environment.XIANYU_PORTABLE_SMOKE_CONFIG_DIRECTORY;
  delete environment.XIANYU_PORTABLE_SMOKE_DATA_DIRECTORY;
  delete environment.XIANYU_UPDATE_CANDIDATE_SMOKE;
  delete environment.XIANYU_UPDATE_BACKUP_DIRECTORY;
  delete environment.XIANYU_UPDATE_HEALTH_DATA_DIRECTORY;
  delete environment.XIANYU_UPDATE_BACKUP_SMOKE;
  delete environment.XIANYU_UPDATE_DATA_DIRECTORY;
  delete environment.XIANYU_UPDATE_BACKUP_ROOT_DIRECTORY;
  Object.assign(environment, additions);
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(executable, [], {
    encoding: 'utf8',
    env: environment,
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    const timeout = result.error.code === 'ETIMEDOUT' ? '（60 秒超时）' : '';
    throw new Error(`${label}冒烟无法完成${timeout}：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label}冒烟失败，退出码：${String(result.status)}`);
  }
}

function writeEvidence(input) {
  const evidenceDirectory = resolve('out', 'release-evidence');
  mkdirSync(evidenceDirectory, { recursive: true });
  const gitCommit = process.env.GITHUB_SHA?.trim() || execFileSync(
    'git',
    ['rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).trim();
  const gitDirty = spawnSync('git', ['status', '--porcelain'], {
    encoding: 'utf8',
  }).stdout.trim().length > 0;
  const baseName = `portable-${input.target.platform}-${input.target.arch}`;
  const evidencePath = join(evidenceDirectory, `${baseName}.json`);
  writeFileSync(evidencePath, `${JSON.stringify({
    schemaVersion: 1,
    version: packageJson.version,
    gitCommit,
    gitDirty,
    platform: input.target.platform,
    architecture: input.target.arch,
    archiveFile: basename(input.archivePath),
    archiveSha256: input.archiveSha256,
    verifiedAt: new Date().toISOString(),
    checks: input.checks,
  }, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(evidenceDirectory, `${baseName}.sha256`),
    `${input.archiveSha256}  ${basename(input.archivePath)}\n`,
    'utf8',
  );
  return evidencePath;
}
