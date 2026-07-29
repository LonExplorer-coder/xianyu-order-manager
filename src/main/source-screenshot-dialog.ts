import { statSync } from 'node:fs';
import { dirname } from 'node:path';

import type { OpenDialogOptions } from 'electron';

type SourceScreenshotSelection = {
  canceled: boolean;
  filePaths: string[];
};

export function sourceScreenshotDialogOptions(
  preferredDirectory?: string,
): OpenDialogOptions {
  const options: OpenDialogOptions = {
    title: '选择一张包含完整闲鱼订单详情的来源截图',
    buttonLabel: '识别此来源截图',
    properties: ['openFile'],
    filters: [
      { name: '来源截图', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
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
