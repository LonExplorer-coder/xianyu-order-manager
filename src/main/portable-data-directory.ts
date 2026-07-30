import { realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';

type CanonicalizePath = (path: string) => string;

export function assertDataDirectoryOutsideProgram(input: {
  dataDirectory: string;
  executablePath: string;
  platform: NodeJS.Platform;
  canonicalizePath?: CanonicalizePath;
}): void {
  const pathApi = input.platform === 'win32' ? win32 : posix;
  const canonicalizePath = input.canonicalizePath ?? realpathSync.native;
  const executablePath = canonicalizeExistingPath(
    pathApi.resolve(input.executablePath),
    pathApi,
    canonicalizePath,
    '程序',
  );
  const programRoot = portableProgramRoot(
    executablePath,
    input.platform,
  );
  const dataDirectory = canonicalizePathAllowingMissingLeaf(
    pathApi.resolve(input.dataDirectory),
    pathApi,
    canonicalizePath,
  );
  const comparableProgramRoot = input.platform === 'win32'
    ? programRoot.toLocaleLowerCase('en-US')
    : programRoot;
  const comparableDataDirectory = input.platform === 'win32'
    ? dataDirectory.toLocaleLowerCase('en-US')
    : dataDirectory;
  const fromProgram = pathApi.relative(
    comparableProgramRoot,
    comparableDataDirectory,
  );
  const isInsideProgram = (
    fromProgram === '' ||
    (
      fromProgram !== '..' &&
      !fromProgram.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(fromProgram)
    )
  );
  if (isInsideProgram) {
    throw new Error('订单数据目录不能放在程序目录内，请选择“文档”等独立位置');
  }
}

function canonicalizeExistingPath(
  path: string,
  pathApi: typeof posix | typeof win32,
  canonicalizePath: CanonicalizePath,
  label: string,
): string {
  try {
    return pathApi.resolve(canonicalizePath(path));
  } catch (error) {
    throw new Error(`无法确认${label}的真实位置`, { cause: error });
  }
}

function canonicalizePathAllowingMissingLeaf(
  path: string,
  pathApi: typeof posix | typeof win32,
  canonicalizePath: CanonicalizePath,
): string {
  let existingAncestor = path;
  const missingSegments: string[] = [];
  while (true) {
    try {
      return pathApi.resolve(
        canonicalizePath(existingAncestor),
        ...missingSegments,
      );
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new Error('无法确认订单数据目录的真实位置，请检查目录访问权限', {
          cause: error,
        });
      }
      const parent = pathApi.dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new Error('无法确认订单数据目录的真实位置', { cause: error });
      }
      missingSegments.unshift(pathApi.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === 'ENOENT' || error.code === 'ENOTDIR';
}

function portableProgramRoot(
  executablePath: string,
  platform: NodeJS.Platform,
): string {
  const pathApi = platform === 'win32' ? win32 : posix;
  if (platform !== 'darwin') return pathApi.dirname(pathApi.resolve(executablePath));

  let current = pathApi.dirname(pathApi.resolve(executablePath));
  while (true) {
    if (pathApi.basename(current).toLocaleLowerCase('en-US').endsWith('.app')) {
      return current;
    }
    const parent = pathApi.dirname(current);
    if (parent === current) return pathApi.dirname(pathApi.resolve(executablePath));
    current = parent;
  }
}
