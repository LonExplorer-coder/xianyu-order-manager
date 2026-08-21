import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join as hostJoin, posix, win32 } from 'node:path';

import type { PortableUpdatePlatform } from '../core/portable-update';

export interface PortableUpdateInstallInput {
  platform: PortableUpdatePlatform;
  version: string;
  currentProcessId: number;
  currentExecutablePath: string;
  archivePath: string;
  archiveSha256: string;
  backupDirectory: string;
  workingDirectory: string;
  statusFilePath: string;
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
  const postInstallMarkerPath = pathApi.join(input.workingDirectory, 'post-install.marker');
  assertSafeUpdatePaths({ ...input, programRoot, rollbackRoot }, pathApi);
  const environment = {
    XIANYU_UPDATE_PID: String(input.currentProcessId),
    XIANYU_UPDATE_ARCHIVE: input.archivePath,
    XIANYU_UPDATE_ARCHIVE_SHA256: input.archiveSha256,
    XIANYU_UPDATE_BACKUP_DIRECTORY: input.backupDirectory,
    XIANYU_UPDATE_WORKING_DIRECTORY: input.workingDirectory,
    XIANYU_UPDATE_EXTRACT_DIRECTORY: extractDirectory,
    XIANYU_UPDATE_HEALTH_DATA_DIRECTORY: healthDataDirectory,
    XIANYU_UPDATE_PROGRAM_ROOT: programRoot,
    XIANYU_UPDATE_ROLLBACK_ROOT: rollbackRoot,
    XIANYU_UPDATE_CANDIDATE_SMOKE: '1',
    XIANYU_UPDATE_EXPECTED_VERSION: input.version,
    XIANYU_UPDATE_POST_INSTALL_TOKEN: input.nonce,
    XIANYU_UPDATE_POST_INSTALL_MARKER: postInstallMarkerPath,
    XIANYU_UPDATE_STATUS_FILE: input.statusFilePath,
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
    input.statusFilePath,
  ].map((value) => pathApi.resolve(value));
  if (roots.some((value) => value === pathApi.parse(value).root)) {
    throw new Error('更新路径不能指向文件系统根目录');
  }
  const [
    programRoot,
    rollbackRoot,
    workingDirectory,
    archivePath,
    backupDirectory,
    statusFilePath,
  ] = roots;
  if (
    archivePath === programRoot
    || !archivePath.toLowerCase().endsWith('.zip')
    || pathApi.dirname(workingDirectory) !== pathApi.dirname(archivePath)
    || isInsidePath(programRoot, workingDirectory, pathApi)
    || isInsidePath(workingDirectory, programRoot, pathApi)
    || isInsidePath(programRoot, backupDirectory, pathApi)
    || isInsidePath(programRoot, statusFilePath, pathApi)
    || rollbackRoot === programRoot
    || !/^[a-f0-9]{64}$/u.test(input.archiveSha256)
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
  dependencies: { spawn?: SpawnLike; environment?: NodeJS.ProcessEnv } = {},
): Promise<{ scriptPath: string; programRoot: string; rollbackRoot: string }> {
  const plan = buildPortableUpdateInstallPlan(input);
  if (input.platform === 'win32') {
    await assertWindowsPortableProgramRoot(plan.programRoot);
  }
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
    env: {
      ...portableRuntimeEnvironment(
        input.platform,
        dependencies.environment ?? process.env,
      ),
      ...plan.environment,
    },
  });
  child.unref();
  return { scriptPath, programRoot: plan.programRoot, rollbackRoot: plan.rollbackRoot };
}

export async function assertWindowsPortableProgramRoot(programRoot: string): Promise<void> {
  const markerName = '.xianyu-portable-program.json';
  let marker: unknown;
  try {
    const raw = await readFile(hostJoin(programRoot, markerName), 'utf8');
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('marker too large');
    marker = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error('当前 Windows 程序目录缺少有效便携版边界标记', { cause: error });
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    throw new Error('当前 Windows 便携版边界标记格式无效');
  }
  const record = marker as Record<string, unknown>;
  if (
    record.schemaVersion !== 1
    || record.product !== 'xianyu-order-manager'
    || !Array.isArray(record.topLevelEntries)
    || record.topLevelEntries.length === 0
    || record.topLevelEntries.length > 1_000
    || !record.topLevelEntries.every((entry) => (
      typeof entry === 'string'
      && entry.length > 0
      && entry.length <= 255
      && !entry.includes('/')
      && !entry.includes('\\')
    ))
    || new Set(record.topLevelEntries).size !== record.topLevelEntries.length
  ) {
    throw new Error('当前 Windows 便携版边界标记格式无效');
  }
  const expected = [...record.topLevelEntries].sort();
  const actual = (await readdir(programRoot)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('当前 Windows 程序目录包含便携版之外的文件，已拒绝整目录替换');
  }
}

function portableRuntimeEnvironment(
  platform: PortableUpdatePlatform,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allowed = platform === 'darwin'
    ? ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'LC_ALL']
    : [
      'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'USERNAME',
      'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG',
    ];
  return Object.fromEntries(allowed.flatMap((key) => (
    source[key] === undefined ? [] : [[key, source[key]]]
  )));
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

write_status() {
  occurred_at=$(/bin/date -u +"%Y-%m-%dT%H:%M:%SZ")
  printf '{"status":"%s","version":"%s","message":"%s","occurredAt":"%s"}\n' "$1" "$XIANYU_UPDATE_EXPECTED_VERSION" "$2" "$occurred_at" > "$XIANYU_UPDATE_STATUS_FILE.tmp"
  mv "$XIANYU_UPDATE_STATUS_FILE.tmp" "$XIANYU_UPDATE_STATUS_FILE"
}

update_succeeded=0
new_pid=""
restore_old_program() {
  if [ ! -e "$XIANYU_UPDATE_ROLLBACK_ROOT" ]; then
    test -d "$XIANYU_UPDATE_PROGRAM_ROOT"
    return
  fi
  rm -rf "$XIANYU_UPDATE_PROGRAM_ROOT" || return 1
  if mv "$XIANYU_UPDATE_ROLLBACK_ROOT" "$XIANYU_UPDATE_PROGRAM_ROOT"; then return 0; fi
  rm -rf "$XIANYU_UPDATE_PROGRAM_ROOT" || true
  /usr/bin/ditto "$XIANYU_UPDATE_ROLLBACK_ROOT" "$XIANYU_UPDATE_PROGRAM_ROOT"
}
on_exit() {
  exit_code=$?
  if [ "$update_succeeded" -eq 0 ]; then
    if [ -n "$new_pid" ]; then kill "$new_pid" 2>/dev/null || true; fi
    if restore_old_program; then
      write_status failed "更新失败，已恢复旧便携程序"
      unset XIANYU_UPDATE_CANDIDATE_SMOKE XIANYU_UPDATE_BACKUP_DIRECTORY XIANYU_UPDATE_HEALTH_DATA_DIRECTORY
      unset XIANYU_UPDATE_POST_INSTALL_TOKEN XIANYU_UPDATE_POST_INSTALL_MARKER XIANYU_UPDATE_STATUS_FILE XIANYU_UPDATE_EXPECTED_VERSION
      /usr/bin/open -n "$XIANYU_UPDATE_PROGRAM_ROOT" || true
    else
      write_status failed "自动恢复未完成，旧程序仍保留在回滚目录"
      unset XIANYU_UPDATE_CANDIDATE_SMOKE XIANYU_UPDATE_BACKUP_DIRECTORY XIANYU_UPDATE_HEALTH_DATA_DIRECTORY
      unset XIANYU_UPDATE_POST_INSTALL_TOKEN XIANYU_UPDATE_POST_INSTALL_MARKER XIANYU_UPDATE_STATUS_FILE XIANYU_UPDATE_EXPECTED_VERSION
      rollback_executable="$XIANYU_UPDATE_ROLLBACK_ROOT/Contents/MacOS/XianyuOrderManager"
      if [ -x "$rollback_executable" ]; then "$rollback_executable" >/dev/null 2>&1 & fi
    fi
  fi
  return "$exit_code"
}
trap on_exit EXIT

write_status applying "正在验证并应用更新"
while kill -0 "$XIANYU_UPDATE_PID" 2>/dev/null; do sleep 1; done

actual_sha=$(/usr/bin/shasum -a 256 "$XIANYU_UPDATE_ARCHIVE" | /usr/bin/awk '{print $1}')
test "$actual_sha" = "$XIANYU_UPDATE_ARCHIVE_SHA256"

rm -rf "$XIANYU_UPDATE_EXTRACT_DIRECTORY" "$XIANYU_UPDATE_HEALTH_DATA_DIRECTORY"
mkdir -p "$XIANYU_UPDATE_EXTRACT_DIRECTORY"
/usr/bin/ditto -x -k "$XIANYU_UPDATE_ARCHIVE" "$XIANYU_UPDATE_EXTRACT_DIRECTORY"

candidate_root="$XIANYU_UPDATE_EXTRACT_DIRECTORY/XianyuOrderManager.app"
candidate_executable="$candidate_root/Contents/MacOS/XianyuOrderManager"
test -x "$candidate_executable"

"$candidate_executable"

test ! -e "$XIANYU_UPDATE_ROLLBACK_ROOT"
mv "$XIANYU_UPDATE_PROGRAM_ROOT" "$XIANYU_UPDATE_ROLLBACK_ROOT"
mv "$candidate_root" "$XIANYU_UPDATE_PROGRAM_ROOT"

unset XIANYU_UPDATE_CANDIDATE_SMOKE XIANYU_UPDATE_BACKUP_DIRECTORY XIANYU_UPDATE_HEALTH_DATA_DIRECTORY
rm -f "$XIANYU_UPDATE_POST_INSTALL_MARKER"
"$XIANYU_UPDATE_PROGRAM_ROOT/Contents/MacOS/XianyuOrderManager" &
new_pid=$!
healthy=0
attempt=0
while [ "$attempt" -lt 60 ]; do
  if [ -f "$XIANYU_UPDATE_POST_INSTALL_MARKER" ] && [ "$(/bin/cat "$XIANYU_UPDATE_POST_INSTALL_MARKER")" = "$XIANYU_UPDATE_POST_INSTALL_TOKEN" ]; then
    healthy=1
    break
  fi
  if ! kill -0 "$new_pid" 2>/dev/null; then break; fi
  sleep 1
  attempt=$((attempt + 1))
done
test "$healthy" -eq 1

update_succeeded=1
rm -rf "$XIANYU_UPDATE_ROLLBACK_ROOT" || true
rm -rf "$XIANYU_UPDATE_EXTRACT_DIRECTORY" "$XIANYU_UPDATE_HEALTH_DATA_DIRECTORY" || true
exit 0
`;

const WINDOWS_UPDATE_SCRIPT = `$ErrorActionPreference = 'Stop'

function Write-UpdateStatus([string]$Status, [string]$Message) {
  $payload = [ordered]@{
    status = $Status
    version = $env:XIANYU_UPDATE_EXPECTED_VERSION
    message = $Message
    occurredAt = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json -Compress
  Set-Content -LiteralPath "$($env:XIANYU_UPDATE_STATUS_FILE).tmp" -Value $payload -Encoding UTF8
  Move-Item -LiteralPath "$($env:XIANYU_UPDATE_STATUS_FILE).tmp" -Destination $env:XIANYU_UPDATE_STATUS_FILE -Force
}

$newProcess = $null
try {
  Write-UpdateStatus 'applying' '正在验证并应用更新'
  while (Get-Process -Id ([int]$env:XIANYU_UPDATE_PID) -ErrorAction SilentlyContinue) {
    Start-Sleep -Seconds 1
  }

  $actualHash = (Get-FileHash -LiteralPath $env:XIANYU_UPDATE_ARCHIVE -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $env:XIANYU_UPDATE_ARCHIVE_SHA256) { throw '更新 ZIP 的 SHA-256 在应用前发生变化' }

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
  Move-Item -LiteralPath $candidateRoot -Destination $env:XIANYU_UPDATE_PROGRAM_ROOT
  $env:XIANYU_UPDATE_CANDIDATE_SMOKE = $null
  $env:XIANYU_UPDATE_BACKUP_DIRECTORY = $null
  $env:XIANYU_UPDATE_HEALTH_DATA_DIRECTORY = $null
  Remove-Item -LiteralPath $env:XIANYU_UPDATE_POST_INSTALL_MARKER -Force -ErrorAction SilentlyContinue
  $newProcess = Start-Process -FilePath (Join-Path $env:XIANYU_UPDATE_PROGRAM_ROOT 'XianyuOrderManager.exe') -PassThru

  $healthy = $false
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    if ((Test-Path -LiteralPath $env:XIANYU_UPDATE_POST_INSTALL_MARKER) -and
        ((Get-Content -LiteralPath $env:XIANYU_UPDATE_POST_INSTALL_MARKER -Raw).Trim() -eq $env:XIANYU_UPDATE_POST_INSTALL_TOKEN)) {
      $healthy = $true
      break
    }
    if ($newProcess.HasExited) { break }
    Start-Sleep -Seconds 1
    $newProcess.Refresh()
  }
  if (-not $healthy) { throw '新程序未确认真实数据目录可读' }

  Remove-Item -LiteralPath $env:XIANYU_UPDATE_ROLLBACK_ROOT -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $env:XIANYU_UPDATE_EXTRACT_DIRECTORY -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $env:XIANYU_UPDATE_HEALTH_DATA_DIRECTORY -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  if ($newProcess -and -not $newProcess.HasExited) {
    Stop-Process -Id $newProcess.Id -Force -ErrorAction SilentlyContinue
    $newProcess.WaitForExit(5000)
  }
  $restored = Test-Path -LiteralPath $env:XIANYU_UPDATE_PROGRAM_ROOT
  if (Test-Path -LiteralPath $env:XIANYU_UPDATE_ROLLBACK_ROOT) {
    $restored = $false
    Remove-Item -LiteralPath $env:XIANYU_UPDATE_PROGRAM_ROOT -Recurse -Force -ErrorAction SilentlyContinue
    try {
      Move-Item -LiteralPath $env:XIANYU_UPDATE_ROLLBACK_ROOT -Destination $env:XIANYU_UPDATE_PROGRAM_ROOT
      $restored = $true
    } catch {
      try {
        Copy-Item -LiteralPath $env:XIANYU_UPDATE_ROLLBACK_ROOT -Destination $env:XIANYU_UPDATE_PROGRAM_ROOT -Recurse -Force
        $restored = $true
      } catch {
        $restored = $false
      }
    }
  }
  $env:XIANYU_UPDATE_CANDIDATE_SMOKE = $null
  $env:XIANYU_UPDATE_BACKUP_DIRECTORY = $null
  $env:XIANYU_UPDATE_HEALTH_DATA_DIRECTORY = $null
  $env:XIANYU_UPDATE_POST_INSTALL_TOKEN = $null
  $env:XIANYU_UPDATE_POST_INSTALL_MARKER = $null
  if ($restored) {
    Write-UpdateStatus 'failed' '更新失败，已恢复旧便携程序'
  } else {
    Write-UpdateStatus 'failed' '自动恢复未完成，旧程序仍保留在回滚目录'
  }
  $env:XIANYU_UPDATE_EXPECTED_VERSION = $null
  if ($restored -and (Test-Path -LiteralPath $env:XIANYU_UPDATE_PROGRAM_ROOT)) {
    Start-Process -FilePath (Join-Path $env:XIANYU_UPDATE_PROGRAM_ROOT 'XianyuOrderManager.exe') | Out-Null
  } elseif (Test-Path -LiteralPath $env:XIANYU_UPDATE_ROLLBACK_ROOT) {
    Start-Process -FilePath (Join-Path $env:XIANYU_UPDATE_ROLLBACK_ROOT 'XianyuOrderManager.exe') | Out-Null
  }
  exit 1
}
`;
