import { BailianOcrClient, type FetchLike } from '../adapters/recognition/bailian-ocr-client';
import { ConfiguredBailianRecognizer } from '../adapters/recognition/configured-bailian-recognizer';
import { DesktopSession } from './desktop-session';
import { OcrSettingsFile } from './ocr-settings-file';
import { OcrSettingsService, type ApiKeyStore } from './ocr-settings';
import { Preferences } from './preferences';

export function createConfiguredDesktopSession(input: {
  configDirectory: string;
  apiKeyStore: ApiKeyStore;
  request?: FetchLike;
}): DesktopSession {
  const client = new BailianOcrClient(input.request);
  const ocrSettings = new OcrSettingsService(
    new OcrSettingsFile(input.configDirectory),
    input.apiKeyStore,
    client,
  );
  const recognizer = new ConfiguredBailianRecognizer(ocrSettings, client);
  return new DesktopSession(
    new Preferences(input.configDirectory),
    recognizer,
    ocrSettings,
  );
}
