import type {
  BootstrapState,
} from '../core/desktop-api';
import type { CandidateAdjudicationAuditView } from '../core/candidate-adjudication-audit';
import type {
  CreateCustomFieldDefinitionInput,
  CustomFieldDefinition,
  CustomFieldValueRecord,
  DraftCustomFieldValues,
  SaveCustomFieldValuesInput,
} from '../core/custom-fields';
import type {
  OrderDetails,
  OrderDraft,
  OrderDraftConfirmation,
  OrderDraftReview,
  OrderReviewIssueCode,
  OrderSummary,
  OrderUpdateConfirmation,
  OriginalOrder,
  Recognizer,
  RecognitionBatchView,
} from '../core/contracts';
import {
  AUTOMATIC_RECOGNITION_RETRY_DELAYS_MS,
  MAX_AUTOMATIC_RECOGNITION_RETRIES,
  summarizeRecognitionBatchItems,
} from '../core/recognition-batches';
import {
  assessAutomaticImport,
  type OrderIntakeSettingsView,
  type SaveOrderIntakeSettingsInput,
} from '../core/order-intake';
import { hasEquivalentOrderContent } from '../core/order-comparison';
import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type {
  OcrConnectionTestInput,
  OcrConnectionTestResult,
  OcrSettingsView,
  SaveOcrSettingsInput,
} from '../core/ocr-settings';
import type {
  CandidateVerificationConnectionTestInput,
  CandidateVerificationConnectionTestResult,
  CandidateVerificationSettingsView,
  SaveCandidateVerificationSettingsInput,
} from '../core/candidate-verification-settings';
import type {
  OrderItemWorkbenchQuery,
  OrderItemWorkbenchResult,
  OrderWorkbenchQuery,
  OrderWorkbenchResult,
} from '../core/order-workbench';
import type {
  OrderExportInput,
  OrderExportWriteResult,
} from '../core/order-export';
import type { ShipmentGroupProjection } from '../core/shipment-groups';
import type {
  ShipmentGroupAdjustmentResult,
} from '../core/shipment-group-adjustments';
import type {
  ShipmentCancellationResult,
  ShipmentConfirmationResult,
  ShipmentLogisticsCorrectionResult,
  ShipmentRecord,
} from '../core/shipment-records';
import type {
  CreateTableTemplateInput,
  TableTemplate,
  TableTemplateGranularity,
  UpdateTableTemplateInput,
} from '../core/table-templates';
import {
  LocalApplication,
  type RecognitionBatchItemUpdate,
} from './local-application';
import { OcrSettingsService } from './ocr-settings';
import { CandidateVerificationSettingsService } from './candidate-verification-settings';
import { Preferences } from './preferences';
import { WorkspaceInUseError } from './workspace';

export type DataDirectoryValidator = (dataDirectory: string) => void;

export class DesktopSession {
  private application?: LocalApplication;
  private state: BootstrapState = { kind: 'needs_data_directory' };
  private readonly recognitionBatches: RecognitionBatchView[] = [];
  private recognitionQueue: Promise<void> = Promise.resolve();
  private readonly seenSourceHashes = new Set<string>();
  private workspaceGeneration = 0;
  private readonly applicationWorkCounts = new Map<LocalApplication, number>();
  private readonly retiringApplications = new Set<LocalApplication>();
  private readonly recognitionRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly recognitionBatchListeners = new Set<
    (batches: RecognitionBatchView[]) => void
  >();
  private readonly orderListeners = new Set<(orders: OrderSummary[]) => void>();

  public constructor(
    private readonly preferences: Preferences,
    private readonly recognizer: Recognizer,
    private readonly ocrSettings: OcrSettingsService,
    private readonly validateDataDirectory: DataDirectoryValidator = () => undefined,
    private readonly candidateVerificationSettings?: CandidateVerificationSettingsService,
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
      const items: RecognitionBatchView['items'] = sourcePaths.map((sourcePath, index) => ({
        id: itemIds[index],
        batchId,
        sourceName: basename(sourcePath),
        status: 'waiting_recognition',
        retryCount: 0,
      }));
      const batch: RecognitionBatchView = {
        id: batchId,
        items,
        ...summarizeRecognitionBatchItems(items),
        createdAt: new Date().toISOString(),
      };
      try {
        application.createRecognitionBatch({
          id: batch.id,
          createdAt: batch.createdAt,
          items: batch.items.map((item, index) => ({
            id: item.id,
            sourceName: item.sourceName,
            queuePath: stagedPaths[index],
          })),
        });
      } catch {
        await rm(stagingBatchDirectory, { recursive: true, force: true })
          .catch(() => undefined);
        throw new Error('无法创建识别批次，请检查数据目录后重试');
      }
      this.recognitionBatches.unshift(batch);
      this.notifyRecognitionBatchesChanged();
      batch.items.forEach((item) => {
        this.enqueueRecognitionItem(
          application,
          generation,
          batchId,
          item.id,
          0,
        );
      });
      return structuredClone(batch);
    } finally {
      this.releaseApplicationWork(application);
    }
  }

  public listRecognitionBatches(): RecognitionBatchView[] {
    return structuredClone(this.recognitionBatches);
  }

  public async waitForCurrentRecognitionWork(): Promise<void> {
    await this.recognitionQueue;
  }

  public async retryRecognitionItem(batchId: string, itemId: string): Promise<void> {
    const application = this.requireApplication();
    const generation = this.workspaceGeneration;
    this.cancelRecognitionRetryTimer(generation, batchId, itemId);
    const item = application.requestRecognitionItemRetry(batchId, itemId);
    this.applyRecognitionItemStatusToView(
      generation,
      {
        batchId,
        itemId,
        status: 'waiting_recognition',
        retryCount: 0,
        nextRetryAt: null,
      },
    );
    this.enqueueRecognitionItem(
      application,
      generation,
      batchId,
      itemId,
      item.retryCount,
    );
  }

  public async createManualDraft(batchId: string, itemId: string): Promise<OrderDraft> {
    const application = this.requireApplication();
    const generation = this.workspaceGeneration;
    this.cancelRecognitionRetryTimer(generation, batchId, itemId);
    const draft = await application.createManualDraft(batchId, itemId);
    this.applyRecognitionItemStatusToView(
      generation,
      {
        batchId,
        itemId,
        status: 'awaiting_confirmation',
        draftId: draft.id,
        nextRetryAt: null,
        reviewIssues: draft.reviewIssues ?? [],
        recognitionConflicts: draft.recognitionConflicts ?? [],
      },
    );
    return structuredClone(draft);
  }

  public getDraft(draftId: string): OrderDraft {
    return structuredClone(this.requireApplication().getDraft(draftId));
  }

  public getDraftReview(draftId: string): OrderDraftReview {
    return structuredClone(this.requireApplication().getDraftReview(draftId));
  }

  public getCandidateAdjudicationAudit(
    draftId: string,
  ): CandidateAdjudicationAuditView[] {
    return structuredClone(
      this.requireApplication().getCandidateAdjudicationAudit(draftId),
    );
  }

  public onRecognitionBatchesChanged(
    listener: (batches: RecognitionBatchView[]) => void,
  ): () => void {
    this.recognitionBatchListeners.add(listener);
    return () => this.recognitionBatchListeners.delete(listener);
  }

  public onOrdersChanged(listener: (orders: OrderSummary[]) => void): () => void {
    this.orderListeners.add(listener);
    return () => this.orderListeners.delete(listener);
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

  public confirmDraft(
    draft: OrderDraft,
    customValues?: DraftCustomFieldValues,
  ): OrderDraftConfirmation {
    const application = this.requireApplication();
    const order = application.confirmDraft(draft, customValues);
    this.refreshOrders();
    this.setItemStatusByDraftId(draft.id, 'imported', 'new_order');
    return { order, resolution: 'new_order' };
  }

  public confirmOrderUpdate(
    draft: OrderDraft,
    expectedRevision: number,
    customValues?: DraftCustomFieldValues,
  ): OrderUpdateConfirmation {
    const outcome = this.requireApplication().confirmOrderUpdate(
      draft,
      expectedRevision,
      customValues,
    );
    this.refreshOrders();
    this.setItemStatusByDraftId(
      draft.id,
      outcome.resolution === 'equivalent_order' ? 'duplicate_skipped' : 'imported',
      outcome.resolution,
    );
    return outcome;
  }

  public listOrders(): OrderSummary[] {
    return this.requireApplication().listOrders();
  }

  public queryOrders(
    query: OrderWorkbenchQuery,
    customFieldDefinitionIds?: readonly string[],
  ): OrderWorkbenchResult {
    return this.requireApplication().queryOrders(query, customFieldDefinitionIds);
  }

  public queryOrderItems(
    query: OrderItemWorkbenchQuery,
    customFieldDefinitionIds?: readonly string[],
  ): OrderItemWorkbenchResult {
    return this.requireApplication().queryOrderItems(query, customFieldDefinitionIds);
  }

  public queryShipmentGroups(): ShipmentGroupProjection {
    return this.requireApplication().queryShipmentGroups();
  }

  public splitShipmentGroup(input: unknown): ShipmentGroupAdjustmentResult {
    return this.requireApplication().splitShipmentGroup(input);
  }

  public mergeShipmentGroups(input: unknown): ShipmentGroupAdjustmentResult {
    return this.requireApplication().mergeShipmentGroups(input);
  }

  public queryShipmentRecords(): ShipmentRecord[] {
    return this.requireApplication().queryShipmentRecords();
  }

  public confirmShipment(input: unknown): ShipmentConfirmationResult {
    const result = this.requireApplication().confirmShipment(input);
    this.refreshOrders();
    return result;
  }

  public cancelShipmentPackages(input: unknown): ShipmentCancellationResult {
    const result = this.requireApplication().cancelShipmentPackages(input);
    this.refreshOrders();
    return result;
  }

  public correctShipmentPackageLogistics(
    input: unknown,
  ): ShipmentLogisticsCorrectionResult {
    return this.requireApplication().correctShipmentPackageLogistics(input);
  }

  public exportOrdersToWorkbook(
    input: OrderExportInput,
    destinationPath: string,
  ): Promise<OrderExportWriteResult> {
    return this.requireApplication().exportOrdersToWorkbook(input, destinationPath);
  }

  public getOrder(orderId: string): OrderDetails {
    return this.requireApplication().getOrder(orderId);
  }

  public updateOrder(input: unknown): OrderDetails {
    const details = this.requireApplication().confirmOrderEdit(input);
    this.refreshOrders();
    return details;
  }

  public updateOrderStatusAndLogistics(input: unknown): OrderDetails[] {
    const details = this.requireApplication().updateOrderStatusAndLogistics(input);
    this.refreshOrders();
    return details;
  }

  public listCustomFieldDefinitions(): CustomFieldDefinition[] {
    return this.requireApplication().listCustomFieldDefinitions();
  }

  public createCustomFieldDefinition(
    input: CreateCustomFieldDefinitionInput,
  ): CustomFieldDefinition {
    const definition = this.requireApplication().createCustomFieldDefinition(input);
    this.refreshOrders();
    return definition;
  }

  public listTableTemplates(
    granularity?: TableTemplateGranularity,
  ): TableTemplate[] {
    return this.requireApplication().listTableTemplates(granularity);
  }

  public createTableTemplate(input: CreateTableTemplateInput): TableTemplate {
    return this.requireApplication().createTableTemplate(input);
  }

  public updateTableTemplate(
    templateId: string,
    input: UpdateTableTemplateInput,
  ): TableTemplate {
    return this.requireApplication().updateTableTemplate(templateId, input);
  }

  public deleteTableTemplate(templateId: string): void {
    this.requireApplication().deleteTableTemplate(templateId);
  }

  public saveCustomFieldValues(
    input: SaveCustomFieldValuesInput,
  ): CustomFieldValueRecord[] {
    const values = this.requireApplication().saveCustomFieldValues(input);
    this.refreshOrders();
    return values;
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

  public getCandidateVerificationSettings(): Promise<CandidateVerificationSettingsView> {
    return this.requireCandidateVerificationSettings().getSettings();
  }

  public saveCandidateVerificationSettings(
    input: SaveCandidateVerificationSettingsInput,
  ): Promise<CandidateVerificationSettingsView> {
    return this.requireCandidateVerificationSettings().saveSettings(input);
  }

  public removeCandidateVerificationApiKey(): Promise<CandidateVerificationSettingsView> {
    return this.requireCandidateVerificationSettings().removeApiKey();
  }

  public testCandidateVerificationConnection(
    input: CandidateVerificationConnectionTestInput,
  ): Promise<CandidateVerificationConnectionTestResult> {
    return this.requireCandidateVerificationSettings().testConnection(input);
  }

  public getOrderIntakeSettings(): OrderIntakeSettingsView {
    return {
      automaticImportEnabled: this.preferences.getAutomaticImportEnabled(),
    };
  }

  public saveOrderIntakeSettings(
    input: SaveOrderIntakeSettingsInput,
  ): OrderIntakeSettingsView {
    return this.preferences.saveOrderIntakeSettings(input);
  }

  private requireCandidateVerificationSettings(): CandidateVerificationSettingsService {
    if (!this.candidateVerificationSettings) {
      throw new Error('当前运行环境未配置候选裁决服务');
    }
    return this.candidateVerificationSettings;
  }

  public close(): void {
    this.recognitionBatchListeners.clear();
    this.orderListeners.clear();
    this.cancelRecognitionRetryTimers();
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
    const preserveCurrentWorkspace = this.state.kind === 'ready' &&
      previousApplication !== undefined;
    const application = new LocalApplication(this.recognizer);
    try {
      this.validateDataDirectory(dataDirectory);
      if (!remember) assertRememberedDataDirectoryExists(dataDirectory);
      application.openDataDirectory(dataDirectory);
      this.reconcilePendingOrderIntake(application);
      const recognitionBatches = application.restoreRecognitionBatches();
      const orders = application.listOrders();
      const pendingRecognitionItems = application.listPendingRecognitionQueueItems();
      if (remember) this.preferences.setLastDataDirectory(dataDirectory);

      this.cancelRecognitionRetryTimers();
      this.workspaceGeneration += 1;
      this.recognitionBatches.splice(0);
      this.seenSourceHashes.clear();
      this.application = application;
      this.recognitionBatches.push(...recognitionBatches);
      this.state = {
        kind: 'ready',
        dataDirectory,
        orders,
      };
      if (previousApplication) this.retireApplication(previousApplication);
      for (const item of pendingRecognitionItems) {
        const retryAt = item.nextRetryAt ? Date.parse(item.nextRetryAt) : Number.NaN;
        const delay = Number.isFinite(retryAt)
          ? Math.max(retryAt - Date.now(), 0)
          : 0;
        if (delay === 0) {
          this.enqueueRecognitionItem(
            application,
            this.workspaceGeneration,
            item.batchId,
            item.itemId,
            item.retryCount,
          );
        } else {
          this.scheduleRecognitionRetry(
            application,
            this.workspaceGeneration,
            item.batchId,
            item.itemId,
            item.retryCount,
            delay,
          );
        }
      }
    } catch (error) {
      application.close();
      if (preserveCurrentWorkspace) {
        throw error instanceof Error ? error : new Error('无法打开数据目录');
      }
      this.application = undefined;
      this.cancelRecognitionRetryTimers();
      this.workspaceGeneration += 1;
      this.recognitionBatches.splice(0);
      this.seenSourceHashes.clear();
      if (previousApplication) this.retireApplication(previousApplication);
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
    const orders = this.requireApplication().listOrders();
    this.state = {
      ...this.state,
      orders,
    };
    for (const listener of this.orderListeners) {
      try {
        listener(structuredClone(orders));
      } catch {
        // A renderer listener cannot interrupt confirmation or automatic import.
      }
    }
  }

  private async processRecognitionItem(
    application: LocalApplication,
    generation: number,
    batchId: string,
    itemId: string,
    expectedRetryCount: number,
  ): Promise<void> {
    let reservedHash: string | undefined;
    let claimedSourcePath: string | undefined;
    let retryCount = expectedRetryCount;
    let keepStagedSource = false;
    try {
      const claimedItem = application.claimRecognitionItem(
        batchId,
        itemId,
        expectedRetryCount,
      );
      if (!claimedItem) {
        keepStagedSource = true;
        return;
      }
      const { sourcePath } = claimedItem;
      retryCount = claimedItem.retryCount;
      claimedSourcePath = sourcePath;
      this.applyRecognitionItemStatusToView(
        generation,
        {
          batchId,
          itemId,
          status: 'recognizing',
          retryCount,
          nextRetryAt: null,
        },
      );
      const sha256 = createHash('sha256')
        .update(await readFile(sourcePath))
        .digest('hex');
      if (
        this.seenSourceHashes.has(sha256) ||
        application.hasActiveSourceScreenshotSha256(sha256, itemId)
      ) {
        this.setRecognitionItemStatus(
          application,
          generation,
          {
            batchId,
            itemId,
            status: 'duplicate_skipped',
            sha256,
            resolution: 'identical_image',
          },
        );
        return;
      }
      reservedHash = sha256;
      this.setRecognitionItemStatus(
        application,
        generation,
        {
          batchId,
          itemId,
          status: 'recognizing',
          sha256,
          retryCount,
          nextRetryAt: null,
        },
      );
      this.seenSourceHashes.add(sha256);
      const draft = await application.submitRecognitionSource(
        sourcePath,
        batchId,
        () => {
          this.setRecognitionItemStatus(
            application,
            generation,
            {
              batchId,
              itemId,
              status: 'validating',
              sha256,
              retryCount,
              nextRetryAt: null,
            },
          );
        },
        itemId,
      );
      const intake = this.decideOrderIntake(application, draft);
      if (intake.status === 'imported') {
        this.refreshOrders();
        this.applyRecognitionItemStatusToView(
          generation,
          {
            batchId,
            itemId,
            status: 'imported',
            draftId: draft.id,
            sha256,
            retryCount,
            nextRetryAt: null,
            reviewIssues: [],
            recognitionConflicts: draft.recognitionConflicts ?? [],
            resolution: 'new_order',
          },
        );
        return;
      }
      if (intake.status === 'duplicate_skipped') {
        this.applyRecognitionItemStatusToView(
          generation,
          {
            batchId,
            itemId,
            status: 'duplicate_skipped',
            draftId: draft.id,
            sha256,
            retryCount,
            nextRetryAt: null,
            reviewIssues: [],
            recognitionConflicts: draft.recognitionConflicts ?? [],
            resolution: 'equivalent_order',
          },
        );
        return;
      }
      this.applyRecognitionItemStatusToView(
        generation,
        {
          batchId,
          itemId,
          status: 'awaiting_confirmation',
          draftId: draft.id,
          sha256,
          retryCount,
          nextRetryAt: null,
          reviewIssues: intake.draft.reviewIssues ?? [],
          recognitionConflicts: intake.draft.recognitionConflicts ?? [],
        },
      );
    } catch (error) {
      const isTemporary = isTemporaryRecognitionError(error);
      const nextRetryCount = retryCount + 1;
      const retryDelay = recognitionRetryDelay(nextRetryCount);
      const shouldRetry = isTemporary && nextRetryCount <= MAX_AUTOMATIC_RECOGNITION_RETRIES;
      keepStagedSource = true;
      this.setRecognitionItemStatus(
        application,
        generation,
        {
          batchId,
          itemId,
          status: shouldRetry ? 'waiting_retry' : 'failed',
          errorMessage: isTemporary && !shouldRetry
            ? '已自动重试 5 次，服务仍不可用，请手动重试或改为人工录入'
            : userFacingRecognitionError(error),
          sha256: reservedHash,
          retryCount: isTemporary
            ? Math.min(nextRetryCount, MAX_AUTOMATIC_RECOGNITION_RETRIES)
            : retryCount,
          nextRetryAt: shouldRetry
            ? new Date(Date.now() + retryDelay).toISOString()
            : null,
        },
      );
      if (
        shouldRetry &&
        generation === this.workspaceGeneration &&
        application === this.application
      ) {
        this.scheduleRecognitionRetry(
          application,
          generation,
          batchId,
          itemId,
          nextRetryCount,
          retryDelay,
        );
      }
    } finally {
      if (reservedHash) this.seenSourceHashes.delete(reservedHash);
      if (!keepStagedSource && claimedSourcePath) {
        const itemDirectory = dirname(claimedSourcePath);
        await rm(itemDirectory, { recursive: true, force: true }).catch(() => undefined);
        await rmdir(dirname(itemDirectory)).catch(() => undefined);
      }
      this.releaseApplicationWork(application);
    }
  }

  private enqueueRecognitionItem(
    application: LocalApplication,
    generation: number,
    batchId: string,
    itemId: string,
    expectedRetryCount: number,
  ): void {
    this.retainApplicationWork(application);
    this.recognitionQueue = this.recognitionQueue
      .then(() => this.processRecognitionItem(
        application,
        generation,
        batchId,
        itemId,
        expectedRetryCount,
      ))
      .catch(() => undefined);
  }

  private scheduleRecognitionRetry(
    application: LocalApplication,
    generation: number,
    batchId: string,
    itemId: string,
    retryCount: number,
    delay = recognitionRetryDelay(retryCount),
  ): void {
    const key = `${generation}:${batchId}:${itemId}`;
    const timer = setTimeout(() => {
      this.recognitionRetryTimers.delete(key);
      if (generation !== this.workspaceGeneration || application !== this.application) return;
      this.enqueueRecognitionItem(
        application,
        generation,
        batchId,
        itemId,
        retryCount,
      );
    }, delay);
    this.recognitionRetryTimers.set(key, timer);
  }

  private cancelRecognitionRetryTimers(): void {
    for (const timer of this.recognitionRetryTimers.values()) clearTimeout(timer);
    this.recognitionRetryTimers.clear();
  }

  private cancelRecognitionRetryTimer(
    generation: number,
    batchId: string,
    itemId: string,
  ): void {
    const key = `${generation}:${batchId}:${itemId}`;
    const timer = this.recognitionRetryTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.recognitionRetryTimers.delete(key);
  }

  private setRecognitionItemStatus(
    application: LocalApplication,
    generation: number,
    update: RecognitionBatchItemUpdate,
  ): void {
    application.updateRecognitionBatchItem(update);
    this.applyRecognitionItemStatusToView(generation, update);
  }

  private applyRecognitionItemStatusToView(
    generation: number,
    update: RecognitionBatchItemUpdate,
  ): void {
    if (generation !== this.workspaceGeneration) return;
    const batch = this.recognitionBatches.find((candidate) => (
      candidate.id === update.batchId
    ));
    const item = batch?.items.find((candidate) => candidate.id === update.itemId);
    if (!batch || !item) return;
    item.status = update.status;
    if (update.draftId) item.draftId = update.draftId;
    if (update.errorMessage) item.errorMessage = update.errorMessage;
    else delete item.errorMessage;
    if (update.reviewIssues) item.reviewIssues = [...update.reviewIssues];
    if (update.recognitionConflicts !== undefined) {
      item.recognitionConflicts = structuredClone(update.recognitionConflicts);
    }
    if (update.resolution) item.resolution = update.resolution;
    else if (!['imported', 'duplicate_skipped'].includes(update.status)) {
      delete item.resolution;
    }
    if (update.retryCount !== undefined) item.retryCount = update.retryCount;
    if (update.nextRetryAt) item.nextRetryAt = update.nextRetryAt;
    else if (update.nextRetryAt === null) delete item.nextRetryAt;
    updateBatchProgress(batch);
    this.notifyRecognitionBatchesChanged();
  }

  private setItemStatusByDraftId(
    draftId: string,
    status: 'imported' | 'duplicate_skipped' | 'cancelled',
    resolution?: RecognitionBatchView['items'][number]['resolution'],
  ): void {
    for (const batch of this.recognitionBatches) {
      const item = batch.items.find((candidate) => candidate.draftId === draftId);
      if (!item) continue;
      item.status = status;
      delete item.errorMessage;
      item.reviewIssues = [];
      if (resolution) item.resolution = resolution;
      else delete item.resolution;
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

  private automaticImportEnabledForBackgroundWork(): boolean {
    try {
      return this.preferences.getAutomaticImportEnabled();
    } catch {
      // A damaged or temporarily unreadable preference must fail closed: the
      // recognized draft remains available for manual confirmation.
      return false;
    }
  }

  private reconcilePendingOrderIntake(application: LocalApplication): void {
    for (const draftId of application.listPendingOrderIntakeDraftIds()) {
      this.decideOrderIntake(application, application.getDraft(draftId));
    }
  }

  private decideOrderIntake(
    application: LocalApplication,
    draft: OrderDraft,
  ): {
    status: 'imported' | 'duplicate_skipped' | 'awaiting_confirmation';
    draft: OrderDraft;
  } {
    const automaticImportEnabled = this.automaticImportEnabledForBackgroundWork();
    const deterministicReviewIssues = uniqueReviewIssues([
      ...(draft.reviewIssues ?? []),
      ...assessAutomaticImport(draft),
    ]);
    const existingOrder = application.findOriginalOrderByIdentity(draft);
    const equivalentToExisting = existingOrder
      ? hasEquivalentOrderContent(existingOrder, draft)
      : false;
    if (
      existingOrder &&
      deterministicReviewIssues.length === 0 &&
      equivalentToExisting
    ) {
      application.resolveEquivalentDraft(draft.id, existingOrder.id);
      return {
        status: 'duplicate_skipped',
        draft: { ...draft, status: 'confirmed', reviewIssues: [] },
      };
    }
    const requiredCustomFieldIssues = (
      !existingOrder && application.hasMissingRequiredOrderCustomFields()
    ) ? ['missing_required_custom_field'] as const : [];
    const reviewIssues = uniqueReviewIssues([
      ...deterministicReviewIssues,
      ...requiredCustomFieldIssues,
      ...(automaticImportEnabled ? [] : ['automatic_import_disabled'] as const),
    ]);
    if (existingOrder) {
      reviewIssues.push(
        equivalentToExisting ? 'duplicate_order' : 'order_content_changed',
      );
      return {
        status: 'awaiting_confirmation',
        draft: application.saveDraftOrderMatch(
          draft.id,
          existingOrder.id,
          uniqueReviewIssues(reviewIssues),
        ),
      };
    }
    if (
      automaticImportEnabled &&
      reviewIssues.length === 0 &&
      application.hasActiveOrderIdentity(
        draft.platform,
        draft.sellerAccount,
        draft.orderNumber,
        draft.id,
      )
    ) {
      reviewIssues.push('duplicate_order');
    }
    if (automaticImportEnabled && reviewIssues.length === 0) {
      try {
        application.confirmDraft(draft, undefined, {
          enforceRequiredItemFields: false,
        });
        return { status: 'imported', draft: { ...draft, status: 'confirmed' } };
      } catch {
        reviewIssues.push('automatic_import_failed');
      }
    }
    return {
      status: 'awaiting_confirmation',
      draft: application.saveDraftReviewIssues(draft.id, reviewIssues),
    };
  }
}

function assertRememberedDataDirectoryExists(dataDirectory: string): void {
  try {
    if (statSync(dataDirectory).isDirectory()) return;
  } catch {
    // The user-facing error below covers missing and temporarily inaccessible paths.
  }
  throw new Error('上次使用的数据目录不存在或无法访问，请重新选择数据目录');
}

function uniqueReviewIssues(
  issues: readonly OrderReviewIssueCode[],
): OrderReviewIssueCode[] {
  return [...new Set(issues)];
}

function updateBatchProgress(batch: RecognitionBatchView): void {
  Object.assign(batch, summarizeRecognitionBatchItems(batch.items));
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

function recognitionRetryDelay(retryCount: number): number {
  const index = Math.min(
    Math.max(retryCount - 1, 0),
    AUTOMATIC_RECOGNITION_RETRY_DELAYS_MS.length - 1,
  );
  return AUTOMATIC_RECOGNITION_RETRY_DELAYS_MS[index];
}

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
