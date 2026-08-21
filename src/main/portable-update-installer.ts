import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import type { PortableUpdatePlatform } from '../core/portable-update';

export interface PortableUpdateInstallInput {
  platform: PortableUpdatePlatform;
  version: string;
  currentProcessId: number;
  currentExecutablePath: string;
  archivePath: string;
  backupDirectory: string;
  workingDirectory: string;
  nonce: string;
}

export interface PortableUpdateInstallPlan {
  programRoot: string;
  rollbackRoot: string;
  scriptFileName: 'apply-update.sh' | 'apply-update.ps1';
  script: string;
  environment: Record<string, string>;
}

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => { unref(): void };

export function buildPortableUpdateInstallPlan(
  input: PortableUpdateInstallInput,
): PortableUpdateInstallPlan {
  if (!Number.isSafeInteger(input.currentProcessId) || input.currentProcessId <= 0) {
    throw new Error('当前应用进程 ID 无效');
  }
  const pathApi = input.platform === 'win32' ? win32 : posix;
  const programRoot = portableProgramRoot(
    input.platform,
    input.currentExecutablePath,
  );
  const rollbackRoot = `${programRoot}.rollback-${input.version}-${input.nonce}`;
  const extractDirectory = pathApi.join(input.workingDirectory, 'candidate');
  const healthDataDirectory = pathApi.join(input.workingDirectory, 'health-data');
  assertSafeUpdatePaths({ ...input, programRoot, rollbackRoot }, pathApi);
  const environment = {
    XIANYU_UPDATE_PID: String(input.currentProcessId),
    XIANYU_UPDATE_ARCHIVE: input.archivePath,
    XIANYU_UPDATE_BACKUP_DIRECTORY: input.backupDirectory,
    XIANYU_UPDATE_WORKING_DIRECTORY: input.workingDirectory,
    XIANYU_UPDATE_EXTRACT_DIRECTORY: extractDirectory,
    XIANYU_UPDATE_HEALTH_DATA_DIRECTORY: healthDataDirectory,
    XIANYU_UPDATE_PROGRAM_ROOT: programRoot,
    XIANYU_UPDATE_ROLLBACK_ROOT: rollbackRoot,
    XIANYU_UPDATE_CANDIDATE_SMOKE: '1',
  };
  return input.platform === 'darwin'
    ? {
      programRoot,
      rollbackRoot,
      scriptFileName: 'apply-update.sh',
      script: MACOS_UPDATE_SCRIPT,
      environment,
    }
    : {
      programRoot,
      rollbackRoot,
      scriptFileName: 'apply-update.ps1',
      script: WINDOWS_UPDATE_SCRIPT,
      environment,
    };
}

function assertSafeUpdatePaths(
  input: PortableUpdateInstallInput & { programRoot: string; rollbackRoot: string },
  pathApi: typeof posix | typeof win32,
): void {
  if (!/^[0-9A-Za-z.-]+$/u.test(input.version) || !/^[0-9A-Za-z-]+$/u.test(input.nonce)) {
    throw new Error('更新版本或随机标识格式无效');
  }
  const roots = [
    input.programRoot,
    input.rollbackRoot,
    input.workingDirectory,
    input.archivePath,
    input.backupDirectory,
  ].map((value) => pathApi.resolve(value));
  if (roots.some((value) => value === pathApi.parse(value).root)) {
    throw new Error('更新路径不能指向文件系统根目录');
  }
  const [programRoot, rollbackRoot, workingDirectory, archivePath, backupDirectory] = roots;
  if (
    archivePath === programRoot
    || !archivePath.toLowerCase().endsWith('.zip')
    || pathApi.dirname(workingDirectory) !== pathApi.dirname(archivePath)
    || isInsidePath(programRoot, workingDirectory, pathApi)
    || isInsidePath(workingDirectory, programRoot, pathApi)
    || isInsidePath(programRoot, backupDirectory, pathApi)
    || rollbackRoot === programRoot
  ) {
    throw new Error('便携版更新路径关系无效');
  }
}

function isInsidePath(
  parent: string,
  child: string,
  pathApi: typeof posix | typeof win32,
): boolean {
  if (pathApi.parse(parent).root.toLowerCase() !== pathApi.parse(child).root.toLowerCase()) {
    return false;
  }
  const relative = pathApi.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${pathApi.sep}`);
}

export async function launchPortableUpdateInstaller(
  input: PortableUpdateInstallInput,
  dependencies: { spawn?: SpawnLike } = {},
): Promise<{ scriptPath: string; programRoot: string; rollbackRoot: string }> {
  const plan = buildPortableUpdateInstallPlan(input);
  const pathApi = input.platform === 'win32' ? win32 : posix;
  await mkdir(input.workingDirectory, { recursive: true });
  const scriptPath = pathApi.join(input.workingDirectory, plan.scriptFileName);
  await writeFile(scriptPath, plan.script, 'utf8');
  const spawn = dependencies.spawn ?? nodeSpawn;
  const command = input.platform === 'darwin'
    ? '/bin/sh'
    : 'powershell.exe';
  const args = input.platform === 'darwin'
    ? [scriptPath]
    : [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ...plan.environment },
  });
  child.unref();
  return { scriptPath, programRoot: plan.programRoot, rollbackRoot: plan.rollbackRoot };
}

function portableProgramRoot(
  platform: PortableUpdatePlatform,
  executablePath: string,
): string {
  if (platform === 'darwin') {
    const macosDirectory = posix.dirname(executablePath);
    const contentsDirectory = posix.dirname(macosDirectory);
    const appRoot = posix.dirname(contentsDirectory);
    if (
      posix.basename(macosDirectory) !== 'MacOS'
      || posix.basename(contentsDirectory) !== 'Contents'
      || !appRoot.endsWith('.app')
    ) {
      throw new Error('当前 macOS 便携程序路径无效');
    }
    return appRoot;
  }
  if (win32.basename(executablePath).toLowerCase() !== 'xianyuordermanager.exe') {
    throw new Error('当前 Windows 便携程序路径无效');
  }
  return win32.dirname(executablePath);
}

const MACOS_UPDATE_SCRIPT = `#!/bin/sh
set -eu

while kill -0 "$XIANYU_UPDATE_PID" 2>/dev/null; do sleep 1; done

rm -rf "$XIANYU_UPDATE_EXTRACT_DIRECTORY" "$XIANYU_UPDATE_HEALTH_DATA_DIRECTORY"
mkdir -p "$XIANYU_UPDATE_EXTRACT_DIRECTORY"
/usr/bin/ditto -x -k "$XIANYU_UPDATE_ARCHIVE" "$XIANYU_UPDATE_EXTRACT_DIRECTORY"

candidate_root="$XIANYU_UPDATE_EXTRACT_DIRECTORY/XianyuOrderManager.app"
candidate_executable="$candidate_root/Contents/MacOS/XianyuOrderManager"
test -x "$candidate_executable"

"$candidate_executable"

test ! -e "$XIANYU_UPDATE_ROLLBACK_ROOT"
mv "$XIANYU_UPDATE_PROGRAM_ROOT" "$XIANYU_UPDATE_ROLLBACK_ROOT"
if mv "$candidate_root" "$XIANYU_UPDATE_PROGRAM_ROOT"; then
  unset XIANYU_UPDATE_CANDIDATE_SMOKE XIANYU_UPDATE_BACKUP_DIRECTORY XIANYU_UPDATE_HEALTH_DATA_DIRECTORY
  if /usr/bin/open -n "$XIANYU_UPDATE_PROGRAM_ROOT"; then
    rm -rf "$XIANYU_UPDATE_ROLLBACK_ROOT" "$XIANYU_UPDATE_EXTRACT_DIRECTORY" "$XIANYU_UPDATE_HEALTH_DATA_DIRECTORY"
    exit 0
  fi
  rm -rf "$XIANYU_UPDATE_PROGRAM_ROOT"
fi

unset XIANYU_UPDATE_CANDIDATE_SMOKE XIANYU_UPDATE_BACKUP_DIRECTORY XIANYU_UPDATE_HEALTH_DATA_DIRECTORY
mv "$XIANYU_UPDATE_ROLLBACK_ROOT" "$XIANYU_UPDATE_PROGRAM_ROOT"
/usr/bin/open -n "$XIANYU_UPDATE_PROGRAM_ROOT" || true
exit 1
`;

const WINDOWS_UPDATE_SCRIPT = `$ErrorActionPreference = 'Stop'

while (Get-Process -Id ([int]$env:XIANYU_UPDATE_PID) -ErrorAction SilentlyContinue) {
  Start-Sleep -Seconds 1
}

Remove-Item -LiteralPath $env:XIANYU_UPDATE_EXTRACT_DIRECTORY -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $env:XIANYU_UPDATE_HEALTH_DATA_DIRECTORY -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $env:XIANYU_UPDATE_EXTRACT_DIRECTORY -Force | Out-Null
Expand-Archive -LiteralPath $env:XIANYU_UPDATE_ARCHIVE -DestinationPath $env:XIANYU_UPDATE_EXTRACT_DIRECTORY -Force

$candidate = Get-ChildItem -LiteralPath $env:XIANYU_UPDATE_EXTRACT_DIRECTORY -Filter 'XianyuOrderManager.exe' -File -Recurse |
  Where-Object { Test-Path (Join-Path $_.Directory.FullName 'resources\\app.asar') } |
  Select-Object -First 1
if (-not $candidate) { throw '更新 ZIP 缺少完整 Windows 便携程序' }
$candidateRoot = $candidate.Directory.FullName
$health = Start-Process -FilePath $candidate.FullName -Wait -PassThru -WindowStyle Hidden
if ($health.ExitCode -ne 0) { throw "更新候选健康检查失败：$($health.ExitCode)" }

if (Test-Path -LiteralPath $env:XIANYU_UPDATE_ROLLBACK_ROOT) { throw '更新回滚目录已存在' }
Move-Item -LiteralPath $env:XIANYU_UPDATE_PROGRAM_ROOT -Destination $env:XIANYU_UPDATE_ROLLBACK_ROOT
try {
  Move-Item -LiteralPath $candidateRoot -Destination $env:XIANYU_UPDATE_PROGRAM_ROOT
  $env:XIANYU_UPDATE_CANDIDATE_SMOKE = $null
  $env:XIANYU_UPDATE_BACKUP_DIRECTORY = $null
  $env:XIANYU_UPDATE_HEALTH_DATA_DIRECTORY = $null
  Start-Process -FilePath (Join-Path $env:XIANYU_UPDATE_PROGRAM_ROOT 'XianyuOrderManager.exe') | Out-Null
  Remove-Item -LiteralPath $env:XIANYU_UPDATE_ROLLBACK_ROOT -Recurse -Force
  Remove-Item -LiteralPath $env:XIANYU_UPDATE_EXTRACT_DIRECTORY -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $env:XIANYU_UPDATE_HEALTH_DATA_DIRECTORY -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  Remove-Item -LiteralPath $env:XIANYU_UPDATE_PROGRAM_ROOT -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $env:XIANYU_UPDATE_ROLLBACK_ROOT -Destination $env:XIANYU_UPDATE_PROGRAM_ROOT
  $env:XIANYU_UPDATE_CANDIDATE_SMOKE = $null
  $env:XIANYU_UPDATE_BACKUP_DIRECTORY = $null
  $env:XIANYU_UPDATE_HEALTH_DATA_DIRECTORY = $null
  Start-Process -FilePath (Join-Path $env:XIANYU_UPDATE_PROGRAM_ROOT 'XianyuOrderManager.exe') | Out-Null
  throw
}
`;
