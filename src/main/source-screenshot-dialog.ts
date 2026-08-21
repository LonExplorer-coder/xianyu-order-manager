import { statSync } from 'node:fs';
import { dirname } from 'node:path';

import type { OpenDialogOptions } from 'electron';

import { SOURCE_SCREENSHOT_EXTENSIONS } from '../core/source-screenshots';

type SourceScreenshotSelection = {
  canceled: boolean;
  filePaths: string[];
};

export function sourceScreenshotDialogOptions(
  preferredDirectory?: string,
): OpenDialogOptions {
  const options: OpenDialogOptions = {
    title: '选择 1–50 张包含完整闲鱼订单详情的来源截图',
    buttonLabel: '创建识别批次',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: '来源截图',
        extensions: SOURCE_SCREENSHOT_EXTENSIONS.map((extension) => extension.slice(1)),
      },
    ],
  };

  if (isExistingDirectory(preferredDirectory)) {
    options.defaultPath = preferredDirectory;
  }

  return options;
}

export function selectedSourceScreenshotDirectory(
  selection: SourceScreenshotSelection,
): string | undefined {
  if (selection.canceled || selection.filePaths.length === 0) return undefined;
  return dirname(selection.filePaths[0]);
}

function isExistingDirectory(candidate?: string): candidate is string {
  if (!candidate?.trim()) return false;
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
