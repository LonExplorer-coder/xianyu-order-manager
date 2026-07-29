import type {
  BootstrapState,
} from '../core/desktop-api';
import type {
  OrderDetails,
  OrderDraft,
  OrderSummary,
  OriginalOrder,
  Recognizer,
  RecognitionBatchView,
} from '../core/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type {
  OcrConnectionTestInput,
  OcrConnectionTestResult,
  OcrSettingsView,
  SaveOcrSettingsInput,
} from '../core/ocr-settings';
import { LocalApplication } from './local-application';
import { OcrSettingsService } from './ocr-settings';
import { Preferences } from './preferences';
import { WorkspaceInUseError } from './workspace';

export class DesktopSession {
  private application?: LocalApplication;
  private state: BootstrapState = { kind: 'needs_data_directory' };
  private readonly recognitionBatches: RecognitionBatchView[] = [];
  private recognitionQueue: Promise<void> = Promise.resolve();
  private readonly seenSourceHashes = new Set<string>();
  private workspaceGeneration = 0;
  private readonly applicationWorkCounts = new Map<LocalApplication, number>();
  private readonly retiringApplications = new Set<LocalApplication>();
  private readonly recognitionBatchListeners = new Set<
    (batches: RecognitionBatchView[]) => void
  >();

  public constructor(
    private readonly preferences: Preferences,
    private readonly recognizer: Recognizer,
    private readonly ocrSettings: OcrSettingsService,
  ) {}

  public restore(): BootstrapState {
    const dataDirectory = this.preferences.getLastDataDirectory();
    if (!dataDirectory) {
      this.state = { kind: 'needs_data_directory' };
      return this.state;
    }
    return this.open(dataDirectory, false);
  }

  public getState(): BootstrapState {
    if (this.state.kind === 'ready') {
      this.state = {
        ...this.state,
        orders: this.requireApplication().listOrders(),
      };
    }
    return this.state;
  }

  public retryDataDirectory(): BootstrapState {
    return this.restore();
  }

  public useDataDirectory(dataDirectory: string): BootstrapState {
    return this.open(dataDirectory, true);
  }

  public submitSourceScreenshots(sourcePaths: string[]): Promise<RecognitionBatchView> {
    if (sourcePaths.length === 0) {
      throw new Error('请至少选择 1 张来源截图');
    }
    if (sourcePaths.length > 50) {
      throw new Error(
        `一次最多选择 50 张，当前选择了 ${sourcePaths.length} 张，请重新选择`,
      );
    }

    return this.stageAndSubmitSourceScreenshots(sourcePaths);
  }

  private async stageAndSubmitSourceScreenshots(
    sourcePaths: string[],
  ): Promise<RecognitionBatchView> {
    const batchId = randomUUID();
    const applicationState = this.getState();
    if (applicationState.kind !== 'ready') {
      throw new Error('请先选择可用的数据目录');
    }
    const application = this.requireApplication();
    const generation = this.workspaceGeneration;
    this.retainApplicationWork(application);
    try {
      for (const sourcePath of sourcePaths) {
        await validateSourceForStaging(sourcePath);
      }
      const itemIds = sourcePaths.map(() => randomUUID());
      const stagingBatchDirectory = join(
        applicationState.dataDirectory,
        '.recognition-queue',
        batchId,
      );
      let stagedPaths: string[];
      try {
        stagedPaths = [];
        for (const [index, sourcePath] of sourcePaths.entries()) {
          const itemDirectory = join(stagingBatchDirectory, itemIds[index]);
          await mkdir(itemDirectory, { recursive: true });
          const stagedPath = join(itemDirectory, basename(sourcePath));
          await copyFile(sourcePath, stagedPath);
          stagedPaths.push(stagedPath);
        }
      } catch {
        await rm(stagingBatchDirectory, { recursive: true, force: true })
          .catch(() => undefined);
        throw new Error('无法接收所选来源截图，请确认文件仍存在且可访问');
      }
      if (
        generation !== this.workspaceGeneration ||
        application !== this.application
      ) {
        await rm(stagingBatchDirectory, { recursive: true, force: true })
          .catch(() => undefined);
        throw new Error('数据目录已切换，本次截图未加入识别队列，请重新选择');
      }
      const batch: RecognitionBatchView = {
        id: batchId,
        items: sourcePaths.map((sourcePath, index) => ({
          id: itemIds[index],
          batchId,
          sourceName: basename(sourcePath),
          status: 'waiting_recognition',
        })),
        totalCount: sourcePaths.length,
        processedCount: 0,
        counts: {
          waiting_recognition: sourcePaths.length,
          recognizing: 0,
          validating: 0,
          awaiting_confirmation: 0,
          imported: 0,
          waiting_retry: 0,
          failed: 0,
          duplicate_skipped: 0,
          cancelled: 0,
        },
        createdAt: new Date().toISOString(),
      };
      this.recognitionBatches.unshift(batch);
      this.notifyRecognitionBatchesChanged();
      stagedPaths.forEach((sourcePath, index) => {
        const itemId = batch.items[index].id;
        this.retainApplicationWork(application);
        this.recognitionQueue = this.recognitionQueue
          .then(() => this.processRecognitionItem(
            application,
            generation,
            batchId,
            itemId,
            sourcePath,
          ))
          .catch(() => undefined);
      });
      this.recognitionQueue = this.recognitionQueue.finally(() => (
        rm(stagingBatchDirectory, { recursive: true, force: true }).catch(() => undefined)
      ));
      return structuredClone(batch);
    } finally {
      this.releaseApplicationWork(application);
    }
  }

  public listRecognitionBatches(): RecognitionBatchView[] {
    return structuredClone(this.recognitionBatches);
  }

  public getDraft(draftId: string): OrderDraft {
    return structuredClone(this.requireApplication().getDraft(draftId));
  }

  public onRecognitionBatchesChanged(
    listener: (batches: RecognitionBatchView[]) => void,
  ): () => void {
    this.recognitionBatchListeners.add(listener);
    return () => this.recognitionBatchListeners.delete(listener);
  }

  public getLastSourceScreenshotDirectory(): string | undefined {
    try {
      return this.preferences.getLastSourceScreenshotDirectory();
    } catch {
      return undefined;
    }
  }

  public rememberSourceScreenshotDirectory(sourceDirectory: string): void {
    try {
      this.preferences.setLastSourceScreenshotDirectory(sourceDirectory);
    } catch {
      // This convenience preference must never prevent selecting or importing a screenshot.
    }
  }

  public cancelDraft(draftId: string): void {
    this.requireApplication().cancelDraft(draftId);
    this.setItemStatusByDraftId(draftId, 'cancelled');
  }

  public confirmDraft(draft: OrderDraft): OriginalOrder {
    const order = this.requireApplication().confirmDraft(draft);
    this.refreshOrders();
    this.setItemStatusByDraftId(draft.id, 'imported');
    return order;
  }

  public listOrders(): OrderSummary[] {
    return this.requireApplication().listOrders();
  }

  public getOrder(orderId: string): OrderDetails {
    return this.requireApplication().getOrder(orderId);
  }

  public async getScreenshotDataUrl(screenshotId: string): Promise<string> {
    try {
      const screenshot = await this.requireApplication().readSourceScreenshot(screenshotId);
      return `data:${screenshot.mimeType};base64,${Buffer.from(screenshot.bytes).toString('base64')}`;
    } catch (error) {
      if (readableError(error) === '未找到来源截图') throw error;
      throw new Error('无法读取来源截图，请检查数据目录后重试');
    }
  }

  public getOcrSettings(): Promise<OcrSettingsView> {
    return this.ocrSettings.getSettings();
  }

  public saveOcrSettings(input: SaveOcrSettingsInput): Promise<OcrSettingsView> {
    return this.ocrSettings.saveSettings(input);
  }

  public removeOcrApiKey(): Promise<OcrSettingsView> {
    return this.ocrSettings.removeApiKey();
  }

  public testOcrConnection(
    input: OcrConnectionTestInput,
  ): Promise<OcrConnectionTestResult> {
    return this.ocrSettings.testConnection(input);
  }

  public close(): void {
    this.recognitionBatchListeners.clear();
    this.workspaceGeneration += 1;
    this.recognitionBatches.splice(0);
    this.seenSourceHashes.clear();
    if (this.application) this.retireApplication(this.application);
    this.application = undefined;
    this.state = { kind: 'needs_data_directory' };
  }

  private open(dataDirectory: string, remember: boolean): BootstrapState {
    if (
      this.state.kind === 'ready' &&
      this.state.dataDirectory === dataDirectory &&
      this.application
    ) {
      if (remember) this.preferences.setLastDataDirectory(dataDirectory);
      return this.getState();
    }
    const previousApplication = this.application;
    this.application = undefined;
    this.workspaceGeneration += 1;
    this.recognitionBatches.splice(0);
    this.seenSourceHashes.clear();
    if (previousApplication) this.retireApplication(previousApplication);
    const application = new LocalApplication(this.recognizer);
    try {
      application.openDataDirectory(dataDirectory);
      this.application = application;
      if (remember) this.preferences.setLastDataDirectory(dataDirectory);
      this.state = {
        kind: 'ready',
        dataDirectory,
        orders: application.listOrders(),
      };
    } catch (error) {
      application.close();
      if (error instanceof WorkspaceInUseError) {
        this.state = {
          kind: 'locked',
          dataDirectory: error.dataDirectory,
          message: error.message,
        };
      } else {
        this.state = {
          kind: 'error',
          message: error instanceof Error ? error.message : '无法打开数据目录',
        };
      }
    }
    this.notifyRecognitionBatchesChanged();
    return this.state;
  }

  private refreshOrders(): void {
    if (this.state.kind !== 'ready') return;
    this.state = {
      ...this.state,
      orders: this.requireApplication().listOrders(),
    };
  }

  private async processRecognitionItem(
    application: LocalApplication,
    generation: number,
    batchId: string,
    itemId: string,
    sourcePath: string,
  ): Promise<void> {
    this.setRecognitionItemStatus(generation, batchId, itemId, 'recognizing');
    let reservedHash: string | undefined;
    try {
      const sha256 = createHash('sha256')
        .update(await readFile(sourcePath))
        .digest('hex');
      if (
        this.seenSourceHashes.has(sha256) ||
        application.hasSourceScreenshotSha256(sha256)
      ) {
        this.setRecognitionItemStatus(
          generation,
          batchId,
          itemId,
          'duplicate_skipped',
        );
        return;
      }
      this.seenSourceHashes.add(sha256);
      reservedHash = sha256;
      const draft = await application.submitRecognitionSource(
        sourcePath,
        batchId,
        () => {
          this.setRecognitionItemStatus(
            generation,
            batchId,
            itemId,
            'validating',
          );
        },
      );
      this.setRecognitionItemStatus(
        generation,
        batchId,
        itemId,
        'awaiting_confirmation',
        draft.id,
      );
    } catch (error) {
      const isTemporary = isTemporaryRecognitionError(error);
      this.setRecognitionItemStatus(
        generation,
        batchId,
        itemId,
        isTemporary ? 'waiting_retry' : 'failed',
        undefined,
        userFacingRecognitionError(error),
      );
    } finally {
      if (reservedHash) this.seenSourceHashes.delete(reservedHash);
      await rm(dirname(sourcePath), { recursive: true, force: true }).catch(() => undefined);
      this.releaseApplicationWork(application);
    }
  }

  private setRecognitionItemStatus(
    generation: number,
    batchId: string,
    itemId: string,
    status: RecognitionBatchView['items'][number]['status'],
    draftId?: string,
    errorMessage?: string,
  ): void {
    if (generation !== this.workspaceGeneration) return;
    const batch = this.recognitionBatches.find((candidate) => candidate.id === batchId);
    const item = batch?.items.find((candidate) => candidate.id === itemId);
    if (!batch || !item) return;
    item.status = status;
    if (draftId) item.draftId = draftId;
    if (errorMessage) item.errorMessage = errorMessage;
    updateBatchProgress(batch);
    this.notifyRecognitionBatchesChanged();
  }

  private setItemStatusByDraftId(
    draftId: string,
    status: 'imported' | 'cancelled',
  ): void {
    for (const batch of this.recognitionBatches) {
      const item = batch.items.find((candidate) => candidate.draftId === draftId);
      if (!item) continue;
      item.status = status;
      delete item.errorMessage;
      updateBatchProgress(batch);
      this.notifyRecognitionBatchesChanged();
      return;
    }
  }

  private notifyRecognitionBatchesChanged(): void {
    for (const listener of this.recognitionBatchListeners) {
      try {
        listener(this.listRecognitionBatches());
      } catch {
        // A renderer listener cannot interrupt the background recognition queue.
      }
    }
  }

  private retainApplicationWork(application: LocalApplication): void {
    this.applicationWorkCounts.set(
      application,
      (this.applicationWorkCounts.get(application) ?? 0) + 1,
    );
  }

  private releaseApplicationWork(application: LocalApplication): void {
    const remaining = (this.applicationWorkCounts.get(application) ?? 1) - 1;
    if (remaining > 0) {
      this.applicationWorkCounts.set(application, remaining);
      return;
    }
    this.applicationWorkCounts.delete(application);
    if (!this.retiringApplications.delete(application)) return;
    closeApplication(application);
  }

  private retireApplication(application: LocalApplication): void {
    if ((this.applicationWorkCounts.get(application) ?? 0) > 0) {
      this.retiringApplications.add(application);
      return;
    }
    closeApplication(application);
  }

  private requireApplication(): LocalApplication {
    if (!this.application || this.state.kind !== 'ready') {
      throw new Error('请先选择可用的数据目录');
    }
    return this.application;
  }
}

const PROCESSED_RECOGNITION_STATUSES = new Set<
  RecognitionBatchView['items'][number]['status']
>([
  'awaiting_confirmation',
  'imported',
  'waiting_retry',
  'failed',
  'duplicate_skipped',
  'cancelled',
]);

function updateBatchProgress(batch: RecognitionBatchView): void {
  for (const status of Object.keys(batch.counts) as Array<keyof typeof batch.counts>) {
    batch.counts[status] = 0;
  }
  for (const item of batch.items) batch.counts[item.status] += 1;
  batch.processedCount = batch.items.filter((item) => (
    PROCESSED_RECOGNITION_STATUSES.has(item.status)
  )).length;
}

function readableError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return '来源截图识别失败，请检查图片后重试';
}

function userFacingRecognitionError(error: unknown): string {
  const originalMessage = readableError(error);
  if (SAFE_RECOGNITION_ERROR_MESSAGES.has(originalMessage)) return originalMessage;
  return '来源截图识别失败，请检查图片完整清晰后重试';
}

const SAFE_RECOGNITION_ERROR_MESSAGES = new Set([
  '请先在设置中保存百炼 OCR 配置和 API Key',
  '无法连接百炼服务，请检查网络后重试',
  '百炼 OCR 识别未通过，请检查 API Key、Workspace ID、地域和模型权限',
  '百炼 OCR 当前限流或额度不足，请稍后再试',
  '百炼 OCR 服务暂时不可用，请稍后再试',
  '百炼 OCR 无法识别这张截图，请确认图片完整清晰',
  '百炼 OCR 返回了无法识别的订单结果',
  '百炼 OCR 返回了无法安全保存的订单结果',
  '百炼 OCR 返回内容被截断，请压缩截图后重试',
  '当前仅支持 PNG、JPG、JPEG 或 WebP 来源截图',
  '请选择一个来源截图文件',
  '来源截图不能超过 7.5 MB，请压缩后重试',
  '来源截图编码后超过 10 MB，请压缩后重试',
]);

function isTemporaryRecognitionError(error: unknown): boolean {
  return TEMPORARY_RECOGNITION_ERROR_MESSAGES.has(readableError(error));
}

const TEMPORARY_RECOGNITION_ERROR_MESSAGES = new Set([
  '无法连接百炼服务，请检查网络后重试',
  '百炼 OCR 当前限流或额度不足，请稍后再试',
  '百炼 OCR 服务暂时不可用，请稍后再试',
]);

const STAGEABLE_SOURCE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_STAGEABLE_SOURCE_BYTES = 7_500_000;

async function validateSourceForStaging(sourcePath: string): Promise<void> {
  let sourceStats;
  try {
    sourceStats = await stat(sourcePath);
  } catch {
    throw new Error('无法读取所选来源截图，请确认文件仍存在且可访问');
  }
  if (!sourceStats.isFile()) throw new Error('请选择一个来源截图文件');
  if (!STAGEABLE_SOURCE_EXTENSIONS.has(extname(sourcePath).toLowerCase())) {
    throw new Error('当前仅支持 PNG、JPG、JPEG 或 WebP 来源截图');
  }
  if (sourceStats.size > MAX_STAGEABLE_SOURCE_BYTES) {
    throw new Error('来源截图不能超过 7.5 MB，请压缩后重试');
  }
}

function closeApplication(application: LocalApplication): void {
  try {
    application.close();
  } catch {
    // Closing a retired workspace must not replace a user-facing workflow result.
  }
}
