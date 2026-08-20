import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type {
  ConfirmedOrderSnapshot,
  DraftItem,
  OrderDetails,
  OrderChangeEvent,
  OrderFieldChange,
  OrderChangeValue,
  OrderEditReview,
  OrderDraft,
  OrderDraftReview,
  OrderItem,
  OrderReviewIssueCode,
  RecognitionBatchItemResolution,
  RecognitionBatch,
  RecognitionBatchItemStatus,
  RecognitionBatchView,
  RecognitionConflictDetail,
  RecognitionEvidence,
  OrderSummary,
  OrderUpdateConfirmation,
  OriginalOrder,
  RecognitionItem,
  RecognitionFulfillmentStatus,
  RecognitionResult,
  Recognizer,
  SourceScreenshot,
  SourceSnapshot,
} from '../core/contracts';
import type {
  CandidateAdjudicationAudit,
  CandidateAdjudicationAuditView,
  CandidateAdjudicationDecisionAudit,
  CandidateAdjudicationDecisionOutcome,
  CandidateAdjudicationRunStatus,
} from '../core/candidate-adjudication-audit';
import {
  CANDIDATE_REGIONS,
  CANDIDATE_VERIFICATION_LIMITS,
  type Candidate,
  type CandidateAdjudicationFailureCode,
  type CandidateContextLine,
  type CandidateModelProvider,
  type CandidateRegion,
} from '../core/candidate-verification';
import {
  RECOGNITION_CONFLICT_FIELDS,
  RECOGNITION_CONFLICT_KINDS,
  RECOGNITION_CONFLICT_LIMITS,
  RECOGNITION_CONFLICT_REGIONS,
} from '../core/contracts';
import { orderEditTargetId, prepareOrderEdit } from '../core/order-edit';
import {
  diffOrderPlatformTransactionStatus,
  prepareOrderPlatformTransactionStatusUpdate,
} from '../core/order-platform-transaction-status';
import { isFulfillmentStatus } from '../core/fulfillment-status';
import { orderOperationsOverview } from '../core/order-operations-projection';
import type {
  ConfirmDraftCustomFieldOptions,
  CreateCustomFieldDefinitionInput,
  CustomFieldDefinition,
  CustomFieldGranularity,
  CustomFieldValue,
  CustomFieldValueRecord,
  DraftCustomFieldValues,
  SaveCustomFieldValuesInput,
  SaveShipmentGroupCustomFieldValuesInput,
} from '../core/custom-fields';
import {
  isCustomFieldGranularity,
  isCustomFieldType,
  isMissingCustomFieldValue,
  normalizeCustomFieldDefinitionInput,
  normalizeCustomFieldValue,
  parseStoredCustomFieldValue,
} from '../core/custom-fields';
import {
  parseStoredShipmentArchiveOrderIds,
  parseStoredShipmentArchiveRecipientSnapshots,
} from '../core/shipment-archive-storage';
import type {
  OrderItemWorkbenchQuery,
  OrderItemWorkbenchResult,
  OrderWorkbenchDateField,
  OrderWorkbenchQuery,
  OrderWorkbenchResult,
  OrderWorkbenchSortField,
} from '../core/order-workbench';
import {
  diffOrderCurrentValues,
  hasEquivalentOrderContent,
  hasSameOrderIdentity,
  normalizedOrderIdentityPart,
  pairOrderItemsForComparison,
} from '../core/order-comparison';
import { matchOrderItemIds } from '../core/order-item-matching';
import {
  fuzzyProductSimilarity,
  normalizeCreateProductMappingInput,
  normalizeCorrectProductMappingInput,
  normalizeOrderItemStandardizationBatchApplyInput,
  normalizeOrderItemStandardizationBatchPreviewInput,
  normalizeProductMappingConflictQueryInput,
  normalizeProductMappingHistoryCorrectionInput,
  normalizeProductMappingReasonInput,
  normalizeProductText,
  normalizeProductStandardizationConfirmations,
  normalizeSkuKey,
  normalizeStandardProductInput,
  normalizeUpdateOrderItemStandardizationInput,
  normalizeUpdateStandardProductInput,
  planOrderItemStandardizationBatch,
  PRODUCT_SIMILARITY_THRESHOLD,
  productMappingHitKey,
  selectProductMappingMatch,
  summarizeProductMappingHits,
  type DraftItemProductStandardization,
  type OrderItemStandardizationBatchApplyInput,
  type OrderItemStandardizationBatchBlockReason,
  type OrderItemStandardizationBatchItemResult,
  type OrderItemStandardizationBatchItemState,
  type OrderItemStandardizationBatchOrderState,
  type OrderItemStandardizationBatchPreview,
  type OrderItemStandardizationBatchPreviewItem,
  type OrderItemStandardizationBatchPreviewOrder,
  type OrderItemStandardizationBatchResult,
  type ProductMappingEvent,
  type ProductMappingEventSnapshot,
  type ProductMappingEventType,
  type ProductMappingHistoryCandidateItem,
  type ProductMappingHistoryCandidatePreview,
  type ProductMappingHistoryCorrectionResult,
  type ProductMappingHitSummary,
  type ProductMappingMatch,
  type ProductMappingMatchContext,
  type ProductMappingOrigin,
  type ProductMappingScope,
  type ProductMappingStats,
  type ProductMappingStatus,
  type ProductMappingView,
  type ProductStandardizationConfirmation,
  type ProductStandardizationSource,
  type StandardDisplayPreference,
  type StandardProduct,
  type StandardProductPriceEvent,
} from '../core/product-standardization';
import {
  normalizeProductCatalogImportConfirmationInput,
  normalizeProductCatalogImportInput,
  type ProductCatalogImportConfirmationInput,
  type ProductCatalogImportInput,
  type ProductCatalogImportPreview,
  type ProductCatalogImportResult,
  type ProductCatalogWorkbookInspection,
} from '../core/product-catalog';
import type {
  HistoricalOrderImportCandidate,
  HistoricalOrderImportConfirmationInput,
  HistoricalOrderImportInput,
  HistoricalOrderImportPreview,
  HistoricalOrderImportResult,
  HistoricalOrderWorkbookInspection,
} from '../core/historical-order-import';
import { normalizeHistoricalOrderImportConfirmationInput } from '../core/historical-order-import';
import {
  assessAutomaticImport,
  isOrderReviewIssueCode,
  normalizeOrderReviewIssues,
} from '../core/order-intake';
import {
  isValidPhonePair,
  normalizeAddress,
  normalizePhone,
  normalizeShanghaiDateTime,
} from '../core/order-normalization';
import {
  isRecognitionBatchItemStatus,
  summarizeRecognitionBatchItems,
} from '../core/recognition-batches';
import {
  isQuantitySource,
  quantityInferredFromSource,
  quantitySourceFromLegacy,
  quantitySourceFromOcr,
  quantitySourcePriority,
  type QuantitySource,
} from '../core/quantity-source';
import {
  DEFAULT_ORDER_ITEM_EXPORT_COLUMNS,
  DEFAULT_SHIPMENT_GROUP_EXPORT_ORDER_COLUMNS,
  DEFAULT_SHIPMENT_GROUP_EXPORT_ORDER_ITEM_COLUMNS,
  normalizeOrderExportInput,
  normalizeOrderExportOrderIds,
  type OrderExportAddressRegion,
  type OrderExportInput,
  type OrderExportPreviewResult,
  type OrderExportWriteResult,
} from '../core/order-export';
import type {
  CreateTableTemplateInput,
  TableTemplate,
  TableTemplateGranularity,
  UpdateTableTemplateInput,
} from '../core/table-templates';
import {
  prepareMergeShipmentGroups,
  prepareSplitShipmentGroup,
  replayShipmentGroupAdjustmentEvents,
  type ShipmentGroupAdjustmentEvent,
  type ShipmentGroupAdjustmentResult,
} from '../core/shipment-group-adjustments';
import {
  buildShipmentGroupWorkbench,
  buildFixedMemberShipmentGroup,
  buildShipmentGroupProjection,
  shipmentMatchKeyIdentity,
  type ShipmentGroupCustomFieldValue,
  type ShipmentGroupProjection,
  type ShipmentGroupWorkbenchResult,
} from '../core/shipment-groups';
import {
  isShipmentLogisticsStatus,
  normalizeProgressShipmentPackageLogisticsExceptionInput,
  normalizeProgressShipmentPackageCarrierClaimInput,
  normalizeRecordShipmentPackageLogisticsExceptionInput,
  normalizeCancelShipmentPackagesInput,
  normalizeConfirmShipmentInput,
  normalizeCorrectShipmentPackageLogisticsInput,
  normalizeUpdateShipmentPackageLogisticsStatusInput,
  type ShipmentCancellationResult,
  type ShipmentConfirmationResult,
  type ShipmentGroupArchive,
  type ShipmentItemQuantityInput,
  type ShipmentLogisticsCorrectionResult,
  type ShipmentLogisticsExceptionResult,
  type ShipmentLogisticsStatusUpdateResult,
  type ShipmentLogisticsStatus,
  type ShipmentCarrierClaimProgressResult,
  type ShipmentPackage,
  type ShipmentPackageItem,
  type ShipmentPackageTimelineEvent,
  type ShipmentRecord,
  type ShipmentSourceDifference,
  type ShipmentSourceOrderSnapshot,
} from '../core/shipment-records';
import {
  prepareLogisticsCorrection,
  prepareLogisticsStatusChange,
} from '../core/logistics-exceptions';
import type { AftersalesCase } from '../core/aftersales-cases';
import type { FulfillmentDemandView } from '../core/fulfillment-demand';
import type {
  FulfillmentPlanProgressView,
  FulfillmentPlanView,
} from '../core/fulfillment-plans';
import type {
  AftersalesWorkflowTemplate,
  CopyAftersalesWorkflowTemplateInput,
  CreateAftersalesWorkflowTemplateInput,
  UpdateAftersalesWorkflowTemplateInput,
} from '../core/aftersales-workflow-templates';
import {
  DEFAULT_ORDER_TABLE_COLUMNS,
  DEFAULT_SHIPMENT_GROUP_TABLE_COLUMNS,
  normalizeCreateTableTemplateInput,
  normalizeStoredTableTemplateInput,
  normalizeShipmentGroupWorkbenchQuery,
  normalizeUpdateTableTemplateInput,
  isDynamicProductTableGroup,
  tableTemplateCustomFieldDefinitionIds,
  tableTemplateNameKey,
} from '../core/table-templates';
import {
  normalizeShipmentGroupExportInput,
  type ShipmentGroupExportInput,
  type ShipmentGroupExportPreviewResult,
  type ShipmentGroupExportWriteResult,
} from '../core/shipment-group-export';
import {
  createOrderExportWorkbookPlan,
  createOrderExportPreviewSheets,
  type OrderExportWorkbookPlan,
  writeOrderExportWorkbook,
} from './order-export-workbook';
import {
  createProductCatalogWorkbook as buildProductCatalogWorkbook,
  inspectProductCatalogWorkbook as inspectCatalogWorkbook,
  previewProductCatalogWorkbook,
} from './product-catalog-workbook';
import {
  createHistoricalOrderErrorRowsWorkbook as buildHistoricalOrderErrorRowsWorkbook,
  inspectHistoricalOrderWorkbook as inspectHistoricalWorkbook,
  previewHistoricalOrderWorkbook,
} from './historical-order-workbook';
import {
  shanghaiDateKey,
  systemOrderNumberForSequence,
  systemOrderNumberSequence,
} from '../core/system-order-number';
import { AftersalesApplicationService } from './aftersales-application-service';
import { AftersalesWorkflowTemplateService } from './aftersales-workflow-template-service';
import { FulfillmentDemandService } from './fulfillment-demand-service';
import type { InventoryMovementView, InventoryView } from '../core/inventory-ledger';
import type { PurchaseView } from '../core/purchase-orders';
import type { FundsView, FinanceFactsForSource, FinanceSourceTypeName } from '../core/funds';
import type { ProfitReportView } from '../core/profit';
import { InventoryLedgerService } from './inventory-ledger-service';
import { PurchaseOrderService } from './purchase-order-service';
import { FundsService } from './funds-service';
import { ProfitService } from './profit-service';
import { FulfillmentPlanService } from './fulfillment-plan-service';
import { RecipientService, type RecipientView } from './recipient-service';
import type { RecipientSummaryView } from '../core/recipients';
import { OrderFulfillmentProjectionService } from './order-fulfillment-projection-service';
import { OrderOperationsProjectionService } from './order-operations-projection-service';
import { LogisticsExceptionService } from './logistics-exception-service';
import { Workspace } from './workspace';

type SqlRow = Record<string, string | number | null>;

export type RecognitionBatchItemUpdate = {
  batchId: string;
  itemId: string;
  status: RecognitionBatchItemStatus;
  draftId?: string;
  sha256?: string;
  errorMessage?: string;
  retryCount?: number;
  nextRetryAt?: string | null;
  reviewIssues?: OrderReviewIssueCode[];
  recognitionConflicts?: RecognitionConflictDetail[];
  resolution?: RecognitionBatchItemResolution;
};

export type PersistedRecognitionQueueItem = {
  batchId: string;
  itemId: string;
  sourcePath: string;
  retryCount: number;
  nextRetryAt: string | null;
};

type PersistRecognitionDraftInput = {
  batchId: string;
  draftId: string;
  screenshotId: string;
  originalName: string;
  storedPath: string;
  mimeType: string;
  sha256: string;
  recognition: RecognitionResult;
  evidences: readonly RecognitionEvidence[];
  reviewIssues: readonly OrderReviewIssueCode[];
  recognitionConflicts: readonly RecognitionConflictDetail[];
  candidateAdjudication?: CandidateAdjudicationAudit;
  intakeDecisionPending: boolean;
  createdAt: string;
};

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const MAX_SOURCE_SCREENSHOT_BYTES = 7_500_000;
const MAX_RECOGNITION_CONFLICTS = RECOGNITION_CONFLICT_LIMITS.details;
const MAX_RECOGNITION_CONFLICT_VALUES = RECOGNITION_CONFLICT_LIMITS.valuesPerSide;
const MAX_RECOGNITION_CONFLICT_TEXT_LENGTH = RECOGNITION_CONFLICT_LIMITS.textLength;
const MAX_RECOGNITION_CONFLICTS_JSON_LENGTH = 5_000_000;
const RECOGNITION_CONFLICT_DETAIL_KEYS = new Set([
  'region',
  'field',
  'kind',
  'itemIndex',
  'locatedValues',
  'extractedValues',
  'retainedValue',
]);

export class LocalApplication {
  private workspace?: Workspace;

  public constructor(private readonly recognizer: Recognizer) {}

  public openDataDirectory(dataDirectory: string): void {
    if (this.workspace) {
      throw new Error('请先关闭当前数据目录');
    }
    this.workspace = Workspace.open(dataDirectory);
  }

  public get dataDirectory(): string {
    return this.requireWorkspace().dataDirectory;
  }

  public get database(): DatabaseSync {
    return this.requireWorkspace().database;
  }

  public createRecognitionBatch(input: {
    id: string;
    createdAt: string;
    items: Array<{ id: string; sourceName: string; queuePath?: string }>;
  }): void {
    if (input.items.length === 0) throw new Error('识别批次必须包含来源截图');
    const workspace = this.requireWorkspace();
    workspace.transaction(() => {
      workspace.database
        .prepare(`
          INSERT INTO recognition_batches (
            id, platform, seller_account, status, created_at
          ) VALUES (?, 'xianyu', '', 'awaiting_review', ?)
        `)
        .run(input.id, input.createdAt);
      const insertItem = workspace.database.prepare(`
        INSERT INTO recognition_batch_items (
          id, batch_id, position, source_name, content_sha256, status,
          draft_id, error_message, created_at, updated_at,
          queue_relative_path, retry_count, next_retry_at
        ) VALUES (?, ?, ?, ?, NULL, 'waiting_recognition', NULL, NULL, ?, ?, ?, 0, NULL)
      `);
      input.items.forEach((item, position) => {
        insertItem.run(
          item.id,
          input.id,
          position,
          item.sourceName,
          input.createdAt,
          input.createdAt,
          item.queuePath ? workspace.toStoredPath(item.queuePath) : null,
        );
      });
    });
  }

  public restoreRecognitionBatches(): RecognitionBatchView[] {
    const workspace = this.requireWorkspace();
    const now = new Date().toISOString();
    workspace.transaction(() => {
      workspace.database
        .prepare(`
          UPDATE recognition_batch_items
          SET
            status = 'waiting_retry',
            error_message = '上次退出时处理未完成，已恢复到等待重试',
            retry_count = MAX(retry_count, 1),
            next_retry_at = ?,
            updated_at = ?
          WHERE status IN ('recognizing', 'validating')
            AND queue_relative_path IS NOT NULL
        `)
        .run(now, now);
      workspace.database
        .prepare(`
          UPDATE recognition_batch_items
          SET
            status = 'failed',
            error_message = '上次退出时处理未完成，且本机队列文件已不可用',
            next_retry_at = NULL,
            updated_at = ?
          WHERE status IN (
            'waiting_recognition', 'recognizing', 'validating', 'waiting_retry'
          )
            AND queue_relative_path IS NULL
        `)
        .run(now);
      workspace.database
        .prepare(`
          UPDATE recognition_batch_items
          SET next_retry_at = ?, updated_at = ?
          WHERE status = 'waiting_retry'
            AND queue_relative_path IS NOT NULL
            AND next_retry_at IS NULL
        `)
        .run(now, now);
      workspace.database.exec(`
        UPDATE recognition_batches
        SET status = CASE
          WHEN EXISTS (
            SELECT 1
            FROM recognition_batch_items AS items
            WHERE items.batch_id = recognition_batches.id
              AND items.status IN (
                'waiting_recognition', 'awaiting_confirmation', 'waiting_retry'
              )
          ) THEN 'awaiting_review'
          ELSE 'completed'
        END
        WHERE EXISTS (
          SELECT 1
          FROM recognition_batch_items AS items
          WHERE items.batch_id = recognition_batches.id
        );
      `);
    });
    return this.listRecognitionBatches();
  }

  public listPendingRecognitionQueueItems(): PersistedRecognitionQueueItem[] {
    const workspace = this.requireWorkspace();
    const rows = workspace.database
      .prepare(`
        SELECT batch_id, id, queue_relative_path, retry_count, next_retry_at
        FROM recognition_batch_items
        WHERE status IN ('waiting_recognition', 'waiting_retry')
          AND queue_relative_path IS NOT NULL
        ORDER BY created_at, batch_id, position, id
      `)
      .all() as unknown as SqlRow[];
    return rows.map((row) => ({
      batchId: asString(row.batch_id),
      itemId: asString(row.id),
      sourcePath: workspace.resolveStoredPath(asString(row.queue_relative_path)),
      retryCount: asNumber(row.retry_count),
      nextRetryAt: row.next_retry_at === null ? null : asString(row.next_retry_at),
    }));
  }

  public requestRecognitionItemRetry(
    batchId: string,
    itemId: string,
  ): PersistedRecognitionQueueItem {
    const workspace = this.requireWorkspace();
    return workspace.transaction(() => {
      const row = workspace.database
        .prepare(`
          SELECT status, queue_relative_path
          FROM recognition_batch_items
          WHERE id = ? AND batch_id = ?
        `)
        .get(itemId, batchId) as SqlRow | undefined;
      if (!row) throw new Error('未找到识别批次中的来源截图');
      if (!['waiting_retry', 'failed'].includes(asString(row.status))) {
        throw new Error('当前状态不能手动重试');
      }
      if (row.queue_relative_path === null) {
        throw new Error('本机队列文件已不可用，请重新上传这张截图');
      }
      const result = workspace.database
        .prepare(`
          UPDATE recognition_batch_items
          SET
            status = 'waiting_recognition',
            error_message = NULL,
            retry_count = 0,
            next_retry_at = NULL,
            updated_at = ?
          WHERE id = ? AND batch_id = ?
            AND status IN ('waiting_retry', 'failed')
        `)
        .run(new Date().toISOString(), itemId, batchId);
      if (result.changes !== 1) throw new Error('该来源截图状态已变化，请刷新后重试');
      workspace.database
        .prepare("UPDATE recognition_batches SET status = 'awaiting_review' WHERE id = ?")
        .run(batchId);
      return {
        batchId,
        itemId,
        sourcePath: workspace.resolveStoredPath(asString(row.queue_relative_path)),
        retryCount: 0,
        nextRetryAt: null,
      };
    });
  }

  public claimRecognitionItem(
    batchId: string,
    itemId: string,
    expectedRetryCount: number,
  ): PersistedRecognitionQueueItem | null {
    const workspace = this.requireWorkspace();
    return workspace.transaction(() => {
      const row = workspace.database
        .prepare(`
          SELECT status, queue_relative_path, retry_count
          FROM recognition_batch_items
          WHERE id = ? AND batch_id = ?
        `)
        .get(itemId, batchId) as SqlRow | undefined;
      if (
        !row ||
        row.queue_relative_path === null ||
        !['waiting_recognition', 'waiting_retry'].includes(asString(row.status)) ||
        asNumber(row.retry_count) !== expectedRetryCount
      ) {
        return null;
      }
      const result = workspace.database
        .prepare(`
          UPDATE recognition_batch_items
          SET
            status = 'recognizing',
            error_message = NULL,
            next_retry_at = NULL,
            updated_at = ?
          WHERE id = ? AND batch_id = ?
            AND status IN ('waiting_recognition', 'waiting_retry')
            AND retry_count = ?
        `)
        .run(new Date().toISOString(), itemId, batchId, expectedRetryCount);
      if (result.changes !== 1) return null;
      return {
        batchId,
        itemId,
        sourcePath: workspace.resolveStoredPath(asString(row.queue_relative_path)),
        retryCount: asNumber(row.retry_count),
        nextRetryAt: null,
      };
    });
  }

  public async createManualDraft(batchId: string, itemId: string): Promise<OrderDraft> {
    const workspace = this.requireWorkspace();
    const queueItem = workspace.database
      .prepare(`
        SELECT source_name, status, queue_relative_path
        FROM recognition_batch_items
        WHERE id = ? AND batch_id = ?
      `)
      .get(itemId, batchId) as SqlRow | undefined;
    if (!queueItem) throw new Error('未找到识别批次中的来源截图');
    if (!['waiting_retry', 'failed'].includes(asString(queueItem.status))) {
      throw new Error('当前状态不能改为人工录入');
    }
    if (queueItem.queue_relative_path === null) {
      throw new Error('本机队列文件已不可用，请重新上传这张截图');
    }
    const queuePath = workspace.resolveStoredPath(asString(queueItem.queue_relative_path));
    const extension = extname(queuePath).toLowerCase();
    const mimeType = IMAGE_MIME_TYPES[extension];
    if (!mimeType) throw new Error('当前仅支持 PNG、JPG、JPEG 或 WebP 来源截图');
    let bytes: Buffer;
    try {
      bytes = await readFile(queuePath);
    } catch {
      throw new Error('无法读取本机队列中的来源截图，请重新上传这张截图');
    }
    if (bytes.byteLength > MAX_SOURCE_SCREENSHOT_BYTES) {
      throw new Error('来源截图不能超过 7.5 MB，请压缩后重试');
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const screenshotId = randomUUID();
    const draftId = randomUUID();
    const storedDirectory = join(workspace.dataDirectory, 'screenshots');
    const storedPath = join(storedDirectory, `${screenshotId}${extension}`);
    const now = new Date().toISOString();
    const recognition = emptyManualRecognition();
    try {
      await mkdir(storedDirectory, { recursive: true });
      await writeFile(storedPath, bytes, { flag: 'wx' });
    } catch {
      throw new Error('无法保存人工录入来源截图，请检查数据目录后重试');
    }

    try {
      workspace.transaction(() => {
        const current = workspace.database
          .prepare(`
            SELECT status, queue_relative_path
            FROM recognition_batch_items
            WHERE id = ? AND batch_id = ?
          `)
          .get(itemId, batchId) as SqlRow | undefined;
        if (!current) throw new Error('未找到识别批次中的来源截图');
        if (!['waiting_retry', 'failed'].includes(asString(current.status))) {
          throw new Error('该来源截图状态已变化，请刷新后重试');
        }
        if (current.queue_relative_path !== queueItem.queue_relative_path) {
          throw new Error('该来源截图状态已变化，请刷新后重试');
        }

        this.persistRecognitionDraft(workspace, {
          batchId,
          draftId,
          screenshotId,
          originalName: asString(queueItem.source_name),
          storedPath,
          mimeType,
          sha256,
          recognition,
          evidences: [],
          reviewIssues: assessAutomaticImport(recognition),
          recognitionConflicts: [],
          candidateAdjudication: undefined,
          intakeDecisionPending: false,
          createdAt: now,
        });
        const linkedItem = workspace.database
          .prepare(`
            UPDATE recognition_batch_items
            SET
              status = 'awaiting_confirmation',
              content_sha256 = ?,
              draft_id = ?,
              error_message = NULL,
              queue_relative_path = NULL,
              next_retry_at = NULL,
              updated_at = ?
            WHERE id = ? AND batch_id = ?
              AND status IN ('waiting_retry', 'failed')
          `)
          .run(sha256, draftId, now, itemId, batchId);
        if (linkedItem.changes !== 1) {
          throw new Error('该来源截图状态已变化，请刷新后重试');
        }
      });
    } catch (error) {
      await unlink(storedPath).catch(() => undefined);
      throw error;
    }

    const queueItemDirectory = dirname(queuePath);
    await rm(queueItemDirectory, { recursive: true, force: true }).catch(() => undefined);
    await rmdir(dirname(queueItemDirectory)).catch(() => undefined);
    return this.getDraft(draftId);
  }

  public listRecognitionBatches(): RecognitionBatchView[] {
    const workspace = this.requireWorkspace();
    const batchRows = workspace.database
      .prepare(`
        SELECT batches.id, batches.created_at
        FROM recognition_batches AS batches
        WHERE EXISTS (
          SELECT 1
          FROM recognition_batch_items AS items
          WHERE items.batch_id = batches.id
        )
        ORDER BY batches.created_at DESC, batches.id DESC
      `)
      .all() as unknown as SqlRow[];
    const itemRows = workspace.database
      .prepare(`
        SELECT items.id, items.batch_id, items.source_name, items.status,
          items.draft_id, items.error_message, items.retry_count, items.next_retry_at,
          items.resolution_kind, drafts.review_issues_json,
          drafts.recognition_conflicts_json
        FROM recognition_batch_items AS items
        JOIN recognition_batches AS batches ON batches.id = items.batch_id
        LEFT JOIN order_drafts AS drafts ON drafts.id = items.draft_id
        ORDER BY batches.created_at DESC, batches.id DESC, items.position, items.id
      `)
      .all() as unknown as SqlRow[];
    const itemsByBatch = new Map<string, SqlRow[]>();
    for (const row of itemRows) {
      const batchId = asString(row.batch_id);
      const rows = itemsByBatch.get(batchId) ?? [];
      rows.push(row);
      itemsByBatch.set(batchId, rows);
    }

    return batchRows.map((batchRow) => {
      const batchId = asString(batchRow.id);
      const items = (itemsByBatch.get(batchId) ?? [])
        .map((row) => ({
          id: asString(row.id),
          batchId: asString(row.batch_id),
          sourceName: asString(row.source_name),
          status: asRecognitionBatchItemStatus(row.status),
          ...(row.draft_id === null ? {} : { draftId: asString(row.draft_id) }),
          ...(row.error_message === null
            ? {}
            : { errorMessage: asString(row.error_message) }),
          retryCount: asNumber(row.retry_count),
          ...(row.next_retry_at === null
            ? {}
            : { nextRetryAt: asString(row.next_retry_at) }),
          ...(row.resolution_kind === null
            ? {}
            : { resolution: asRecognitionBatchItemResolution(row.resolution_kind) }),
          ...(row.review_issues_json === null
            ? {}
            : { reviewIssues: parseStoredOrderReviewIssues(row.review_issues_json) }),
          ...(row.recognition_conflicts_json === null
            ? {}
            : {
                recognitionConflicts: parseStoredRecognitionConflicts(
                  row.recognition_conflicts_json,
                ),
              }),
        }));
      return {
        id: batchId,
        items,
        ...summarizeRecognitionBatchItems(items),
        createdAt: asString(batchRow.created_at),
      };
    });
  }

  public updateRecognitionBatchItem(input: RecognitionBatchItemUpdate): void {
    const workspace = this.requireWorkspace();
    workspace.transaction(() => {
      const result = workspace.database
        .prepare(`
          UPDATE recognition_batch_items
          SET
            status = ?,
            draft_id = COALESCE(?, draft_id),
            content_sha256 = COALESCE(?, content_sha256),
            error_message = ?,
            retry_count = COALESCE(?, retry_count),
            next_retry_at = ?,
            resolution_kind = CASE
              WHEN ? IN ('imported', 'duplicate_skipped') THEN ?
              ELSE NULL
            END,
            queue_relative_path = CASE
              WHEN ? IN ('awaiting_confirmation', 'duplicate_skipped', 'imported', 'cancelled')
                THEN NULL
              ELSE queue_relative_path
            END,
            updated_at = ?
          WHERE id = ? AND batch_id = ?
        `)
        .run(
          input.status,
          input.draftId ?? null,
          input.sha256 ?? null,
          input.errorMessage ?? null,
          input.retryCount ?? null,
          input.nextRetryAt ?? null,
          input.status,
          input.resolution ?? null,
          input.status,
          new Date().toISOString(),
          input.itemId,
          input.batchId,
        );
      if (result.changes !== 1) throw new Error('未找到识别批次中的来源截图');
      if (input.reviewIssues !== undefined) {
        const linked = workspace.database
          .prepare(`
            SELECT draft_id
            FROM recognition_batch_items
            WHERE id = ? AND batch_id = ?
          `)
          .get(input.itemId, input.batchId) as SqlRow;
        if (linked.draft_id !== null) {
          workspace.database
            .prepare(`
              UPDATE order_drafts
              SET review_issues_json = ?, intake_decision_pending = 0
              WHERE id = ?
            `)
            .run(
              serializeOrderReviewIssues(input.reviewIssues),
              asString(linked.draft_id),
            );
        }
      }
      this.refreshRecognitionBatchStatus(input.batchId);
    });
  }

  public async submitRecognitionSource(
    sourcePath: string,
    batchId: string,
    onPhase?: (phase: 'validating') => void,
    batchItemId?: string,
  ): Promise<OrderDraft> {
    const workspace = this.requireWorkspace();
    const extension = extname(sourcePath).toLowerCase();
    const mimeType = IMAGE_MIME_TYPES[extension];
    if (!mimeType) {
      throw new Error('当前仅支持 PNG、JPG、JPEG 或 WebP 来源截图');
    }

    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isFile()) throw new Error('请选择一个来源截图文件');
    if (sourceStats.size > MAX_SOURCE_SCREENSHOT_BYTES) {
      throw new Error('来源截图不能超过 7.5 MB，请压缩后重试');
    }
    const bytes = await readFile(sourcePath);
    if (bytes.byteLength > MAX_SOURCE_SCREENSHOT_BYTES) {
      throw new Error('来源截图不能超过 7.5 MB，请压缩后重试');
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const screenshotId = randomUUID();
    const draftId = randomUUID();
    const storedDirectory = join(workspace.dataDirectory, 'screenshots');
    const storedPath = join(storedDirectory, `${screenshotId}${extension}`);
    await mkdir(storedDirectory, { recursive: true });
    await writeFile(storedPath, bytes, { flag: 'wx' });

    try {
      const attempt = await this.recognizer.recognize({
        absolutePath: storedPath,
        originalName: basename(sourcePath),
        mimeType,
        sha256,
        bytes,
      });
      onPhase?.('validating');
      const recognition = withOcrQuantitySources(attempt.result);
      validateRecognition(recognition);
      const reviewIssues = assessAutomaticImport({
        ...recognition,
        reviewIssues: attempt.reviewIssues,
      });
      const now = new Date().toISOString();

      workspace.transaction(() => {
        this.persistRecognitionDraft(workspace, {
          batchId,
          draftId,
          screenshotId,
          originalName: basename(sourcePath),
          storedPath,
          mimeType,
          sha256,
          recognition,
          evidences: attempt.evidences,
          reviewIssues,
          recognitionConflicts: attempt.recognitionConflicts ?? [],
          candidateAdjudication: attempt.candidateAdjudication,
          intakeDecisionPending: true,
          createdAt: now,
        });

        if (batchItemId) {
          const linkedItem = workspace.database
            .prepare(`
              UPDATE recognition_batch_items
              SET
                status = 'awaiting_confirmation',
                draft_id = ?,
                content_sha256 = ?,
                error_message = NULL,
                queue_relative_path = NULL,
                next_retry_at = NULL,
                updated_at = ?
              WHERE id = ? AND batch_id = ?
            `)
            .run(draftId, sha256, now, batchItemId, batchId);
          if (linkedItem.changes !== 1) {
            throw new Error('未找到识别批次中的来源截图');
          }
        }
      });

      return this.getDraft(draftId);
    } catch (error) {
      await unlink(storedPath).catch(() => undefined);
      throw error;
    }
  }

  public async submitRecognitionBatch(sourcePaths: string[]): Promise<RecognitionBatch> {
    if (sourcePaths.length === 0) {
      throw new Error('请至少选择 1 张来源截图');
    }
    if (sourcePaths.length > 50) {
      throw new Error(
        `一次最多选择 50 张，当前选择了 ${sourcePaths.length} 张，请重新选择`,
      );
    }
    const batchId = randomUUID();
    const batchItemIds = sourcePaths.map(() => randomUUID());
    this.createRecognitionBatch({
      id: batchId,
      createdAt: new Date().toISOString(),
      items: sourcePaths.map((sourcePath, index) => ({
        id: batchItemIds[index],
        sourceName: basename(sourcePath),
      })),
    });
    const drafts: OrderDraft[] = [];
    for (const [index, sourcePath] of sourcePaths.entries()) {
      const itemId = batchItemIds[index];
      this.updateRecognitionBatchItem({
        batchId,
        itemId,
        status: 'recognizing',
      });
      try {
        drafts.push(await this.submitRecognitionSource(
          sourcePath,
          batchId,
          () => this.updateRecognitionBatchItem({
            batchId,
            itemId,
            status: 'validating',
          }),
          itemId,
        ));
      } catch (error) {
        this.updateRecognitionBatchItem({
          batchId,
          itemId,
          status: 'failed',
          errorMessage: '来源截图识别失败，请检查图片完整清晰后重试',
        });
        throw error;
      }
    }
    return { id: batchId, drafts };
  }

  public getDraft(draftId: string): OrderDraft {
    const workspace = this.requireWorkspace();
    const row = workspace.database
      .prepare('SELECT * FROM order_drafts WHERE id = ?')
      .get(draftId) as SqlRow | undefined;
    if (!row) throw new Error('未找到订单草稿');

    const itemRows = workspace.database
      .prepare('SELECT * FROM draft_items WHERE draft_id = ? ORDER BY position')
      .all(draftId) as unknown as SqlRow[];

    return {
      id: asString(row.id),
      batchId: asString(row.batch_id),
      screenshotId: asString(row.screenshot_id),
      platform: 'xianyu',
      sellerAccount: asString(row.seller_account),
      orderNumber: asString(row.order_number),
      alipayTransactionNumber: asString(row.alipay_transaction_number),
      buyerNickname: asString(row.buyer_nickname),
      recipient: asString(row.recipient),
      phone: asString(row.phone),
      phoneNormalized: asString(row.phone_normalized),
      addressOriginal: asString(row.address_original),
      addressNormalized: asString(row.address_normalized),
      province: asString(row.province),
      city: asString(row.city),
      district: asString(row.district),
      orderedAtOriginal: asString(row.ordered_at_original),
      orderedAtNormalized: asString(row.ordered_at_normalized),
      paidAtOriginal: asString(row.paid_at_original),
      paidAtNormalized: asString(row.paid_at_normalized),
      productTotalCents: asOptionalStoredMoney(
        row.product_total_cents,
        row.product_total_present,
      ),
      shippingFeeCents: asOptionalStoredMoney(
        row.shipping_fee_cents,
        row.shipping_fee_present,
      ),
      amountCents: asOptionalStoredMoney(row.amount_cents, row.amount_present),
      platformTransactionStatus: asPlatformTransactionStatus(
        row.platform_transaction_status,
      ),
      fulfillmentStatus: asRecognitionFulfillmentStatus(row.fulfillment_status),
      status: row.review_cancelled_at === null
        ? asString(row.status) as OrderDraft['status']
        : 'cancelled',
      reviewIssues: parseStoredOrderReviewIssues(row.review_issues_json),
      recognitionConflicts: parseStoredRecognitionConflicts(
        row.recognition_conflicts_json,
      ),
      createdAt: asString(row.created_at),
      items: itemRows.map((item) => {
        const quantitySource = asQuantitySource(item.quantity_source);
        return {
          id: asString(item.id),
          position: asNumber(item.position),
          sourceTitle: asString(item.source_title),
          sourceSpec: asString(item.source_spec),
          unitPriceCents: asOptionalStoredMoney(
            item.unit_price_cents,
            item.unit_price_present,
          ),
          quantity: asNumber(item.quantity),
          quantitySource,
          quantityInferred: quantityInferredFromSource(quantitySource),
        };
      }),
    };
  }

  public getDraftReview(draftId: string): OrderDraftReview {
    const workspace = this.requireWorkspace();
    const draft = this.getDraft(draftId);
    const row = workspace.database
      .prepare('SELECT matched_order_id FROM order_drafts WHERE id = ?')
      .get(draftId) as SqlRow;
    if (row.matched_order_id === null) return { kind: 'new_order', draft };

    const currentOrder = this.getOrder(asString(row.matched_order_id)).order;
    const snapshotRow = workspace.database
      .prepare(`
        SELECT id, recognition_json, confirmed_json, created_at
        FROM source_snapshots
        WHERE draft_id = ?
      `)
      .get(draftId) as SqlRow | undefined;
    if (!snapshotRow) throw new Error('订单草稿缺少来源快照');
    return {
      kind: 'order_update',
      draft,
      currentOrder,
      expectedRevision: currentOrder.revision,
      changes: diffOrderCurrentValues(currentOrder, draft),
      customFieldValues: this.listCustomFieldValuesForOrder(currentOrder.id),
      sourceSnapshot: {
        id: asString(snapshotRow.id),
        createdAt: asString(snapshotRow.created_at),
        recognition: parseStoredRecognition(asString(snapshotRow.recognition_json)),
        confirmed: snapshotRow.confirmed_json === null
          ? null
          : parseStoredConfirmedOrderSnapshot(asString(snapshotRow.confirmed_json)),
      },
    };
  }

  public saveDraftOrderMatch(
    draftId: string,
    orderId: string,
    reviewIssues: readonly OrderReviewIssueCode[],
    reviewedDraft?: OrderDraft,
  ): OrderDraft {
    const persistedDraft = this.getDraft(draftId);
    let draft = reviewedDraft
      ? withManualQuantityEdits(persistedDraft, reviewedDraft)
      : persistedDraft;
    if (draft.id !== draftId) {
      throw new Error('校对订单与来源草稿不一致');
    }
    validateDraft(draft);
    const existing = this.getOrder(orderId).order;
    if (!hasSameOrderIdentity(existing, draft)) {
      throw new Error('订单草稿与候选原始订单身份不一致');
    }
    draft = withHigherPriorityCurrentQuantities(existing, draft);
    return this.persistDraftReviewTarget(
      draftId,
      orderId,
      reviewIssues,
      draft,
    );
  }

  public saveDraftAsNewOrderReview(
    draftId: string,
    reviewIssues: readonly OrderReviewIssueCode[],
    reviewedDraft: OrderDraft,
  ): OrderDraft {
    const persistedDraft = this.getDraft(draftId);
    if (reviewedDraft.id !== draftId) {
      throw new Error('校对订单与来源草稿不一致');
    }
    const draft = withManualQuantityEdits(persistedDraft, reviewedDraft);
    validateDraft(draft);
    return this.persistDraftReviewTarget(
      draftId,
      null,
      reviewIssues,
      draft,
    );
  }

  private persistDraftReviewTarget(
    draftId: string,
    matchedOrderId: string | null,
    reviewIssues: readonly OrderReviewIssueCode[],
    reviewedDraft?: OrderDraft,
  ): OrderDraft {
    const workspace = this.requireWorkspace();
    const draft = reviewedDraft ?? this.getDraft(draftId);
    workspace.transaction(() => {
      const result = reviewedDraft
        ? workspace.database
          .prepare(`
            UPDATE order_drafts
            SET
              platform = ?,
              seller_account = ?,
              order_number = ?,
              alipay_transaction_number = ?,
              buyer_nickname = ?,
              recipient = ?,
              phone = ?,
              phone_normalized = ?,
              address_original = ?,
              address_normalized = ?,
              province = ?,
              city = ?,
              district = ?,
              ordered_at_original = ?,
              ordered_at_normalized = ?,
              paid_at_original = ?,
              paid_at_normalized = ?,
              product_total_cents = ?,
              product_total_present = ?,
              shipping_fee_cents = ?,
              shipping_fee_present = ?,
              amount_cents = ?,
              amount_present = ?,
              platform_transaction_status = ?,
              fulfillment_status = ?,
              matched_order_id = ?,
              review_issues_json = ?,
              intake_decision_pending = 0
            WHERE id = ?
              AND status = 'awaiting_review'
              AND review_cancelled_at IS NULL
          `)
          .run(
            draft.platform,
            draft.sellerAccount,
            draft.orderNumber,
            draft.alipayTransactionNumber,
            draft.buyerNickname,
            draft.recipient,
            draft.phone,
            draft.phoneNormalized,
            draft.addressOriginal,
            draft.addressNormalized,
            draft.province,
            draft.city,
            draft.district,
            draft.orderedAtOriginal,
            draft.orderedAtNormalized,
            draft.paidAtOriginal,
            draft.paidAtNormalized,
            draft.productTotalCents ?? 0,
            draft.productTotalCents === null ? 0 : 1,
            draft.shippingFeeCents ?? 0,
            draft.shippingFeeCents === null ? 0 : 1,
            draft.amountCents ?? 0,
            draft.amountCents === null ? 0 : 1,
            draft.platformTransactionStatus,
            draft.fulfillmentStatus,
            matchedOrderId,
            serializeOrderReviewIssues(reviewIssues),
            draftId,
          )
        : workspace.database
          .prepare(`
            UPDATE order_drafts
            SET
              matched_order_id = ?,
              review_issues_json = ?,
              intake_decision_pending = 0
            WHERE id = ?
              AND status = 'awaiting_review'
              AND review_cancelled_at IS NULL
          `)
          .run(matchedOrderId, serializeOrderReviewIssues(reviewIssues), draftId);
      if (result.changes !== 1) {
        throw new Error('该订单草稿状态已变化，请刷新后重试');
      }
      if (!reviewedDraft) return;

      workspace.database.prepare('DELETE FROM draft_items WHERE draft_id = ?').run(draftId);
      const insertItem = workspace.database.prepare(`
        INSERT INTO draft_items (
          id, draft_id, position, source_title, source_spec,
          unit_price_cents, unit_price_present, quantity, quantity_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      draft.items.forEach((item, position) => {
        const quantitySource = requiredQuantitySource(item);
        insertItem.run(
          randomUUID(),
          draftId,
          position,
          item.sourceTitle,
          item.sourceSpec,
          item.unitPriceCents ?? 0,
          item.unitPriceCents === null ? 0 : 1,
          item.quantity,
          quantitySource,
        );
      });
    });
    return this.getDraft(draftId);
  }

  public saveDraftReviewIssues(
    draftId: string,
    reviewIssues: readonly OrderReviewIssueCode[],
  ): OrderDraft {
    const workspace = this.requireWorkspace();
    const result = workspace.database
      .prepare(`
        UPDATE order_drafts
        SET review_issues_json = ?, intake_decision_pending = 0
        WHERE id = ?
      `)
      .run(serializeOrderReviewIssues(reviewIssues), draftId);
    if (result.changes !== 1) throw new Error('未找到订单草稿');
    return this.getDraft(draftId);
  }

  public listPendingOrderIntakeDraftIds(): string[] {
    const workspace = this.requireWorkspace();
    const rows = workspace.database
      .prepare(`
        SELECT id
        FROM order_drafts
        WHERE status = 'awaiting_review'
          AND review_cancelled_at IS NULL
          AND intake_decision_pending = 1
        ORDER BY created_at, id
      `)
      .all() as unknown as SqlRow[];
    return rows.map((row) => asString(row.id));
  }

  public hasActiveOrderIdentity(
    identity: Pick<RecognitionResult, 'platform' | 'sellerAccount' | 'orderNumber'> & {
      id?: string;
    },
    excludeDraftId?: string,
  ): boolean;

  public hasActiveOrderIdentity(
    platform: RecognitionResult['platform'],
    sellerAccount: string,
    orderNumber: string,
    excludeDraftId?: string,
  ): boolean;

  public hasActiveOrderIdentity(
    identityOrPlatform: (
      Pick<RecognitionResult, 'platform' | 'sellerAccount' | 'orderNumber'> & { id?: string }
    ) | RecognitionResult['platform'],
    sellerAccountOrExcludedDraftId?: string,
    orderNumber?: string,
    excludedDraftId?: string,
  ): boolean {
    const identity = typeof identityOrPlatform === 'string'
      ? {
          platform: identityOrPlatform,
          sellerAccount: sellerAccountOrExcludedDraftId ?? '',
          orderNumber: orderNumber ?? '',
          excludedDraftId,
        }
      : {
          ...identityOrPlatform,
          excludedDraftId: sellerAccountOrExcludedDraftId ?? identityOrPlatform.id,
        };
    const sellerAccount = normalizedOrderIdentityPart(identity.sellerAccount);
    const platformOrderNumber = normalizedOrderIdentityPart(identity.orderNumber);
    if (!sellerAccount || !platformOrderNumber) return false;

    const workspace = this.requireWorkspace();
    const rows = workspace.database
      .prepare(`
        SELECT platform, seller_account, platform_order_number, draft_id
        FROM original_orders
        WHERE platform = ?
        UNION ALL
        SELECT platform, seller_account, order_number AS platform_order_number, id AS draft_id
        FROM order_drafts
        WHERE platform = ?
          AND review_cancelled_at IS NULL
      `)
      .all(identity.platform, identity.platform) as unknown as SqlRow[];
    return rows.some((row) => (
      asString(row.draft_id) !== identity.excludedDraftId &&
      normalizedOrderIdentityPart(asString(row.seller_account)) === sellerAccount &&
      normalizedOrderIdentityPart(asString(row.platform_order_number)) === platformOrderNumber
    ));
  }

  public findOriginalOrderByIdentity(
    identity: Pick<RecognitionResult, 'platform' | 'sellerAccount' | 'orderNumber'>,
  ): OriginalOrder | null {
    const sellerAccount = normalizedOrderIdentityPart(identity.sellerAccount);
    const platformOrderNumber = normalizedOrderIdentityPart(identity.orderNumber);
    if (!sellerAccount || !platformOrderNumber) return null;
    const workspace = this.requireWorkspace();
    const matched = workspace.database
      .prepare(`
        SELECT id
        FROM original_orders
        WHERE platform = ?
          AND seller_account_normalized = ?
          AND platform_order_number_normalized = ?
      `)
      .get(identity.platform, sellerAccount, platformOrderNumber) as SqlRow | undefined;
    return matched ? this.getOrder(asString(matched.id)).order : null;
  }

  public resolveEquivalentDraft(
    draftId: string,
    orderId: string,
    reviewedDraft?: OrderDraft,
  ): OriginalOrder {
    const workspace = this.requireWorkspace();
    const persistedDraft = this.getDraft(draftId);
    const draft = reviewedDraft ?? persistedDraft;
    if (draft.id !== draftId) {
      throw new Error('校对订单与来源草稿不一致');
    }
    const existing = this.getOrder(orderId).order;
    if (!hasSameOrderIdentity(existing, draft) || !hasEquivalentOrderContent(existing, draft)) {
      throw new Error('订单内容已经变化，不能按重复来源跳过');
    }
    if (persistedDraft.status !== 'awaiting_review') {
      throw new Error('该订单草稿已经处理');
    }

    const now = new Date().toISOString();
    workspace.transaction(() => {
      this.resolveEquivalentDraftInTransaction(draftId, orderId, existing, now);
    });
    return existing;
  }

  private resolveEquivalentDraftInTransaction(
    draftId: string,
    orderId: string,
    existing: OriginalOrder,
    now: string,
  ): void {
    const workspace = this.requireWorkspace();
    const current = workspace.database
      .prepare(`
        SELECT batch_id, screenshot_id, status, review_cancelled_at
        FROM order_drafts
        WHERE id = ?
      `)
      .get(draftId) as SqlRow | undefined;
    if (!current || asString(current.status) !== 'awaiting_review') {
      throw new Error('该订单草稿状态已变化，请刷新后重试');
    }
    if (current.review_cancelled_at !== null) {
      throw new Error('该订单草稿已取消，不能记录为重复来源');
    }

    const finalizedSnapshot = workspace.database
      .prepare(`
        UPDATE source_snapshots
        SET order_id = ?, confirmed_json = ?, resolved_at = ?
        WHERE draft_id = ?
          AND order_id IS NULL
          AND confirmed_json IS NULL
          AND resolved_at IS NULL
      `)
      .run(
        orderId,
        serializeRecognition(toConfirmedOrderSnapshot(existing)),
        now,
        draftId,
      );
    if (finalizedSnapshot.changes !== 1) {
      throw new Error('该订单来源快照状态已变化，请刷新后重试');
    }
    const resolved = workspace.database
      .prepare(`
        UPDATE order_drafts
        SET
          status = 'confirmed',
          confirmed_at = ?,
          matched_order_id = ?,
          review_issues_json = '[]',
          intake_decision_pending = 0
        WHERE id = ?
          AND status = 'awaiting_review'
          AND review_cancelled_at IS NULL
      `)
      .run(now, orderId, draftId);
    if (resolved.changes !== 1) {
      throw new Error('该订单草稿状态已变化，请刷新后重试');
    }
    workspace.database
      .prepare(`
        UPDATE recognition_batch_items
        SET
          status = 'duplicate_skipped',
          error_message = NULL,
          resolution_kind = 'equivalent_order',
          updated_at = ?
        WHERE draft_id = ?
      `)
      .run(now, draftId);
    this.completeBatchWhenReviewed(asString(current.batch_id));
  }

  public hasActiveSourceScreenshotSha256(
    sha256: string,
    excludedBatchItemId = '',
  ): boolean {
    const workspace = this.requireWorkspace();
    const sourceRow = workspace.database
      .prepare(`
        SELECT 1 AS found
        FROM source_screenshots AS screenshots
        JOIN order_drafts AS drafts ON drafts.screenshot_id = screenshots.id
        WHERE screenshots.content_sha256 = ?
          AND (
            drafts.status = 'confirmed'
            OR (
              drafts.status = 'awaiting_review'
              AND drafts.review_cancelled_at IS NULL
            )
          )
        LIMIT 1
      `)
      .get(sha256) as SqlRow | undefined;
    if (sourceRow !== undefined) return true;

    const paidAttemptRow = workspace.database
      .prepare(`
        SELECT 1 AS found
        FROM recognition_batch_items
        WHERE content_sha256 = ?
          AND id <> ?
          AND status IN (
            'recognizing', 'validating', 'awaiting_confirmation',
            'imported', 'waiting_retry', 'failed'
          )
        LIMIT 1
      `)
      .get(sha256, excludedBatchItemId) as SqlRow | undefined;
    return paidAttemptRow !== undefined;
  }

  public cancelDraft(draftId: string): void {
    const workspace = this.requireWorkspace();
    workspace.transaction(() => {
      const now = new Date().toISOString();
      const row = workspace.database
        .prepare(`
          SELECT batch_id, status, review_cancelled_at
          FROM order_drafts
          WHERE id = ?
        `)
        .get(draftId) as SqlRow | undefined;
      if (!row) throw new Error('未找到订单草稿');
      if (asString(row.status) !== 'awaiting_review') {
        throw new Error('该订单草稿已经确认');
      }
      if (row.review_cancelled_at !== null) return;

      const result = workspace.database
        .prepare(`
          UPDATE order_drafts
          SET
            review_cancelled_at = ?,
            review_issues_json = '[]',
            intake_decision_pending = 0
          WHERE id = ?
            AND status = 'awaiting_review'
            AND review_cancelled_at IS NULL
        `)
        .run(now, draftId);
      if (result.changes !== 1) {
        throw new Error('该订单草稿状态已变化，请刷新后重试');
      }
      workspace.database
        .prepare(`
          UPDATE recognition_batch_items
          SET
            status = 'cancelled',
            error_message = NULL,
            resolution_kind = NULL,
            updated_at = ?
          WHERE draft_id = ?
        `)
        .run(now, draftId);
      this.completeBatchWhenReviewed(asString(row.batch_id));
    });
  }

  public createCustomFieldDefinition(
    input: CreateCustomFieldDefinitionInput,
  ): CustomFieldDefinition {
    const workspace = this.requireWorkspace();
    const normalized = normalizeCustomFieldDefinitionInput(input);
    const now = new Date().toISOString();
    const definition: CustomFieldDefinition = {
      id: randomUUID(),
      ...normalized,
      createdAt: now,
      updatedAt: now,
    };

    workspace.transaction(() => {
      workspace.database.prepare(`
        INSERT INTO custom_field_definitions (
          id, name, granularity, value_type, required,
          default_value_json, options_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        definition.id,
        definition.name,
        definition.granularity,
        definition.type,
        definition.required ? 1 : 0,
        definition.defaultValue === null ? null : JSON.stringify(definition.defaultValue),
        JSON.stringify(definition.options),
        definition.createdAt,
        definition.updatedAt,
      );

      if (definition.defaultValue === null || definition.granularity === 'shipment_group') return;
      const targets = definition.granularity === 'order'
        ? workspace.database.prepare('SELECT id FROM original_orders ORDER BY created_at, id').all()
        : workspace.database.prepare('SELECT id FROM order_items ORDER BY order_id, position, id').all();
      const insertValue = workspace.database.prepare(`
        INSERT INTO custom_field_values (
          id, definition_id, order_id, order_item_id,
          value_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const target of targets as unknown as SqlRow[]) {
        insertValue.run(
          randomUUID(),
          definition.id,
          definition.granularity === 'order' ? asString(target.id) : null,
          definition.granularity === 'order_item' ? asString(target.id) : null,
          JSON.stringify(definition.defaultValue),
          definition.createdAt,
          definition.updatedAt,
        );
      }
    });

    return structuredClone(definition);
  }

  public listCustomFieldDefinitions(): CustomFieldDefinition[] {
    const workspace = this.requireWorkspace();
    const rows = workspace.database.prepare(`
      SELECT *
      FROM custom_field_definitions
      ORDER BY created_at, id
    `).all() as unknown as SqlRow[];
    return rows.map(parseCustomFieldDefinitionRow);
  }

  public listTableTemplates(
    granularity?: TableTemplateGranularity,
  ): TableTemplate[] {
    const workspace = this.requireWorkspace();
    if (
      granularity !== undefined &&
      granularity !== 'order' &&
      granularity !== 'order_item' &&
      granularity !== 'shipment_group'
    ) {
      throw new Error('表格模板数据粒度无效');
    }
    const rows = workspace.database.prepare(`
      SELECT *
      FROM table_templates
      ${granularity === undefined ? '' : 'WHERE granularity = ?'}
      ORDER BY created_at, id
    `).all(...(granularity === undefined ? [] : [granularity])) as unknown as SqlRow[];
    const definitions = this.listCustomFieldDefinitions();
    return rows.map((row) => {
      const template = parseTableTemplateRow(row, definitions);
      this.assertTableTemplateDependenciesMatch(template);
      return template;
    });
  }

  public listAftersalesWorkflowTemplates(): AftersalesWorkflowTemplate[] {
    return this.aftersalesWorkflowTemplateService().list();
  }

  public setAftersalesWorkflowTemplateEnabled(
    templateId: string,
    enabled: boolean,
  ): AftersalesWorkflowTemplate {
    return this.aftersalesWorkflowTemplateService().setEnabled(templateId, enabled);
  }

  public createAftersalesWorkflowTemplate(
    input: unknown,
  ): AftersalesWorkflowTemplate {
    return this.aftersalesWorkflowTemplateService().create(input);
  }

  public copyAftersalesWorkflowTemplate(
    input: unknown,
  ): AftersalesWorkflowTemplate {
    return this.aftersalesWorkflowTemplateService().copy(input);
  }

  public updateAftersalesWorkflowTemplate(
    templateId: string,
    input: unknown,
  ): AftersalesWorkflowTemplate {
    return this.aftersalesWorkflowTemplateService().update(templateId, input);
  }

  public createTableTemplate(input: CreateTableTemplateInput): TableTemplate {
    const workspace = this.requireWorkspace();
    const definitions = this.listCustomFieldDefinitions();
    const normalized = normalizeTableTemplateCustomFilter(
      normalizeCreateTableTemplateInput(input, definitions),
      definitions,
    );
    const now = new Date().toISOString();
    const template: TableTemplate = {
      id: randomUUID(),
      ...normalized,
      createdAt: now,
      updatedAt: now,
    } as TableTemplate;

    workspace.transaction(() => {
      this.assertTableTemplateNameAvailable(
        template.granularity,
        tableTemplateNameKey(template.name),
      );
      workspace.database.prepare(`
        INSERT INTO table_templates (
          id, name, name_key, granularity, configuration_version,
          configuration_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 2, ?, ?, ?)
      `).run(
        template.id,
        template.name,
        tableTemplateNameKey(template.name),
        template.granularity,
        serializeTableTemplateConfiguration(template),
        template.createdAt,
        template.updatedAt,
      );
      this.replaceTableTemplateCustomFieldDependencies(template);
    });

    return structuredClone(template);
  }

  public updateTableTemplate(
    templateId: string,
    input: UpdateTableTemplateInput,
  ): TableTemplate {
    const workspace = this.requireWorkspace();
    const existing = this.getTableTemplate(templateId);
    const definitions = this.listCustomFieldDefinitions();
    const normalizedInput = normalizeUpdateTableTemplateInput(
      templateId,
      existing.granularity,
      input,
      definitions,
    );
    const normalized = normalizeTableTemplateCustomFilter({
      ...normalizedInput,
      granularity: existing.granularity,
    } as CreateTableTemplateInput, definitions);
    const template: TableTemplate = {
      id: existing.id,
      ...normalized,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    } as TableTemplate;

    workspace.transaction(() => {
      this.assertTableTemplateNameAvailable(
        template.granularity,
        tableTemplateNameKey(template.name),
        template.id,
      );
      const result = workspace.database.prepare(`
        UPDATE table_templates
        SET name = ?, name_key = ?, configuration_json = ?, updated_at = ?
        WHERE id = ? AND granularity = ?
      `).run(
        template.name,
        tableTemplateNameKey(template.name),
        serializeTableTemplateConfiguration(template),
        template.updatedAt,
        template.id,
        template.granularity,
      );
      if (result.changes !== 1) throw new Error('表格模板已变化，请刷新后重试');
      this.replaceTableTemplateCustomFieldDependencies(template);
    });

    return structuredClone(template);
  }

  public deleteTableTemplate(templateId: string): void {
    const workspace = this.requireWorkspace();
    const id = normalizeTableTemplateId(templateId);
    const result = workspace.database
      .prepare('DELETE FROM table_templates WHERE id = ?')
      .run(id);
    if (result.changes !== 1) throw new Error('未找到表格模板');
  }

  public async exportOrdersToWorkbook(
    input: OrderExportInput,
    destinationPath: string,
  ): Promise<OrderExportWriteResult> {
    if (typeof destinationPath !== 'string' || !destinationPath.trim()) {
      throw new Error('订单导出文件路径无效');
    }

    const prepared = this.prepareOrderExport(input);
    await writeOrderExportWorkbook(destinationPath, prepared.plan);
    return {
      orderCount: prepared.orderCount,
      orderItemCount: prepared.orderItemCount,
    };
  }

  public previewOrderExport(input: OrderExportInput): OrderExportPreviewResult {
    const prepared = this.prepareOrderExport(input, 5);
    return {
      orderCount: prepared.orderCount,
      orderItemCount: prepared.orderItemCount,
      sheets: createOrderExportPreviewSheets(prepared.plan, 5, {
        '订单总表': prepared.orderCount,
        ...(
          prepared.orderItemCount === null
            ? {}
            : { '订单商品明细表': prepared.orderItemCount }
        ),
      }),
    };
  }

  public async exportShipmentGroupsToWorkbook(
    input: ShipmentGroupExportInput,
    destinationPath: string,
  ): Promise<ShipmentGroupExportWriteResult> {
    if (typeof destinationPath !== 'string' || !destinationPath.trim()) {
      throw new Error('合并发货表导出文件路径无效');
    }
    const prepared = this.prepareShipmentGroupExport(input);
    await writeOrderExportWorkbook(destinationPath, prepared.plan);
    return {
      shipmentGroupCount: prepared.shipmentGroupCount,
      orderCount: prepared.orderCount,
      orderItemCount: prepared.orderItemCount,
    };
  }

  public previewShipmentGroupExport(
    input: ShipmentGroupExportInput,
  ): ShipmentGroupExportPreviewResult {
    const prepared = this.prepareShipmentGroupExport(input, 5);
    return {
      shipmentGroupCount: prepared.shipmentGroupCount,
      orderCount: prepared.orderCount,
      orderItemCount: prepared.orderItemCount,
      sheets: createOrderExportPreviewSheets(prepared.plan, 5, {
        '订单总表': prepared.orderCount,
        '订单商品明细表': prepared.orderItemCount,
        '合并发货表': prepared.shipmentGroupCount,
      }),
    };
  }

  private prepareShipmentGroupExport(
    input: ShipmentGroupExportInput,
    previewRowLimit?: number,
  ): {
    plan: OrderExportWorkbookPlan;
    shipmentGroupCount: number;
    orderCount: number;
    orderItemCount: number;
  } {
    const normalizedInput = normalizeShipmentGroupExportInput(input);
    const orderTemplate = normalizedInput.orderTemplateId === null
      ? null
      : this.getTableTemplate(normalizedInput.orderTemplateId);
    const orderItemTemplate = normalizedInput.orderItemTemplateId === null
      ? null
      : this.getTableTemplate(normalizedInput.orderItemTemplateId);
    const shipmentGroupTemplate = normalizedInput.shipmentGroupTemplateId === null
      ? null
      : this.getTableTemplate(normalizedInput.shipmentGroupTemplateId);
    if (orderTemplate && orderTemplate.granularity !== 'order') {
      throw new Error('订单总表必须使用订单粒度模板');
    }
    if (orderItemTemplate && orderItemTemplate.granularity !== 'order_item') {
      throw new Error('订单商品明细表必须使用订单商品明细粒度模板');
    }
    if (shipmentGroupTemplate && shipmentGroupTemplate.granularity !== 'shipment_group') {
      throw new Error('合并发货表必须使用发货组粒度模板');
    }

    const groupById = new Map(this.queryShipmentGroups().groups.map((group) => [group.id, group]));
    const groups = normalizedInput.shipmentGroups.map(({ id }) => groupById.get(id));
    if (groups.some((group) => group === undefined)) {
      throw new Error('部分发货组已变化，请刷新后重新导出');
    }
    const selectedGroups = groups.filter((group): group is NonNullable<typeof group> => (
      group !== undefined
    ));
    for (const expected of normalizedInput.shipmentGroups) {
      const group = groupById.get(expected.id);
      if (!group || !sameTextSet(
        group.orders.map(({ id }) => id),
        expected.expectedMemberOrderIds,
      )) {
        throw new Error('部分发货组成员已变化，请刷新后重新导出');
      }
    }
    const ambiguousGroup = selectedGroups.find((group) => (
      group.recipientConflict && group.selectedRecipientOrderId === null
    ));
    if (ambiguousGroup) {
      throw new Error('发货组的收件人不一致，请先确认最终收件人再导出');
    }

    const shipmentGroupDefinitions = this.listCustomFieldDefinitions().filter(
      ({ granularity }) => granularity === 'shipment_group',
    );
    const requiredShipmentGroupDefinitions = shipmentGroupDefinitions.filter(
      ({ required }) => required,
    );
    if (requiredShipmentGroupDefinitions.length > 0) {
      const requiredValues = this.listShipmentGroupCustomFieldValues(
        selectedGroups.map(({ id }) => id),
        requiredShipmentGroupDefinitions.map(({ id }) => id),
        requiredShipmentGroupDefinitions,
      );
      const valuesByTarget = new Map(requiredValues.map((entry) => [
        `${entry.shipmentGroupId}\u0000${entry.definitionId}`,
        entry.value,
      ]));
      for (const group of selectedGroups) {
        for (const definition of requiredShipmentGroupDefinitions) {
          const key = `${group.id}\u0000${definition.id}`;
          const value = valuesByTarget.has(key)
            ? valuesByTarget.get(key)
            : definition.defaultValue;
          if (isMissingCustomFieldValue(value)) {
            throw new Error(
              `发货组缺少必填字段“${definition.name}”，请补全后再导出`,
            );
          }
        }
      }
    }

    const orderIds = [...new Set(selectedGroups.flatMap((group) => (
      group.orders.map(({ id }) => id)
    )))];
    const scopeStats = this.orderExportScopeStats(orderIds);
    if (scopeStats.orderCount !== orderIds.length) {
      throw new Error('部分订单已变化，请刷新发货组后重新导出');
    }

    const orderColumns = orderTemplate?.columns ?? DEFAULT_SHIPMENT_GROUP_EXPORT_ORDER_COLUMNS;
    const orderItemColumns = orderItemTemplate?.columns
      ?? DEFAULT_SHIPMENT_GROUP_EXPORT_ORDER_ITEM_COLUMNS;
    const shipmentGroupColumns = shipmentGroupTemplate?.columns
      ?? DEFAULT_SHIPMENT_GROUP_TABLE_COLUMNS;
    const orderCustomDefinitionIds = tableTemplateCustomFieldDefinitionIds(orderColumns);
    const orderItemCustomDefinitionIds = tableTemplateCustomFieldDefinitionIds(orderItemColumns);
    const shipmentGroupCustomDefinitionIds = tableTemplateCustomFieldDefinitionIds(
      shipmentGroupColumns,
    );
    const projectedOrderIds = previewRowLimit === undefined
      ? orderIds
      : orderIds.slice(0, previewRowLimit);
    const projectedGroups = previewRowLimit === undefined
      ? selectedGroups
      : selectedGroups.slice(0, previewRowLimit);
    const addressRegionOrderIds = [...new Set([
      ...projectedOrderIds,
      ...projectedGroups.map((group) => (
        group.selectedRecipientOrderId ?? group.orders[0]?.id ?? ''
      )).filter(Boolean),
    ])];
    const orderResult = this.queryOrders(
      { lifecycleStatus: 'all' },
      orderCustomDefinitionIds,
      projectedOrderIds,
    );
    const queriedItems = this.queryOrderItems(
      {},
      orderItemCustomDefinitionIds,
      projectedOrderIds,
      true,
    );
    const orderItemResult = previewRowLimit === undefined
      ? queriedItems
      : {
          items: queriedItems.items.slice(0, previewRowLimit),
          customFieldValues: queriedItems.customFieldValues.filter((value) => (
            value.orderItemId !== null
            && queriedItems.items.slice(0, previewRowLimit)
              .some((item) => item.id === value.orderItemId)
          )),
        };
    const groupCustomFieldValues = this.listShipmentGroupCustomFieldValues(
      projectedGroups.map(({ id }) => id),
      shipmentGroupCustomDefinitionIds,
      shipmentGroupDefinitions,
    );
    const plan = createOrderExportWorkbookPlan({
      masking: normalizedInput.masking,
      includeOrderItems: true,
      orders: orderResult.orders,
      orderItems: orderItemResult.items,
      orderColumns,
      orderItemColumns,
      customFieldDefinitions: this.listCustomFieldDefinitions(),
      orderCustomFieldValues: orderResult.customFieldValues,
      orderItemCustomFieldValues: orderItemResult.customFieldValues,
      addressRegions: this.orderExportAddressRegions(addressRegionOrderIds),
      orderMaximumItemCount: scopeStats.maximumItemCount,
      shipmentGroups: projectedGroups,
      shipmentGroupColumns,
      shipmentGroupCustomFieldValues: groupCustomFieldValues,
    });
    return {
      plan,
      shipmentGroupCount: selectedGroups.length,
      orderCount: orderIds.length,
      orderItemCount: scopeStats.orderItemCount,
    };
  }

  private prepareOrderExport(input: OrderExportInput, previewRowLimit?: number): {
    plan: OrderExportWorkbookPlan;
    orderCount: number;
    orderItemCount: number | null;
  } {
    const normalizedInput = normalizeOrderExportInput(input);
    const orderIds = normalizedInput.scope.orderIds;

    const orderTemplate = normalizedInput.orderTemplateId === null
      ? null
      : this.getTableTemplate(normalizedInput.orderTemplateId);
    const orderItemTemplate = !normalizedInput.includeOrderItems || normalizedInput.orderItemTemplateId === null
      ? null
      : this.getTableTemplate(normalizedInput.orderItemTemplateId);
    if (orderTemplate && orderTemplate.granularity !== 'order') {
      throw new Error('订单总表必须使用订单粒度模板');
    }
    if (orderItemTemplate && orderItemTemplate.granularity !== 'order_item') {
      throw new Error('订单商品明细表必须使用订单商品明细粒度模板');
    }
    const orderColumns = orderTemplate?.columns ?? DEFAULT_ORDER_TABLE_COLUMNS;
    const orderItemColumns = normalizedInput.includeOrderItems
      ? orderItemTemplate?.columns ?? DEFAULT_ORDER_ITEM_EXPORT_COLUMNS
      : [];
    const orderCustomDefinitionIds = tableTemplateCustomFieldDefinitionIds(orderColumns);
    const orderItemCustomDefinitionIds = tableTemplateCustomFieldDefinitionIds(orderItemColumns);
    const scopeStats = previewRowLimit === undefined
      ? null
      : this.orderExportScopeStats(orderIds);
    if (scopeStats && scopeStats.orderCount !== orderIds.length) {
      throw new Error('部分订单已变化，请刷新订单表后重新导出');
    }
    const projectedOrderIds = previewRowLimit === undefined
      ? orderIds
      : orderIds.slice(0, previewRowLimit);

    const orderResult = this.queryOrders(
      { lifecycleStatus: 'all' },
      orderCustomDefinitionIds,
      projectedOrderIds,
    );
    if (orderResult.orders.length !== projectedOrderIds.length) {
      throw new Error('部分订单已变化，请刷新订单表后重新导出');
    }
    const queriedOrderItems = normalizedInput.includeOrderItems
      ? this.queryOrderItems({}, orderItemCustomDefinitionIds, projectedOrderIds, true)
      : { items: [], customFieldValues: [] };
    const orderItemResult = previewRowLimit === undefined
      ? queriedOrderItems
      : {
          items: queriedOrderItems.items.slice(0, previewRowLimit),
          customFieldValues: queriedOrderItems.customFieldValues.filter((value) => (
            value.orderItemId !== null
            && queriedOrderItems.items.slice(0, previewRowLimit)
              .some((item) => item.id === value.orderItemId)
          )),
        };
    const addressRegions = this.orderExportAddressRegions(projectedOrderIds);
    const plan = createOrderExportWorkbookPlan({
      masking: normalizedInput.masking,
      includeOrderItems: normalizedInput.includeOrderItems,
      orders: orderResult.orders,
      orderItems: orderItemResult.items,
      orderColumns,
      orderItemColumns,
      customFieldDefinitions: this.listCustomFieldDefinitions(),
      orderCustomFieldValues: orderResult.customFieldValues,
      orderItemCustomFieldValues: orderItemResult.customFieldValues,
      addressRegions,
      ...(scopeStats ? { orderMaximumItemCount: scopeStats.maximumItemCount } : {}),
    });
    return {
      plan,
      orderCount: scopeStats?.orderCount ?? orderResult.orders.length,
      orderItemCount: normalizedInput.includeOrderItems
        ? scopeStats?.orderItemCount ?? orderItemResult.items.length
        : null,
    };
  }

  private orderExportScopeStats(orderIds: readonly string[]): {
    orderCount: number;
    orderItemCount: number;
    maximumItemCount: number;
  } {
    const workspace = this.requireWorkspace();
    const row = workspace.database.prepare(`
      SELECT
        COUNT(*) AS order_count,
        COALESCE(SUM(item_count), 0) AS order_item_count,
        COALESCE(MAX(item_count), 0) AS maximum_item_count
      FROM (
        SELECT orders.id, COUNT(items.id) AS item_count
        FROM original_orders AS orders
        LEFT JOIN order_items AS items ON items.order_id = orders.id
        WHERE orders.id IN (SELECT value FROM json_each(?))
        GROUP BY orders.id
      )
    `).get(JSON.stringify(orderIds)) as SqlRow;
    return {
      orderCount: asNumber(row.order_count),
      orderItemCount: asNumber(row.order_item_count),
      maximumItemCount: asNumber(row.maximum_item_count),
    };
  }

  private getTableTemplate(templateId: string): TableTemplate {
    const workspace = this.requireWorkspace();
    const row = workspace.database
      .prepare('SELECT * FROM table_templates WHERE id = ?')
      .get(normalizeTableTemplateId(templateId)) as SqlRow | undefined;
    if (!row) throw new Error('未找到表格模板');
    const template = parseTableTemplateRow(row, this.listCustomFieldDefinitions());
    this.assertTableTemplateDependenciesMatch(template);
    return template;
  }

  private orderExportAddressRegions(
    orderIds: readonly string[],
  ): ReadonlyMap<string, OrderExportAddressRegion> {
    const workspace = this.requireWorkspace();
    const rows = workspace.database.prepare(`
      SELECT id, province, city, district
      FROM original_orders
      WHERE id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(orderIds)) as unknown as SqlRow[];
    return new Map(rows.map((row) => [
      asString(row.id),
      {
        province: asString(row.province),
        city: asString(row.city),
        district: asString(row.district),
      },
    ]));
  }

  private assertTableTemplateNameAvailable(
    granularity: TableTemplateGranularity,
    nameKey: string,
    excludedTemplateId = '',
  ): void {
    const workspace = this.requireWorkspace();
    const duplicate = workspace.database.prepare(`
      SELECT 1 AS found
      FROM table_templates
      WHERE granularity = ? AND name_key = ? AND id <> ?
      LIMIT 1
    `).get(granularity, nameKey, excludedTemplateId);
    if (duplicate) throw new Error('同一数据粒度下不能使用重复的模板名称');
  }

  private replaceTableTemplateCustomFieldDependencies(template: TableTemplate): void {
    const workspace = this.requireWorkspace();
    workspace.database.prepare(`
      DELETE FROM table_template_custom_field_dependencies
      WHERE template_id = ?
    `).run(template.id);
    const dependencies = tableTemplateCustomFieldDependencies(template);
    const insert = workspace.database.prepare(`
      INSERT INTO table_template_custom_field_dependencies (
        template_id, definition_id, usage
      ) VALUES (?, ?, ?)
    `);
    for (const dependency of dependencies) {
      insert.run(template.id, dependency.definitionId, dependency.usage);
    }
  }

  private assertTableTemplateDependenciesMatch(template: TableTemplate): void {
    const workspace = this.requireWorkspace();
    const stored = workspace.database.prepare(`
      SELECT definition_id, usage
      FROM table_template_custom_field_dependencies
      WHERE template_id = ?
      ORDER BY usage, definition_id
    `).all(template.id) as unknown as SqlRow[];
    const storedKeys = stored.map((row) => (
      `${asString(row.usage)}:${asString(row.definition_id)}`
    ));
    const expectedKeys = tableTemplateCustomFieldDependencies(template)
      .map((dependency) => `${dependency.usage}:${dependency.definitionId}`)
      .sort();
    if (storedKeys.sort().join('\n') !== expectedKeys.join('\n')) {
      throw new Error(`表格模板“${template.name}”的自定义字段依赖已损坏`);
    }
  }

  public hasMissingRequiredOrderCustomFields(): boolean {
    const workspace = this.requireWorkspace();
    return workspace.database.prepare(`
      SELECT 1 AS found
      FROM custom_field_definitions
      WHERE granularity = 'order'
        AND required = 1
        AND default_value_json IS NULL
      LIMIT 1
    `).get() !== undefined;
  }

  public saveCustomFieldValues(
    input: SaveCustomFieldValuesInput,
  ): CustomFieldValueRecord[] {
    const workspace = this.requireWorkspace();
    if (!input || typeof input !== 'object' || !input.orderId) {
      throw new Error('自定义字段保存目标无效');
    }
    if (!Array.isArray(input.orderValues) || !Array.isArray(input.itemValues)) {
      throw new Error('自定义字段保存内容无效');
    }

    workspace.transaction(() => {
      const orderExists = workspace.database
        .prepare('SELECT 1 AS found FROM original_orders WHERE id = ?')
        .get(input.orderId);
      if (!orderExists) throw new Error('未找到自定义字段对应的原始订单');

      const pending: Array<{
        definition: CustomFieldDefinition;
        orderId: string | null;
        orderItemId: string | null;
        value: CustomFieldValue | null;
      }> = [];
      const seenTargets = new Set<string>();

      for (const entry of input.orderValues) {
        const definition = this.getCustomFieldDefinition(entry.definitionId);
        if (definition.granularity !== 'order') {
          throw new Error('商品粒度字段不能保存到订单');
        }
        const key = `${definition.id}:order`;
        if (seenTargets.has(key)) throw new Error('同一订单自定义字段不能重复赋值');
        seenTargets.add(key);
        pending.push({
          definition,
          orderId: input.orderId,
          orderItemId: null,
          value: entry.value === null
            ? null
            : normalizeCustomFieldValue(definition.type, entry.value, definition.options),
        });
      }

      for (const entry of input.itemValues) {
        const definition = this.getCustomFieldDefinition(entry.definitionId);
        if (definition.granularity !== 'order_item') {
          throw new Error('订单粒度字段不能保存到商品');
        }
        const item = workspace.database
          .prepare('SELECT order_id FROM order_items WHERE id = ?')
          .get(entry.orderItemId) as SqlRow | undefined;
        if (!item || asString(item.order_id) !== input.orderId) {
          throw new Error('自定义字段的商品不属于当前订单');
        }
        const key = `${definition.id}:item:${entry.orderItemId}`;
        if (seenTargets.has(key)) throw new Error('同一商品自定义字段不能重复赋值');
        seenTargets.add(key);
        pending.push({
          definition,
          orderId: null,
          orderItemId: entry.orderItemId,
          value: entry.value === null
            ? null
            : normalizeCustomFieldValue(definition.type, entry.value, definition.options),
        });
      }

      const now = new Date().toISOString();
      for (const entry of pending) {
        if (entry.value === null) {
          workspace.database.prepare(`
            DELETE FROM custom_field_values
            WHERE definition_id = ?
              AND order_id IS ?
              AND order_item_id IS ?
          `).run(entry.definition.id, entry.orderId, entry.orderItemId);
          continue;
        }
        const existing = workspace.database.prepare(`
          SELECT id
          FROM custom_field_values
          WHERE definition_id = ?
            AND order_id IS ?
            AND order_item_id IS ?
        `).get(entry.definition.id, entry.orderId, entry.orderItemId) as SqlRow | undefined;
        if (existing) {
          workspace.database.prepare(`
            UPDATE custom_field_values
            SET value_json = ?, updated_at = ?
            WHERE id = ?
          `).run(JSON.stringify(entry.value), now, asString(existing.id));
        } else {
          workspace.database.prepare(`
            INSERT INTO custom_field_values (
              id, definition_id, order_id, order_item_id,
              value_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            entry.definition.id,
            entry.orderId,
            entry.orderItemId,
            JSON.stringify(entry.value),
            now,
            now,
          );
        }
      }
      this.assertRequiredCustomFieldValuesPresent(input.orderId);
    });

    return this.listCustomFieldValuesForOrder(input.orderId);
  }

  public confirmDraft(
    draft: OrderDraft,
    customValues?: DraftCustomFieldValues,
    options: ConfirmDraftCustomFieldOptions = {},
    productStandardizations?: readonly ProductStandardizationConfirmation[],
  ): OriginalOrder {
    const workspace = this.requireWorkspace();
    const persistedDraft = this.getDraft(draft.id);
    if (persistedDraft.status === 'cancelled') {
      throw new Error('该订单草稿已取消，不能再确认入库');
    }
    if (persistedDraft.status !== 'awaiting_review') {
      throw new Error('该订单草稿已经确认');
    }
    draft = withManualQuantityEdits(persistedDraft, draft);
    validateDraft(draft);

    const existingOrder = this.findOriginalOrderByIdentity(draft);
    if (existingOrder) {
      const equivalent = hasEquivalentOrderContent(existingOrder, draft);
      this.saveDraftOrderMatch(
        draft.id,
        existingOrder.id,
        reviewIssuesForRetargetedOrder(draft, equivalent),
        draft,
      );
      throw new Error('该订单身份已存在，已转为订单更新，请核对目标订单及自定义字段后再次确认');
    }

    const preparedCustomValues = this.prepareDraftCustomFieldValues(draft, customValues, {
      enforceRequiredItemFields: options.enforceRequiredItemFields ?? true,
    });
    const preparedProductStandardizations = this.prepareProductStandardizations(
      draft.items,
      productStandardizations,
      { platform: draft.platform, sellerAccount: draft.sellerAccount },
    );
    const orderId = randomUUID();
    const now = new Date().toISOString();
    const confirmedRecognition = toConfirmedOrderSnapshot(draft);
    const productTotalCents = requireMoney('商品总价', draft.productTotalCents);
    const shippingFeeCents = requireMoney('运费', draft.shippingFeeCents);
    const amountCents = requireMoney('成交金额', draft.amountCents);
    const persistedItemIds = new Map(
      draft.items.map((item) => [item.id, randomUUID()] as const),
    );
    if (persistedItemIds.size !== draft.items.length) {
      throw new Error('订单草稿商品标识不能重复');
    }

    workspace.transaction(() => {
      const systemOrderNumber = this.nextSystemOrderNumber(now);
      workspace.database
        .prepare(`
          INSERT INTO original_orders (
            id, system_order_number, draft_id, screenshot_id, platform,
            seller_account, seller_account_normalized,
            platform_order_number, platform_order_number_normalized,
            alipay_transaction_number, buyer_nickname, recipient, phone, phone_normalized,
            address_original, address_normalized, province, city, district,
            ordered_at_original, ordered_at_normalized, paid_at_original, paid_at_normalized,
            product_total_cents, shipping_fee_cents, amount_cents,
            platform_transaction_status, fulfillment_status, lifecycle_status,
            created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'active', ?, ?
          )
        `)
        .run(
          orderId,
          systemOrderNumber,
          draft.id,
          persistedDraft.screenshotId,
          draft.platform,
          draft.sellerAccount,
          normalizedOrderIdentityPart(draft.sellerAccount),
          draft.orderNumber,
          normalizedOrderIdentityPart(draft.orderNumber),
          draft.alipayTransactionNumber,
          draft.buyerNickname,
          draft.recipient,
          draft.phone,
          draft.phoneNormalized,
          draft.addressOriginal,
          draft.addressNormalized,
          draft.province,
          draft.city,
          draft.district,
          draft.orderedAtOriginal,
          draft.orderedAtNormalized,
          draft.paidAtOriginal,
          draft.paidAtNormalized,
          productTotalCents,
          shippingFeeCents,
          amountCents,
          draft.platformTransactionStatus,
          draft.fulfillmentStatus,
          now,
          now,
        );
      this.recipientService().ensureRecipient(draft.recipient, draft.phoneNormalized, now);

      const insertItem = workspace.database.prepare(`
        INSERT INTO order_items (
          id, order_id, position, source_title, source_spec,
          unit_price_cents, quantity, quantity_source, subtotal_cents,
          standard_product_id, standardization_source, standard_display_preference
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      draft.items.forEach((item, position) => {
        const unitPriceCents = requireMoney('商品单价', item.unitPriceCents);
        const quantitySource = requiredQuantitySource(item);
        const itemId = persistedItemIds.get(item.id);
        if (!itemId) throw new Error('订单草稿商品标识无效');
        const standardization = preparedProductStandardizations.get(item.id);
        if (!standardization) throw new Error('订单草稿商品标准化结果无效');
        insertItem.run(
          itemId,
          orderId,
          position,
          item.sourceTitle,
          item.sourceSpec,
          unitPriceCents,
          item.quantity,
          quantitySource,
          safeSubtotal(unitPriceCents, item.quantity),
          standardization.standardProductId,
          standardization.source,
          plannedStandardDisplayPreference(standardization.standardProductId, undefined),
        );
        if (standardization.matchedMappingId) {
          this.markProductMappingUsed(standardization.matchedMappingId, now);
        }
        if (standardization.createMapping && standardization.standardProductId) {
          this.insertProductMapping(
            item,
            standardization.standardProductId,
            { platform: draft.platform, sellerAccount: draft.sellerAccount },
            now,
            'confirmation',
          );
        }
      });

      const insertCustomValue = workspace.database.prepare(`
        INSERT INTO custom_field_values (
          id, definition_id, order_id, order_item_id,
          value_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const value of preparedCustomValues.orderValues) {
        insertCustomValue.run(
          randomUUID(),
          value.definitionId,
          orderId,
          null,
          JSON.stringify(value.value),
          now,
          now,
        );
      }
      for (const value of preparedCustomValues.itemValues) {
        const orderItemId = persistedItemIds.get(value.draftItemId);
        if (!orderItemId) throw new Error('自定义字段对应的草稿商品不存在');
        insertCustomValue.run(
          randomUUID(),
          value.definitionId,
          null,
          orderItemId,
          JSON.stringify(value.value),
          now,
          now,
        );
      }

      const finalizedSnapshot = workspace.database
        .prepare(`
          UPDATE source_snapshots
          SET order_id = ?, confirmed_json = ?, resolved_at = ?
          WHERE draft_id = ?
            AND order_id IS NULL
            AND confirmed_json IS NULL
            AND resolved_at IS NULL
        `)
        .run(
          orderId,
          serializeRecognition(confirmedRecognition),
          now,
          draft.id,
        );
      if (finalizedSnapshot.changes !== 1) {
        throw new Error('该订单来源快照状态已变化，请刷新后重试');
      }

      const resolvedDraft = workspace.database
        .prepare(`
          UPDATE order_drafts
          SET
            status = 'confirmed',
            confirmed_at = ?,
            matched_order_id = NULL,
            review_issues_json = '[]',
            intake_decision_pending = 0
          WHERE id = ?
            AND status = 'awaiting_review'
            AND review_cancelled_at IS NULL
        `)
        .run(now, draft.id);
      if (resolvedDraft.changes !== 1) {
        throw new Error('该订单草稿状态已变化，请刷新后重试');
      }
      workspace.database
        .prepare(`
          UPDATE recognition_batch_items
          SET
            status = 'imported',
            error_message = NULL,
            resolution_kind = 'new_order',
            updated_at = ?
          WHERE draft_id = ?
        `)
        .run(now, draft.id);
      this.completeBatchWhenReviewed(persistedDraft.batchId);
    });

    return this.getOrder(orderId).order;
  }

  public confirmOrderUpdate(
    draft: OrderDraft,
    expectedRevision: number,
    customValues?: DraftCustomFieldValues,
    productStandardizations?: readonly ProductStandardizationConfirmation[],
  ): OrderUpdateConfirmation {
    const workspace = this.requireWorkspace();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error('订单版本无效，请刷新后重试');
    }
    const draftRow = workspace.database
      .prepare(`
        SELECT matched_order_id, batch_id, status, review_cancelled_at
        FROM order_drafts
        WHERE id = ?
      `)
      .get(draft.id) as SqlRow | undefined;
    if (!draftRow) throw new Error('未找到订单草稿');
    if (draftRow.review_cancelled_at !== null) {
      throw new Error('该订单草稿已取消，不能确认更新');
    }
    if (asString(draftRow.status) !== 'awaiting_review') {
      throw new Error('该订单草稿已经处理');
    }
    if (draftRow.matched_order_id === null) {
      throw new Error('该订单草稿不是已有订单更新');
    }

    const orderId = asString(draftRow.matched_order_id);
    const existing = this.getOrder(orderId).order;
    draft = withManualQuantityEdits(this.getDraft(draft.id), draft);
    validateDraft(draft);
    if (!hasSameOrderIdentity(existing, draft)) {
      const correctedExisting = this.findOriginalOrderByIdentity(draft);
      if (!correctedExisting) {
        this.saveDraftAsNewOrderReview(
          draft.id,
          reviewIssuesForNewOrder(draft),
          draft,
        );
        throw new Error('订单身份已改为全新订单，已切换为新订单校对，请核对自定义字段后再次确认');
      }
      const equivalent = hasEquivalentOrderContent(correctedExisting, draft);
      this.saveDraftOrderMatch(
        draft.id,
        correctedExisting.id,
        reviewIssuesForRetargetedOrder(draft, equivalent),
        draft,
      );
      throw new Error('修正后的订单身份命中另一笔已有订单，已切换对比，请核对后再次确认');
    }
    if (existing.revision !== expectedRevision) {
      throw new Error('订单已在其他操作中更新，请刷新对比后重试');
    }
    draft = withHigherPriorityCurrentQuantities(existing, draft);
    const hasShipmentHistory = this.orderFulfillmentProjection().hasShipmentHistory(orderId);
    const contentChanges = diffOrderCurrentValues(existing, draft).filter((change) => (
      !hasShipmentHistory || change.path !== 'fulfillmentStatus'
    ));
    const fulfillmentStatus = hasShipmentHistory
      ? existing.fulfillmentStatus
      : draft.fulfillmentStatus;

    const productTotalCents = requireMoney('商品总价', draft.productTotalCents);
    const shippingFeeCents = requireMoney('运费', draft.shippingFeeCents);
    const amountCents = requireMoney('成交金额', draft.amountCents);
    const now = new Date().toISOString();
    const confirmedRecognition = toConfirmedOrderSnapshot({
      ...draft,
      platform: existing.platform,
      sellerAccount: existing.sellerAccount,
      orderNumber: existing.orderNumber,
      fulfillmentStatus: draft.fulfillmentStatus,
    });
    const preparedCustomValues = this.prepareDraftCustomFieldValues(
      draft,
      customValues,
      {
        includeDefaults: false,
        enforceRequiredOrderFields: false,
        enforceRequiredItemFields: false,
      },
    );
    const draftItemIds = new Set(draft.items.map((item) => item.id));
    if (draftItemIds.size !== draft.items.length) {
      throw new Error('订单草稿商品标识不能重复');
    }
    const persistedItemIds = matchOrderItemIds(existing.items, draft.items);
    const unusedExistingItemIds = new Set(existing.items.map((item) => item.id));
    for (const existingItemId of persistedItemIds.values()) {
      unusedExistingItemIds.delete(existingItemId);
    }
    const preparedProductStandardizations = this.prepareProductStandardizations(
      draft.items,
      productStandardizations,
      { platform: existing.platform, sellerAccount: existing.sellerAccount },
    );
    const explicitStandardizationItemIds = new Set(
      (productStandardizations ?? []).map(({ draftItemId }) => draftItemId),
    );
    const existingItemsById = new Map(existing.items.map((item) => [item.id, item]));
    draft.items.forEach((item) => {
      if (explicitStandardizationItemIds.has(item.id)) return;
      const persistedItemId = persistedItemIds.get(item.id);
      const existingItem = persistedItemId ? existingItemsById.get(persistedItemId) : undefined;
      if (!existingItem?.standardProduct) return;
      preparedProductStandardizations.set(item.id, {
        standardProductId: existingItem.standardProduct.id,
        source: existingItem.standardizationSource,
        createMapping: false,
        matchedMappingId: null,
      });
    });
    const standardizationChanges: OrderFieldChange[] = [];
    draft.items.forEach((item, index) => {
      const prepared = preparedProductStandardizations.get(item.id);
      if (!prepared) throw new Error('订单草稿商品标准化结果无效');
      const persistedItemId = persistedItemIds.get(item.id);
      const existingItem = persistedItemId ? existingItemsById.get(persistedItemId) : undefined;
      const beforeProductId = existingItem?.standardProduct?.id ?? null;
      const beforeSource = existingItem?.standardizationSource ?? null;
      if (beforeProductId !== prepared.standardProductId) {
        const afterProduct = prepared.standardProductId
          ? this.getStandardProduct(prepared.standardProductId)
          : null;
        standardizationChanges.push({
          path: `items[${index}].standardProductSku`,
          before: existingItem?.standardProduct?.sku ?? null,
          after: afterProduct?.sku ?? null,
        });
      }
      if (beforeSource !== prepared.source) {
        standardizationChanges.push({
          path: `items[${index}].standardizationSource`,
          before: beforeSource,
          after: prepared.source,
        });
      }
      const afterDisplayPreference = plannedStandardDisplayPreference(
        prepared.standardProductId,
        existingItem,
      );
      if ((existingItem?.standardDisplayPreference ?? null) !== afterDisplayPreference) {
        standardizationChanges.push({
          path: `items[${index}].standardDisplayPreference`,
          before: existingItem?.standardDisplayPreference ?? null,
          after: afterDisplayPreference,
        });
      }
    });
    const changes = [...contentChanges, ...standardizationChanges];
    if (changes.length === 0) {
      workspace.transaction(() => {
        for (const item of draft.items) {
          const standardization = preparedProductStandardizations.get(item.id);
          if (standardization?.createMapping && standardization.standardProductId) {
            this.insertProductMapping(
              item,
              standardization.standardProductId,
              { platform: existing.platform, sellerAccount: existing.sellerAccount },
              now,
              'confirmation',
            );
          }
        }
        this.deleteDraftCustomFieldValuesForOrderUpdate(
          orderId,
          persistedItemIds,
          customValues,
        );
        const upsertCustomValue = workspace.database.prepare(`
          INSERT INTO custom_field_values (
            id, definition_id, order_id, order_item_id,
            value_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `);
        for (const value of preparedCustomValues.orderValues) {
          upsertCustomValue.run(
            randomUUID(), value.definitionId, orderId, null,
            JSON.stringify(value.value), now, now,
          );
        }
        for (const value of preparedCustomValues.itemValues) {
          const itemId = persistedItemIds.get(value.draftItemId);
          if (!itemId) {
            throw new Error('无法唯一确定自定义字段对应的已有商品，请重新核对商品明细');
          }
          upsertCustomValue.run(
            randomUUID(), value.definitionId, null, itemId,
            JSON.stringify(value.value), now, now,
          );
        }
        this.assertRequiredCustomFieldValuesPresent(orderId);
        this.resolveEquivalentDraftInTransaction(draft.id, orderId, existing, now);
      });
      return {
        order: this.getOrder(orderId).order,
        resolution: 'equivalent_order',
      };
    }
    for (const draftItem of draft.items) {
      if (persistedItemIds.has(draftItem.id)) continue;
      const persistedId = randomUUID();
      persistedItemIds.set(draftItem.id, persistedId);
    }
    const existingItemIds = new Set(existing.items.map((item) => item.id));
    workspace.transaction(() => {
      const currentDraft = workspace.database
        .prepare(`
          SELECT matched_order_id, status, review_cancelled_at
          FROM order_drafts
          WHERE id = ?
        `)
        .get(draft.id) as SqlRow | undefined;
      if (
        !currentDraft ||
        currentDraft.matched_order_id !== orderId ||
        asString(currentDraft.status) !== 'awaiting_review' ||
        currentDraft.review_cancelled_at !== null
      ) {
        throw new Error('该订单草稿状态已变化，请刷新后重试');
      }

      const updatedOrder = workspace.database
        .prepare(`
          UPDATE original_orders
          SET
            alipay_transaction_number = ?,
            buyer_nickname = ?,
            recipient = ?,
            phone = ?,
            phone_normalized = ?,
            address_original = ?,
            address_normalized = ?,
            province = ?,
            city = ?,
            district = ?,
            ordered_at_original = ?,
            ordered_at_normalized = ?,
            paid_at_original = ?,
            paid_at_normalized = ?,
            product_total_cents = ?,
            shipping_fee_cents = ?,
            amount_cents = ?,
            platform_transaction_status = ?,
            fulfillment_status = ?,
            revision = revision + 1,
            updated_at = ?
          WHERE id = ? AND revision = ?
        `)
        .run(
          draft.alipayTransactionNumber,
          draft.buyerNickname,
          draft.recipient,
          draft.phone,
          draft.phoneNormalized,
          draft.addressOriginal,
          draft.addressNormalized,
          draft.province,
          draft.city,
          draft.district,
          draft.orderedAtOriginal,
          draft.orderedAtNormalized,
          draft.paidAtOriginal,
          draft.paidAtNormalized,
          productTotalCents,
          shippingFeeCents,
          amountCents,
          draft.platformTransactionStatus,
          fulfillmentStatus,
          now,
          orderId,
          expectedRevision,
        );
      if (updatedOrder.changes !== 1) {
        throw new Error('订单已在其他操作中更新，请刷新对比后重试');
      }
      if (['refunded', 'cancelled'].includes(draft.platformTransactionStatus)) {
        new FulfillmentDemandService(workspace).shrinkDraftsAfterOrderExit(
          orderId,
          now,
          draft.platformTransactionStatus === 'refunded'
            ? '订单整单退款后重算未确认建议'
            : '订单取消后重算未确认建议',
        );
      }
      this.recipientService().ensureRecipient(draft.recipient, draft.phoneNormalized, now);

      workspace.database
        .prepare('UPDATE order_items SET position = position + 100000 WHERE order_id = ?')
        .run(orderId);
      const insertItem = workspace.database.prepare(`
        INSERT INTO order_items (
          id, order_id, position, source_title, source_spec,
          unit_price_cents, quantity, quantity_source, subtotal_cents,
          standard_product_id, standardization_source, standard_display_preference
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateItem = workspace.database.prepare(`
        UPDATE order_items
        SET
          position = ?,
          source_title = ?,
          source_spec = ?,
          unit_price_cents = ?,
          quantity = ?,
          quantity_source = ?,
          subtotal_cents = ?,
          standard_product_id = ?,
          standardization_source = ?,
          standard_display_preference = ?
        WHERE id = ? AND order_id = ?
      `);
      draft.items.forEach((item, position) => {
        const unitPriceCents = requireMoney('商品单价', item.unitPriceCents);
        const quantitySource = requiredQuantitySource(item);
        const itemId = persistedItemIds.get(item.id);
        if (!itemId) throw new Error('订单草稿商品标识无效');
        const standardization = preparedProductStandardizations.get(item.id);
        if (!standardization) throw new Error('订单草稿商品标准化结果无效');
        const previousItem = existingItemsById.get(itemId);
        const standardDisplayPreference = plannedStandardDisplayPreference(
          standardization.standardProductId,
          previousItem,
        );
        if (existingItemIds.has(itemId)) {
          updateItem.run(
            position,
            item.sourceTitle,
            item.sourceSpec,
            unitPriceCents,
            item.quantity,
            quantitySource,
            safeSubtotal(unitPriceCents, item.quantity),
            standardization.standardProductId,
            standardization.source,
            standardDisplayPreference,
            itemId,
            orderId,
          );
        } else {
          insertItem.run(
            itemId,
            orderId,
            position,
            item.sourceTitle,
            item.sourceSpec,
            unitPriceCents,
            item.quantity,
            quantitySource,
            safeSubtotal(unitPriceCents, item.quantity),
            standardization.standardProductId,
            standardization.source,
            standardDisplayPreference,
          );
          workspace.database.prepare(`
            INSERT INTO custom_field_values (
              id, definition_id, order_id, order_item_id,
              value_json, created_at, updated_at
            )
            SELECT
              lower(hex(randomblob(16))), definitions.id, NULL, ?,
              definitions.default_value_json, ?, ?
            FROM custom_field_definitions AS definitions
            WHERE definitions.granularity = 'order_item'
              AND definitions.default_value_json IS NOT NULL
          `).run(itemId, now, now);
        }
        if (standardization.matchedMappingId) {
          this.markProductMappingUsed(standardization.matchedMappingId, now);
        }
        if (standardization.createMapping && standardization.standardProductId) {
          this.insertProductMapping(
            item,
            standardization.standardProductId,
            { platform: existing.platform, sellerAccount: existing.sellerAccount },
            now,
            'confirmation',
          );
        }
      });
      if (unusedExistingItemIds.size > 0) {
        const placeholders = [...unusedExistingItemIds].map(() => '?').join(', ');
        workspace.database.prepare(`
          DELETE FROM order_items
          WHERE order_id = ? AND id IN (${placeholders})
        `).run(orderId, ...unusedExistingItemIds);
      }

      this.deleteDraftCustomFieldValuesForOrderUpdate(
        orderId,
        persistedItemIds,
        customValues,
      );

      const upsertCustomValue = workspace.database.prepare(`
        INSERT INTO custom_field_values (
          id, definition_id, order_id, order_item_id,
          value_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `);
      for (const value of preparedCustomValues.orderValues) {
        upsertCustomValue.run(
          randomUUID(), value.definitionId, orderId, null,
          JSON.stringify(value.value), now, now,
        );
      }
      for (const value of preparedCustomValues.itemValues) {
        const itemId = persistedItemIds.get(value.draftItemId);
        if (!itemId) throw new Error('自定义字段对应的草稿商品不存在');
        upsertCustomValue.run(
          randomUUID(), value.definitionId, null, itemId,
          JSON.stringify(value.value), now, now,
        );
      }

      this.assertRequiredCustomFieldValuesPresent(orderId);

      const snapshotRow = workspace.database
        .prepare(`
          SELECT id
          FROM source_snapshots
          WHERE draft_id = ?
            AND order_id IS NULL
            AND confirmed_json IS NULL
            AND resolved_at IS NULL
        `)
        .get(draft.id) as SqlRow | undefined;
      if (!snapshotRow) {
        throw new Error('订单更新来源快照状态已变化，请刷新后重试');
      }
      const sourceSnapshotId = asString(snapshotRow.id);
      const finalizedSnapshot = workspace.database
        .prepare(`
          UPDATE source_snapshots
          SET order_id = ?, confirmed_json = ?, resolved_at = ?
          WHERE id = ?
            AND order_id IS NULL
            AND confirmed_json IS NULL
            AND resolved_at IS NULL
        `)
        .run(
          orderId,
            serializeRecognition(confirmedRecognition),
          now,
          sourceSnapshotId,
        );
      if (finalizedSnapshot.changes !== 1) {
        throw new Error('订单更新来源快照状态已变化，请刷新后重试');
      }

      const eventId = randomUUID();
      workspace.database
        .prepare(`
          INSERT INTO order_change_events (
            id, order_id, source_snapshot_id, source,
            base_revision, result_revision, created_at
          ) VALUES (?, ?, ?, 'source_update', ?, ?, ?)
        `)
        .run(
          eventId,
          orderId,
          sourceSnapshotId,
          expectedRevision,
          expectedRevision + 1,
          now,
        );
      const insertChange = workspace.database.prepare(`
        INSERT INTO order_field_changes (
          id, event_id, field_path, before_json, after_json
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const change of changes) {
        insertChange.run(
          randomUUID(),
          eventId,
          change.path,
          JSON.stringify(change.before),
          JSON.stringify(change.after),
        );
      }
      if (hasShipmentHistory) {
        this.synchronizeShipmentOrderFulfillment(orderId, now);
      }

      const resolvedDraft = workspace.database
        .prepare(`
          UPDATE order_drafts
          SET
            status = 'confirmed',
            confirmed_at = ?,
            review_issues_json = '[]',
            intake_decision_pending = 0
          WHERE id = ?
            AND status = 'awaiting_review'
            AND review_cancelled_at IS NULL
        `)
        .run(now, draft.id);
      if (resolvedDraft.changes !== 1) {
        throw new Error('该订单草稿状态已变化，请刷新后重试');
      }
      workspace.database
        .prepare(`
          UPDATE recognition_batch_items
          SET
            status = 'imported',
            error_message = NULL,
            resolution_kind = 'order_updated',
            updated_at = ?
          WHERE draft_id = ?
        `)
        .run(now, draft.id);
      this.completeBatchWhenReviewed(asString(draftRow.batch_id));
    });

    return {
      order: this.getOrder(orderId).order,
      resolution: 'order_updated',
    };
  }

  public reviewOrderEdit(input: unknown): OrderEditReview {
    const current = this.getOrder(orderEditTargetId(input)).order;
    const prepared = prepareOrderEdit(
      current,
      input,
      this.listCustomFieldDefinitions(),
      this.listCustomFieldValuesForOrder(current.id),
      this.listStandardProducts(),
    );
    this.assertOrderEditIdentityAvailable(
      current.id,
      prepared.identity.platform,
      prepared.identity.sellerAccount,
      prepared.identity.orderNumber,
    );
    return prepared.review;
  }

  public confirmOrderEdit(input: unknown): OrderDetails {
    const workspace = this.requireWorkspace();
    const current = this.getOrder(orderEditTargetId(input)).order;
    const prepared = prepareOrderEdit(
      current,
      input,
      this.listCustomFieldDefinitions(),
      this.listCustomFieldValuesForOrder(current.id),
      this.listStandardProducts(),
    );
    this.assertOrderEditIdentityAvailable(
      current.id,
      prepared.identity.platform,
      prepared.identity.sellerAccount,
      prepared.identity.orderNumber,
    );
    if (prepared.review.changes.length === 0) return this.getOrder(current.id);

    const now = new Date().toISOString();
    try {
      workspace.transaction(() => {
        this.assertOrderEditIdentityAvailable(
          current.id,
          prepared.identity.platform,
          prepared.identity.sellerAccount,
          prepared.identity.orderNumber,
        );
        const updated = workspace.database.prepare(`
          UPDATE original_orders
          SET
            platform = ?,
            seller_account = ?,
            seller_account_normalized = ?,
            platform_order_number = ?,
            platform_order_number_normalized = ?,
            alipay_transaction_number = ?,
            buyer_nickname = ?,
            recipient = ?,
            phone = ?,
            phone_normalized = ?,
            address_original = ?,
            address_normalized = ?,
            province = ?,
            city = ?,
            district = ?,
            ordered_at_original = ?,
            ordered_at_normalized = ?,
            paid_at_original = ?,
            paid_at_normalized = ?,
            product_total_cents = ?,
            shipping_fee_cents = ?,
            amount_cents = ?,
            note = ?,
            revision = revision + 1,
            updated_at = ?
          WHERE id = ? AND revision = ?
        `).run(
          prepared.identity.platform,
          prepared.identity.sellerAccount,
          normalizedOrderIdentityPart(prepared.identity.sellerAccount),
          prepared.identity.orderNumber,
          normalizedOrderIdentityPart(prepared.identity.orderNumber),
          prepared.values.alipayTransactionNumber,
          prepared.values.buyerNickname,
          prepared.values.recipient,
          prepared.values.phone,
          prepared.values.phoneNormalized,
          prepared.values.addressOriginal,
          prepared.values.addressNormalized,
          prepared.values.province,
          prepared.values.city,
          prepared.values.district,
          prepared.values.orderedAtOriginal,
          prepared.values.orderedAtNormalized,
          prepared.values.paidAtOriginal,
          prepared.values.paidAtNormalized,
          prepared.values.productTotalCents,
          prepared.values.shippingFeeCents,
          prepared.values.amountCents,
          prepared.values.note,
          now,
          current.id,
          prepared.review.expectedRevision,
        );
        if (updated.changes !== 1) {
          throw new Error('订单已在其他操作中更新，请刷新后重试');
        }
        this.recipientService().ensureRecipient(
          prepared.values.recipient,
          prepared.values.phoneNormalized,
          now,
        );

        workspace.database
          .prepare('UPDATE order_items SET position = position + 100000 WHERE order_id = ?')
          .run(current.id);
        const retainedItemIds = new Set<string>();
        const updateItem = workspace.database.prepare(`
          UPDATE order_items
          SET
            position = ?,
            source_title = ?,
            source_spec = ?,
            unit_price_cents = ?,
            quantity = ?,
            quantity_source = ?,
            subtotal_cents = ?
          WHERE id = ? AND order_id = ?
        `);
        const insertItem = workspace.database.prepare(`
          INSERT INTO order_items (
            id, order_id, position, source_title, source_spec,
            unit_price_cents, quantity, quantity_source, subtotal_cents,
            standard_product_id, standardization_source, standard_display_preference
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        prepared.items.forEach((item, position) => {
          if (item.id !== null) {
            retainedItemIds.add(item.id);
            const itemUpdate = updateItem.run(
              position,
              item.sourceTitle,
              item.sourceSpec,
              item.unitPriceCents,
              item.quantity,
              item.quantitySource,
              item.subtotalCents,
              item.id,
              current.id,
            );
            if (itemUpdate.changes !== 1) {
              throw new Error('订单商品已变化，请刷新后重试');
            }
            return;
          }
          const itemId = randomUUID();
          insertItem.run(
            itemId,
            current.id,
            position,
            item.sourceTitle,
            item.sourceSpec,
            item.unitPriceCents,
            item.quantity,
            item.quantitySource,
            item.subtotalCents,
            item.standardProductId,
            item.standardProductId === null ? null : 'manual',
            plannedStandardDisplayPreference(item.standardProductId, undefined),
          );
          const insertCustomValue = workspace.database.prepare(`
            INSERT INTO custom_field_values (
              id, definition_id, order_id, order_item_id,
              value_json, created_at, updated_at
            ) VALUES (?, ?, NULL, ?, ?, ?, ?)
          `);
          for (const customValue of item.customFieldValues ?? []) {
            insertCustomValue.run(
              randomUUID(),
              customValue.definitionId,
              itemId,
              JSON.stringify(customValue.value),
              now,
              now,
            );
          }
        });
        const retainedIds = [...retainedItemIds];
        if (retainedIds.length === 0) {
          workspace.database
            .prepare('DELETE FROM order_items WHERE order_id = ? AND position >= 100000')
            .run(current.id);
        } else {
          workspace.database.prepare(`
            DELETE FROM order_items
            WHERE order_id = ?
              AND position >= 100000
              AND id NOT IN (${retainedIds.map(() => '?').join(', ')})
          `).run(current.id, ...retainedIds);
        }
        this.assertRequiredCustomFieldValuesPresent(current.id);

        const eventId = randomUUID();
        workspace.database.prepare(`
          INSERT INTO order_change_events (
            id, order_id, source_snapshot_id, source,
            base_revision, result_revision, created_at
          ) VALUES (?, ?, NULL, 'manual_edit', ?, ?, ?)
        `).run(
          eventId,
          current.id,
          prepared.review.expectedRevision,
          prepared.review.expectedRevision + 1,
          now,
        );
        const insertChange = workspace.database.prepare(`
          INSERT INTO order_field_changes (
            id, event_id, field_path, before_json, after_json
          ) VALUES (?, ?, ?, ?, ?)
        `);
        for (const change of prepared.review.changes) {
          insertChange.run(
            randomUUID(),
            eventId,
            change.path,
            JSON.stringify(change.before),
            JSON.stringify(change.after),
          );
        }
        if (this.orderFulfillmentProjection().hasShipmentHistory(current.id)) {
          this.synchronizeShipmentOrderFulfillment(current.id, now);
        }
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /original_orders_by_normalized_identity|UNIQUE constraint failed: original_orders\.platform/u
          .test(error.message)
      ) {
        throw new Error('订单身份与另一笔已有订单冲突，请更正后重试');
      }
      throw error;
    }
    return this.getOrder(current.id);
  }

  public updateOrderPlatformTransactionStatus(input: unknown): OrderDetails[] {
    const workspace = this.requireWorkspace();
    const prepared = prepareOrderPlatformTransactionStatusUpdate(input).input;
    const now = new Date().toISOString();
    workspace.transaction(() => {
      for (const target of prepared.targets) {
        const current = this.getOrder(target.orderId).order;
        if (current.revision !== target.expectedRevision) {
          throw new Error('订单已在其他操作中更新，请刷新后重试');
        }
        const changes = diffOrderPlatformTransactionStatus(current, prepared.patch);
        if (changes.length === 0) continue;
        const updated = workspace.database.prepare(`
          UPDATE original_orders
          SET
            platform_transaction_status = ?,
            revision = revision + 1,
            updated_at = ?
          WHERE id = ? AND revision = ?
        `).run(
          prepared.patch.platformTransactionStatus,
          now,
          current.id,
          target.expectedRevision,
        );
        if (updated.changes !== 1) {
          throw new Error('订单已在其他操作中更新，请刷新后重试');
        }
        if (['refunded', 'cancelled'].includes(prepared.patch.platformTransactionStatus)) {
          new FulfillmentDemandService(workspace).shrinkDraftsAfterOrderExit(
            target.orderId,
            now,
            prepared.patch.platformTransactionStatus === 'refunded'
              ? '订单整单退款后重算未确认建议'
              : '订单取消后重算未确认建议',
          );
        }
        const eventId = randomUUID();
        workspace.database.prepare(`
          INSERT INTO order_change_events (
            id, order_id, source_snapshot_id, source,
            base_revision, result_revision, created_at
          ) VALUES (?, ?, NULL, 'manual_edit', ?, ?, ?)
        `).run(
          eventId,
          current.id,
          target.expectedRevision,
          target.expectedRevision + 1,
          now,
        );
        const insertChange = workspace.database.prepare(`
          INSERT INTO order_field_changes (
            id, event_id, field_path, before_json, after_json
          ) VALUES (?, ?, ?, ?, ?)
        `);
        for (const change of changes) {
          insertChange.run(
            randomUUID(),
            eventId,
            change.path,
            JSON.stringify(change.before),
            JSON.stringify(change.after),
          );
        }
      }
    });
    return prepared.targets.map((target) => this.getOrder(target.orderId));
  }

  public updateOrderItemStandardization(
    orderId: string,
    itemId: string,
    input: unknown,
  ): OrderDetails {
    const workspace = this.requireWorkspace();
    const normalized = normalizeUpdateOrderItemStandardizationInput(input);
    const current = this.getOrder(orderId).order;
    const itemIndex = current.items.findIndex((item) => item.id === itemId);
    if (itemIndex < 0) throw new Error('订单商品不属于该订单');
    const item = current.items[itemIndex];
    const afterProduct = normalized.standardProductId === null
      ? null
      : this.getStandardProduct(normalized.standardProductId);
    if (current.revision !== normalized.expectedRevision) {
      throw new Error('订单已在其他操作中更新，请刷新后重试');
    }

    const beforeProductId = item.standardProduct?.id ?? null;
    const productChanged = beforeProductId !== normalized.standardProductId;
    const afterSource = normalized.standardProductId === null
      ? null
      : productChanged
        ? 'manual' as const
        : item.standardizationSource;
    const afterPreference = normalized.standardProductId === null
      ? null
      : normalized.standardDisplayPreference ?? (
        !productChanged && item.standardDisplayPreference !== null
          ? item.standardDisplayPreference
          : 'prefer_standard'
      );
    const changes: OrderFieldChange[] = [];
    if (productChanged) {
      changes.push({
        path: `items[${itemIndex}].standardProductSku`,
        before: item.standardProduct?.sku ?? null,
        after: afterProduct?.sku ?? null,
      });
    }
    if (item.standardizationSource !== afterSource) {
      changes.push({
        path: `items[${itemIndex}].standardizationSource`,
        before: item.standardizationSource,
        after: afterSource,
      });
    }
    if (item.standardDisplayPreference !== afterPreference) {
      changes.push({
        path: `items[${itemIndex}].standardDisplayPreference`,
        before: item.standardDisplayPreference,
        after: afterPreference,
      });
    }
    if (changes.length === 0) return this.getOrder(current.id);

    const now = new Date().toISOString();
    workspace.transaction(() => {
      const updatedOrder = workspace.database.prepare(`
        UPDATE original_orders
        SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(now, current.id, normalized.expectedRevision);
      if (updatedOrder.changes !== 1) {
        throw new Error('订单已在其他操作中更新，请刷新后重试');
      }
      const updatedItem = workspace.database.prepare(`
        UPDATE order_items
        SET
          standard_product_id = ?,
          standardization_source = ?,
          standard_display_preference = ?
        WHERE id = ? AND order_id = ?
      `).run(
        normalized.standardProductId,
        afterSource,
        afterPreference,
        itemId,
        current.id,
      );
      if (updatedItem.changes !== 1) {
        throw new Error('订单商品已变化，请刷新后重试');
      }
      const eventId = randomUUID();
      workspace.database.prepare(`
        INSERT INTO order_change_events (
          id, order_id, source_snapshot_id, source,
          base_revision, result_revision, created_at
        ) VALUES (?, ?, NULL, 'manual_edit', ?, ?, ?)
      `).run(
        eventId,
        current.id,
        normalized.expectedRevision,
        normalized.expectedRevision + 1,
        now,
      );
      const insertChange = workspace.database.prepare(`
        INSERT INTO order_field_changes (
          id, event_id, field_path, before_json, after_json
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const change of changes) {
        insertChange.run(
          randomUUID(),
          eventId,
          change.path,
          JSON.stringify(change.before),
          JSON.stringify(change.after),
        );
      }
    });
    return this.getOrder(current.id);
  }

  public previewOrderItemStandardizationBatch(
    input: unknown,
  ): OrderItemStandardizationBatchPreview {
    const normalized = normalizeOrderItemStandardizationBatchPreviewInput(input);
    const product = this.getStandardProduct(normalized.standardProductId);
    const { itemRowsById, orderRowsById } = this.loadOrderItemStandardizationBatchRows(
      normalized.itemIds,
    );
    if (normalized.itemIds.some((itemId) => !itemRowsById.has(itemId))) {
      throw new Error('订单商品不存在，请刷新后重试');
    }
    const plan = planOrderItemStandardizationBatch({
      items: normalized.itemIds.map((itemId) => itemRowsById.get(itemId)!.state),
      orders: [...orderRowsById.values()].map((order) => order.state),
      product,
      options: normalized.options,
    });
    return {
      standardProduct: product,
      options: normalized.options,
      priceSyncRequested: plan.priceSyncRequested,
      priceSyncAvailable: plan.priceSyncAvailable,
      defaultOrderPriceCents: plan.defaultOrderPriceCents,
      createMappingsRequested: plan.createMappingsRequested,
      plannedMappingCreationCount: plan.plannedMappingCreationCount,
      mappingConflictCount: plan.mappingConflictCount,
      orderCount: plan.orderCount,
      itemCount: plan.itemCount,
      totalQuantity: plan.totalQuantity,
      unlinkedCount: plan.unlinkedCount,
      sameProductCount: plan.sameProductCount,
      otherProductCount: plan.otherProductCount,
      shippedOrderCount: plan.shippedOrderCount,
      aftersalesOrderCount: plan.aftersalesOrderCount,
      priceAffectedItemCount: plan.priceAffectedItemCount,
      suggestedProductTotalOrderCount: plan.suggestedProductTotalOrderCount,
      items: plan.items.map((itemPlan): OrderItemStandardizationBatchPreviewItem => {
        const row = itemRowsById.get(itemPlan.itemId)!;
        return {
          itemId: itemPlan.itemId,
          orderId: itemPlan.orderId,
          orderNumber: row.orderNumber,
          systemOrderNumber: row.systemOrderNumber,
          position: row.state.position,
          sourceTitle: row.sourceTitle,
          sourceSpec: row.sourceSpec,
          quantity: row.state.quantity,
          currentUnitPriceCents: row.state.unitPriceCents,
          plannedUnitPriceCents: itemPlan.plannedUnitPriceCents,
          currentSubtotalCents: row.state.subtotalCents,
          plannedSubtotalCents: itemPlan.plannedSubtotalCents,
          beforeStandardProductSku: row.beforeStandardProductSku,
          linkState: itemPlan.linkState,
          blockReasons: itemPlan.blockReasons,
        };
      }),
      orders: plan.orders.map((orderPlan): OrderItemStandardizationBatchPreviewOrder => {
        const row = orderRowsById.get(orderPlan.orderId)!;
        return {
          orderId: orderPlan.orderId,
          orderNumber: row.orderNumber,
          systemOrderNumber: row.systemOrderNumber,
          revision: orderPlan.revision,
          shippedOrDelivered: orderPlan.shippedOrDelivered,
          hasAftersales: orderPlan.hasAftersales,
          productTotalCents: orderPlan.productTotalCents,
          shippingFeeCents: orderPlan.shippingFeeCents,
          amountCents: orderPlan.amountCents,
          suggestedProductTotalCents: orderPlan.suggestedProductTotalCents,
          productTotalChanges: orderPlan.productTotalChanges,
          amountMismatch: orderPlan.amountMismatch,
        };
      }),
    };
  }

  public applyOrderItemStandardizationBatch(
    input: unknown,
  ): OrderItemStandardizationBatchResult {
    const workspace = this.requireWorkspace();
    const normalized: OrderItemStandardizationBatchApplyInput =
      normalizeOrderItemStandardizationBatchApplyInput(input);
    const product = this.getStandardProduct(normalized.standardProductId);
    if (normalized.options.useDefaultOrderPrice && product.defaultOrderPriceCents === null) {
      throw new Error('标准商品未设置默认订单单价，无法同步商品单价');
    }
    const batchId = randomUUID();
    const now = new Date().toISOString();
    return workspace.transaction(() => {
      const { itemRowsById, orderRowsById } = this.loadOrderItemStandardizationBatchRows(
        normalized.itemIds,
      );
      if (normalized.itemIds.some((itemId) => !itemRowsById.has(itemId))) {
        throw new Error('订单商品不存在，请刷新后重试');
      }
      const expectedRevisionByOrderId = new Map(
        normalized.expectedOrderRevisions.map(
          ({ orderId, revision }) => [orderId, revision] as const,
        ),
      );
      for (const [orderId, orderRow] of orderRowsById) {
        const expectedRevision = expectedRevisionByOrderId.get(orderId);
        if (expectedRevision === undefined) {
          throw new Error('订单版本无效，请刷新后重试');
        }
        if (orderRow.state.revision !== expectedRevision) {
          throw new Error('订单已在其他操作中更新，请刷新后重试');
        }
      }
      const plan = planOrderItemStandardizationBatch({
        items: normalized.itemIds.map((itemId) => itemRowsById.get(itemId)!.state),
        orders: [...orderRowsById.values()].map((order) => order.state),
        product,
        options: normalized.options,
      });
      const confirmedOverrideItemIds = new Set(normalized.confirmedOverrideItemIds);
      const confirmedAmountMismatchOrderIds = new Set(normalized.confirmedAmountMismatchOrderIds);
      const confirmedMappingConflictItemIds = new Set(normalized.confirmedMappingConflictItemIds);
      // 规格第 6 节：映射冲突不能静默通过；未逐条确认单笔例外时整批拒绝，不产生任何留痕。
      if (normalized.options.createMappings) {
        const unconfirmedMappingConflicts = plan.items.filter((itemPlan) => (
          itemPlan.blockReasons.includes('mapping_conflict') &&
          !confirmedMappingConflictItemIds.has(itemPlan.itemId)
        ));
        if (unconfirmedMappingConflicts.length > 0) {
          throw new Error('相同原文已有指向其他 SKU 的有效映射，须逐条确认单笔例外或先更正商品映射');
        }
      }
      const changesByOrderId = new Map<string, OrderFieldChange[]>();
      const appliedSubtotalDeltaByOrderId = new Map<string, number>();
      let createdMappingCount = 0;
      const results: OrderItemStandardizationBatchItemResult[] = [];
      const eventRows: Array<{
        orderId: string;
        orderItemId: string;
        beforeStandardProductId: string | null;
        afterStandardProductId: string | null;
        applied: 0 | 1;
        blockReason: OrderItemStandardizationBatchBlockReason | null;
      }> = [];

      for (const itemPlan of plan.items) {
        const row = itemRowsById.get(itemPlan.itemId)!;
        // 映射冲突已在执行前整批校验：确认单笔例外的明细不再此处阻断。
        const blockReason = itemPlan.blockReasons.find((reason) => (
          reason === 'linked_other_product'
            ? !confirmedOverrideItemIds.has(itemPlan.itemId)
            : reason === 'amount_mismatch'
              ? !confirmedAmountMismatchOrderIds.has(itemPlan.orderId)
              : false
        )) ?? null;
        if (blockReason !== null) {
          results.push({
            itemId: itemPlan.itemId,
            orderId: itemPlan.orderId,
            applied: false,
            blockReason,
            beforeStandardProductSku: row.beforeStandardProductSku,
            afterStandardProductSku: null,
          });
          eventRows.push({
            orderId: itemPlan.orderId,
            orderItemId: itemPlan.itemId,
            beforeStandardProductId: row.state.standardProductId,
            afterStandardProductId: null,
            applied: 0,
            blockReason,
          });
          continue;
        }

        const position = row.state.position;
        const productChanged = itemPlan.linkState !== 'same_product';
        const afterSource: ProductStandardizationSource | null = productChanged
          ? 'manual'
          : row.standardizationSource;
        const afterPreference = normalized.options.standardDisplayPreference;
        workspace.database.prepare(`
          UPDATE order_items
          SET
            standard_product_id = ?,
            standardization_source = ?,
            standard_display_preference = ?,
            unit_price_cents = ?,
            subtotal_cents = ?
          WHERE id = ? AND order_id = ?
        `).run(
          product.id,
          afterSource,
          afterPreference,
          itemPlan.plannedUnitPriceCents,
          itemPlan.plannedSubtotalCents,
          itemPlan.itemId,
          itemPlan.orderId,
        );
        const orderChanges = changesByOrderId.get(itemPlan.orderId) ?? [];
        changesByOrderId.set(itemPlan.orderId, orderChanges);
        if (productChanged) {
          orderChanges.push({
            path: `items[${position}].standardProductSku`,
            before: row.beforeStandardProductSku,
            after: product.sku,
          });
        }
        if (row.standardizationSource !== afterSource) {
          orderChanges.push({
            path: `items[${position}].standardizationSource`,
            before: row.standardizationSource,
            after: afterSource,
          });
        }
        if (row.standardDisplayPreference !== afterPreference) {
          orderChanges.push({
            path: `items[${position}].standardDisplayPreference`,
            before: row.standardDisplayPreference,
            after: afterPreference,
          });
        }
        if (itemPlan.unitPriceChanges) {
          orderChanges.push({
            path: `items[${position}].unitPriceCents`,
            before: row.state.unitPriceCents,
            after: itemPlan.plannedUnitPriceCents,
          });
        }
        appliedSubtotalDeltaByOrderId.set(
          itemPlan.orderId,
          (appliedSubtotalDeltaByOrderId.get(itemPlan.orderId) ?? 0) +
            itemPlan.plannedSubtotalCents - row.state.subtotalCents,
        );
        // 勾选建立映射时按当前账号适用范围建映射；冲突明细经逐条确认后按
        // 单笔例外处理：只关联本次订单商品，不建立也不修改商品映射（规格 4.4）。
        if (normalized.options.createMappings) {
          const existingMappingProductId = row.state.currentAccountMappingProductId;
          const mappingConflictException = existingMappingProductId !== null &&
            existingMappingProductId !== product.id;
          if (!mappingConflictException) {
            const created = this.insertProductMapping(
              { sourceTitle: row.sourceTitle, sourceSpec: row.sourceSpec },
              product.id,
              { platform: row.orderPlatform, sellerAccount: row.orderSellerAccount },
              now,
              'manual',
            );
            if (created) createdMappingCount += 1;
          }
        }
        results.push({
          itemId: itemPlan.itemId,
          orderId: itemPlan.orderId,
          applied: true,
          blockReason: null,
          beforeStandardProductSku: row.beforeStandardProductSku,
          afterStandardProductSku: product.sku,
        });
        eventRows.push({
          orderId: itemPlan.orderId,
          orderItemId: itemPlan.itemId,
          beforeStandardProductId: row.state.standardProductId,
          afterStandardProductId: product.id,
          applied: 1,
          blockReason: null,
        });
      }

      for (const [orderId, orderChanges] of changesByOrderId) {
        const orderRow = orderRowsById.get(orderId)!;
        if (normalized.options.updateProductTotal) {
          const delta = appliedSubtotalDeltaByOrderId.get(orderId) ?? 0;
          const suggestedTotalCents = orderRow.state.itemsSubtotalCents + delta;
          if (!Number.isSafeInteger(suggestedTotalCents) || suggestedTotalCents < 0) {
            throw new Error('商品明细合计超出安全范围');
          }
          if (delta !== 0 && suggestedTotalCents !== orderRow.state.productTotalCents) {
            orderChanges.push({
              path: 'productTotalCents',
              before: orderRow.state.productTotalCents,
              after: suggestedTotalCents,
            });
          }
        }
        if (orderChanges.length === 0) continue;
        const appliedDelta = normalized.options.updateProductTotal
          ? appliedSubtotalDeltaByOrderId.get(orderId) ?? 0
          : 0;
        const finalProductTotalCents = appliedDelta !== 0
          ? orderRow.state.itemsSubtotalCents + appliedDelta
          : orderRow.state.productTotalCents;
        const expectedRevision = expectedRevisionByOrderId.get(orderId)!;
        const updated = workspace.database.prepare(`
          UPDATE original_orders
          SET
            product_total_cents = ?,
            revision = revision + 1,
            updated_at = ?
          WHERE id = ? AND revision = ?
        `).run(finalProductTotalCents, now, orderId, expectedRevision);
        if (updated.changes !== 1) {
          throw new Error('订单已在其他操作中更新，请刷新后重试');
        }
        const eventId = randomUUID();
        workspace.database.prepare(`
          INSERT INTO order_change_events (
            id, order_id, source_snapshot_id, source,
            base_revision, result_revision, created_at
          ) VALUES (?, ?, NULL, 'manual_edit', ?, ?, ?)
        `).run(eventId, orderId, expectedRevision, expectedRevision + 1, now);
        const insertChange = workspace.database.prepare(`
          INSERT INTO order_field_changes (
            id, event_id, field_path, before_json, after_json
          ) VALUES (?, ?, ?, ?, ?)
        `);
        for (const change of orderChanges) {
          insertChange.run(
            randomUUID(),
            eventId,
            change.path,
            JSON.stringify(change.before),
            JSON.stringify(change.after),
          );
        }
      }

      const insertBatchEvent = workspace.database.prepare(`
        INSERT INTO order_item_standardization_batch_events (
          id, batch_id, order_id, order_item_id,
          target_standard_product_id, before_standard_product_id, after_standard_product_id,
          standard_display_preference, use_default_order_price,
          applied, block_reason, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const eventRow of eventRows) {
        insertBatchEvent.run(
          randomUUID(),
          batchId,
          eventRow.orderId,
          eventRow.orderItemId,
          product.id,
          eventRow.beforeStandardProductId,
          eventRow.afterStandardProductId,
          normalized.options.standardDisplayPreference,
          normalized.options.useDefaultOrderPrice ? 1 : 0,
          eventRow.applied,
          eventRow.blockReason,
          now,
          now,
        );
      }
      return {
        batchId,
        standardProduct: product,
        appliedItemCount: results.filter((result) => result.applied).length,
        blockedItemCount: results.filter((result) => !result.applied).length,
        createdMappingCount,
        results,
      };
    });
  }

  private loadOrderItemStandardizationBatchRows(itemIds: readonly string[]): {
    itemRowsById: Map<string, OrderItemStandardizationBatchItemRow>;
    orderRowsById: Map<string, OrderItemStandardizationBatchOrderRow>;
  } {
    const workspace = this.requireWorkspace();
    const rows = workspace.database.prepare(`
      SELECT
        items.id AS item_id,
        items.order_id AS order_id,
        items.position AS position,
        items.source_title AS source_title,
        items.source_spec AS source_spec,
        items.quantity AS quantity,
        items.unit_price_cents AS unit_price_cents,
        items.subtotal_cents AS subtotal_cents,
        items.standard_product_id AS standard_product_id,
        items.standardization_source AS standardization_source,
        items.standard_display_preference AS standard_display_preference,
        before_products.sku AS before_standard_product_sku,
        orders.system_order_number AS system_order_number,
        orders.platform_order_number AS order_number,
        orders.platform AS order_platform,
        orders.seller_account AS order_seller_account,
        orders.revision AS order_revision,
        orders.fulfillment_status AS fulfillment_status,
        orders.product_total_cents AS product_total_cents,
        orders.shipping_fee_cents AS shipping_fee_cents,
        orders.amount_cents AS amount_cents,
        (
          SELECT COALESCE(SUM(all_items.subtotal_cents), 0)
          FROM order_items AS all_items
          WHERE all_items.order_id = orders.id
        ) AS items_subtotal_cents,
        EXISTS (
          SELECT 1
          FROM aftersales_case_items AS case_items
          JOIN shipment_package_items AS shipment_items
            ON shipment_items.id = case_items.shipment_package_item_id
          WHERE shipment_items.order_id = orders.id
        ) AS has_aftersales
      FROM order_items AS items
      JOIN original_orders AS orders ON orders.id = items.order_id
      LEFT JOIN standard_products AS before_products
        ON before_products.id = items.standard_product_id
      WHERE orders.lifecycle_status = 'active'
        AND items.id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(itemIds)) as unknown as SqlRow[];
    const rowByItemId = new Map(rows.map((row) => [asString(row.item_id), row] as const));
    // 当前账号适用范围的有效映射按 平台|卖家账号|规范化原文 索引，供建立映射前查冲突。
    const accountMappingProductIdByKey = new Map<string, string>();
    const mappingRows = workspace.database.prepare(`
      SELECT platform, seller_account, source_title_key, source_spec_key, standard_product_id
      FROM product_mappings
      WHERE scope = 'current_account' AND status = 'active'
    `).all() as unknown as SqlRow[];
    for (const mappingRow of mappingRows) {
      accountMappingProductIdByKey.set([
        asString(mappingRow.platform),
        asString(mappingRow.seller_account),
        asString(mappingRow.source_title_key),
        asString(mappingRow.source_spec_key),
      ].join('\u001f'), asString(mappingRow.standard_product_id));
    }
    const itemRowsById = new Map<string, OrderItemStandardizationBatchItemRow>();
    const orderRowsById = new Map<string, OrderItemStandardizationBatchOrderRow>();
    for (const itemId of itemIds) {
      const row = rowByItemId.get(itemId);
      if (!row) continue;
      const orderId = asString(row.order_id);
      const orderPlatform = asString(row.order_platform);
      const orderSellerAccount = asString(row.order_seller_account);
      const sourceTitle = asString(row.source_title);
      const sourceSpec = asString(row.source_spec);
      const accountMappingKey = [
        orderPlatform,
        orderSellerAccount,
        normalizeProductText(sourceTitle),
        normalizeProductText(sourceSpec),
      ].join('\u001f');
      itemRowsById.set(itemId, {
        state: {
          itemId,
          orderId,
          position: asNumber(row.position),
          quantity: asNumber(row.quantity),
          unitPriceCents: asNumber(row.unit_price_cents),
          subtotalCents: asNumber(row.subtotal_cents),
          standardProductId: row.standard_product_id === null
            ? null
            : asString(row.standard_product_id),
          currentAccountMappingProductId: accountMappingProductIdByKey.get(accountMappingKey) ?? null,
          currentAccountMappingKey: accountMappingKey,
        },
        sourceTitle,
        sourceSpec,
        orderPlatform,
        orderSellerAccount,
        standardizationSource: row.standardization_source === null
          ? null
          : asProductStandardizationSource(row.standardization_source),
        standardDisplayPreference: row.standard_display_preference === null
          ? null
          : asStandardDisplayPreference(row.standard_display_preference),
        beforeStandardProductSku: row.before_standard_product_sku === null
          ? null
          : asString(row.before_standard_product_sku),
        orderNumber: asString(row.order_number),
        systemOrderNumber: asString(row.system_order_number),
      });
      if (!orderRowsById.has(orderId)) {
        orderRowsById.set(orderId, {
          state: {
            orderId,
            revision: asNumber(row.order_revision),
            shippedOrDelivered: ['partially_shipped', 'shipped', 'delivered'].includes(
              asString(row.fulfillment_status),
            ),
            hasAftersales: asNumber(row.has_aftersales) === 1,
            productTotalCents: asNumber(row.product_total_cents),
            shippingFeeCents: asNumber(row.shipping_fee_cents),
            amountCents: asNumber(row.amount_cents),
            itemsSubtotalCents: asNumber(row.items_subtotal_cents),
          },
          orderNumber: asString(row.order_number),
          systemOrderNumber: asString(row.system_order_number),
        });
      }
    }
    return { itemRowsById, orderRowsById };
  }

  public listOrders(): OrderSummary[] {
    return this.queryOrders({}, []).orders;
  }

  public createStandardProduct(input: unknown): StandardProduct {
    const workspace = this.requireWorkspace();
    const normalized = normalizeStandardProductInput(input);
    const skuKey = normalizeSkuKey(normalized.sku);
    if (workspace.database.prepare(
      'SELECT 1 AS found FROM standard_products WHERE sku_key = ?',
    ).get(skuKey)) {
      throw new Error('SKU 已存在');
    }
    const price = normalized.defaultOrderPriceCents ?? null;
    const initialEvent = price === null
      ? null
      : { price, reason: normalized.priceChangeReason ?? '' };
    if (initialEvent && !initialEvent.reason) {
      throw new Error('默认订单单价变更必须填写原因');
    }
    if (!initialEvent && normalized.priceChangeReason) {
      throw new Error('价格未变更时不能填写价格变更原因');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    return workspace.transaction(() => {
      workspace.database.prepare(`
        INSERT INTO standard_products (
          id, sku, sku_key, name, specification,
          name_key, specification_key, default_order_price_cents,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        id,
        normalized.sku,
        skuKey,
        normalized.name,
        normalized.specification,
        normalizeProductText(normalized.name),
        normalizeProductText(normalized.specification),
        price,
        now,
        now,
      );
      if (initialEvent) {
        this.insertStandardProductPriceEvent(
          id,
          null,
          initialEvent.price,
          initialEvent.reason,
          now,
        );
      }
      return this.getStandardProduct(id);
    });
  }

  public listStandardProductPriceEvents(productId: string): StandardProductPriceEvent[] {
    const workspace = this.requireWorkspace();
    const id = productId.trim();
    if (!id || id.length > 200) throw new Error('标准商品标识无效');
    if (!workspace.database.prepare(
      'SELECT 1 AS found FROM standard_products WHERE id = ?',
    ).get(id)) {
      throw new Error('未找到标准商品');
    }
    return (workspace.database.prepare(`
      SELECT *
      FROM standard_product_price_events
      WHERE standard_product_id = ?
      ORDER BY sequence
    `).all(id) as unknown as SqlRow[]).map(parseStandardProductPriceEventRow);
  }

  private insertStandardProductPriceEvent(
    productId: string,
    previousPrice: number | null,
    price: number | null,
    reason: string,
    now: string,
  ): void {
    this.requireWorkspace().database.prepare(`
      INSERT INTO standard_product_price_events (
        id, standard_product_id,
        previous_default_order_price_cents, default_order_price_cents,
        reason, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), productId, previousPrice, price, reason, now, now);
  }

  public listStandardProducts(): StandardProduct[] {
    const workspace = this.requireWorkspace();
    return (workspace.database.prepare(`
      SELECT *
      FROM standard_products
      ORDER BY sku_key, id
    `).all() as unknown as SqlRow[]).map(parseStandardProductRow);
  }

  public inspectHistoricalOrderWorkbook(
    buffer: Buffer,
  ): Promise<HistoricalOrderWorkbookInspection> {
    this.requireWorkspace();
    return inspectHistoricalWorkbook(buffer);
  }

  public async previewHistoricalOrderImport(
    buffer: Buffer,
    input: HistoricalOrderImportInput,
  ): Promise<HistoricalOrderImportPreview> {
    this.requireWorkspace();
    return (await previewHistoricalOrderWorkbook({
      buffer,
      columnMapping: input.columnMapping,
      findExistingOrder: (candidate) => this.findOriginalOrderByIdentity(candidate),
      prepareExistingOrderCandidate: (existing, candidate) => (
        this.prepareHistoricalUpdateCandidate(existing, candidate, input.columnMapping)
      ),
    })).preview;
  }

  public async confirmHistoricalOrderImport(
    buffer: Buffer,
    sourceName: string,
    input: HistoricalOrderImportConfirmationInput | unknown,
  ): Promise<HistoricalOrderImportResult> {
    const workspace = this.requireWorkspace();
    const normalizedSourceName = sourceName.normalize('NFKC').trim();
    if (!normalizedSourceName || normalizedSourceName.length > 255) {
      throw new Error('历史导入来源文件名无效');
    }
    const normalized = normalizeHistoricalOrderImportConfirmationInput(input);
    const plan = await previewHistoricalOrderWorkbook({
      buffer,
      columnMapping: normalized.columnMapping,
      findExistingOrder: (candidate) => this.findOriginalOrderByIdentity(candidate),
      prepareExistingOrderCandidate: (existing, candidate) => (
        this.prepareHistoricalUpdateCandidate(existing, candidate, normalized.columnMapping)
      ),
    });
    if (plan.preview.previewToken !== normalized.previewToken) {
      throw new Error('历史订单预览已过期，请重新预览');
    }

    let createdOrderCount = 0;
    let updatedOrderCount = 0;
    const now = new Date().toISOString();
    workspace.transaction(() => {
      plan.preview.orders.forEach((orderPreview, index) => {
        const candidate = plan.candidates[index];
        if (!candidate) throw new Error('历史订单预览内容无效');
        if (orderPreview.action === 'duplicate') return;
        if (orderPreview.action === 'update') {
          if (!orderPreview.existingOrderId || orderPreview.expectedRevision === null) {
            throw new Error('历史订单预览内容无效');
          }
          this.updateHistoricalOrder(
            candidate,
            normalized.columnMapping,
            normalizedSourceName,
            orderPreview.existingOrderId,
            orderPreview.expectedRevision,
            now,
          );
          updatedOrderCount += 1;
          return;
        }
        this.insertHistoricalOrder(candidate, normalizedSourceName, now);
        createdOrderCount += 1;
      });
    });
    return {
      createdOrderCount,
      updatedOrderCount,
      skippedDuplicateOrderCount: plan.preview.summary.duplicateOrderCount,
      skippedErrorRowCount: plan.preview.summary.errorRowCount,
    };
  }

  public async createHistoricalOrderErrorRowsWorkbook(
    buffer: Buffer,
    input: HistoricalOrderImportConfirmationInput | unknown,
  ): Promise<Buffer> {
    this.requireWorkspace();
    const normalized = normalizeHistoricalOrderImportConfirmationInput(input);
    const plan = await previewHistoricalOrderWorkbook({
      buffer,
      columnMapping: normalized.columnMapping,
      findExistingOrder: (candidate) => this.findOriginalOrderByIdentity(candidate),
      prepareExistingOrderCandidate: (existing, candidate) => (
        this.prepareHistoricalUpdateCandidate(existing, candidate, normalized.columnMapping)
      ),
    });
    if (plan.preview.previewToken !== normalized.previewToken) {
      throw new Error('历史订单预览已过期，请重新预览');
    }
    return buildHistoricalOrderErrorRowsWorkbook({
      buffer,
      columnMapping: normalized.columnMapping,
      errorRows: plan.preview.errorRows,
    });
  }

  private insertHistoricalOrder(
    candidate: HistoricalOrderImportCandidate,
    sourceName: string,
    now: string,
  ): void {
    const workspace = this.requireWorkspace();
    if (this.findOriginalOrderByIdentity(candidate)) {
      throw new Error('历史订单预览已过期，请重新预览');
    }
    const orderId = randomUUID();
    const systemOrderNumber = this.nextSystemOrderNumber(now);
    const importItems = candidate.items.map((item, position) => ({ ...item, position }));
    const productStandardizations = this.prepareProductStandardizations(
      importItems,
      undefined,
      { platform: candidate.platform, sellerAccount: candidate.sellerAccount },
    );
    workspace.database.prepare(`
      INSERT INTO original_orders (
        id, system_order_number, draft_id, screenshot_id, platform,
        seller_account, seller_account_normalized,
        platform_order_number, platform_order_number_normalized,
        alipay_transaction_number, buyer_nickname, recipient, phone, phone_normalized,
        address_original, address_normalized, province, city, district,
        ordered_at_original, ordered_at_normalized, paid_at_original, paid_at_normalized,
        product_total_cents, shipping_fee_cents, amount_cents,
        platform_transaction_status, fulfillment_status, lifecycle_status,
        created_at, updated_at
      ) VALUES (
        ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'active', ?, ?
      )
    `).run(
      orderId,
      systemOrderNumber,
      candidate.platform,
      candidate.sellerAccount,
      normalizedOrderIdentityPart(candidate.sellerAccount),
      candidate.orderNumber,
      normalizedOrderIdentityPart(candidate.orderNumber),
      candidate.alipayTransactionNumber,
      candidate.buyerNickname,
      candidate.recipient,
      candidate.phone,
      candidate.phoneNormalized,
      candidate.addressOriginal,
      candidate.addressNormalized,
      candidate.province,
      candidate.city,
      candidate.district,
      candidate.orderedAtOriginal,
      candidate.orderedAtNormalized,
      candidate.paidAtOriginal,
      candidate.paidAtNormalized,
      candidate.productTotalCents,
      candidate.shippingFeeCents,
      candidate.amountCents,
      candidate.platformTransactionStatus,
      candidate.fulfillmentStatus,
      now,
      now,
    );
    this.recipientService().ensureRecipient(candidate.recipient, candidate.phoneNormalized, now);

    const insertItem = workspace.database.prepare(`
      INSERT INTO order_items (
        id, order_id, position, source_title, source_spec,
        unit_price_cents, quantity, quantity_source, subtotal_cents,
        standard_product_id, standardization_source, standard_display_preference
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const itemIds: string[] = [];
    candidate.items.forEach((item, position) => {
      const itemId = randomUUID();
      itemIds.push(itemId);
      const standardization = productStandardizations.get(item.id);
      if (!standardization) throw new Error('历史订单商品标准化结果无效');
      insertItem.run(
        itemId,
        orderId,
        position,
        item.sourceTitle,
        item.sourceSpec,
        item.unitPriceCents,
        item.quantity,
        requiredQuantitySource(item),
        safeSubtotal(requireMoney('商品单价', item.unitPriceCents), item.quantity),
        standardization.standardProductId,
        standardization.source,
        plannedStandardDisplayPreference(standardization.standardProductId, undefined),
      );
      if (standardization.matchedMappingId) {
        this.markProductMappingUsed(standardization.matchedMappingId, now);
      }
    });
    this.insertDefaultCustomFieldValues(orderId, itemIds, now);
    this.assertRequiredCustomFieldValuesPresent(orderId);

    const snapshotId = randomUUID();
    const serialized = serializeRecognition(candidate);
    workspace.database.prepare(`
      INSERT INTO source_snapshots (
        id, draft_id, order_id, screenshot_id,
        source_type, source_name, source_row_numbers_json,
        recognition_json, confirmed_json, created_at, resolved_at
      ) VALUES (?, NULL, ?, NULL, 'historical_import', ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotId,
      orderId,
      sourceName,
      JSON.stringify(candidate.rowNumbers),
      serialized,
      serialized,
      now,
      now,
    );
  }

  private updateHistoricalOrder(
    imported: HistoricalOrderImportCandidate,
    columnMapping: HistoricalOrderImportInput['columnMapping'],
    sourceName: string,
    orderId: string,
    expectedRevision: number,
    now: string,
  ): void {
    const workspace = this.requireWorkspace();
    const existing = this.getOrder(orderId).order;
    if (
      existing.revision !== expectedRevision ||
      !hasSameOrderIdentity(existing, imported)
    ) {
      throw new Error('历史订单预览已过期，请重新预览');
    }
    const confirmed = this.prepareHistoricalUpdateCandidate(existing, imported, columnMapping);
    const hasShipmentHistory = this.orderFulfillmentProjection().hasShipmentHistory(orderId);
    const changes = diffOrderCurrentValues(existing, confirmed);
    if (changes.length === 0) {
      throw new Error('历史订单内容已与当前值一致，请重新预览');
    }

    const persistedItemIds = matchHistoricalOrderItemIds(existing.items, confirmed.items);
    for (const item of confirmed.items) {
      if (!persistedItemIds.has(item.id)) persistedItemIds.set(item.id, randomUUID());
    }
    const existingItemsById = new Map(existing.items.map((item) => [item.id, item]));
    const retainedExistingItemIds = new Set(persistedItemIds.values());
    const importItems = confirmed.items.map((item, position) => ({ ...item, position }));
    const productStandardizations = this.prepareProductStandardizations(
      importItems,
      undefined,
      { platform: existing.platform, sellerAccount: existing.sellerAccount },
    );
    for (const item of confirmed.items) {
      const persistedItemId = persistedItemIds.get(item.id);
      const existingItem = persistedItemId ? existingItemsById.get(persistedItemId) : undefined;
      if (!existingItem?.standardProduct) continue;
      productStandardizations.set(item.id, {
        standardProductId: existingItem.standardProduct.id,
        source: existingItem.standardizationSource,
        createMapping: false,
        matchedMappingId: null,
      });
    }
    const updatedOrder = workspace.database.prepare(`
      UPDATE original_orders
      SET
        alipay_transaction_number = ?,
        buyer_nickname = ?,
        recipient = ?,
        phone = ?,
        phone_normalized = ?,
        address_original = ?,
        address_normalized = ?,
        province = ?,
        city = ?,
        district = ?,
        ordered_at_original = ?,
        ordered_at_normalized = ?,
        paid_at_original = ?,
        paid_at_normalized = ?,
        product_total_cents = ?,
        shipping_fee_cents = ?,
        amount_cents = ?,
        platform_transaction_status = ?,
        fulfillment_status = ?,
        revision = revision + 1,
        updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      confirmed.alipayTransactionNumber,
      confirmed.buyerNickname,
      confirmed.recipient,
      confirmed.phone,
      confirmed.phoneNormalized,
      confirmed.addressOriginal,
      confirmed.addressNormalized,
      confirmed.province,
      confirmed.city,
      confirmed.district,
      confirmed.orderedAtOriginal,
      confirmed.orderedAtNormalized,
      confirmed.paidAtOriginal,
      confirmed.paidAtNormalized,
      confirmed.productTotalCents,
      confirmed.shippingFeeCents,
      confirmed.amountCents,
      confirmed.platformTransactionStatus,
      confirmed.fulfillmentStatus,
      now,
      orderId,
      expectedRevision,
    );
    if (updatedOrder.changes !== 1) throw new Error('历史订单预览已过期，请重新预览');
    if (['refunded', 'cancelled'].includes(confirmed.platformTransactionStatus)) {
      new FulfillmentDemandService(workspace).shrinkDraftsAfterOrderExit(
        orderId,
        now,
        confirmed.platformTransactionStatus === 'refunded'
          ? '订单整单退款后重算未确认建议'
          : '订单取消后重算未确认建议',
      );
    }
    this.recipientService().ensureRecipient(confirmed.recipient, confirmed.phoneNormalized, now);

    workspace.database.prepare('UPDATE order_items SET position = position + 100000 WHERE order_id = ?')
      .run(orderId);
    const updateItem = workspace.database.prepare(`
      UPDATE order_items
      SET position = ?, source_title = ?, source_spec = ?, unit_price_cents = ?,
        quantity = ?, quantity_source = ?, subtotal_cents = ?
      WHERE id = ? AND order_id = ?
    `);
    const insertItem = workspace.database.prepare(`
      INSERT INTO order_items (
        id, order_id, position, source_title, source_spec,
        unit_price_cents, quantity, quantity_source, subtotal_cents,
        standard_product_id, standardization_source, standard_display_preference
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    confirmed.items.forEach((item, position) => {
      const itemId = persistedItemIds.get(item.id);
      if (!itemId) throw new Error('历史订单商品标识无效');
      const subtotal = safeSubtotal(requireMoney('商品单价', item.unitPriceCents), item.quantity);
      if (existingItemsById.has(itemId)) {
        updateItem.run(
          position, item.sourceTitle, item.sourceSpec, item.unitPriceCents,
          item.quantity, requiredQuantitySource(item), subtotal, itemId, orderId,
        );
      } else {
        const standardization = productStandardizations.get(item.id);
        if (!standardization) throw new Error('历史订单商品标准化结果无效');
        insertItem.run(
          itemId, orderId, position, item.sourceTitle, item.sourceSpec,
          item.unitPriceCents, item.quantity, requiredQuantitySource(item), subtotal,
          standardization.standardProductId,
          standardization.source,
          plannedStandardDisplayPreference(standardization.standardProductId, undefined),
        );
        if (standardization.matchedMappingId) {
          this.markProductMappingUsed(standardization.matchedMappingId, now);
        }
        this.insertDefaultCustomFieldValues(null, [itemId], now);
      }
    });
    const removedItemIds = existing.items
      .map(({ id }) => id)
      .filter((id) => !retainedExistingItemIds.has(id));
    if (removedItemIds.length > 0) {
      workspace.database.prepare(`
        DELETE FROM order_items
        WHERE order_id = ? AND id IN (${removedItemIds.map(() => '?').join(', ')})
      `).run(orderId, ...removedItemIds);
    }
    this.assertRequiredCustomFieldValuesPresent(orderId);

    const snapshotId = randomUUID();
    workspace.database.prepare(`
      INSERT INTO source_snapshots (
        id, draft_id, order_id, screenshot_id,
        source_type, source_name, source_row_numbers_json,
        recognition_json, confirmed_json, created_at, resolved_at
      ) VALUES (?, NULL, ?, NULL, 'historical_import', ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotId,
      orderId,
      sourceName,
      JSON.stringify(imported.rowNumbers),
      serializeRecognition(imported),
      serializeRecognition(confirmed),
      now,
      now,
    );
    const eventId = randomUUID();
    workspace.database.prepare(`
      INSERT INTO order_change_events (
        id, order_id, source_snapshot_id, source,
        base_revision, result_revision, created_at
      ) VALUES (?, ?, ?, 'source_update', ?, ?, ?)
    `).run(eventId, orderId, snapshotId, expectedRevision, expectedRevision + 1, now);
    const insertChange = workspace.database.prepare(`
      INSERT INTO order_field_changes (
        id, event_id, field_path, before_json, after_json
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const change of changes) {
      insertChange.run(
        randomUUID(), eventId, change.path,
        JSON.stringify(change.before), JSON.stringify(change.after),
      );
    }
    if (hasShipmentHistory) this.synchronizeShipmentOrderFulfillment(orderId, now);
  }

  private prepareHistoricalUpdateCandidate(
    existing: OriginalOrder,
    imported: HistoricalOrderImportCandidate,
    columnMapping: HistoricalOrderImportInput['columnMapping'],
  ): HistoricalOrderImportCandidate {
    const columns = columnMapping.columns;
    const existingIdByImportedId = matchHistoricalOrderItemIds(existing.items, imported.items);
    const existingItemsById = new Map(existing.items.map((item) => [item.id, item]));
    const withPreservedUnmappedFields: HistoricalOrderImportCandidate = {
      ...imported,
      alipayTransactionNumber: columns.alipayTransactionNumber === null
        ? existing.alipayTransactionNumber
        : imported.alipayTransactionNumber,
      buyerNickname: columns.buyerNickname === null
        ? existing.buyerNickname
        : imported.buyerNickname,
      orderedAtOriginal: columns.orderedAt === null
        ? existing.orderedAtOriginal
        : imported.orderedAtOriginal,
      orderedAtNormalized: columns.orderedAt === null
        ? existing.orderedAtNormalized
        : imported.orderedAtNormalized,
      paidAtOriginal: columns.paidAt === null
        ? existing.paidAtOriginal
        : imported.paidAtOriginal,
      paidAtNormalized: columns.paidAt === null
        ? existing.paidAtNormalized
        : imported.paidAtNormalized,
      productTotalCents: columns.productTotal === null
        ? existing.productTotalCents
        : imported.productTotalCents,
      shippingFeeCents: columns.shippingFee === null
        ? existing.shippingFeeCents
        : imported.shippingFeeCents,
      platformTransactionStatus: columns.platformTransactionStatus === null
        ? existing.platformTransactionStatus
        : imported.platformTransactionStatus,
      fulfillmentStatus: columns.fulfillmentStatus === null
        ? existing.fulfillmentStatus
        : imported.fulfillmentStatus,
      items: imported.items.map((item) => {
        if (columns.itemSpec !== null) return item;
        const existingId = existingIdByImportedId.get(item.id);
        const existingItem = existingId ? existingItemsById.get(existingId) : undefined;
        return existingItem ? { ...item, sourceSpec: existingItem.sourceSpec } : item;
      }),
    };
    const withProtectedQuantities = withHigherPriorityCurrentQuantities(
      existing,
      withPreservedUnmappedFields,
      matchHistoricalOrderItemIds,
    );
    return this.orderFulfillmentProjection().hasShipmentHistory(existing.id)
      ? { ...withProtectedQuantities, fulfillmentStatus: existing.fulfillmentStatus }
      : withProtectedQuantities;
  }

  public inspectProductCatalogWorkbook(
    buffer: Buffer,
  ): Promise<ProductCatalogWorkbookInspection> {
    this.requireWorkspace();
    return inspectCatalogWorkbook(buffer);
  }

  public async previewProductCatalogImport(
    buffer: Buffer,
    input: ProductCatalogImportInput | unknown,
  ): Promise<ProductCatalogImportPreview> {
    this.requireWorkspace();
    const normalized = normalizeProductCatalogImportInput(input);
    const existingProducts = this.listStandardProducts();
    const existingMappings = this.listActiveProductMappings();
    const stateToken = productCatalogStateToken(existingProducts, existingMappings);
    const preview = await previewProductCatalogWorkbook({
      buffer,
      columnMapping: normalized.columnMapping,
      duplicateSkuResolutions: normalized.duplicateSkuResolutions,
      existingProducts,
      existingMappings,
    });
    if (stateToken !== productCatalogStateToken(
      this.listStandardProducts(),
      this.listActiveProductMappings(),
    )) {
      throw new Error('商品目录状态已变化，请重新预览');
    }
    return preview;
  }

  public async confirmProductCatalogImport(
    buffer: Buffer,
    input: ProductCatalogImportConfirmationInput | unknown,
  ): Promise<ProductCatalogImportResult> {
    const workspace = this.requireWorkspace();
    const normalized = normalizeProductCatalogImportConfirmationInput(input);
    const preview = await this.previewProductCatalogImport(buffer, {
      columnMapping: normalized.columnMapping,
      duplicateSkuResolutions: normalized.duplicateSkuResolutions,
    });
    if (preview.previewToken !== normalized.previewToken) {
      throw new Error('商品目录预览已过期，请重新预览');
    }
    if (preview.duplicateSkus.some(({ selectedRowNumber }) => selectedRowNumber === null)) {
      throw new Error('重复 SKU 必须全部明确选择保留行');
    }
    if (preview.summary.updateMappingCount > 0 && !normalized.mappingUpdateReason) {
      throw new Error('商品映射更新必须填写原因');
    }

    return workspace.transaction(() => {
      let createdProductCount = 0;
      let updatedProductCount = 0;
      let createdMappingCount = 0;
      let updatedMappingCount = 0;
      const productsBySku = new Map(this.listStandardProducts().map((product) => (
        [normalizeSkuKey(product.sku), product] as const
      )));
      for (const row of preview.productRows) {
        if (row.action === 'create') {
          const created = this.createStandardProduct({
            sku: row.sku,
            name: row.name,
            specification: row.specification,
          });
          productsBySku.set(row.skuKey, created);
          createdProductCount += 1;
        } else if (row.action === 'update') {
          const current = productsBySku.get(row.skuKey);
          if (!current) throw new Error('商品目录预览已过期，请重新预览');
          const updated = this.updateStandardProduct(current.id, {
            sku: row.sku,
            name: row.name,
            specification: row.specification,
            defaultOrderPriceCents: current.defaultOrderPriceCents,
            expectedRevision: current.revision,
          });
          productsBySku.set(row.skuKey, updated);
          updatedProductCount += 1;
        }
      }

      for (const row of preview.mappingRows) {
        if (row.action !== 'create' && row.action !== 'update') continue;
        const product = productsBySku.get(row.skuKey);
        if (!product) throw new Error('商品目录预览已过期，请重新预览');
        if (row.action === 'create') {
          this.createProductMapping(product.id, {
            sourceTitle: row.sourceTitle,
            sourceSpec: row.sourceSpec,
            scope: row.scope,
            platform: row.platform,
            sellerAccount: row.sellerAccount,
          });
          createdMappingCount += 1;
        } else {
          if (!row.existingMappingId) throw new Error('商品目录预览已过期，请重新预览');
          this.correctProductMapping(row.existingMappingId, {
            standardProductId: product.id,
            reason: normalized.mappingUpdateReason,
          });
          updatedMappingCount += 1;
        }
      }
      return {
        createdProductCount,
        updatedProductCount,
        createdMappingCount,
        updatedMappingCount,
        skippedErrorRowCount: preview.summary.errorRowCount,
      };
    });
  }

  public createProductCatalogWorkbook(): Promise<Buffer> {
    this.requireWorkspace();
    return buildProductCatalogWorkbook({
      products: this.listStandardProducts(),
      mappings: this.listActiveProductMappings(),
    });
  }

  private listActiveProductMappings(): ProductMappingView[] {
    const workspace = this.requireWorkspace();
    const hitSummaries = this.projectProductMappingHits();
    return (workspace.database.prepare(`
      SELECT mappings.*, products.sku AS target_sku, products.name AS target_name
      FROM product_mappings AS mappings
      JOIN standard_products AS products ON products.id = mappings.standard_product_id
      WHERE mappings.status = 'active'
      ORDER BY products.sku_key, mappings.created_at, mappings.id
    `).all() as unknown as SqlRow[]).map((row) => (
      parseProductMappingViewRow(row, hitSummaries)
    ));
  }

  public updateStandardProduct(productId: string, input: unknown): StandardProduct {
    const workspace = this.requireWorkspace();
    const id = productId.trim();
    if (!id || id.length > 200) throw new Error('标准商品标识无效');
    const normalized = normalizeUpdateStandardProductInput(input);
    const skuKey = normalizeSkuKey(normalized.sku);
    const duplicate = workspace.database.prepare(`
      SELECT 1 AS found
      FROM standard_products
      WHERE sku_key = ? AND id <> ?
    `).get(skuKey, id);
    if (duplicate) throw new Error('SKU 已存在');
    const now = new Date().toISOString();
    return workspace.transaction(() => {
      const currentRow = workspace.database.prepare(`
        SELECT default_order_price_cents
        FROM standard_products
        WHERE id = ?
      `).get(id) as SqlRow | undefined;
      if (!currentRow) throw new Error('未找到标准商品');
      const previousPrice = currentRow.default_order_price_cents === null
        ? null
        : asNumber(currentRow.default_order_price_cents);
      const priceChanged = previousPrice !== normalized.defaultOrderPriceCents;
      const priceChangeReason = normalized.priceChangeReason ?? '';
      if (priceChanged && !priceChangeReason) {
        throw new Error('默认订单单价变更必须填写原因');
      }
      if (!priceChanged && priceChangeReason) {
        throw new Error('价格未变更时不能填写价格变更原因');
      }
      const result = workspace.database.prepare(`
        UPDATE standard_products
        SET
          sku = ?,
          sku_key = ?,
          name = ?,
          specification = ?,
          name_key = ?,
          specification_key = ?,
          default_order_price_cents = ?,
          revision = revision + 1,
          updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        normalized.sku,
        skuKey,
        normalized.name,
        normalized.specification,
        normalizeProductText(normalized.name),
        normalizeProductText(normalized.specification),
        normalized.defaultOrderPriceCents,
        now,
        id,
        normalized.expectedRevision,
      );
      if (result.changes !== 1) {
        throw new Error('标准商品已在其他操作中更新，请刷新后重试');
      }
      if (priceChanged) {
        this.insertStandardProductPriceEvent(
          id,
          previousPrice,
          normalized.defaultOrderPriceCents,
          priceChangeReason,
          now,
        );
      }
      return this.getStandardProduct(id);
    });
  }

  private getStandardProduct(productId: string): StandardProduct {
    const workspace = this.requireWorkspace();
    const row = workspace.database.prepare(`
      SELECT * FROM standard_products WHERE id = ?
    `).get(productId) as SqlRow | undefined;
    if (!row) throw new Error('未找到标准商品');
    return parseStandardProductRow(row);
  }

  private exactStandardProductId(
    item: Pick<RecognitionItem, 'sourceTitle' | 'sourceSpec'>,
  ): string | null {
    const workspace = this.requireWorkspace();
    const rows = workspace.database.prepare(`
      SELECT id
      FROM standard_products
      WHERE name_key = ? AND specification_key = ?
      ORDER BY id
      LIMIT 2
    `).all(
      normalizeProductText(item.sourceTitle),
      normalizeProductText(item.sourceSpec),
    ) as unknown as SqlRow[];
    return rows.length === 1 ? asString(rows[0].id) : null;
  }

  private matchedProductMapping(
    item: Pick<RecognitionItem, 'sourceTitle' | 'sourceSpec'>,
    context: ProductMappingMatchContext,
  ): (ProductMappingMatch & { row: { id: string } }) | null {
    const workspace = this.requireWorkspace();
    // 已停用的映射不参与匹配（规格 4.2）。
    const rows = workspace.database.prepare(`
      SELECT id, scope, platform, seller_account, standard_product_id
      FROM product_mappings
      WHERE source_title_key = ? AND source_spec_key = ? AND status = 'active'
    `).all(
      normalizeProductText(item.sourceTitle),
      normalizeProductText(item.sourceSpec),
    ) as unknown as SqlRow[];
    return selectProductMappingMatch(rows.map((row) => ({
      id: asString(row.id),
      scope: asProductMappingScope(row.scope),
      platform: row.platform === null ? null : asString(row.platform),
      sellerAccount: row.seller_account === null ? null : asString(row.seller_account),
      standardProductId: asString(row.standard_product_id),
    })), context);
  }

  public previewDraftProductStandardizations(
    draft: OrderDraft,
  ): DraftItemProductStandardization[] {
    const persisted = this.getDraft(draft.id);
    if (persisted.status !== 'awaiting_review') {
      throw new Error('该订单草稿已经处理');
    }
    if (!Array.isArray(draft.items) || draft.items.length > 200) {
      throw new Error('订单商品明细无效');
    }
    for (const item of draft.items) {
      if (
        typeof item.id !== 'string' || !item.id ||
        typeof item.sourceTitle !== 'string' || item.sourceTitle.length > 300 ||
        typeof item.sourceSpec !== 'string' || item.sourceSpec.length > 300
      ) {
        throw new Error('订单商品明细无效');
      }
    }
    const products = this.listStandardProducts();
    const workspace = this.requireWorkspace();
    const mappingContext: ProductMappingMatchContext = {
      platform: draft.platform,
      sellerAccount: draft.sellerAccount,
    };
    return draft.items.map((item) => {
      const mapping = this.matchedProductMapping(item, mappingContext);
      const exactId = mapping ? null : this.exactStandardProductId(item);
      const automaticProductId = mapping?.standardProductId ?? exactId;
      const automaticProduct = automaticProductId
        ? products.find(({ id }) => id === automaticProductId) ?? null
        : null;
      const previousManualRows = workspace.database.prepare(`
        SELECT standard_product_id, COUNT(*) AS correction_count
        FROM order_items
        WHERE standardization_source = 'manual'
          AND source_title = ? COLLATE NOCASE
          AND source_spec = ? COLLATE NOCASE
          AND standard_product_id IS NOT NULL
        GROUP BY standard_product_id
      `).all(item.sourceTitle, item.sourceSpec) as unknown as SqlRow[];
      const correctionCountByProductId = new Map(previousManualRows.map((row) => [
        asString(row.standard_product_id),
        asNumber(row.correction_count),
      ]));
      const candidates = automaticProduct
        ? []
        : products
          .map((product) => {
            const correctionCount = correctionCountByProductId.get(product.id) ?? 0;
            const score = correctionCount > 0
              ? 1
              : fuzzyProductSimilarity(item.sourceTitle, item.sourceSpec, product);
            return {
              product,
              reason: correctionCount > 0
                ? 'previous_manual_choice' as const
                : 'fuzzy' as const,
              score,
              mappingSuggested: correctionCount > 0,
            };
          })
          .filter(({ score }) => score >= PRODUCT_SIMILARITY_THRESHOLD)
          .sort((left, right) => right.score - left.score || (
            left.product.sku.localeCompare(right.product.sku, 'zh-CN')
          ))
          .slice(0, 5);
      return {
        draftItemId: item.id,
        sourceTitle: item.sourceTitle,
        sourceSpec: item.sourceSpec,
        automaticProduct,
        automaticSource: mapping ? 'mapping' : exactId ? 'exact' : null,
        automaticMappingScope: mapping?.scope ?? null,
        candidates,
      };
    });
  }

  private prepareProductStandardizations(
    items: readonly DraftItem[],
    confirmations: readonly ProductStandardizationConfirmation[] | undefined,
    mappingContext: ProductMappingMatchContext,
  ): Map<string, {
    standardProductId: string | null;
    source: ProductStandardizationSource | null;
    createMapping: boolean;
    matchedMappingId: string | null;
  }> {
    const choices = normalizeProductStandardizationConfirmations(confirmations);
    const itemById = new Map(items.map((item) => [item.id, item]));
    const choiceByItemId = new Map<string, ProductStandardizationConfirmation>();
    for (const choice of choices) {
      if (!itemById.has(choice.draftItemId) || choiceByItemId.has(choice.draftItemId)) {
        throw new Error('商品标准化确认目标无效');
      }
      if (choice.standardProductId !== null) this.getStandardProduct(choice.standardProductId);
      choiceByItemId.set(choice.draftItemId, choice);
    }
    const entries: Array<[
      string,
      {
        standardProductId: string | null;
        source: ProductStandardizationSource | null;
        createMapping: boolean;
        matchedMappingId: string | null;
      },
    ]> = items.map((item) => {
      const choice = choiceByItemId.get(item.id);
      if (choice) {
        return [item.id, {
          standardProductId: choice.standardProductId,
          source: choice.standardProductId ? 'manual' : null,
          createMapping: choice.createMapping,
          matchedMappingId: null,
        }];
      }
      const mapping = this.matchedProductMapping(item, mappingContext);
      if (mapping) {
        return [item.id, {
          standardProductId: mapping.standardProductId,
          source: 'mapping',
          createMapping: false,
          matchedMappingId: mapping.row.id,
        }];
      }
      const exactId = this.exactStandardProductId(item);
      return [item.id, {
        standardProductId: exactId,
        source: exactId ? 'exact' : null,
        createMapping: false,
        matchedMappingId: null,
      }];
    });
    return new Map(entries);
  }

  /**
   * 按当前账号适用范围建立商品映射并留建立事件；同范围同原文已指向同一
   * 标准商品时幂等跳过（返回 false），指向其他 SKU 时抛出冲突错误（规格 4.4）。
   */
  private insertProductMapping(
    item: Pick<RecognitionItem, 'sourceTitle' | 'sourceSpec'>,
    standardProductId: string,
    context: ProductMappingMatchContext,
    now: string,
    origin: ProductMappingOrigin,
  ): boolean {
    const workspace = this.requireWorkspace();
    const sourceTitleKey = normalizeProductText(item.sourceTitle);
    const sourceSpecKey = normalizeProductText(item.sourceSpec);
    const existing = workspace.database.prepare(`
      SELECT standard_product_id
      FROM product_mappings
      WHERE scope = 'current_account'
        AND platform = ?
        AND seller_account = ?
        AND source_title_key = ?
        AND source_spec_key = ?
        AND status = 'active'
    `).get(
      context.platform,
      context.sellerAccount,
      sourceTitleKey,
      sourceSpecKey,
    ) as SqlRow | undefined;
    if (existing) {
      if (asString(existing.standard_product_id) === standardProductId) return false;
      throw new Error(productMappingConflictMessage('current_account'));
    }
    const mappingId = randomUUID();
    workspace.database.prepare(`
      INSERT INTO product_mappings (
        id, source_title, source_spec, source_title_key, source_spec_key,
        standard_product_id, scope, platform, seller_account, origin, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'current_account', ?, ?, ?, ?, ?)
    `).run(
      mappingId,
      item.sourceTitle,
      item.sourceSpec,
      sourceTitleKey,
      sourceSpecKey,
      standardProductId,
      context.platform,
      context.sellerAccount,
      origin,
      now,
      now,
    );
    this.insertProductMappingEvent(
      mappingId,
      standardProductId,
      'created',
      null,
      {
        sourceTitle: item.sourceTitle,
        sourceSpec: item.sourceSpec,
        standardProductId,
        scope: 'current_account',
        platform: context.platform,
        sellerAccount: context.sellerAccount,
        status: 'active',
      },
      origin,
      '',
      now,
    );
    return true;
  }

  /**
   * 规格 4.4 映射冲突查询：校对确认等有订单上下文的入口在建立映射前，
   * 查找当前账号适用范围内相同规范化原文的有效映射，供三选一处理。
   */
  public findProductMappingConflict(input: unknown): ProductMappingView | null {
    const normalized = normalizeProductMappingConflictQueryInput(input);
    const conflict = this.findActiveProductMappingConflict({
      sourceTitleKey: normalizeProductText(normalized.sourceTitle),
      sourceSpecKey: normalizeProductText(normalized.sourceSpec),
      scope: 'current_account',
      platform: normalized.platform,
      sellerAccount: normalized.sellerAccount,
      excludeMappingId: null,
    });
    return conflict ? this.getProductMappingView(conflict.id) : null;
  }

  public getProductMappingStats(productId: string): ProductMappingStats {
    const workspace = this.requireWorkspace();
    const id = productId.trim();
    if (!id || id.length > 200) throw new Error('标准商品标识无效');
    this.getStandardProduct(id);
    const mappingRow = workspace.database.prepare(`
      SELECT COUNT(*) AS count
      FROM product_mappings
      WHERE standard_product_id = ? AND status = 'active'
    `).get(id) as SqlRow;
    // 已关联订单数、明细数与商品总数量由商品标准化关联事实投影，不另存计数副本。
    const linkedRow = workspace.database.prepare(`
      SELECT
        COUNT(DISTINCT order_id) AS order_count,
        COUNT(*) AS item_count,
        COALESCE(SUM(quantity), 0) AS total_quantity
      FROM order_items
      WHERE standard_product_id = ?
    `).get(id) as SqlRow;
    return {
      activeMappingCount: asNumber(mappingRow.count),
      linkedOrderCount: asNumber(linkedRow.order_count),
      linkedItemCount: asNumber(linkedRow.item_count),
      linkedTotalQuantity: asNumber(linkedRow.total_quantity),
    };
  }

  public listProductMappings(productId: string, search?: string): ProductMappingView[] {
    const workspace = this.requireWorkspace();
    const id = productId.trim();
    if (!id || id.length > 200) throw new Error('标准商品标识无效');
    this.getStandardProduct(id);
    const hitSummaries = this.projectProductMappingHits();
    const needle = search?.trim() ? normalizeProductText(search) : '';
    return (workspace.database.prepare(`
      SELECT mappings.*, products.sku AS target_sku, products.name AS target_name
      FROM product_mappings AS mappings
      JOIN standard_products AS products ON products.id = mappings.standard_product_id
      WHERE mappings.standard_product_id = ?
      ORDER BY mappings.created_at, mappings.id
    `).all(id) as unknown as SqlRow[])
      .map((row) => parseProductMappingViewRow(row, hitSummaries))
      .filter((view) => (
        !needle || view.sourceTitleKey.includes(needle) || view.sourceSpecKey.includes(needle)
      ));
  }

  public listProductMappingEvents(productId: string): ProductMappingEvent[] {
    const workspace = this.requireWorkspace();
    const id = productId.trim();
    if (!id || id.length > 200) throw new Error('标准商品标识无效');
    this.getStandardProduct(id);
    // 删除与更正保留历史：事件按标准商品归集，映射行删除后仍可追溯。
    return (workspace.database.prepare(`
      SELECT *
      FROM product_mapping_events
      WHERE standard_product_id = ?
      ORDER BY sequence
    `).all(id) as unknown as SqlRow[]).map(parseProductMappingEventRow);
  }

  public createProductMapping(productId: string, input: unknown): ProductMappingView {
    const workspace = this.requireWorkspace();
    const id = productId.trim();
    if (!id || id.length > 200) throw new Error('标准商品标识无效');
    this.getStandardProduct(id);
    const normalized = normalizeCreateProductMappingInput(input);
    const now = new Date().toISOString();
    return workspace.transaction(() => {
      const conflict = this.findActiveProductMappingConflict({
        sourceTitleKey: normalizeProductText(normalized.sourceTitle),
        sourceSpecKey: normalizeProductText(normalized.sourceSpec),
        scope: normalized.scope,
        platform: normalized.platform,
        sellerAccount: normalized.sellerAccount,
        excludeMappingId: null,
      });
      if (conflict) {
        if (conflict.standardProductId === id) return this.getProductMappingView(conflict.id);
        throw new Error(productMappingConflictMessage(normalized.scope));
      }
      const mappingId = randomUUID();
      workspace.database.prepare(`
        INSERT INTO product_mappings (
          id, source_title, source_spec, source_title_key, source_spec_key,
          standard_product_id, scope, platform, seller_account, status, origin,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'manual', ?, ?)
      `).run(
        mappingId,
        normalized.sourceTitle,
        normalized.sourceSpec,
        normalizeProductText(normalized.sourceTitle),
        normalizeProductText(normalized.sourceSpec),
        id,
        normalized.scope,
        normalized.platform,
        normalized.sellerAccount,
        now,
        now,
      );
      this.insertProductMappingEvent(
        mappingId,
        id,
        'created',
        null,
        {
          sourceTitle: normalized.sourceTitle,
          sourceSpec: normalized.sourceSpec,
          standardProductId: id,
          scope: normalized.scope,
          platform: normalized.platform,
          sellerAccount: normalized.sellerAccount,
          status: 'active',
        },
        'manual',
        '',
        now,
      );
      return this.getProductMappingView(mappingId);
    });
  }

  public correctProductMapping(mappingId: string, input: unknown): ProductMappingView {
    const workspace = this.requireWorkspace();
    const id = mappingId.trim();
    if (!id || id.length > 200) throw new Error('商品映射标识无效');
    const normalized = normalizeCorrectProductMappingInput(input);
    const now = new Date().toISOString();
    return workspace.transaction(() => {
      const current = this.getProductMappingRecord(id);
      if (current.status !== 'active') throw new Error('已停用的商品映射不能更正');
      const nextProductId = normalized.standardProductId ?? current.standardProductId;
      this.getStandardProduct(nextProductId);
      const scopeChanged = normalized.scope !== undefined;
      const next = {
        standardProductId: nextProductId,
        scope: scopeChanged ? normalized.scope as ProductMappingScope : current.scope,
        platform: scopeChanged ? normalized.platform ?? null : current.platform,
        sellerAccount: scopeChanged ? normalized.sellerAccount ?? null : current.sellerAccount,
      };
      if (
        next.standardProductId === current.standardProductId &&
        next.scope === current.scope &&
        next.platform === current.platform &&
        next.sellerAccount === current.sellerAccount
      ) {
        throw new Error('商品映射未发生变化');
      }
      const conflict = this.findActiveProductMappingConflict({
        sourceTitleKey: current.sourceTitleKey,
        sourceSpecKey: current.sourceSpecKey,
        scope: next.scope,
        platform: next.platform,
        sellerAccount: next.sellerAccount,
        excludeMappingId: id,
      });
      if (conflict) throw new Error(productMappingConflictMessage(next.scope));
      // 规格 4.5：更正只影响以后的匹配，不改写已关联的历史订单。
      workspace.database.prepare(`
        UPDATE product_mappings
        SET
          standard_product_id = ?,
          scope = ?,
          platform = ?,
          seller_account = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        next.standardProductId,
        next.scope,
        next.platform,
        next.sellerAccount,
        now,
        id,
      );
      this.insertProductMappingEvent(
        id,
        next.standardProductId,
        'corrected',
        productMappingSnapshot(current),
        { ...productMappingSnapshot(current), ...next },
        'manual',
        normalized.reason,
        now,
      );
      return this.getProductMappingView(id);
    });
  }

  public disableProductMapping(mappingId: string, input: unknown): ProductMappingView {
    const workspace = this.requireWorkspace();
    const id = mappingId.trim();
    if (!id || id.length > 200) throw new Error('商品映射标识无效');
    const normalized = normalizeProductMappingReasonInput(input);
    const now = new Date().toISOString();
    return workspace.transaction(() => {
      const current = this.getProductMappingRecord(id);
      if (current.status === 'disabled') throw new Error('商品映射已停用');
      workspace.database.prepare(`
        UPDATE product_mappings
        SET status = 'disabled', updated_at = ?
        WHERE id = ?
      `).run(now, id);
      this.insertProductMappingEvent(
        id,
        current.standardProductId,
        'disabled',
        productMappingSnapshot(current),
        { ...productMappingSnapshot(current), status: 'disabled' },
        'manual',
        normalized.reason,
        now,
      );
      return this.getProductMappingView(id);
    });
  }

  public deleteProductMapping(mappingId: string, input: unknown): void {
    const workspace = this.requireWorkspace();
    const id = mappingId.trim();
    if (!id || id.length > 200) throw new Error('商品映射标识无效');
    const normalized = normalizeProductMappingReasonInput(input);
    const now = new Date().toISOString();
    workspace.transaction(() => {
      const current = this.getProductMappingRecord(id);
      // 删除保留历史：行删除，事件留痕，product_mapping_events 是唯一审计源。
      this.insertProductMappingEvent(
        id,
        current.standardProductId,
        'deleted',
        productMappingSnapshot(current),
        null,
        'manual',
        normalized.reason,
        now,
      );
      workspace.database.prepare('DELETE FROM product_mappings WHERE id = ?').run(id);
    });
  }

  /**
   * 规格 4.5：查找映射的历史候选——原文命中该映射、但当前关联指向其他 SKU 的
   * 活跃订单商品明细。映射变更本身不改写历史订单，批量更正必须先独立预览。
   */
  public previewProductMappingHistoryCandidates(
    mappingId: string,
  ): ProductMappingHistoryCandidatePreview {
    const workspace = this.requireWorkspace();
    const id = mappingId.trim();
    if (!id || id.length > 200) throw new Error('商品映射标识无效');
    const mapping = this.getProductMappingView(id);
    const targetProduct = this.getStandardProduct(mapping.standardProductId);
    const scopeCondition = mapping.scope === 'current_account'
      ? 'orders.platform = ? AND orders.seller_account = ?'
      : mapping.scope === 'current_platform'
        ? 'orders.platform = ?'
        : '1 = 1';
    const scopeParams: string[] = [];
    if (mapping.scope !== 'workspace') scopeParams.push(mapping.platform as string);
    if (mapping.scope === 'current_account') {
      scopeParams.push(mapping.sellerAccount as string);
    }
    const rows = workspace.database.prepare(`
      SELECT
        items.id AS item_id,
        orders.id AS order_id,
        orders.platform_order_number AS order_number,
        orders.system_order_number AS system_order_number,
        orders.revision AS order_revision,
        orders.fulfillment_status AS fulfillment_status,
        orders.platform AS order_platform,
        orders.seller_account AS order_seller_account,
        items.position AS position,
        items.quantity AS quantity,
        items.source_title AS source_title,
        items.source_spec AS source_spec,
        items.standardization_source AS standardization_source,
        items.standard_product_id AS before_product_id,
        before_products.sku AS before_sku,
        EXISTS (
          SELECT 1
          FROM aftersales_case_items AS case_items
          JOIN shipment_package_items AS shipment_items
            ON shipment_items.id = case_items.shipment_package_item_id
          WHERE shipment_items.order_id = orders.id
        ) AS has_aftersales
      FROM order_items AS items
      JOIN original_orders AS orders ON orders.id = items.order_id
      JOIN standard_products AS before_products
        ON before_products.id = items.standard_product_id
      WHERE orders.lifecycle_status = 'active'
        AND items.standard_product_id IS NOT NULL
        AND items.standard_product_id <> ?
        AND ${scopeCondition}
    `).all(targetProduct.id, ...scopeParams) as unknown as SqlRow[];
    // 映射优先级：账号 > 平台 > 工作区。被更高优先级同原文有效映射接管的明细
    // 不算命中该映射（CONTEXT.md「历史候选」），不进入候选清单。
    const higherPriorityMappings = (workspace.database.prepare(`
      SELECT scope, platform, seller_account
      FROM product_mappings
      WHERE source_title_key = ? AND source_spec_key = ?
        AND status = 'active' AND id <> ?
    `).all(mapping.sourceTitleKey, mapping.sourceSpecKey, id) as unknown as SqlRow[])
      .filter((row) => asString(row.scope) !== 'workspace')
      .filter((row) => (
        mapping.scope === 'workspace' ||
        (mapping.scope === 'current_platform' && asString(row.scope) === 'current_account')
      ));
    const items: ProductMappingHistoryCandidateItem[] = rows
      .filter((row) => !higherPriorityMappings.some((shadow) => {
        const platform = asString(shadow.platform);
        if (asString(shadow.scope) === 'current_account') {
          return platform === asString(row.order_platform) &&
            asString(shadow.seller_account) === asString(row.order_seller_account);
        }
        return platform === asString(row.order_platform);
      }))
      .filter((row) => (
        normalizeProductText(asString(row.source_title)) === mapping.sourceTitleKey &&
        normalizeProductText(asString(row.source_spec)) === mapping.sourceSpecKey
      ))
      .map((row) => ({
        itemId: asString(row.item_id),
        orderId: asString(row.order_id),
        orderNumber: asString(row.order_number),
        systemOrderNumber: asString(row.system_order_number),
        orderRevision: asNumber(row.order_revision),
        position: asNumber(row.position),
        quantity: asNumber(row.quantity),
        beforeStandardProductId: asString(row.before_product_id),
        beforeStandardProductSku: asString(row.before_sku),
        standardizationSource: asProductStandardizationSource(row.standardization_source),
        shippedOrDelivered: ['partially_shipped', 'shipped', 'delivered'].includes(
          asString(row.fulfillment_status),
        ),
        hasAftersales: asNumber(row.has_aftersales) === 1,
      }))
      .sort((left, right) => (
        left.orderId.localeCompare(right.orderId) || left.position - right.position
      ));
    const orderIds = new Set(items.map((item) => item.orderId));
    const shippedOrderIds = new Set(
      items.filter((item) => item.shippedOrDelivered).map((item) => item.orderId),
    );
    const aftersalesOrderIds = new Set(
      items.filter((item) => item.hasAftersales).map((item) => item.orderId),
    );
    return {
      mapping,
      targetProduct,
      items,
      orderCount: orderIds.size,
      itemCount: items.length,
      totalQuantity: items.reduce((total, item) => total + item.quantity, 0),
      shippedOrderCount: shippedOrderIds.size,
      aftersalesOrderCount: aftersalesOrderIds.size,
    };
  }

  /**
   * 规格 4.6：带原因的批量商品身份更正。只改标准商品归属，不改来源原文、数量、
   * 金额与发货、退款等业务事实；逐条写不可变商品身份更正事件。
   */
  public relinkProductMappingHistoryCandidates(
    mappingId: string,
    input: unknown,
  ): ProductMappingHistoryCorrectionResult {
    const workspace = this.requireWorkspace();
    const id = mappingId.trim();
    if (!id || id.length > 200) throw new Error('商品映射标识无效');
    const normalized = normalizeProductMappingHistoryCorrectionInput(input);
    const now = new Date().toISOString();
    const correctionId = randomUUID();
    return workspace.transaction(() => {
      const preview = this.previewProductMappingHistoryCandidates(id);
      const candidateById = new Map(preview.items.map((item) => [item.itemId, item] as const));
      // 重放守卫：映射或订单在预览后变化时候选集合随之变化，整批拒绝。
      if (normalized.itemIds.some((itemId) => !candidateById.has(itemId))) {
        throw new Error('商品映射或订单已变化，请刷新预览后重试');
      }
      const selected = normalized.itemIds.map((itemId) => candidateById.get(itemId)!);
      const revisionByOrderId = new Map(
        selected.map((item) => [item.orderId, item.orderRevision] as const),
      );
      for (const { orderId, revision } of normalized.expectedOrderRevisions) {
        if (revisionByOrderId.get(orderId) !== revision) {
          throw new Error('订单已在其他操作中更新，请刷新后重试');
        }
      }
      for (const orderId of revisionByOrderId.keys()) {
        if (!normalized.expectedOrderRevisions.some((entry) => entry.orderId === orderId)) {
          throw new Error('订单版本无效，请刷新后重试');
        }
      }
      const changesByOrderId = new Map<string, OrderFieldChange[]>();
      const insertCorrectionEvent = workspace.database.prepare(`
        INSERT INTO product_identity_correction_events (
          id, correction_id, mapping_id, order_id, order_item_id,
          before_standard_product_id, after_standard_product_id,
          before_standard_product_sku, after_standard_product_sku,
          reason, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of selected) {
        workspace.database.prepare(`
          UPDATE order_items
          SET standard_product_id = ?, standardization_source = 'manual'
          WHERE id = ?
        `).run(preview.targetProduct.id, item.itemId);
        const orderChanges = changesByOrderId.get(item.orderId) ?? [];
        changesByOrderId.set(item.orderId, orderChanges);
        orderChanges.push({
          path: `items[${item.position}].standardProductSku`,
          before: item.beforeStandardProductSku,
          after: preview.targetProduct.sku,
        });
        if (item.standardizationSource !== 'manual') {
          orderChanges.push({
            path: `items[${item.position}].standardizationSource`,
            before: item.standardizationSource,
            after: 'manual',
          });
        }
        insertCorrectionEvent.run(
          randomUUID(),
          correctionId,
          id,
          item.orderId,
          item.itemId,
          item.beforeStandardProductId,
          preview.targetProduct.id,
          item.beforeStandardProductSku,
          preview.targetProduct.sku,
          normalized.reason,
          now,
          now,
        );
      }
      for (const [orderId, orderChanges] of changesByOrderId) {
        const expectedRevision = revisionByOrderId.get(orderId)!;
        const updated = workspace.database.prepare(`
          UPDATE original_orders
          SET revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ?
        `).run(now, orderId, expectedRevision);
        if (updated.changes !== 1) {
          throw new Error('订单已在其他操作中更新，请刷新后重试');
        }
        const eventId = randomUUID();
        workspace.database.prepare(`
          INSERT INTO order_change_events (
            id, order_id, source_snapshot_id, source,
            base_revision, result_revision, created_at
          ) VALUES (?, ?, NULL, 'manual_edit', ?, ?, ?)
        `).run(eventId, orderId, expectedRevision, expectedRevision + 1, now);
        const insertChange = workspace.database.prepare(`
          INSERT INTO order_field_changes (
            id, event_id, field_path, before_json, after_json
          ) VALUES (?, ?, ?, ?, ?)
        `);
        for (const change of orderChanges) {
          insertChange.run(
            randomUUID(),
            eventId,
            change.path,
            JSON.stringify(change.before),
            JSON.stringify(change.after),
          );
        }
      }
      return {
        correctionId,
        appliedItemCount: selected.length,
        orderCount: revisionByOrderId.size,
        results: selected.map((item) => ({
          itemId: item.itemId,
          orderId: item.orderId,
          beforeStandardProductSku: item.beforeStandardProductSku,
          afterStandardProductSku: preview.targetProduct.sku,
        })),
      };
    });
  }

  private getProductMappingRecord(mappingId: string): ProductMappingRecord {
    const workspace = this.requireWorkspace();
    const row = workspace.database.prepare(`
      SELECT * FROM product_mappings WHERE id = ?
    `).get(mappingId) as SqlRow | undefined;
    if (!row) throw new Error('未找到商品映射');
    return parseProductMappingRecord(row);
  }

  private getProductMappingView(mappingId: string): ProductMappingView {
    const workspace = this.requireWorkspace();
    const hitSummaries = this.projectProductMappingHits();
    const row = workspace.database.prepare(`
      SELECT mappings.*, products.sku AS target_sku, products.name AS target_name
      FROM product_mappings AS mappings
      JOIN standard_products AS products ON products.id = mappings.standard_product_id
      WHERE mappings.id = ?
    `).get(mappingId) as SqlRow | undefined;
    if (!row) throw new Error('未找到商品映射');
    return parseProductMappingViewRow(row, hitSummaries);
  }

  private projectProductMappingHits(): ReadonlyMap<string, ProductMappingHitSummary> {
    const workspace = this.requireWorkspace();
    const facts = (workspace.database.prepare(`
      SELECT order_id, source_title, source_spec, standard_product_id, quantity
      FROM order_items
      WHERE standardization_source = 'mapping'
    `).all() as unknown as SqlRow[]).map((row) => ({
      orderId: asString(row.order_id),
      sourceTitle: asString(row.source_title),
      sourceSpec: asString(row.source_spec),
      standardProductId: asString(row.standard_product_id),
      quantity: asNumber(row.quantity),
    }));
    return summarizeProductMappingHits(facts);
  }

  private markProductMappingUsed(mappingId: string, now: string): void {
    this.requireWorkspace().database.prepare(
      'UPDATE product_mappings SET last_used_at = ? WHERE id = ?',
    ).run(now, mappingId);
  }

  private findActiveProductMappingConflict(query: {
    sourceTitleKey: string;
    sourceSpecKey: string;
    scope: ProductMappingScope;
    platform: string | null;
    sellerAccount: string | null;
    excludeMappingId: string | null;
  }): { id: string; standardProductId: string } | null {
    const workspace = this.requireWorkspace();
    const scopeCondition = query.scope === 'current_account'
      ? 'platform = ? AND seller_account = ?'
      : query.scope === 'current_platform'
        ? 'platform = ? AND seller_account IS NULL'
        : 'platform IS NULL AND seller_account IS NULL';
    const params: string[] = [];
    if (query.scope !== 'workspace') params.push(query.platform as string);
    if (query.scope === 'current_account') params.push(query.sellerAccount as string);
    params.push(query.sourceTitleKey, query.sourceSpecKey);
    const rows = workspace.database.prepare(`
      SELECT id, standard_product_id
      FROM product_mappings
      WHERE scope = ?
        AND ${scopeCondition}
        AND source_title_key = ?
        AND source_spec_key = ?
        AND status = 'active'
    `).all(query.scope, ...params) as unknown as SqlRow[];
    const conflict = rows.find((row) => asString(row.id) !== query.excludeMappingId);
    return conflict
      ? { id: asString(conflict.id), standardProductId: asString(conflict.standard_product_id) }
      : null;
  }

  private insertProductMappingEvent(
    mappingId: string,
    standardProductId: string,
    eventType: ProductMappingEventType,
    before: ProductMappingEventSnapshot | null,
    after: ProductMappingEventSnapshot | null,
    origin: ProductMappingOrigin,
    reason: string,
    now: string,
  ): void {
    this.requireWorkspace().database.prepare(`
      INSERT INTO product_mapping_events (
        id, mapping_id, standard_product_id, event_type, before_json, after_json,
        origin, reason, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      mappingId,
      standardProductId,
      eventType,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      origin,
      reason,
      now,
      now,
    );
  }

  private listShipmentCandidateOrders(): OriginalOrder[] {
    const workspace = this.requireWorkspace();
    const rows = workspace.database.prepare(`
      SELECT id
      FROM original_orders
      WHERE lifecycle_status = 'active'
        AND (
          fulfillment_status IN ('pending_shipment', 'partially_shipped')
          OR (
            fulfillment_status IN ('shipped', 'unknown')
            AND NOT EXISTS (
              SELECT 1
              FROM shipment_package_items
              WHERE shipment_package_items.order_id = original_orders.id
            )
          )
        )
        AND platform_transaction_status NOT IN ('cancelled', 'refunded')
        AND ${unreleasedPlanMemberGateSql('original_orders.id')}
      ORDER BY created_at, id
    `).all() as unknown as SqlRow[];
    return rows.flatMap((row) => {
      const order = this.getOrder(asString(row.id)).order;
      const items = order.items.flatMap((item) => {
        const shippedQuantity = this.activeShippedQuantity(item.id);
        const refundedQuantity = this.preShipmentRefundedQuantity(item.id);
        const remainingQuantity = Math.max(
          item.quantity - shippedQuantity - refundedQuantity,
          0,
        );
        return remainingQuantity > 0
          ? [{
            ...item,
            quantity: remainingQuantity,
            subtotalCents: item.unitPriceCents * remainingQuantity,
          }]
          : [];
      });
      return items.length > 0 ? [{ ...order, items }] : [];
    });
  }

  public queryShipmentGroups(): ShipmentGroupProjection {
    const workspace = this.requireWorkspace();
    const archivedOrderIds = new Set((workspace.database.prepare(`
      SELECT member_order_ids_json
      FROM shipment_group_archives
      WHERE status = 'partially_shipped'
    `).all() as unknown as SqlRow[]).flatMap((row) => parseStoredTextArray(
      asString(row.member_order_ids_json),
      '数据库发货组档案成员订单格式错误',
    )));
    const orders = this.listShipmentCandidateOrders().filter(
      ({ id }) => !archivedOrderIds.has(id),
    );
    const adjustmentState = replayShipmentGroupAdjustmentEvents(
      this.listShipmentGroupAdjustmentEvents(),
    );
    const orderById = new Map(orders.map((order) => [order.id, order]));
    const orderIdsByManualGroupId = new Map<string, string[]>();
    for (const order of orders) {
      if (!order.phoneNormalized.trim() || !order.addressNormalized.trim()) continue;
      const manualGroupId = adjustmentState.groupIdByOrderId.get(order.id);
      if (!manualGroupId) continue;
      const orderIds = orderIdsByManualGroupId.get(manualGroupId) ?? [];
      orderIds.push(order.id);
      orderIdsByManualGroupId.set(manualGroupId, orderIds);
    }
    const manualGroups = [...orderIdsByManualGroupId].flatMap(([id, orderIds]) => {
      const selectedRecipientOrderId =
        adjustmentState.selectedRecipientOrderIdByGroupId.get(id) ?? null;
      const selectedRecipientOrder = selectedRecipientOrderId && orderIds.includes(
        selectedRecipientOrderId,
      )
        ? orderById.get(selectedRecipientOrderId) ?? null
        : null;
      const matchKeyCount = new Set(orderIds.map((orderId) => {
        const order = orderById.get(orderId);
        return order ? shipmentMatchKeyIdentity(order) : '';
      })).size;
      if (matchKeyCount > 1 && !selectedRecipientOrder) return [];
      return [{
        id,
        orderIds,
        selectedRecipientOrder,
      }];
    });
    const projection = buildShipmentGroupProjection(orders, (matchKey, groupOrders) => (
      `shipment-group-${createHash('sha256')
        .update(JSON.stringify([
          shipmentMatchKeyIdentity(matchKey),
          groupOrders.reduce((earliest, order) => (
            order.createdAt < earliest.createdAt
            || (order.createdAt === earliest.createdAt && order.id < earliest.id)
              ? order
              : earliest
          )).id,
        ]))
        .digest('hex')
        .slice(0, 24)}`
    ), manualGroups);
    const repurchaseRankByOrderId = this.recipientService()
      .spendingProjection().byOrderId;
    return {
      ...projection,
      groups: projection.groups.map((group) => ({
        ...group,
        orders: group.orders.map((order) => ({
          ...order,
          repurchaseRank: repurchaseRankByOrderId.get(order.id)?.repurchaseRank ?? null,
        })),
      })),
    };
  }

  public queryShipmentGroupWorkbench(
    query: unknown = {},
    customFieldDefinitionIds: readonly string[] = [],
  ): ShipmentGroupWorkbenchResult {
    const definitions = this.listCustomFieldDefinitions();
    const groupDefinitions = definitions.filter(
      ({ granularity }) => granularity === 'shipment_group',
    );
    const normalizedQuery = normalizeShipmentGroupWorkbenchQuery(query, definitions);
    const requestedDefinitionIds = new Set(customFieldDefinitionIds.map((definitionId) => {
      const definition = groupDefinitions.find(({ id }) => id === definitionId);
      if (!definition) throw new Error('发货组自定义字段无效');
      return definition.id;
    }));
    if (normalizedQuery.customFieldFilter) {
      requestedDefinitionIds.add(normalizedQuery.customFieldFilter.definitionId);
    }
    if (normalizedQuery.customFieldSort) {
      requestedDefinitionIds.add(normalizedQuery.customFieldSort.definitionId);
    }

    const projection = this.queryShipmentGroups();
    const values = this.listShipmentGroupCustomFieldValues(
      projection.groups.map(({ id }) => id),
      [...requestedDefinitionIds],
      groupDefinitions,
    );
    return buildShipmentGroupWorkbench(
      projection,
      normalizedQuery,
      groupDefinitions.filter(({ id }) => requestedDefinitionIds.has(id)),
      values,
    );
  }

  public saveShipmentGroupCustomFieldValues(
    input: SaveShipmentGroupCustomFieldValuesInput,
  ): ShipmentGroupCustomFieldValue[] {
    const workspace = this.requireWorkspace();
    if (!input || typeof input !== 'object') {
      throw new Error('发货组自定义字段保存内容无效');
    }
    const shipmentGroupId = normalizeShipmentGroupIdentifier(input.shipmentGroupId);
    if (!Array.isArray(input.expectedMemberOrderIds) || input.expectedMemberOrderIds.length === 0) {
      throw new Error('发货组成员快照无效');
    }
    const expectedMemberOrderIds = input.expectedMemberOrderIds.map(
      (orderId) => normalizeShipmentGroupIdentifier(orderId),
    );
    if (new Set(expectedMemberOrderIds).size !== expectedMemberOrderIds.length) {
      throw new Error('发货组成员快照不能重复');
    }
    if (!Array.isArray(input.values)) {
      throw new Error('发货组自定义字段保存内容无效');
    }

    const group = this.queryShipmentGroups().groups.find(({ id }) => id === shipmentGroupId);
    const currentMemberIds = group?.orders.map(({ id }) => id).sort() ?? [];
    if (
      !group ||
      currentMemberIds.join('\n') !== [...expectedMemberOrderIds].sort().join('\n')
    ) {
      throw new Error('发货组已变化，请刷新后重试');
    }

    const definitions = this.listCustomFieldDefinitions().filter(
      ({ granularity }) => granularity === 'shipment_group',
    );
    const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
    const pending = input.values.map((entry) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error('发货组自定义字段保存内容无效');
      }
      const definitionId = normalizeShipmentGroupIdentifier(entry.definitionId);
      const definition = definitionsById.get(definitionId);
      if (!definition) throw new Error('发货组自定义字段无效');
      return {
        definition,
        value: entry.value === null
          ? null
          : normalizeCustomFieldValue(definition.type, entry.value, definition.options),
      };
    });
    if (new Set(pending.map(({ definition }) => definition.id)).size !== pending.length) {
      throw new Error('同一发货组自定义字段不能重复赋值');
    }

    workspace.transaction(() => {
      const now = new Date().toISOString();
      for (const entry of pending) {
        workspace.database.prepare(`
          INSERT INTO shipment_group_custom_field_values (
            id, definition_id, shipment_group_id, value_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (definition_id, shipment_group_id) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `).run(
          randomUUID(),
          entry.definition.id,
          shipmentGroupId,
          JSON.stringify(entry.value),
          now,
          now,
        );
      }

      const stored = this.listShipmentGroupCustomFieldValues(
        [shipmentGroupId],
        definitions.map(({ id }) => id),
        definitions,
      );
      const storedByDefinition = new Map(stored.map((entry) => [entry.definitionId, entry.value]));
      for (const definition of definitions) {
        if (!definition.required) continue;
        const value = storedByDefinition.has(definition.id)
          ? storedByDefinition.get(definition.id)
          : definition.defaultValue;
        if (isMissingCustomFieldValue(value)) {
          throw new Error(`必填自定义字段“${definition.name}”不能为空`);
        }
      }
    });

    return this.listShipmentGroupCustomFieldValues(
      [shipmentGroupId],
      definitions.map(({ id }) => id),
      definitions,
    );
  }

  public confirmShipment(input: unknown): ShipmentConfirmationResult {
    const prepared = normalizeConfirmShipmentInput(input);
    const projection = this.queryShipmentGroups();
    const workspace = this.requireWorkspace();
    const expectedOrderIds = new Set(
      prepared.expectedRemainingItems.map(({ orderId }) => orderId),
    );
    const partiallyShippedArchiveRows = workspace.database.prepare(`
      SELECT *
      FROM shipment_group_archives
      WHERE status = 'partially_shipped'
      ORDER BY created_at DESC, id DESC
    `).all() as unknown as SqlRow[];
    const existingArchiveRow = prepared.archiveId
      ? partiallyShippedArchiveRows.find((row) => asString(row.id) === prepared.archiveId)
      : undefined;
    if (prepared.archiveId && !existingArchiveRow) {
      throw new Error('发货组档案已变化，请刷新后重试');
    }
    const claimedOrderIds = new Set(partiallyShippedArchiveRows.flatMap((row) => (
      parseStoredTextArray(
        asString(row.member_order_ids_json),
        '数据库发货组档案成员订单格式错误',
      )
    )));
    const existingMemberOrderIds = existingArchiveRow
      ? new Set(parseStoredTextArray(
        asString(existingArchiveRow.member_order_ids_json),
        '数据库发货组档案成员订单格式错误',
      ))
      : null;
    if (existingMemberOrderIds && [...expectedOrderIds].some(
      (orderId) => !existingMemberOrderIds.has(orderId),
    )) {
      throw new Error('本次商品不属于所选发货组档案');
    }
    const group = prepared.archiveId
      ? null
      : projection.groups.find(({ id }) => id === prepared.groupId) ?? null;
    if (!prepared.archiveId && !group) throw new Error('发货组已变化，请刷新后重试');
    const shipmentOrders = existingArchiveRow
      ? this.listShipmentCandidateOrders().filter(({ id }) => existingMemberOrderIds?.has(id))
      : group?.orders.filter(({ id }) => !claimedOrderIds.has(id)) ?? [];
    const remainingByItemId = new Map(shipmentOrders.flatMap((order) => (
      order.items.map((item) => [item.id, { order, item }] as const)
    )));
    assertExpectedShipmentItems(prepared.expectedRemainingItems, remainingByItemId);
    const allocatedByItemId = new Map<string, number>();
    for (const shipmentPackage of prepared.packages) {
      const packageItemIds = new Set<string>();
      for (const item of shipmentPackage.items) {
        const remaining = remainingByItemId.get(item.orderItemId);
        if (!remaining || remaining.order.id !== item.orderId) {
          throw new Error('包裹中包含不属于当前发货组的商品');
        }
        if (packageItemIds.has(item.orderItemId)) {
          throw new Error('同一包裹中的商品不能重复登记');
        }
        packageItemIds.add(item.orderItemId);
        const allocated = (allocatedByItemId.get(item.orderItemId) ?? 0) + item.quantity;
        if (allocated > remaining.item.quantity) {
          throw new Error('实际发出数量不能超过当前剩余待发数量');
        }
        allocatedByItemId.set(item.orderItemId, allocated);
      }
    }
    const now = new Date().toISOString();
    const recordId = randomUUID();
    const sourceOrderById = new Map(shipmentOrders.map(({ id }) => (
      [id, this.getOrder(id).order] as const
    )));
    const archiveId = prepared.archiveId ?? randomUUID();
    const allocatedQuantity = [...allocatedByItemId.values()].reduce(
      (total, quantity) => total + quantity,
      0,
    );
    const shipmentGroupQuantity = shipmentOrders.flatMap(({ items }) => items)
      .reduce((total, item) => total + item.quantity, 0);
    const previouslyShippedQuantity = existingArchiveRow
      ? this.activeShippedQuantityForArchive(archiveId)
      : 0;
    const archiveTotalQuantity = existingArchiveRow
      ? asNumber(existingArchiveRow.total_quantity)
      : shipmentGroupQuantity;
    if (previouslyShippedQuantity + allocatedQuantity > archiveTotalQuantity) {
      throw new Error('实际发出数量不能超过发货组建档数量');
    }
    const archiveFullyShipped = (
      previouslyShippedQuantity + allocatedQuantity === archiveTotalQuantity
    );
    const selectedRecipientOrderId = group?.selectedRecipientOrderId ?? null;
    const currentRecipientSource = shipmentOrders.find(({ id }) => (
      id === selectedRecipientOrderId
    )) ?? shipmentOrders[0];
    const recipientSource = existingArchiveRow
      ? {
        recipient: asString(existingArchiveRow.recipient),
        phone: asString(existingArchiveRow.phone),
        phoneNormalized: asString(existingArchiveRow.phone_normalized),
        addressOriginal: asString(existingArchiveRow.address_original),
        addressNormalized: asString(existingArchiveRow.address_normalized),
      }
      : currentRecipientSource;
    if (!recipientSource) throw new Error('发货组没有可确认的成员订单');
    const sourceGroupId = existingArchiveRow
      ? asString(existingArchiveRow.source_group_id)
      : asString(group?.id);
    workspace.transaction(() => {
      if (!existingArchiveRow) {
        workspace.database.prepare(`
          INSERT INTO shipment_group_archives (
            id, source_group_id, status,
            recipient, phone, phone_normalized,
            address_original, address_normalized,
            member_order_ids_json, member_recipient_snapshots_json,
            total_quantity, created_at, fully_shipped_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          archiveId,
          sourceGroupId,
          archiveFullyShipped ? 'fully_shipped' : 'partially_shipped',
          recipientSource.recipient,
          recipientSource.phone,
          recipientSource.phoneNormalized,
          recipientSource.addressOriginal,
          recipientSource.addressNormalized,
          JSON.stringify(shipmentOrders.map(({ id }) => id).sort()),
          JSON.stringify(shipmentOrders.map((order) => ({
            orderId: order.id,
            recipient: order.recipient,
            phone: order.phone,
            addressOriginal: order.addressOriginal,
          })).sort((left, right) => left.orderId.localeCompare(right.orderId))),
          archiveTotalQuantity,
          now,
          archiveFullyShipped ? now : null,
          now,
        );
        workspace.database.prepare(`
          DELETE FROM shipment_group_custom_field_values
          WHERE shipment_group_id = ?
        `).run(sourceGroupId);
      } else if (archiveFullyShipped) {
        workspace.database.prepare(`
          UPDATE shipment_group_archives
          SET status = 'fully_shipped', fully_shipped_at = ?, updated_at = ?
          WHERE id = ? AND status = 'partially_shipped'
        `).run(now, now, archiveId);
      }
      workspace.database.prepare(`
        INSERT INTO shipment_records (
          id, shipment_group_archive_id, source_group_id,
          recipient, phone, phone_normalized,
          address_original, address_normalized, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        archiveId,
        sourceGroupId,
        recipientSource.recipient,
        recipientSource.phone,
        recipientSource.phoneNormalized,
        recipientSource.addressOriginal,
        recipientSource.addressNormalized,
        now,
      );
      const allocatedOrderIds = new Set(prepared.packages.flatMap((shipmentPackage) => (
        shipmentPackage.items.map((item) => item.orderId)
      )));
      const insertOrderSnapshot = workspace.database.prepare(`
        INSERT INTO shipment_record_order_snapshots (
          id, shipment_record_id, order_id,
          order_number, seller_account, buyer_nickname,
          recipient, phone, address_original,
          amount_cents, revision, readable_order_number, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const readableNumberByOrderId = this.recipientService().readableOrderNumbers(
        [...allocatedOrderIds],
      );
      for (const orderId of allocatedOrderIds) {
        const sourceOrder = sourceOrderById.get(orderId);
        if (!sourceOrder) throw new Error('发货订单来源已变化，请刷新后重试');
        insertOrderSnapshot.run(
          randomUUID(),
          recordId,
          sourceOrder.id,
          sourceOrder.orderNumber,
          sourceOrder.sellerAccount,
          sourceOrder.buyerNickname,
          sourceOrder.recipient,
          sourceOrder.phone,
          sourceOrder.addressOriginal,
          sourceOrder.amountCents,
          sourceOrder.revision,
          readableNumberByOrderId.get(orderId) ?? null,
          now,
        );
      }
      for (const [packagePosition, shipmentPackage] of prepared.packages.entries()) {
        const packageId = randomUUID();
        workspace.database.prepare(`
          INSERT INTO shipment_packages (
            id, shipment_record_id, position,
            shipping_carrier, tracking_number, revision, created_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?)
        `).run(
          packageId,
          recordId,
          packagePosition,
          shipmentPackage.shippingCarrier,
          shipmentPackage.trackingNumber,
          now,
        );
        for (const [itemPosition, allocation] of shipmentPackage.items.entries()) {
          const source = remainingByItemId.get(allocation.orderItemId);
          if (!source) throw new Error('包裹商品来源已变化，请刷新后重试');
          const sourceItem = sourceOrderById.get(source.order.id)?.items.find(
            ({ id }) => id === allocation.orderItemId,
          );
          if (!sourceItem) throw new Error('包裹商品来源已变化，请刷新后重试');
          workspace.database.prepare(`
            INSERT INTO shipment_package_items (
              id, package_id, position,
              order_id, source_order_item_id,
              order_number, seller_account, buyer_nickname,
              source_title, source_spec,
              unit_price_cents, source_item_quantity,
              quantity, subtotal_cents, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            packageId,
            itemPosition,
            source.order.id,
            source.item.id,
            source.order.orderNumber,
            source.order.sellerAccount,
            source.order.buyerNickname,
            sourceItem.sourceTitle,
            sourceItem.sourceSpec,
            sourceItem.unitPriceCents,
            sourceItem.quantity,
            allocation.quantity,
            sourceItem.unitPriceCents * allocation.quantity,
            now,
          );
        }
      }
      for (const orderId of new Set(prepared.packages.flatMap((shipmentPackage) => (
        shipmentPackage.items.map((item) => item.orderId)
      )))) {
        this.synchronizeShipmentOrderFulfillment(orderId, now);
      }
      this.inventoryLedgerService().recordShipmentDispatchFact({
        shipmentRecordId: recordId,
        sourceType: 'shipment_dispatch',
        occurredAt: now,
        reason: '订单实际发出',
      });
    });
    const record = this.getShipmentRecord(recordId);
    return {
      record,
      archive: this.getShipmentGroupArchive(record.archiveId),
      projection: this.queryShipmentGroups(),
    };
  }

  public queryShipmentRecords(): ShipmentRecord[] {
    const workspace = this.requireWorkspace();
    const rows = workspace.database.prepare(`
      SELECT id
      FROM shipment_records
      ORDER BY created_at DESC, id DESC
    `).all() as unknown as SqlRow[];
    return rows.map((row) => this.getShipmentRecord(asString(row.id)));
  }

  public queryShipmentGroupArchives(): ShipmentGroupArchive[] {
    const workspace = this.requireWorkspace();
    const shipmentCandidateOrders = this.listShipmentCandidateOrders();
    const rows = workspace.database.prepare(`
      SELECT *
      FROM shipment_group_archives
      ORDER BY created_at DESC, id DESC
    `).all() as unknown as SqlRow[];
    return rows.map((row): ShipmentGroupArchive => {
      const archiveId = asString(row.id);
      const recordRows = workspace.database.prepare(`
        SELECT id
        FROM shipment_records
        WHERE shipment_group_archive_id = ?
        ORDER BY created_at DESC, id DESC
      `).all(archiveId) as unknown as SqlRow[];
      const records = recordRows.map((recordRow) => (
        this.getShipmentRecord(asString(recordRow.id))
      ));
      const sourceGroupId = asString(row.source_group_id);
      const orderIds = parseStoredShipmentArchiveOrderIds(
        asString(row.member_order_ids_json),
        '数据库发货组档案成员订单格式错误',
      );
      const orderIdSet = new Set(orderIds);
      const recipientSnapshotByOrderId = new Map(
        parseStoredShipmentArchiveRecipientSnapshots(
          asString(row.member_recipient_snapshots_json),
          '数据库发货组档案成员收货快照格式错误',
        ).map((snapshot) => [snapshot.orderId, snapshot] as const),
      );
      if (
        recipientSnapshotByOrderId.size !== orderIdSet.size ||
        orderIds.some((orderId) => !recipientSnapshotByOrderId.has(orderId))
      ) {
        throw new Error('数据库发货组档案成员收货快照与成员订单不一致');
      }
      const currentMemberOrders = orderIds.map((orderId) => this.getOrder(orderId).order)
        .sort((left, right) => (
          left.orderNumber.localeCompare(right.orderNumber) || left.id.localeCompare(right.id)
        ));
      const shippedQuantity = this.activeShippedQuantityForArchive(archiveId);
      const totalQuantity = asNumber(row.total_quantity);
      const remainingQuantity = Math.max(totalQuantity - shippedQuantity, 0);
      const status = remainingQuantity > 0
        ? 'partially_shipped'
        : 'fully_shipped';
      const remainingGroup = status === 'partially_shipped'
        ? buildFixedMemberShipmentGroup(
          shipmentCandidateOrders.filter(({ id }) => orderIdSet.has(id)),
          `shipment-archive-${archiveId}`,
          {
            recipient: asString(row.recipient),
            phone: asString(row.phone),
            phoneNormalized: asString(row.phone_normalized),
            addressOriginal: asString(row.address_original),
            addressNormalized: asString(row.address_normalized),
          },
        )
        : null;
      const remainingOrderIds = new Set(remainingGroup?.orders.map(({ id }) => id) ?? []);
      const memberOrders = currentMemberOrders.map((order) => ({
        orderId: order.id,
        orderNumber: order.orderNumber,
        hasRemainingShipment: remainingOrderIds.has(order.id),
      }));
      const recipientDifferences = currentMemberOrders.flatMap((order) => {
        const snapshot = recipientSnapshotByOrderId.get(order.id);
        if (!snapshot) throw new Error('数据库发货组档案成员收货快照缺失');
        const fields: Array<'recipient' | 'phone' | 'address'> = [];
        if (order.recipient !== snapshot.recipient) fields.push('recipient');
        if (order.phoneNormalized !== normalizePhone(snapshot.phone)) fields.push('phone');
        if (order.addressNormalized !== normalizeAddress(snapshot.addressOriginal)) {
          fields.push('address');
        }
        return fields.length > 0
          ? [{
            orderId: order.id,
            orderNumber: order.orderNumber,
            fields,
          }]
          : [];
      });
      const orderNumbers = memberOrders.map(({ orderNumber }) => orderNumber);
      return {
        id: archiveId,
        sourceGroupId,
        status,
        recipient: asString(row.recipient),
        phone: asString(row.phone),
        phoneNormalized: asString(row.phone_normalized),
        addressOriginal: asString(row.address_original),
        addressNormalized: asString(row.address_normalized),
        orderIds,
        orderNumbers,
        memberOrders,
        recipientDifferences,
        shippedQuantity,
        remainingQuantity,
        totalQuantity,
        remainingGroup: status === 'partially_shipped' ? remainingGroup : null,
        records,
        createdAt: asString(row.created_at),
        fullyShippedAt: status === 'partially_shipped'
          ? null
          : row.fully_shipped_at === null
            ? asString(row.updated_at)
            : asString(row.fully_shipped_at),
      };
    });
  }

  private getShipmentGroupArchive(archiveId: string): ShipmentGroupArchive {
    const archive = this.queryShipmentGroupArchives().find(({ id }) => id === archiveId);
    if (!archive) throw new Error('发货组档案不存在');
    return archive;
  }

  private activeShippedQuantityForArchive(archiveId: string): number {
    const workspace = this.requireWorkspace();
    const row = workspace.database.prepare(`
      SELECT COALESCE(SUM(items.quantity), 0) AS quantity
      FROM shipment_package_items AS items
      JOIN shipment_packages AS packages ON packages.id = items.package_id
      JOIN shipment_records AS records ON records.id = packages.shipment_record_id
      LEFT JOIN shipment_package_cancellation_events AS cancellations
        ON cancellations.package_id = packages.id
      WHERE records.shipment_group_archive_id = ?
        AND cancellations.id IS NULL
    `).get(archiveId) as SqlRow;
    return asNumber(row.quantity);
  }

  public cancelShipmentPackages(input: unknown): ShipmentCancellationResult {
    const prepared = normalizeCancelShipmentPackagesInput(input);
    const record = this.getShipmentRecord(prepared.recordId);
    if (record.status === 'voided') throw new Error('发货记录已经作废');
    const packageById = new Map(record.packages.map((shipmentPackage) => (
      [shipmentPackage.id, shipmentPackage] as const
    )));
    const packages = prepared.packageIds.map((packageId) => {
      const shipmentPackage = packageById.get(packageId);
      if (!shipmentPackage) throw new Error('所选包裹不属于当前发货记录');
      if (shipmentPackage.status === 'cancelled') throw new Error('所选包裹已经撤销');
      if (shipmentPackage.carrierAcceptedAt !== null
        || shipmentPackage.logisticsStatus === 'delivered'
        || shipmentPackage.logisticsStatus === 'returned') {
        throw new Error('包裹已交寄，请走拦截或后续物流处置');
      }
      return shipmentPackage;
    });
    const workspace = this.requireWorkspace();
    this.aftersalesService().assertPackagesCanBeCancelled(
      packages.map(({ id }) => id),
    );
    const now = new Date().toISOString();
    workspace.transaction(() => {
      const insertCancellation = workspace.database.prepare(`
        INSERT INTO shipment_package_cancellation_events (
          id, package_id, reason, created_at
        ) VALUES (?, ?, ?, ?)
      `);
      const cancellations: Array<{ cancellationEventId: string; packageId: string }> = [];
      for (const shipmentPackage of packages) {
        const cancellationEventId = randomUUID();
        cancellations.push({
          cancellationEventId,
          packageId: shipmentPackage.id,
        });
        insertCancellation.run(
          cancellationEventId,
          shipmentPackage.id,
          prepared.reason,
          now,
        );
      }
      const remainingRow = workspace.database.prepare(`
        SELECT COUNT(*) AS count
        FROM shipment_packages AS packages
        LEFT JOIN shipment_package_cancellation_events AS cancellations
          ON cancellations.package_id = packages.id
        WHERE packages.shipment_record_id = ?
          AND cancellations.id IS NULL
      `).get(record.id) as SqlRow;
      if (asNumber(remainingRow.count) === 0) {
        workspace.database.prepare(`
          INSERT INTO shipment_record_void_events (
            id, shipment_record_id, reason, created_at
          ) VALUES (?, ?, ?, ?)
        `).run(randomUUID(), record.id, prepared.reason, now);
      }
      for (const orderId of new Set(packages.flatMap((shipmentPackage) => (
        shipmentPackage.items.map((item) => item.orderId)
      )))) {
        this.synchronizeShipmentOrderFulfillment(orderId, now);
      }
      const archiveQuantityRow = workspace.database.prepare(`
        SELECT total_quantity
        FROM shipment_group_archives
        WHERE id = ?
      `).get(record.archiveId) as SqlRow;
      const archivePartiallyShipped = (
        this.activeShippedQuantityForArchive(record.archiveId) <
          asNumber(archiveQuantityRow.total_quantity)
      );
      workspace.database.prepare(`
        UPDATE shipment_group_archives
        SET status = ?, fully_shipped_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        archivePartiallyShipped ? 'partially_shipped' : 'fully_shipped',
        archivePartiallyShipped ? null : now,
        now,
        record.archiveId,
      );
      this.aftersalesService().synchronizeCancelledReplacementShipment(
        record.id,
        packages.map(({ id }) => id),
        prepared.reason,
        now,
      );
      const isReplacementRecord = workspace.database.prepare(`
        SELECT 1 FROM aftersales_replacement_shipments WHERE shipment_record_id = ?
      `).get(record.id) !== undefined;
      for (const { cancellationEventId, packageId } of cancellations) {
        this.inventoryLedgerService().recordShipmentVoidFact({
          cancellationEventId,
          packageId,
          shipmentRecordId: record.id,
          dispatchSourceType: isReplacementRecord ? 'replacement_dispatch' : 'shipment_dispatch',
          occurredAt: now,
          reason: '未交寄撤销冲正',
        });
      }
    });
    const updatedRecord = this.getShipmentRecord(record.id);
    return {
      record: updatedRecord,
      archive: this.getShipmentGroupArchive(updatedRecord.archiveId),
      projection: this.queryShipmentGroups(),
    };
  }

  public correctShipmentPackageLogistics(
    input: unknown,
  ): ShipmentLogisticsCorrectionResult {
    const prepared = normalizeCorrectShipmentPackageLogisticsInput(input);
    const record = this.getShipmentRecord(prepared.recordId);
    if (record.status === 'voided') throw new Error('已作废的发货记录不能更正物流');
    const shipmentPackage = record.packages.find(({ id }) => id === prepared.packageId);
    if (!shipmentPackage) throw new Error('所选包裹不属于当前发货记录');
    if (shipmentPackage.status === 'cancelled') throw new Error('已撤销的包裹不能更正物流');
    if (shipmentPackage.revision !== prepared.expectedRevision) {
      throw new Error('包裹物流已在其他操作中更新，请刷新后重试');
    }
    const nextLogistics = prepareLogisticsCorrection({
      current: {
        shippingCarrier: shipmentPackage.shippingCarrier,
        trackingNumber: shipmentPackage.trackingNumber,
      },
      next: {
        shippingCarrier: prepared.shippingCarrier,
        trackingNumber: prepared.trackingNumber,
      },
      occurredAt: prepared.occurredAt,
      latestOccurredAt: shipmentPackage.timeline.at(-1)?.occurredAt
        ?? shipmentPackage.createdAt,
    });
    const now = new Date().toISOString();
    const workspace = this.requireWorkspace();
    workspace.transaction(() => {
      const updated = workspace.database.prepare(`
        UPDATE shipment_packages
        SET shipping_carrier = ?, tracking_number = ?, revision = revision + 1
        WHERE id = ? AND shipment_record_id = ? AND revision = ?
      `).run(
        nextLogistics.shippingCarrier,
        nextLogistics.trackingNumber,
        shipmentPackage.id,
        record.id,
        prepared.expectedRevision,
      );
      if (updated.changes !== 1) {
        throw new Error('包裹物流已在其他操作中更新，请刷新后重试');
      }
      workspace.database.prepare(`
        INSERT INTO shipment_package_logistics_change_events (
          id, package_id, base_revision, result_revision, reason,
          before_shipping_carrier, before_tracking_number,
          after_shipping_carrier, after_tracking_number, created_at
          , occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        shipmentPackage.id,
        shipmentPackage.revision,
        shipmentPackage.revision + 1,
        prepared.reason,
        shipmentPackage.shippingCarrier,
        shipmentPackage.trackingNumber,
        nextLogistics.shippingCarrier,
        nextLogistics.trackingNumber,
        now,
        prepared.occurredAt,
      );
    });
    const updatedRecord = this.getShipmentRecord(record.id);
    return {
      record: updatedRecord,
      archive: this.getShipmentGroupArchive(updatedRecord.archiveId),
      projection: this.queryShipmentGroups(),
    };
  }

  public updateShipmentPackageLogisticsStatus(
    input: unknown,
  ): ShipmentLogisticsStatusUpdateResult {
    const prepared = normalizeUpdateShipmentPackageLogisticsStatusInput(input);
    const record = this.getShipmentRecord(prepared.recordId);
    if (record.status === 'voided') throw new Error('已作废的发货记录不能更新物流状态');
    const shipmentPackage = record.packages.find(({ id }) => id === prepared.packageId);
    if (!shipmentPackage) throw new Error('所选包裹不属于当前发货记录');
    if (shipmentPackage.status === 'cancelled') throw new Error('已撤销的包裹不能更新物流状态');
    if (shipmentPackage.revision !== prepared.expectedRevision) {
      throw new Error('包裹物流已在其他操作中更新，请刷新后重试');
    }
    const physicalReceiptAt = [...shipmentPackage.timeline].reverse().find((event) => (
      event.kind === 'status_changed' && event.afterStatus === 'delivered'
    ))?.occurredAt ?? (shipmentPackage.logisticsStatus === 'delivered'
      ? shipmentPackage.createdAt
      : null);
    const statusChange = prepareLogisticsStatusChange({
      direction: 'outbound',
      currentStatus: shipmentPackage.logisticsStatus,
      nextStatus: prepared.logisticsStatus,
      carrierAcceptedAt: shipmentPackage.carrierAcceptedAt,
      physicalReceiptAt,
      carrierAcceptanceConfirmed: prepared.carrierAcceptanceConfirmed ?? false,
      occurredAt: prepared.occurredAt,
      latestOccurredAt: shipmentPackage.timeline.at(-1)?.occurredAt
        ?? shipmentPackage.createdAt,
    });
    if (
      shipmentPackage.logisticsStatus === prepared.logisticsStatus
      && shipmentPackage.carrierAcceptedAt === statusChange.carrierAcceptedAt
    ) {
      throw new Error('包裹物流状态没有变化');
    }
    const now = new Date().toISOString();
    const workspace = this.requireWorkspace();
    workspace.transaction(() => {
      const updated = workspace.database.prepare(`
        UPDATE shipment_packages
        SET logistics_status = ?, carrier_accepted_at = ?, revision = revision + 1
        WHERE id = ? AND shipment_record_id = ? AND revision = ?
      `).run(
        prepared.logisticsStatus,
        statusChange.carrierAcceptedAt,
        shipmentPackage.id,
        record.id,
        prepared.expectedRevision,
      );
      if (updated.changes !== 1) {
        throw new Error('包裹物流已在其他操作中更新，请刷新后重试');
      }
      workspace.database.prepare(`
        INSERT INTO shipment_package_logistics_status_events (
          id, package_id, base_revision, result_revision,
          before_status, after_status, reason, occurred_at, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        shipmentPackage.id,
        shipmentPackage.revision,
        shipmentPackage.revision + 1,
        shipmentPackage.logisticsStatus,
        prepared.logisticsStatus,
        prepared.reason,
        prepared.occurredAt,
        JSON.stringify({
          carrierAcceptedAt: statusChange.carrierAcceptedAt,
        }),
        now,
      );
      if (record.sourceRecordRole !== 'aftersales_replacement') {
        for (const orderId of new Set(shipmentPackage.items.map(({ orderId }) => orderId))) {
          this.synchronizeShipmentOrderFulfillment(orderId, now);
        }
      }
      this.aftersalesService().synchronizeReplacementShipment(record.id, now);
    });
    const updatedRecord = this.getShipmentRecord(record.id);
    return {
      record: updatedRecord,
      archive: this.getShipmentGroupArchive(updatedRecord.archiveId),
      projection: this.queryShipmentGroups(),
    };
  }

  public recordShipmentPackageLogisticsException(
    input: unknown,
  ): ShipmentLogisticsExceptionResult {
    const workspace = this.requireWorkspace();
    const prepared = normalizeRecordShipmentPackageLogisticsExceptionInput(input);
    const record = this.getShipmentRecord(prepared.recordId);
    if (record.status === 'voided') throw new Error('已作废的发货记录不能登记物流异常');
    const shipmentPackage = record.packages.find(({ id }) => id === prepared.packageId);
    if (!shipmentPackage) throw new Error('所选包裹不属于当前发货记录');
    if (shipmentPackage.status === 'cancelled') throw new Error('已撤销的包裹不能登记物流异常');
    if (prepared.exceptionType === 'lost') {
      const affectedItemIds = prepared.impact.scope === 'package'
        ? shipmentPackage.items.map(({ id }) => id)
        : prepared.impact.items.map(({ sourceItemId }) => sourceItemId);
      if (affectedItemIds.length > 0) {
        const placeholders = affectedItemIds.map(() => '?').join(', ');
        const returnedItem = workspace.database.prepare(`
          SELECT 1
          FROM aftersales_return_record_items
          WHERE shipment_package_item_id IN (${placeholders})
          LIMIT 1
        `).get(...affectedItemIds);
        if (returnedItem) {
          throw new Error('买家已交寄同一商品，不能再把原正向包裹普通登记为丢件');
        }
      }
    }
    const physicalReceiptAt = [...shipmentPackage.timeline].reverse().find((event) => (
      event.kind === 'status_changed' && event.afterStatus === 'delivered'
    ))?.occurredAt ?? (shipmentPackage.logisticsStatus === 'delivered'
      ? shipmentPackage.createdAt
      : null);
    this.logisticsExceptionService().openException({
      subject: { direction: 'outbound', packageId: shipmentPackage.id },
      expectedPackageRevision: prepared.expectedRevision,
      exceptionType: prepared.exceptionType,
      stage: prepared.stage,
      impact: prepared.impact,
      availableItems: shipmentPackage.items.map((item) => ({
        sourceItemId: item.id,
        quantity: item.quantity,
      })),
      evidence: {
        carrierAcceptedAt: shipmentPackage.carrierAcceptedAt,
        physicalReceiptAt,
        carrierConfirmedLoss: prepared.carrierConfirmedLoss ?? false,
      },
      occurredAt: prepared.occurredAt,
      reason: prepared.reason,
    });
    return this.shipmentLogisticsExceptionResult(record.id);
  }

  public progressShipmentPackageLogisticsException(
    input: unknown,
  ): ShipmentLogisticsExceptionResult {
    const prepared = normalizeProgressShipmentPackageLogisticsExceptionInput(input);
    const record = this.getShipmentRecord(prepared.recordId);
    if (record.status === 'voided') throw new Error('已作废的发货记录不能推进物流异常');
    const shipmentPackage = record.packages.find(({ id }) => id === prepared.packageId);
    if (!shipmentPackage) throw new Error('所选包裹不属于当前发货记录');
    if (shipmentPackage.status === 'cancelled') throw new Error('已撤销的包裹不能推进物流异常');
    const physicalReceiptAt = [...shipmentPackage.timeline].reverse().find((event) => (
      event.kind === 'status_changed' && event.afterStatus === 'delivered'
    ))?.occurredAt ?? (shipmentPackage.logisticsStatus === 'delivered'
      ? shipmentPackage.createdAt
      : null);
    this.logisticsExceptionService().progressException({
      subject: { direction: 'outbound', packageId: shipmentPackage.id },
      exceptionId: prepared.exceptionId,
      expectedExceptionRevision: prepared.expectedExceptionRevision,
      stage: prepared.stage,
      evidence: {
        carrierAcceptedAt: shipmentPackage.carrierAcceptedAt,
        physicalReceiptAt,
        carrierConfirmedLoss: prepared.carrierConfirmedLoss ?? false,
      },
      occurredAt: prepared.occurredAt,
      reason: prepared.reason,
    });
    return this.shipmentLogisticsExceptionResult(record.id);
  }

  public progressShipmentPackageCarrierClaim(
    input: unknown,
  ): ShipmentCarrierClaimProgressResult {
    const prepared = normalizeProgressShipmentPackageCarrierClaimInput(input);
    const record = this.getShipmentRecord(prepared.recordId);
    if (record.status === 'voided') throw new Error('已作废的发货记录不能处理承运索赔');
    const shipmentPackage = record.packages.find(({ id }) => id === prepared.packageId);
    if (!shipmentPackage) throw new Error('所选包裹不属于当前发货记录');
    if (shipmentPackage.status === 'cancelled') throw new Error('已撤销的包裹不能处理承运索赔');
    const subject = { direction: 'outbound' as const, packageId: shipmentPackage.id };
    const logistics = this.logisticsExceptionService();
    if (prepared.kind === 'open') {
      if (shipmentPackage.revision !== prepared.expectedRevision) {
        throw new Error('包裹物流已在其他操作中更新，请刷新后重试');
      }
      if (!shipmentPackage.currentException) {
        throw new Error('当前包裹没有可索赔的物流异常');
      }
      logistics.openClaim({
        subject,
        exception: shipmentPackage.currentException,
        latestOccurredAt: shipmentPackage.timeline.at(-1)?.occurredAt
          ?? shipmentPackage.createdAt,
        impact: shipmentPackage.currentException.impact,
        requestedAmountCents: prepared.requestedAmountCents,
        occurredAt: prepared.occurredAt,
        reason: prepared.reason,
      });
    } else if (prepared.kind === 'resolve') {
      logistics.resolveClaim({
        subject,
        expectedClaimRevision: prepared.expectedClaimRevision,
        outcome: prepared.outcome,
        approvedAmountCents: prepared.outcome === 'approved'
          ? prepared.approvedAmountCents as number
          : null,
        occurredAt: prepared.occurredAt,
        reason: prepared.reason,
      });
    } else {
      logistics.confirmCompensation({
        subject,
        expectedClaimRevision: prepared.expectedClaimRevision,
        amountCents: prepared.amountCents,
        occurredAt: prepared.occurredAt,
        note: prepared.note,
      });
    }
    const updatedRecord = this.getShipmentRecord(record.id);
    return {
      record: updatedRecord,
      archive: this.getShipmentGroupArchive(updatedRecord.archiveId),
      projection: this.queryShipmentGroups(),
    };
  }

  private shipmentLogisticsExceptionResult(recordId: string): ShipmentLogisticsExceptionResult {
    const updatedRecord = this.getShipmentRecord(recordId);
    return {
      record: updatedRecord,
      archive: this.getShipmentGroupArchive(updatedRecord.archiveId),
      projection: this.queryShipmentGroups(),
    };
  }

  public createAftersalesCase(input: unknown): AftersalesCase {
    return this.aftersalesService().create(input);
  }

  public changeAftersalesCaseWorkflowTemplate(input: unknown): AftersalesCase {
    return this.aftersalesService().changeWorkflowTemplate(input);
  }

  public queryAftersalesCases(input?: unknown): AftersalesCase[] {
    return this.aftersalesService().query(input);
  }

  public recordAftersalesWorkflowStepEvent(input: unknown): AftersalesCase {
    return this.aftersalesService().recordStepEvent(input);
  }

  public updateAftersalesCase(input: unknown): AftersalesCase {
    return this.aftersalesService().update(input);
  }

  public progressAftersalesCase(input: unknown): AftersalesCase {
    return this.aftersalesService().progress(input);
  }

  public queryFulfillmentPlans(input?: unknown): FulfillmentPlanView[] {
    return this.fulfillmentPlanService().query(input);
  }

  public createFulfillmentPlan(input: unknown): FulfillmentPlanView {
    return this.fulfillmentPlanService().create(input);
  }

  public addFulfillmentPlanOrders(input: unknown): FulfillmentPlanView {
    return this.fulfillmentPlanService().addOrders(input);
  }

  public removeFulfillmentPlanOrder(input: unknown): FulfillmentPlanView {
    return this.fulfillmentPlanService().removeOrder(input);
  }

  public releaseFulfillmentPlanOrders(input: unknown): FulfillmentPlanView {
    return this.fulfillmentPlanService().releaseOrders(input);
  }

  public updateFulfillmentPlan(input: unknown): FulfillmentPlanView {
    return this.fulfillmentPlanService().update(input);
  }

  public closeFulfillmentPlan(input: unknown): FulfillmentPlanView {
    return this.fulfillmentPlanService().close(input);
  }

  public confirmGroupFormation(input: unknown): FulfillmentPlanView {
    return this.fulfillmentPlanService().confirmFormation(input);
  }

  public queryFulfillmentPlanProgress(input: unknown): FulfillmentPlanProgressView {
    return this.fulfillmentPlanService().progress(input);
  }

  public queryFulfillmentPlanOrderCandidates(): OrderSummary[] {
    return this.queryOrders(
      { fulfillmentStatus: 'pending_shipment' },
      undefined,
      undefined,
      { excludeReleasedPlanMembers: true },
    ).orders;
  }

  public queryFulfillmentDemand(planId: unknown): FulfillmentDemandView {
    return this.fulfillmentDemandService().demand(planId);
  }

  public registerFulfillmentRefund(input: unknown): FulfillmentDemandView {
    return this.fulfillmentDemandService().registerRefund(input);
  }

  public createPurchaseSuggestion(input: unknown): FulfillmentDemandView {
    return this.fulfillmentDemandService().createSuggestion(input);
  }

  public confirmPurchaseSuggestion(input: unknown): FulfillmentDemandView {
    return this.fulfillmentDemandService().confirmSuggestion(input);
  }

  public cancelPurchaseSuggestion(input: unknown): FulfillmentDemandView {
    return this.fulfillmentDemandService().cancelSuggestion(input);
  }

  public queryInventory(): InventoryView {
    return this.inventoryLedgerService().view();
  }

  public queryAftersalesInventoryImpact(caseId: string): InventoryMovementView[] {
    return this.inventoryLedgerService().movementsForAftersalesCase(caseId);
  }

  public recordInventoryAdjustment(input: unknown): InventoryView {
    return this.inventoryLedgerService().recordAdjustment(input);
  }

  public recordInventoryInspection(input: unknown): InventoryView {
    return this.inventoryLedgerService().recordInspection(input);
  }

  public queryPurchases(): PurchaseView {
    return this.purchaseOrderService().view();
  }

  public queryFunds(): FundsView {
    return this.fundsService().view();
  }

  public queryFinanceFactsForSource(
    sourceType: FinanceSourceTypeName,
    sourceId: string,
  ): FinanceFactsForSource {
    return this.fundsService().factsForSource(sourceType, sourceId);
  }

  public queryFinanceFactsForAftersalesCase(caseId: string): FinanceFactsForSource {
    return this.fundsService().factsForAftersalesCase(caseId);
  }

  public queryFinanceFactsForShipmentRecord(recordId: string): FinanceFactsForSource {
    return this.fundsService().factsForShipmentRecord(recordId);
  }

  public queryProfitReport(): ProfitReportView {
    return this.profitService().report();
  }

  public recordPendingFinanceItem(input: unknown): FundsView {
    return this.fundsService().recordPendingItem(input);
  }

  public confirmPendingFinanceItem(input: unknown): FundsView {
    return this.fundsService().confirmPendingItem(input);
  }

  public cancelPendingFinanceItem(input: unknown): FundsView {
    return this.fundsService().cancelPendingItem(input);
  }

  public recordFinanceRecord(input: unknown): FundsView {
    return this.fundsService().recordDirectRecord(input);
  }

  public reverseFinanceRecord(input: unknown): FundsView {
    return this.fundsService().reverseRecord(input);
  }

  public createSupplier(input: unknown): PurchaseView {
    return this.purchaseOrderService().createSupplier(input);
  }

  public createPurchaseOrder(input: unknown): PurchaseView {
    return this.purchaseOrderService().createOrder(input);
  }

  public createPurchaseOrderFromSuggestion(input: unknown): PurchaseView {
    return this.purchaseOrderService().createOrderFromSuggestion(input);
  }

  public confirmPurchaseOrder(input: unknown): PurchaseView {
    return this.purchaseOrderService().confirmOrder(input);
  }

  public cancelPurchaseOrder(input: unknown): PurchaseView {
    return this.purchaseOrderService().cancelOrder(input);
  }

  public changePurchaseOrderItemQuantity(input: unknown): PurchaseView {
    return this.purchaseOrderService().changeOrderItemQuantity(input);
  }

  public changePurchaseOrderExpectedDate(input: unknown): PurchaseView {
    return this.purchaseOrderService().changeOrderExpectedDate(input);
  }

  public recordPurchaseArrival(input: unknown): PurchaseView {
    return this.purchaseOrderService().recordArrival(input);
  }

  public recordSupplierReturn(input: unknown): PurchaseView {
    return this.purchaseOrderService().recordSupplierReturn(input);
  }

  public queryRecipients(): RecipientView[] {
    return this.recipientService().queryRecipients();
  }

  public queryRecipientSummaries(): RecipientSummaryView[] {
    return this.recipientService().queryRecipientSummaries();
  }

  public queryRecipientOrders(input: unknown): OrderSummary[] {
    if (typeof input !== 'string' || !input.trim() || input.length > 200) {
      throw new Error('收件人标识无效');
    }
    const orderIds = this.recipientService().orderIdsForRecipient(input);
    if (orderIds.length === 0) return [];
    return this.queryOrders({ lifecycleStatus: 'all' }, undefined, orderIds).orders;
  }

  public mergeRecipients(input: unknown): RecipientSummaryView[] {
    return this.recipientService().mergeRecipients(input);
  }

  public readableOrderNumbers(input: unknown): Record<string, string | null> {
    if (!Array.isArray(input)) throw new Error('订单标识列表无效');
    const orderIds = [...new Set(input.map((value) => {
      if (typeof value !== 'string' || !value.trim() || value.length > 200) {
        throw new Error('订单标识无效');
      }
      return value;
    }))];
    return Object.fromEntries(this.recipientService().readableOrderNumbers(orderIds));
  }

  private getShipmentRecord(recordId: string): ShipmentRecord {
    const workspace = this.requireWorkspace();
    const row = workspace.database.prepare(`
      SELECT * FROM shipment_records WHERE id = ?
    `).get(recordId) as SqlRow | undefined;
    if (!row) throw new Error('发货记录不存在');
    const packageRows = workspace.database.prepare(`
      SELECT *
      FROM shipment_packages
      WHERE shipment_record_id = ?
      ORDER BY position, id
    `).all(recordId) as unknown as SqlRow[];
    const sourceOrderRows = workspace.database.prepare(`
      SELECT
        snapshots.*,
        orders.system_order_number AS system_order_number
      FROM shipment_record_order_snapshots AS snapshots
      JOIN original_orders AS orders ON orders.id = snapshots.order_id
      WHERE snapshots.shipment_record_id = ?
      ORDER BY snapshots.order_number, snapshots.order_id
    `).all(recordId) as unknown as SqlRow[];
    const liveReadableNumberByOrder = this.recipientService().readableOrderNumbers(
      sourceOrderRows
        .filter((row) => row.readable_order_number === null)
        .map((row) => asString(row.order_id)),
    );
    const sourceOrders = sourceOrderRows.map((sourceOrderRow): ShipmentSourceOrderSnapshot => ({
      orderId: asString(sourceOrderRow.order_id),
      systemOrderNumber: asString(sourceOrderRow.system_order_number),
      readableOrderNumber: sourceOrderRow.readable_order_number === null
        ? liveReadableNumberByOrder.get(asString(sourceOrderRow.order_id)) ?? null
        : asString(sourceOrderRow.readable_order_number),
      orderNumber: asString(sourceOrderRow.order_number),
      sellerAccount: asString(sourceOrderRow.seller_account),
      buyerNickname: asString(sourceOrderRow.buyer_nickname),
      recipient: asString(sourceOrderRow.recipient),
      phone: asString(sourceOrderRow.phone),
      addressOriginal: asString(sourceOrderRow.address_original),
      amountCents: asNumber(sourceOrderRow.amount_cents),
      revision: asNumber(sourceOrderRow.revision),
    }));
    const voidRow = workspace.database.prepare(`
      SELECT reason, created_at
      FROM shipment_record_void_events
      WHERE shipment_record_id = ?
    `).get(recordId) as SqlRow | undefined;
    const packages = packageRows.map((packageRow): ShipmentPackage => {
      const packageId = asString(packageRow.id);
      const cancellationRow = workspace.database.prepare(`
        SELECT reason, created_at
        FROM shipment_package_cancellation_events
        WHERE package_id = ?
      `).get(packageId) as SqlRow | undefined;
      const itemRows = workspace.database.prepare(`
        SELECT *
        FROM shipment_package_items
        WHERE package_id = ?
        ORDER BY position, id
      `).all(packageId) as unknown as SqlRow[];
      const changeRows = workspace.database.prepare(`
        SELECT *
        FROM shipment_package_logistics_change_events
        WHERE package_id = ?
        ORDER BY sequence
      `).all(packageId) as unknown as SqlRow[];
      const statusChangeRows = workspace.database.prepare(`
        SELECT *
        FROM shipment_package_logistics_status_events
        WHERE package_id = ?
        ORDER BY sequence
      `).all(packageId) as unknown as SqlRow[];
      const items = itemRows.map((itemRow): ShipmentPackageItem => ({
        id: asString(itemRow.id),
        orderId: asString(itemRow.order_id),
        orderItemId: asString(itemRow.source_order_item_id),
        orderNumber: asString(itemRow.order_number),
        sellerAccount: asString(itemRow.seller_account),
        buyerNickname: asString(itemRow.buyer_nickname),
        sourceTitle: asString(itemRow.source_title),
        sourceSpec: asString(itemRow.source_spec),
        unitPriceCents: asNumber(itemRow.unit_price_cents),
        sourceItemQuantity: asNumber(itemRow.source_item_quantity),
        quantity: asNumber(itemRow.quantity),
        subtotalCents: asNumber(itemRow.subtotal_cents),
      }));
      const timeline: ShipmentPackageTimelineEvent[] = [
        ...changeRows.map((changeRow): ShipmentPackageTimelineEvent => ({
          kind: 'logistics_corrected',
          baseRevision: asNumber(changeRow.base_revision),
          resultRevision: asNumber(changeRow.result_revision),
        reason: asString(changeRow.reason),
          before: {
            shippingCarrier: asString(changeRow.before_shipping_carrier),
            trackingNumber: asString(changeRow.before_tracking_number),
          },
        after: {
            shippingCarrier: asString(changeRow.after_shipping_carrier),
            trackingNumber: asString(changeRow.after_tracking_number),
        },
        occurredAt: asString(changeRow.occurred_at),
        createdAt: asString(changeRow.created_at),
        })),
        ...statusChangeRows.map((changeRow): ShipmentPackageTimelineEvent => ({
          kind: 'status_changed',
          baseRevision: asNumber(changeRow.base_revision),
          resultRevision: asNumber(changeRow.result_revision),
          beforeStatus: asShipmentLogisticsStatus(changeRow.before_status),
          afterStatus: asShipmentLogisticsStatus(changeRow.after_status),
          carrierAcceptedAt: parseShipmentStatusPayload(changeRow.payload_json)
            .carrierAcceptedAt,
          reason: asString(changeRow.reason),
          occurredAt: asString(changeRow.occurred_at),
          createdAt: asString(changeRow.created_at),
        })),
      ].sort((left, right) => (
        left.resultRevision - right.resultRevision ||
        left.createdAt.localeCompare(right.createdAt)
      ));
      const logisticsExceptions = this.logisticsExceptionService().getExceptions({
        direction: 'outbound',
        packageId,
      });
      return {
        id: packageId,
        position: asNumber(packageRow.position),
        status: cancellationRow ? 'cancelled' : 'active',
        logisticsStatus: asShipmentLogisticsStatus(packageRow.logistics_status),
        carrierAcceptedAt: packageRow.carrier_accepted_at === null
          ? null
          : asString(packageRow.carrier_accepted_at),
        shippingCarrier: asString(packageRow.shipping_carrier),
        trackingNumber: asString(packageRow.tracking_number),
        revision: asNumber(packageRow.revision),
        totalQuantity: items.reduce((total, item) => total + item.quantity, 0),
        items,
        cancellation: cancellationRow ? {
          reason: asString(cancellationRow.reason),
          createdAt: asString(cancellationRow.created_at),
        } : null,
        currentException: [...logisticsExceptions].reverse().find(({ stage }) => (
          stage !== 'resolved'
        )) as ShipmentPackage['currentException'] ?? null,
        logisticsExceptions,
        carrierClaim: this.logisticsExceptionService().getClaim({
          direction: 'outbound',
          packageId,
        }),
        timeline,
        createdAt: asString(packageRow.created_at),
      };
    });
    return {
      id: asString(row.id),
      sourceRecordRole: workspace.database.prepare(`
        SELECT 1 FROM aftersales_replacement_shipments WHERE shipment_record_id = ?
      `).get(recordId) ? 'aftersales_replacement' : 'initial',
      archiveId: asString(row.shipment_group_archive_id),
      sourceGroupId: asString(row.source_group_id),
      status: voidRow ? 'voided' : 'active',
      recipient: asString(row.recipient),
      phone: asString(row.phone),
      phoneNormalized: asString(row.phone_normalized),
      addressOriginal: asString(row.address_original),
      addressNormalized: asString(row.address_normalized),
      totalQuantity: packages.reduce((total, shipmentPackage) => (
        total + shipmentPackage.totalQuantity
      ), 0),
      packages,
      sourceOrders,
      sourceDifferences: this.shipmentSourceDifferences(sourceOrders, packages),
      voiding: voidRow ? {
        reason: asString(voidRow.reason),
        createdAt: asString(voidRow.created_at),
      } : null,
      createdAt: asString(row.created_at),
    };
  }

  private activeShippedQuantity(orderItemId: string): number {
    const workspace = this.requireWorkspace();
    const row = workspace.database.prepare(`
      SELECT COALESCE(SUM(items.quantity), 0) AS quantity
      FROM shipment_package_items AS items
      JOIN shipment_packages AS packages ON packages.id = items.package_id
      LEFT JOIN aftersales_replacement_shipments AS replacements
        ON replacements.shipment_record_id = packages.shipment_record_id
      LEFT JOIN shipment_package_cancellation_events AS cancellations
        ON cancellations.package_id = packages.id
      WHERE items.source_order_item_id = ?
        AND cancellations.id IS NULL
        AND replacements.id IS NULL
    `).get(orderItemId) as SqlRow;
    return asNumber(row.quantity);
  }

  // 发货前逐项退款扣减可发数量：与已预留、需求投影同用净额口径，避免部分退款后超发。
  private preShipmentRefundedQuantity(orderItemId: string): number {
    const workspace = this.requireWorkspace();
    const row = workspace.database.prepare(`
      SELECT COALESCE(SUM(quantity), 0) AS quantity
      FROM fulfillment_refund_events
      WHERE order_item_id = ?
    `).get(orderItemId) as SqlRow;
    return asNumber(row.quantity);
  }

  private shipmentSourceDifferences(
    sourceOrders: readonly ShipmentSourceOrderSnapshot[],
    packages: readonly ShipmentPackage[],
  ): ShipmentSourceDifference[] {
    const differences: ShipmentSourceDifference[] = [];
    const currentOrderById = new Map(sourceOrders.map((snapshot) => (
      [snapshot.orderId, this.getOrder(snapshot.orderId).order] as const
    )));
    const orderFields = [
      ['orderNumber', 'orderNumber'],
      ['sellerAccount', 'sellerAccount'],
      ['buyerNickname', 'buyerNickname'],
      ['recipient', 'recipient'],
      ['phone', 'phone'],
      ['addressOriginal', 'addressOriginal'],
      ['amountCents', 'amountCents'],
    ] as const;
    for (const snapshot of sourceOrders) {
      const current = currentOrderById.get(snapshot.orderId);
      for (const [field, key] of orderFields) {
        if (snapshot[key] === current?.[key]) continue;
        differences.push({
          orderId: snapshot.orderId,
          orderItemId: null,
          field,
          snapshotValue: snapshot[key],
          currentValue: current?.[key] ?? null,
        });
      }
    }
    const itemSnapshots = new Map(packages.flatMap((shipmentPackage) => (
      shipmentPackage.items.map((item) => [item.orderItemId, item] as const)
    )));
    const itemFields = [
      ['sourceTitle', 'sourceTitle'],
      ['sourceSpec', 'sourceSpec'],
      ['unitPriceCents', 'unitPriceCents'],
      ['quantity', 'sourceItemQuantity'],
    ] as const;
    for (const snapshot of itemSnapshots.values()) {
      const currentItem = currentOrderById.get(snapshot.orderId)?.items.find(
        ({ id }) => id === snapshot.orderItemId,
      );
      for (const [field, snapshotKey] of itemFields) {
        if (snapshot[snapshotKey] === currentItem?.[field]) continue;
        differences.push({
          orderId: snapshot.orderId,
          orderItemId: snapshot.orderItemId,
          field,
          snapshotValue: snapshot[snapshotKey],
          currentValue: currentItem?.[field] ?? null,
        });
      }
    }
    return differences;
  }

  private synchronizeShipmentOrderFulfillment(orderId: string, now: string): void {
    this.orderFulfillmentProjection().synchronize(orderId, now);
  }

  private orderFulfillmentProjection(): OrderFulfillmentProjectionService {
    return new OrderFulfillmentProjectionService(this.requireWorkspace().database);
  }

  public splitShipmentGroup(input: unknown): ShipmentGroupAdjustmentResult {
    const projection = this.queryShipmentGroups();
    const prepared = prepareSplitShipmentGroup(input, projection);
    const event: ShipmentGroupAdjustmentEvent = {
      id: randomUUID(),
      operation: 'split',
      reason: prepared.reason,
      sourceGroupIds: [prepared.groupId],
      sourceOrderIds: prepared.expectedMemberOrderIds,
      targetGroupId: `manual-shipment-group-${randomUUID()}`,
      targetOrderIds: prepared.splitOrderIds,
      selectedRecipientOrderId: null,
      createdAt: new Date().toISOString(),
    };
    const nextProjection = this.insertShipmentGroupAdjustmentEvent(event);
    return { event, projection: nextProjection };
  }

  public mergeShipmentGroups(input: unknown): ShipmentGroupAdjustmentResult {
    const projection = this.queryShipmentGroups();
    const prepared = prepareMergeShipmentGroups(input, projection);
    const event: ShipmentGroupAdjustmentEvent = {
      id: randomUUID(),
      operation: 'merge',
      reason: prepared.reason,
      sourceGroupIds: prepared.groupIds,
      sourceOrderIds: prepared.expectedMemberOrderIds,
      targetGroupId: `manual-shipment-group-${randomUUID()}`,
      targetOrderIds: prepared.expectedMemberOrderIds,
      selectedRecipientOrderId: prepared.selectedRecipientOrderId,
      createdAt: new Date().toISOString(),
    };
    const nextProjection = this.insertShipmentGroupAdjustmentEvent(event);
    return { event, projection: nextProjection };
  }

  public listShipmentGroupAdjustmentEvents(): ShipmentGroupAdjustmentEvent[] {
    const workspace = this.requireWorkspace();
    const rows = workspace.database.prepare(`
      SELECT *
      FROM shipment_group_adjustment_events
      ORDER BY sequence
    `).all() as unknown as SqlRow[];
    return rows.map(parseShipmentGroupAdjustmentEvent);
  }

  private insertShipmentGroupAdjustmentEvent(
    event: ShipmentGroupAdjustmentEvent,
  ): ShipmentGroupProjection {
    const workspace = this.requireWorkspace();
    return workspace.transaction(() => {
      workspace.database.prepare(`
        INSERT INTO shipment_group_adjustment_events (
          id, operation, reason,
          source_group_ids_json, source_order_ids_json,
          target_group_id, target_order_ids_json,
          selected_recipient_order_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.operation,
        event.reason,
        JSON.stringify(event.sourceGroupIds),
        JSON.stringify(event.sourceOrderIds),
        event.targetGroupId,
        JSON.stringify(event.targetOrderIds),
        event.selectedRecipientOrderId,
        event.createdAt,
      );
      const projection = this.queryShipmentGroups();
      this.pruneShipmentGroupCustomFieldValues(projection.groups.map(({ id }) => id));
      return projection;
    });
  }

  private pruneShipmentGroupCustomFieldValues(activeGroupIds: readonly string[]): void {
    this.requireWorkspace().database.prepare(`
      DELETE FROM shipment_group_custom_field_values
      WHERE shipment_group_id NOT IN (SELECT value FROM json_each(?))
    `).run(JSON.stringify(activeGroupIds));
  }

  public queryOrders(
    query: OrderWorkbenchQuery,
    customFieldDefinitionIds?: readonly string[],
    scopedOrderIds?: readonly string[],
    options?: { excludeReleasedPlanMembers?: boolean },
  ): OrderWorkbenchResult {
    const workspace = this.requireWorkspace();
    const where = [
      query.lifecycleStatus === 'all'
        ? '1 = 1'
        : 'orders.lifecycle_status = ?',
    ];
    const parameters: Array<string | number> = query.lifecycleStatus === 'all'
      ? []
      : [query.lifecycleStatus ?? 'active'];
    const normalizedScopedOrderIds = scopedOrderIds === undefined
      ? undefined
      : normalizeOrderExportOrderIds(scopedOrderIds);
    if (normalizedScopedOrderIds) {
      where.push('orders.id IN (SELECT value FROM json_each(?))');
      parameters.push(JSON.stringify(normalizedScopedOrderIds));
    }
    const text = query.text?.normalize('NFKC').trim();
    if (text) {
      const pattern = containsLikePattern(text);
      where.push(`(
        orders.system_order_number LIKE ? ESCAPE '\\'
        OR orders.platform_order_number LIKE ? ESCAPE '\\'
        OR orders.buyer_nickname LIKE ? ESCAPE '\\'
        OR orders.recipient LIKE ? ESCAPE '\\'
        OR orders.phone LIKE ? ESCAPE '\\'
        OR orders.phone_normalized LIKE ? ESCAPE '\\'
        OR orders.address_original LIKE ? ESCAPE '\\'
        OR orders.address_normalized LIKE ? ESCAPE '\\'
        OR orders.seller_account LIKE ? ESCAPE '\\'
        OR orders.note LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM order_items AS searched_items
          LEFT JOIN standard_products AS searched_products
            ON searched_products.id = searched_items.standard_product_id
          WHERE searched_items.order_id = orders.id
            AND (
              searched_items.source_title LIKE ? ESCAPE '\\'
              OR searched_items.source_spec LIKE ? ESCAPE '\\'
              OR searched_products.sku LIKE ? ESCAPE '\\'
              OR searched_products.name LIKE ? ESCAPE '\\'
              OR searched_products.specification LIKE ? ESCAPE '\\'
            )
        )
      )`);
      parameters.push(...Array<string>(15).fill(pattern));
    }
    const buyerText = query.buyerText?.normalize('NFKC').trim();
    if (buyerText) {
      const pattern = containsLikePattern(buyerText);
      where.push(`(
        orders.buyer_nickname LIKE ? ESCAPE '\\'
        OR orders.recipient LIKE ? ESCAPE '\\'
        OR orders.phone LIKE ? ESCAPE '\\'
        OR orders.phone_normalized LIKE ? ESCAPE '\\'
      )`);
      parameters.push(...Array<string>(4).fill(pattern));
    }
    const productText = query.productText?.normalize('NFKC').trim();
    if (productText) {
      const pattern = containsLikePattern(productText);
      where.push(`EXISTS (
        SELECT 1
        FROM order_items AS filtered_items
        LEFT JOIN standard_products AS filtered_products
          ON filtered_products.id = filtered_items.standard_product_id
        WHERE filtered_items.order_id = orders.id
          AND (
            filtered_items.source_title LIKE ? ESCAPE '\\'
            OR filtered_items.source_spec LIKE ? ESCAPE '\\'
            OR filtered_products.sku LIKE ? ESCAPE '\\'
            OR filtered_products.name LIKE ? ESCAPE '\\'
            OR filtered_products.specification LIKE ? ESCAPE '\\'
          )
      )`);
      parameters.push(pattern, pattern, pattern, pattern, pattern);
    }
    if (query.platform) {
      where.push('orders.platform = ?');
      parameters.push(query.platform);
    }
    if (query.sellerAccount) {
      where.push('orders.seller_account = ?');
      parameters.push(query.sellerAccount);
    }
    if (query.initialSourceRecognitionStatus) {
      where.push("COALESCE(source_items.status, 'imported') = ?");
      parameters.push(query.initialSourceRecognitionStatus);
    }
    if (query.platformTransactionStatus) {
      where.push('orders.platform_transaction_status = ?');
      parameters.push(query.platformTransactionStatus);
    }
    if (query.fulfillmentStatus) {
      where.push('orders.fulfillment_status = ?');
      parameters.push(query.fulfillmentStatus);
      if (query.fulfillmentStatus === 'pending_shipment') {
        where.push("orders.platform_transaction_status NOT IN ('cancelled', 'refunded')");
        where.push(unreleasedPlanMemberGateSql('orders.id'));
        if (options?.excludeReleasedPlanMembers) {
          where.push(releasedPlanMemberGateSql('orders.id'));
        }
      }
    }
    const dateColumn = orderWorkbenchDateColumn(query.dateField ?? 'created_at');
    if (query.dateFrom) {
      where.push(`${dateColumn} >= ?`);
      parameters.push(orderWorkbenchDateBoundary(query.dateFrom, dateColumn, 'start'));
    }
    if (query.dateTo) {
      where.push(`${dateColumn} <= ?`);
      parameters.push(orderWorkbenchDateBoundary(query.dateTo, dateColumn, 'end'));
    }
    if (query.customFieldFilter) {
      const definition = this.getCustomFieldDefinition(
        query.customFieldFilter.definitionId,
      );
      if (definition.granularity !== 'order') {
        throw new Error('商品粒度自定义字段不能用于订单筛选');
      }
      const value = normalizeCustomFieldValue(
        definition.type,
        query.customFieldFilter.value,
        definition.options,
      );
      if (definition.type === 'text') {
        where.push(`EXISTS (
          SELECT 1
          FROM custom_field_values AS filtered_custom_values
          WHERE filtered_custom_values.definition_id = ?
            AND filtered_custom_values.order_id = orders.id
            AND CAST(json_extract(filtered_custom_values.value_json, '$') AS TEXT)
              LIKE ? ESCAPE '\\'
        )`);
        parameters.push(definition.id, containsLikePattern(value as string));
      } else if (definition.type === 'multi_select') {
        where.push(`EXISTS (
          SELECT 1
          FROM custom_field_values AS filtered_custom_values
          WHERE filtered_custom_values.definition_id = ?
            AND filtered_custom_values.order_id = orders.id
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(?) AS requested_values
              WHERE NOT EXISTS (
                SELECT 1
                FROM json_each(filtered_custom_values.value_json) AS stored_values
                WHERE stored_values.value = requested_values.value
              )
            )
        )`);
        parameters.push(definition.id, JSON.stringify(value));
      } else {
        where.push(`EXISTS (
          SELECT 1
          FROM custom_field_values AS filtered_custom_values
          WHERE filtered_custom_values.definition_id = ?
            AND filtered_custom_values.order_id = orders.id
            AND filtered_custom_values.value_json = ?
        )`);
        parameters.push(definition.id, JSON.stringify(value));
      }
    }
    const sortParameters: Array<string | number> = [];
    let sortExpression = orderWorkbenchSortExpression(query.sortField ?? 'created_at');
    let sortDirection = orderWorkbenchSortDirection(query.sortDirection ?? 'desc');
    if (query.customFieldSort) {
      const definition = this.getCustomFieldDefinition(query.customFieldSort.definitionId);
      if (definition.granularity !== 'order') {
        throw new Error('商品粒度自定义字段不能用于订单排序');
      }
      sortExpression = `(
        SELECT json_extract(sorted_custom_values.value_json, '$')
        FROM custom_field_values AS sorted_custom_values
        WHERE sorted_custom_values.definition_id = ?
          AND sorted_custom_values.order_id = orders.id
        LIMIT 1
      )${customFieldTextCollation(definition.type)}`;
      sortParameters.push(definition.id);
      sortDirection = orderWorkbenchSortDirection(query.customFieldSort.direction);
    }
    const rows = workspace.database
      .prepare(`
        SELECT
          orders.id,
          orders.system_order_number,
          orders.platform,
          orders.seller_account,
          orders.platform_order_number,
          orders.alipay_transaction_number,
          orders.buyer_nickname,
          orders.recipient,
          orders.phone,
          orders.address_original,
          orders.province,
          orders.city,
          orders.district,
          orders.amount_cents,
          orders.note,
          orders.shipping_carrier,
          orders.tracking_number,
          orders.revision,
          orders.updated_at,
          (
            SELECT manual_events.created_at
            FROM order_change_events AS manual_events
            WHERE manual_events.order_id = orders.id
              AND manual_events.source = 'manual_edit'
            ORDER BY manual_events.result_revision DESC, manual_events.id DESC
            LIMIT 1
          ) AS last_manual_edit_at,
          COALESCE(source_items.status, 'imported') AS initial_source_recognition_status,
          orders.platform_transaction_status,
          orders.fulfillment_status,
          orders.lifecycle_status,
          orders.ordered_at_normalized,
          orders.paid_at_normalized,
          orders.created_at,
          COALESCE(SUM(items.quantity), 0) AS item_count,
          COALESCE((
            SELECT json_group_array(json_object(
              'sourceTitle', ordered_items.source_title,
              'sourceSpec', ordered_items.source_spec,
              'quantity', ordered_items.quantity,
              'standardDisplayPreference', ordered_items.standard_display_preference,
              'standardProduct', CASE
                WHEN ordered_items.standard_product_id IS NULL THEN NULL
                ELSE json_object(
                  'id', ordered_items.standard_product_id,
                  'sku', ordered_items.standard_sku,
                  'name', ordered_items.standard_name,
                  'specification', ordered_items.standard_specification,
                  'revision', ordered_items.standard_revision,
                  'createdAt', ordered_items.standard_created_at,
                  'updatedAt', ordered_items.standard_updated_at
                )
              END
            ))
            FROM (
              SELECT
                order_items.source_title,
                order_items.source_spec,
                order_items.quantity,
                order_items.standard_product_id,
                order_items.standard_display_preference,
                standard_products.sku AS standard_sku,
                standard_products.name AS standard_name,
                standard_products.specification AS standard_specification,
                standard_products.revision AS standard_revision,
                standard_products.created_at AS standard_created_at,
                standard_products.updated_at AS standard_updated_at
              FROM order_items
              LEFT JOIN standard_products
                ON standard_products.id = order_items.standard_product_id
              WHERE order_items.order_id = orders.id
              ORDER BY order_items.position
            ) AS ordered_items
          ), '[]') AS items_json
        FROM original_orders AS orders
        LEFT JOIN recognition_batch_items AS source_items
          ON source_items.draft_id = orders.draft_id
        LEFT JOIN order_items AS items ON items.order_id = orders.id
        WHERE ${where.join('\n          AND ')}
        GROUP BY orders.id
        ORDER BY ${sortExpression} ${sortDirection}, orders.id DESC
      `)
      .all(...parameters, ...sortParameters) as unknown as SqlRow[];

    const operationsByOrder = new OrderOperationsProjectionService(workspace.database)
      .getOverviewMany(rows.map((row) => asString(row.id)));
    const readableNumberByOrder = this.recipientService()
      .readableOrderNumbers(rows.map((row) => asString(row.id)));
    const spendingByOrderId = this.recipientService().spendingProjection().byOrderId;
    let orders = rows.map((row) => {
      const id = asString(row.id);
      const itemCount = asNumber(row.item_count);
      const operations = operationsByOrder.get(id);
      if (!operations) throw new Error('订单运营投影缺少查询结果');
      return {
        id,
        systemOrderNumber: asString(row.system_order_number),
        readableOrderNumber: readableNumberByOrder.get(id) ?? null,
        platform: asOrderPlatform(row.platform),
        sellerAccount: asString(row.seller_account),
        orderNumber: asString(row.platform_order_number),
        alipayTransactionNumber: asString(row.alipay_transaction_number),
        buyerNickname: asString(row.buyer_nickname),
        recipient: asString(row.recipient),
        phone: asString(row.phone),
        addressOriginal: asString(row.address_original),
        province: asString(row.province),
        city: asString(row.city),
        district: asString(row.district),
        amountCents: asNumber(row.amount_cents),
        note: asString(row.note),
        shippingCarrier: asString(row.shipping_carrier),
        trackingNumber: asString(row.tracking_number),
        revision: asNumber(row.revision),
        updatedAt: asString(row.updated_at),
        lastManualEditAt: row.last_manual_edit_at === null
          ? null
          : asString(row.last_manual_edit_at),
        itemCount,
        initialSourceRecognitionStatus: asRecognitionBatchItemStatus(
          row.initial_source_recognition_status,
        ),
        platformTransactionStatus: asPlatformTransactionStatus(
          row.platform_transaction_status,
        ),
        fulfillmentStatus: asFulfillmentStatus(row.fulfillment_status),
        lifecycleStatus: asLifecycleStatus(row.lifecycle_status),
        orderedAtNormalized: asString(row.ordered_at_normalized),
        paidAtNormalized: asString(row.paid_at_normalized),
        createdAt: asString(row.created_at),
        items: parseOrderSummaryItems(asString(row.items_json)),
        operations: orderOperationsOverview(operations, itemCount),
        spending: spendingByOrderId.get(id) ?? null,
      };
    });
    if (query.repurchase !== undefined) {
      orders = orders.filter((order) => {
        const rank = order.spending?.repurchaseRank;
        return rank !== undefined && rank !== null
          ? query.repurchase ? rank > 1 : rank === 1
          : false;
      });
    }
    if (normalizedScopedOrderIds) {
      const positionById = new Map(
        normalizedScopedOrderIds.map((id, index) => [id, index]),
      );
      orders.sort((left, right) => (
        (positionById.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (positionById.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      ));
    }

    const counts = workspace.database.prepare(`
      SELECT
        COUNT(*) AS all_lifecycle_order_count,
        COALESCE(SUM(lifecycle_status = 'active'), 0) AS active_order_count,
        COALESCE(SUM(
          lifecycle_status = 'active'
          AND fulfillment_status IN ('pending_shipment', 'partially_shipped')
          AND platform_transaction_status NOT IN ('cancelled', 'refunded')
          AND ${unreleasedPlanMemberGateSql('original_orders.id')}
        ), 0) AS pending_shipment_count
      FROM original_orders
    `).get() as SqlRow;
    const platforms = workspace.database.prepare(`
      SELECT DISTINCT platform
      FROM original_orders
      ORDER BY platform
    `).all() as unknown as SqlRow[];
    const sellerAccounts = workspace.database.prepare(`
      SELECT DISTINCT seller_account
      FROM original_orders
      ORDER BY seller_account
    `).all() as unknown as SqlRow[];

    return {
      orders,
      customFieldValues: this.listWorkbenchCustomFieldValues(
        'order',
        orders.map((order) => order.id),
        customFieldDefinitionIds,
      ),
      allLifecycleOrderCount: asNumber(counts.all_lifecycle_order_count),
      activeOrderCount: asNumber(counts.active_order_count),
      pendingShipmentCount: asNumber(counts.pending_shipment_count),
      platforms: platforms.map((row) => asOrderPlatform(row.platform)),
      sellerAccounts: sellerAccounts.map((row) => asString(row.seller_account)),
    };
  }

  public queryOrderItems(
    query: OrderItemWorkbenchQuery,
    customFieldDefinitionIds?: readonly string[],
    scopedOrderIds?: readonly string[],
    includeAllLifecycles = false,
  ): OrderItemWorkbenchResult {
    const workspace = this.requireWorkspace();
    const where = [includeAllLifecycles ? '1 = 1' : "orders.lifecycle_status = 'active'"];
    const parameters: Array<string | number> = [];
    const normalizedScopedOrderIds = scopedOrderIds === undefined
      ? undefined
      : normalizeOrderExportOrderIds(scopedOrderIds);
    if (normalizedScopedOrderIds) {
      where.push('orders.id IN (SELECT value FROM json_each(?))');
      parameters.push(JSON.stringify(normalizedScopedOrderIds));
    }
    const sourceTitle = query.sourceTitle?.trim();
    if (sourceTitle) {
      where.push('items.source_title = ? COLLATE NOCASE');
      parameters.push(sourceTitle);
    }
    const sourceSpec = query.sourceSpec?.trim();
    if (sourceSpec) {
      where.push('items.source_spec = ? COLLATE NOCASE');
      parameters.push(sourceSpec);
    }
    const similarText = query.similarText?.trim();
    if (similarText && similarText.length > 300) {
      throw new Error('相似标题规格筛选值无效');
    }
    if (query.unitPriceCents !== undefined) {
      if (!Number.isSafeInteger(query.unitPriceCents) || query.unitPriceCents < 0) {
        throw new Error('商品单价筛选值无效');
      }
      where.push('items.unit_price_cents = ?');
      parameters.push(query.unitPriceCents);
    }
    if (query.quantity !== undefined) {
      if (!Number.isSafeInteger(query.quantity) || query.quantity < 1) {
        throw new Error('商品数量筛选值无效');
      }
      where.push('items.quantity = ?');
      parameters.push(query.quantity);
    }
    if (query.quantitySource !== undefined) {
      if (!isQuantitySource(query.quantitySource)) {
        throw new Error('商品数量来源筛选值无效');
      }
      where.push('items.quantity_source = ?');
      parameters.push(query.quantitySource);
    }
    if (query.customFieldFilter) {
      const definition = this.getCustomFieldDefinition(
        query.customFieldFilter.definitionId,
      );
      if (definition.granularity !== 'order_item') {
        throw new Error('订单粒度自定义字段不能用于商品筛选');
      }
      const value = normalizeCustomFieldValue(
        definition.type,
        query.customFieldFilter.value,
        definition.options,
      );
      if (definition.type === 'text') {
        where.push(`EXISTS (
          SELECT 1
          FROM custom_field_values AS filtered_custom_values
          WHERE filtered_custom_values.definition_id = ?
            AND filtered_custom_values.order_item_id = items.id
            AND CAST(json_extract(filtered_custom_values.value_json, '$') AS TEXT)
              LIKE ? ESCAPE '\\'
        )`);
        parameters.push(definition.id, containsLikePattern(value as string));
      } else if (definition.type === 'multi_select') {
        where.push(`EXISTS (
          SELECT 1
          FROM custom_field_values AS filtered_custom_values
          WHERE filtered_custom_values.definition_id = ?
            AND filtered_custom_values.order_item_id = items.id
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(?) AS requested_values
              WHERE NOT EXISTS (
                SELECT 1
                FROM json_each(filtered_custom_values.value_json) AS stored_values
                WHERE stored_values.value = requested_values.value
              )
            )
        )`);
        parameters.push(definition.id, JSON.stringify(value));
      } else {
        where.push(`EXISTS (
          SELECT 1
          FROM custom_field_values AS filtered_custom_values
          WHERE filtered_custom_values.definition_id = ?
            AND filtered_custom_values.order_item_id = items.id
            AND filtered_custom_values.value_json = ?
        )`);
        parameters.push(definition.id, JSON.stringify(value));
      }
    }

    const sortParameters: Array<string | number> = [];
    let sortExpression = 'orders.created_at DESC, orders.id DESC, items.position';
    let sortDirection = '';
    if (query.sortField && query.customFieldSort) {
      throw new Error('订单商品明细一次只能使用一种排序');
    }
    if (query.sortField) {
      const expressions = {
        source_title: 'items.source_title COLLATE NOCASE',
        source_spec: 'items.source_spec COLLATE NOCASE',
        unit_price: 'items.unit_price_cents',
        quantity: 'items.quantity',
        quantity_source: `CASE items.quantity_source
          WHEN 'system_default_1' THEN 1
          WHEN 'ocr_explicit' THEN 2
          WHEN 'legacy_explicit_or_manual' THEN 2
          WHEN 'manual' THEN 3
        END`,
      } as const;
      sortExpression = expressions[query.sortField];
      sortDirection = orderWorkbenchSortDirection(query.sortDirection ?? 'asc');
    } else if (query.customFieldSort) {
      const definition = this.getCustomFieldDefinition(query.customFieldSort.definitionId);
      if (definition.granularity !== 'order_item') {
        throw new Error('订单粒度自定义字段不能用于商品排序');
      }
      sortExpression = `(
        SELECT json_extract(sorted_custom_values.value_json, '$')
        FROM custom_field_values AS sorted_custom_values
        WHERE sorted_custom_values.definition_id = ?
          AND sorted_custom_values.order_item_id = items.id
        LIMIT 1
      )${customFieldTextCollation(definition.type)}`;
      sortParameters.push(definition.id);
      sortDirection = orderWorkbenchSortDirection(query.customFieldSort.direction);
    }

    const rows = workspace.database.prepare(`
      SELECT
        items.*,
        orders.system_order_number,
        orders.platform_order_number AS order_number,
        products.sku AS standard_sku,
        products.name AS standard_name,
        products.specification AS standard_specification,
        products.default_order_price_cents AS standard_default_order_price_cents,
        products.revision AS standard_revision,
        products.created_at AS standard_created_at,
        products.updated_at AS standard_updated_at
      FROM order_items AS items
      JOIN original_orders AS orders ON orders.id = items.order_id
      LEFT JOIN standard_products AS products ON products.id = items.standard_product_id
      WHERE ${where.join('\n        AND ')}
      ORDER BY ${sortExpression} ${sortDirection}, items.id
    `).all(...parameters, ...sortParameters) as unknown as SqlRow[];
    const readableNumberByOrder = this.recipientService().readableOrderNumbers(
      [...new Set(rows.map((row) => asString(row.order_id)))],
    );
    const items = rows.map((row) => {
      const quantitySource = asQuantitySource(row.quantity_source);
      return {
        id: asString(row.id),
        orderId: asString(row.order_id),
        systemOrderNumber: asString(row.system_order_number),
        readableOrderNumber: readableNumberByOrder.get(asString(row.order_id)) ?? null,
        orderNumber: asString(row.order_number),
        position: asNumber(row.position),
        sourceTitle: asString(row.source_title),
        sourceSpec: asString(row.source_spec),
        unitPriceCents: asNumber(row.unit_price_cents),
        quantity: asNumber(row.quantity),
        quantitySource,
        quantityInferred: quantityInferredFromSource(quantitySource),
        subtotalCents: asNumber(row.subtotal_cents),
        standardProduct: row.standard_product_id === null
          ? null
          : {
              id: asString(row.standard_product_id),
              sku: asString(row.standard_sku),
              name: asString(row.standard_name),
              specification: asString(row.standard_specification),
              defaultOrderPriceCents: row.standard_default_order_price_cents === null
                ? null
                : asNumber(row.standard_default_order_price_cents),
              revision: asNumber(row.standard_revision),
              createdAt: asString(row.standard_created_at),
              updatedAt: asString(row.standard_updated_at),
            },
        standardizationSource: row.standardization_source === null
          ? null
          : asProductStandardizationSource(row.standardization_source),
        standardDisplayPreference: row.standard_display_preference === null
          ? null
          : asStandardDisplayPreference(row.standard_display_preference),
      };
    });
    if (normalizedScopedOrderIds) {
      const positionByOrderId = new Map(
        normalizedScopedOrderIds.map((id, index) => [id, index]),
      );
      items.sort((left, right) => (
        (positionByOrderId.get(left.orderId) ?? Number.MAX_SAFE_INTEGER) -
          (positionByOrderId.get(right.orderId) ?? Number.MAX_SAFE_INTEGER) ||
        left.position - right.position ||
        left.id.localeCompare(right.id)
      ));
    }
    // 相同或相似筛选复用商品标准化候选的相似度口径，在 SQL 精确筛选之后按文本计算。
    const filteredItems = similarText
      ? items.filter((item) => fuzzyProductSimilarity(
        item.sourceTitle,
        item.sourceSpec,
        { name: similarText, specification: '' },
      ) >= PRODUCT_SIMILARITY_THRESHOLD)
      : items;
    return {
      items: filteredItems,
      customFieldValues: this.listWorkbenchCustomFieldValues(
        'order_item',
        filteredItems.map((item) => item.id),
        customFieldDefinitionIds,
      ),
    };
  }

  private completeBatchWhenReviewed(batchId: string): void {
    const workspace = this.requireWorkspace();
    const row = workspace.database
      .prepare(`
        SELECT COUNT(*) AS pending_count
        FROM order_drafts
        WHERE batch_id = ?
          AND status = 'awaiting_review'
          AND review_cancelled_at IS NULL
      `)
      .get(batchId) as SqlRow;
    if (asNumber(row.pending_count) !== 0) return;
    workspace.database
      .prepare("UPDATE recognition_batches SET status = 'completed' WHERE id = ?")
      .run(batchId);
  }

  private refreshRecognitionBatchStatus(batchId: string): void {
    const workspace = this.requireWorkspace();
    workspace.database
      .prepare(`
        UPDATE recognition_batches
        SET status = CASE
          WHEN EXISTS (
            SELECT 1
            FROM recognition_batch_items
            WHERE batch_id = ?
              AND status IN (
                'waiting_recognition', 'recognizing', 'validating',
                'awaiting_confirmation', 'waiting_retry'
              )
          ) THEN 'awaiting_review'
          ELSE 'completed'
        END
        WHERE id = ?
      `)
      .run(batchId, batchId);
  }

  public getOrder(orderId: string): OrderDetails {
    const workspace = this.requireWorkspace();
    const row = workspace.database
      .prepare('SELECT * FROM original_orders WHERE id = ?')
      .get(orderId) as SqlRow | undefined;
    if (!row) throw new Error('未找到原始订单');

    const itemRows = workspace.database
      .prepare(`
        SELECT
          items.*,
          products.sku AS standard_sku,
          products.name AS standard_name,
          products.specification AS standard_specification,
          products.default_order_price_cents AS standard_default_order_price_cents,
          products.revision AS standard_revision,
          products.created_at AS standard_created_at,
          products.updated_at AS standard_updated_at
        FROM order_items AS items
        LEFT JOIN standard_products AS products ON products.id = items.standard_product_id
        WHERE items.order_id = ?
        ORDER BY items.position
      `)
      .all(orderId) as unknown as SqlRow[];
    const items: OrderItem[] = itemRows.map((item) => {
      const quantitySource = asQuantitySource(item.quantity_source);
      return {
        id: asString(item.id),
        position: asNumber(item.position),
        sourceTitle: asString(item.source_title),
        sourceSpec: asString(item.source_spec),
        unitPriceCents: asNumber(item.unit_price_cents),
        quantity: asNumber(item.quantity),
        quantitySource,
        quantityInferred: quantityInferredFromSource(quantitySource),
        subtotalCents: asNumber(item.subtotal_cents),
        standardProduct: item.standard_product_id === null
          ? null
          : {
              id: asString(item.standard_product_id),
              sku: asString(item.standard_sku),
              name: asString(item.standard_name),
              specification: asString(item.standard_specification),
              defaultOrderPriceCents: item.standard_default_order_price_cents === null
                ? null
                : asNumber(item.standard_default_order_price_cents),
              revision: asNumber(item.standard_revision),
              createdAt: asString(item.standard_created_at),
              updatedAt: asString(item.standard_updated_at),
            },
        standardizationSource: item.standardization_source === null
          ? null
          : asProductStandardizationSource(item.standardization_source),
        standardDisplayPreference: item.standard_display_preference === null
          ? null
          : asStandardDisplayPreference(item.standard_display_preference),
      };
    });

    const order: OriginalOrder = {
      id: asString(row.id),
      systemOrderNumber: asString(row.system_order_number),
      revision: asNumber(row.revision),
      platform: asOrderPlatform(row.platform),
      sellerAccount: asString(row.seller_account),
      orderNumber: asString(row.platform_order_number),
      alipayTransactionNumber: asString(row.alipay_transaction_number),
      buyerNickname: asString(row.buyer_nickname),
      recipient: asString(row.recipient),
      phone: asString(row.phone),
      phoneNormalized: asString(row.phone_normalized),
      addressOriginal: asString(row.address_original),
      addressNormalized: asString(row.address_normalized),
      province: asString(row.province),
      city: asString(row.city),
      district: asString(row.district),
      orderedAtOriginal: asString(row.ordered_at_original),
      orderedAtNormalized: asString(row.ordered_at_normalized),
      paidAtOriginal: asString(row.paid_at_original),
      paidAtNormalized: asString(row.paid_at_normalized),
      productTotalCents: asNullableNumber(row.product_total_cents),
      shippingFeeCents: asNullableNumber(row.shipping_fee_cents),
      amountCents: asNumber(row.amount_cents),
      note: asString(row.note),
      shippingCarrier: asString(row.shipping_carrier),
      trackingNumber: asString(row.tracking_number),
      platformTransactionStatus: asPlatformTransactionStatus(
        row.platform_transaction_status,
      ),
      fulfillmentStatus: asFulfillmentStatus(row.fulfillment_status),
      lifecycleStatus: asLifecycleStatus(row.lifecycle_status),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      items,
    };

    const sourceRows = workspace.database
      .prepare(`
        SELECT
          screenshots.id AS source_id,
          screenshots.original_name,
          screenshots.relative_path,
          screenshots.mime_type,
          screenshots.content_sha256,
          screenshots.created_at AS screenshot_created_at,
          snapshots.id AS snapshot_id,
          snapshots.source_type,
          snapshots.source_name,
          snapshots.source_row_numbers_json,
          snapshots.recognition_json,
          snapshots.confirmed_json,
          snapshots.created_at AS snapshot_created_at,
          source_items.status AS recognition_status
        FROM source_snapshots AS snapshots
        LEFT JOIN source_screenshots AS screenshots ON screenshots.id = snapshots.screenshot_id
        LEFT JOIN recognition_batch_items AS source_items
          ON source_items.draft_id = snapshots.draft_id
        LEFT JOIN (
          SELECT source_snapshot_id, MAX(result_revision) AS result_revision
          FROM order_change_events
          WHERE source_snapshot_id IS NOT NULL
          GROUP BY source_snapshot_id
        ) AS applied_updates ON applied_updates.source_snapshot_id = snapshots.id
        WHERE snapshots.order_id = ?
        ORDER BY
          snapshots.resolved_at DESC,
          applied_updates.result_revision DESC,
          snapshots.rowid DESC
      `)
      .all(orderId) as unknown as SqlRow[];
    const sources = sourceRows.map((sourceRow) => {
      const sourceType = asOrderSourceType(sourceRow.source_type);
      return {
        recognitionStatus: sourceType === 'historical_import'
          ? 'imported' as const
          : asRecognitionBatchItemStatus(sourceRow.recognition_status),
        sourceScreenshot: sourceType === 'historical_import'
          ? null
          : {
            id: asString(sourceRow.source_id),
            originalName: asString(sourceRow.original_name),
            relativePath: asString(sourceRow.relative_path),
            mimeType: asString(sourceRow.mime_type),
            sha256: asString(sourceRow.content_sha256),
            createdAt: asString(sourceRow.screenshot_created_at),
          } satisfies SourceScreenshot,
        sourceSnapshot: {
          id: asString(sourceRow.snapshot_id),
          createdAt: asString(sourceRow.snapshot_created_at),
          sourceType,
          sourceName: sourceRow.source_name === null ? null : asString(sourceRow.source_name),
          sourceRowNumbers: sourceRow.source_row_numbers_json === null
            ? []
            : parseSourceRowNumbers(asString(sourceRow.source_row_numbers_json)),
          recognition: parseStoredConfirmedOrderSnapshot(asString(sourceRow.recognition_json)),
          confirmed: sourceRow.confirmed_json === null
            ? null
            : parseStoredConfirmedOrderSnapshot(asString(sourceRow.confirmed_json)),
        } satisfies SourceSnapshot,
      };
    });
    const latestSource = sources[0];
    if (!latestSource) throw new Error('原始订单缺少来源快照');

    const changeRows = workspace.database
      .prepare(`
        SELECT
          events.id AS event_id,
          events.source_snapshot_id,
          events.source,
          events.base_revision,
          events.result_revision,
          events.created_at,
          changes.id AS change_id,
          changes.field_path,
          changes.before_json,
          changes.after_json
        FROM order_change_events AS events
        LEFT JOIN order_field_changes AS changes ON changes.event_id = events.id
        WHERE events.order_id = ?
        ORDER BY events.result_revision DESC, events.id DESC, changes.field_path
      `)
      .all(orderId) as unknown as SqlRow[];
    const eventsById = new Map<string, OrderChangeEvent>();
    for (const changeRow of changeRows) {
      const eventId = asString(changeRow.event_id);
      let event = eventsById.get(eventId);
      if (!event) {
        const source = asString(changeRow.source);
        if (
          source !== 'source_update'
          && source !== 'manual_edit'
          && source !== 'shipment_sync'
        ) {
          throw new Error('数据库订单修改来源格式错误');
        }
        event = {
          id: eventId,
          sourceSnapshotId: changeRow.source_snapshot_id === null
            ? null
            : asString(changeRow.source_snapshot_id),
          source,
          baseRevision: asNumber(changeRow.base_revision),
          resultRevision: asNumber(changeRow.result_revision),
          createdAt: asString(changeRow.created_at),
          changes: [],
        };
        eventsById.set(eventId, event);
      }
      if (changeRow.change_id !== null) {
        event.changes.push({
          path: asString(changeRow.field_path),
          before: parseOrderChangeValue(asString(changeRow.before_json)),
          after: parseOrderChangeValue(asString(changeRow.after_json)),
        });
      }
    }

    return {
      order,
      sourceScreenshot: latestSource.sourceScreenshot,
      sourceSnapshot: latestSource.sourceSnapshot,
      sources,
      changeEvents: [...eventsById.values()],
      lastManualEditAt: [...eventsById.values()]
        .find((event) => event.source === 'manual_edit')?.createdAt ?? null,
      customFieldDefinitions: this.listCustomFieldDefinitions(),
      customFieldValues: this.listCustomFieldValuesForOrder(orderId),
      operations: new OrderOperationsProjectionService(workspace.database).get(orderId),
      readableOrderNumber: this.recipientService().readableOrderNumbers([orderId])
        .get(orderId) ?? null,
      spending: this.recipientService().spendingProjection().byOrderId.get(orderId) ?? null,
    };
  }

  public getRecognitionEvidence(screenshotId: string): RecognitionEvidence {
    const workspace = this.requireWorkspace();
    const row = workspace.database
      .prepare(`
        SELECT provider, model, request_id, schema_version, raw_response
        FROM recognition_attempts
        WHERE screenshot_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `)
      .get(screenshotId) as SqlRow | undefined;
    if (!row) throw new Error('未找到识别追溯证据');

    const provider = asString(row.provider);
    const model = asString(row.model);
    const schemaVersion = asNumber(row.schema_version);
    if (provider !== 'aliyun-bailian' && provider !== 'controlled') {
      throw new Error('识别追溯证据服务商格式错误');
    }
    if (model !== 'qwen3.5-ocr' && model !== 'controlled') {
      throw new Error('识别追溯证据模型格式错误');
    }
    if (schemaVersion !== 1) {
      throw new Error('识别追溯证据版本不受支持');
    }
    return {
      provider,
      model,
      requestId: asString(row.request_id),
      schemaVersion,
      rawResponse: asString(row.raw_response),
    };
  }

  public getCandidateAdjudicationAudit(
    draftId: string,
  ): CandidateAdjudicationAuditView[] {
    const workspace = this.requireWorkspace();
    const runRows = workspace.database.prepare(`
      SELECT
        id, provider, model, status,
        failure_code, failure_message, created_at
      FROM candidate_adjudication_runs
      WHERE draft_id = ?
      ORDER BY created_at, id
    `).all(draftId) as unknown as SqlRow[];
    const decisionsByRun = new Map<string, CandidateAdjudicationDecisionAudit[]>();
    if (runRows.length > 0) {
      const decisionRows = workspace.database.prepare(`
        SELECT
          decisions.run_id, decisions.ambiguity_id, decisions.region,
          decisions.field, decisions.item_index, decisions.candidates_json,
          decisions.selected_candidate_id, decisions.context_lines_json,
          decisions.outcome, decisions.failure_code
        FROM candidate_adjudication_decisions AS decisions
        JOIN candidate_adjudication_runs AS runs ON runs.id = decisions.run_id
        WHERE runs.draft_id = ?
        ORDER BY decisions.run_id, decisions.position
      `).all(draftId) as unknown as SqlRow[];
      for (const row of decisionRows) {
        const runId = asString(row.run_id);
        const decisions = decisionsByRun.get(runId) ?? [];
        decisions.push(parseCandidateAdjudicationDecisionRow(row));
        decisionsByRun.set(runId, decisions);
      }
    }
    return runRows.map((row) => {
      const id = asString(row.id);
      const failureCode = optionalCandidateAdjudicationFailureCode(row.failure_code);
      return {
        id,
        provider: asCandidateModelProvider(row.provider),
        model: asString(row.model),
        status: asCandidateAdjudicationRunStatus(row.status),
        ...(failureCode === undefined ? {} : { failureCode }),
        ...(row.failure_message === null
          ? {}
          : { failureMessage: asString(row.failure_message) }),
        createdAt: asString(row.created_at),
        decisions: decisionsByRun.get(id) ?? [],
      };
    });
  }

  public async readSourceScreenshot(screenshotId: string): Promise<{
    bytes: Uint8Array;
    mimeType: string;
    originalName: string;
  }> {
    const workspace = this.requireWorkspace();
    const row = workspace.database
      .prepare('SELECT original_name, relative_path, mime_type FROM source_screenshots WHERE id = ?')
      .get(screenshotId) as SqlRow | undefined;
    if (!row) throw new Error('未找到来源截图');
    return {
      bytes: await readFile(workspace.resolveStoredPath(asString(row.relative_path))),
      mimeType: asString(row.mime_type),
      originalName: asString(row.original_name),
    };
  }

  public close(): void {
    this.workspace?.close();
    this.workspace = undefined;
  }

  private persistRecognitionDraft(
    workspace: Workspace,
    input: PersistRecognitionDraftInput,
  ): void {
    workspace.database
      .prepare(`
        INSERT OR IGNORE INTO recognition_batches (
          id, platform, seller_account, status, created_at
        ) VALUES (?, ?, ?, 'awaiting_review', ?)
      `)
      .run(
        input.batchId,
        input.recognition.platform,
        input.recognition.sellerAccount,
        input.createdAt,
      );
    workspace.database
      .prepare("UPDATE recognition_batches SET status = 'awaiting_review' WHERE id = ?")
      .run(input.batchId);

    workspace.database
      .prepare(`
        INSERT INTO source_screenshots (
          id, batch_id, original_name, relative_path, content_sha256, mime_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.screenshotId,
        input.batchId,
        input.originalName,
        workspace.toStoredPath(input.storedPath),
        input.sha256,
        input.mimeType,
        input.createdAt,
      );

    const recognition = input.recognition;
    workspace.database
      .prepare(`
        INSERT INTO order_drafts (
          id, batch_id, screenshot_id, platform, seller_account, order_number,
          alipay_transaction_number, buyer_nickname, recipient, phone, phone_normalized,
          address_original, address_normalized, province, city, district,
          ordered_at_original, ordered_at_normalized, paid_at_original, paid_at_normalized,
          product_total_cents, product_total_present,
          shipping_fee_cents, shipping_fee_present, amount_cents, amount_present,
          platform_transaction_status, fulfillment_status,
          status, recognition_json, review_issues_json, recognition_conflicts_json,
          intake_decision_pending, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, 'awaiting_review', ?, ?, ?, ?, ?
        )
      `)
      .run(
        input.draftId,
        input.batchId,
        input.screenshotId,
        recognition.platform,
        recognition.sellerAccount,
        recognition.orderNumber,
        recognition.alipayTransactionNumber,
        recognition.buyerNickname,
        recognition.recipient,
        recognition.phone,
        recognition.phoneNormalized,
        recognition.addressOriginal,
        recognition.addressNormalized,
        recognition.province,
        recognition.city,
        recognition.district,
        recognition.orderedAtOriginal,
        recognition.orderedAtNormalized,
        recognition.paidAtOriginal,
        recognition.paidAtNormalized,
        recognition.productTotalCents ?? 0,
        recognition.productTotalCents === null ? 0 : 1,
        recognition.shippingFeeCents ?? 0,
        recognition.shippingFeeCents === null ? 0 : 1,
        recognition.amountCents ?? 0,
        recognition.amountCents === null ? 0 : 1,
        recognition.platformTransactionStatus,
        recognition.fulfillmentStatus,
        serializeRecognition(recognition),
        serializeOrderReviewIssues(input.reviewIssues),
        serializeRecognitionConflicts(input.recognitionConflicts),
        input.intakeDecisionPending ? 1 : 0,
        input.createdAt,
      );

    workspace.database
      .prepare(`
        INSERT INTO source_snapshots (
          id, draft_id, order_id, screenshot_id,
          source_type, source_name, source_row_numbers_json,
          recognition_json, confirmed_json, created_at, resolved_at
        ) VALUES (?, ?, NULL, ?, 'screenshot', NULL, NULL, ?, NULL, ?, NULL)
      `)
      .run(
        randomUUID(),
        input.draftId,
        input.screenshotId,
        serializeRecognition(recognition),
        input.createdAt,
      );

    const insertItem = workspace.database.prepare(`
      INSERT INTO draft_items (
        id, draft_id, position, source_title, source_spec,
        unit_price_cents, unit_price_present, quantity, quantity_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    recognition.items.forEach((item, position) => {
      const quantitySource = requiredQuantitySource(item);
      insertItem.run(
        randomUUID(),
        input.draftId,
        position,
        item.sourceTitle,
        item.sourceSpec,
        item.unitPriceCents ?? 0,
        item.unitPriceCents === null ? 0 : 1,
        item.quantity,
        quantitySource,
      );
    });

    const insertEvidence = workspace.database.prepare(`
      INSERT INTO recognition_attempts (
        id, screenshot_id, draft_id, provider, model, request_id,
        schema_version, raw_response, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    input.evidences.forEach((evidence, index) => {
      insertEvidence.run(
        randomUUID(),
        input.screenshotId,
        input.draftId,
        evidence.provider,
        evidence.model,
        evidence.requestId,
        evidence.schemaVersion,
        evidence.rawResponse,
        new Date(Date.parse(input.createdAt) + index).toISOString(),
      );
    });

    if (input.candidateAdjudication) {
      const validatedAudit = optionalValidatedCandidateAdjudicationAudit(
        input.candidateAdjudication,
      );
      if (validatedAudit) {
        persistCandidateAdjudicationAudit(
          workspace,
          input.screenshotId,
          input.draftId,
          input.createdAt,
          validatedAudit,
        );
      }
    }
  }

  private getCustomFieldDefinition(definitionId: string): CustomFieldDefinition {
    const workspace = this.requireWorkspace();
    if (typeof definitionId !== 'string' || !definitionId) {
      throw new Error('自定义字段标识无效');
    }
    const row = workspace.database
      .prepare('SELECT * FROM custom_field_definitions WHERE id = ?')
      .get(definitionId) as SqlRow | undefined;
    if (!row) throw new Error('未找到自定义字段定义');
    return parseCustomFieldDefinitionRow(row);
  }

  private deleteDraftCustomFieldValuesForOrderUpdate(
    orderId: string,
    persistedItemIds: ReadonlyMap<string, string>,
    customValues: DraftCustomFieldValues | undefined,
  ): void {
    if (!customValues) return;
    const workspace = this.requireWorkspace();
    const deleteOrderValue = workspace.database.prepare(`
      DELETE FROM custom_field_values
      WHERE definition_id = ? AND order_id = ?
    `);
    for (const value of customValues.orderValues) {
      if (value.value !== null) continue;
      deleteOrderValue.run(value.definitionId, orderId);
    }

    const deleteItemValue = workspace.database.prepare(`
      DELETE FROM custom_field_values
      WHERE definition_id = ? AND order_item_id = ?
    `);
    for (const value of customValues.itemValues) {
      if (value.value !== null) continue;
      const orderItemId = persistedItemIds.get(value.draftItemId);
      if (!orderItemId) {
        throw new Error('无法唯一确定待清空自定义字段对应的已有商品，请重新核对商品明细');
      }
      deleteItemValue.run(value.definitionId, orderItemId);
    }
  }

  private listCustomFieldValuesForOrder(orderId: string): CustomFieldValueRecord[] {
    const workspace = this.requireWorkspace();
    const rows = workspace.database.prepare(`
      SELECT
        values_table.definition_id,
        values_table.order_id,
        values_table.order_item_id,
        values_table.value_json,
        values_table.created_at,
        values_table.updated_at,
        definitions.value_type,
        definitions.options_json
      FROM custom_field_values AS values_table
      JOIN custom_field_definitions AS definitions
        ON definitions.id = values_table.definition_id
      LEFT JOIN order_items AS items ON items.id = values_table.order_item_id
      WHERE values_table.order_id = ? OR items.order_id = ?
      ORDER BY
        definitions.created_at,
        definitions.id,
        CASE WHEN values_table.order_id IS NOT NULL THEN -1 ELSE items.position END,
        values_table.order_item_id
    `).all(orderId, orderId) as unknown as SqlRow[];
    return rows.map(parseCustomFieldValueRecordRow);
  }

  private listWorkbenchCustomFieldValues(
    granularity: CustomFieldGranularity,
    ownerIds: readonly string[],
    customFieldDefinitionIds?: readonly string[],
  ): CustomFieldValueRecord[] {
    if (ownerIds.length === 0 || customFieldDefinitionIds?.length === 0) return [];
    const workspace = this.requireWorkspace();
    const ownerColumn = granularity === 'order' ? 'order_id' : 'order_item_id';
    const selectedDefinitionIds = customFieldDefinitionIds === undefined
      ? undefined
      : [...new Set(customFieldDefinitionIds)];
    const definitionFilter = selectedDefinitionIds === undefined
      ? ''
      : `AND values_table.definition_id IN (${selectedDefinitionIds.map(() => '?').join(', ')})`;
    const values: CustomFieldValueRecord[] = [];
    const chunkSize = 500;
    for (let offset = 0; offset < ownerIds.length; offset += chunkSize) {
      const chunk = ownerIds.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = workspace.database.prepare(`
        SELECT
          values_table.definition_id,
          values_table.order_id,
          values_table.order_item_id,
          values_table.value_json,
          values_table.created_at,
          values_table.updated_at,
          definitions.value_type,
          definitions.options_json
        FROM custom_field_values AS values_table
        JOIN custom_field_definitions AS definitions
          ON definitions.id = values_table.definition_id
        WHERE definitions.granularity = ?
          AND values_table.${ownerColumn} IN (${placeholders})
          ${definitionFilter}
        ORDER BY
          definitions.created_at,
          definitions.id,
          values_table.${ownerColumn}
      `).all(granularity, ...chunk, ...(selectedDefinitionIds ?? [])) as unknown as SqlRow[];
      values.push(...rows.map(parseCustomFieldValueRecordRow));
    }
    return values;
  }

  private listShipmentGroupCustomFieldValues(
    shipmentGroupIds: readonly string[],
    definitionIds: readonly string[],
    definitions: readonly CustomFieldDefinition[],
  ): ShipmentGroupCustomFieldValue[] {
    if (shipmentGroupIds.length === 0 || definitionIds.length === 0) return [];
    const workspace = this.requireWorkspace();
    const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
    const selectedDefinitionIds = [...new Set(definitionIds)];
    const values: ShipmentGroupCustomFieldValue[] = [];
    const chunkSize = 400;
    for (let offset = 0; offset < shipmentGroupIds.length; offset += chunkSize) {
      const groupChunk = shipmentGroupIds.slice(offset, offset + chunkSize);
      const groupPlaceholders = groupChunk.map(() => '?').join(', ');
      const definitionPlaceholders = selectedDefinitionIds.map(() => '?').join(', ');
      const rows = workspace.database.prepare(`
        SELECT shipment_group_id, definition_id, value_json
        FROM shipment_group_custom_field_values
        WHERE shipment_group_id IN (${groupPlaceholders})
          AND definition_id IN (${definitionPlaceholders})
        ORDER BY shipment_group_id, definition_id
      `).all(...groupChunk, ...selectedDefinitionIds) as unknown as SqlRow[];
      values.push(...rows.map((row) => {
        const definitionId = asString(row.definition_id);
        const definition = definitionsById.get(definitionId);
        if (!definition || definition.granularity !== 'shipment_group') {
          throw new Error('数据库发货组自定义字段定义错误');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(asString(row.value_json));
        } catch (error) {
          throw new Error('数据库发货组自定义字段值格式错误', { cause: error });
        }
        return {
          shipmentGroupId: asString(row.shipment_group_id),
          definitionId,
          value: parsed === null
            ? null
            : normalizeCustomFieldValue(definition.type, parsed, definition.options),
        };
      }));
    }
    return values;
  }

  private insertDefaultCustomFieldValues(
    orderId: string | null,
    orderItemIds: readonly string[],
    now: string,
  ): void {
    const workspace = this.requireWorkspace();
    if (orderId) {
      workspace.database.prepare(`
        INSERT INTO custom_field_values (
          id, definition_id, order_id, order_item_id,
          value_json, created_at, updated_at
        )
        SELECT lower(hex(randomblob(16))), definitions.id, ?, NULL,
          definitions.default_value_json, ?, ?
        FROM custom_field_definitions AS definitions
        WHERE definitions.granularity = 'order'
          AND definitions.default_value_json IS NOT NULL
      `).run(orderId, now, now);
    }
    const insertItemDefaults = workspace.database.prepare(`
      INSERT INTO custom_field_values (
        id, definition_id, order_id, order_item_id,
        value_json, created_at, updated_at
      )
      SELECT lower(hex(randomblob(16))), definitions.id, NULL, ?,
        definitions.default_value_json, ?, ?
      FROM custom_field_definitions AS definitions
      WHERE definitions.granularity = 'order_item'
        AND definitions.default_value_json IS NOT NULL
    `);
    for (const orderItemId of orderItemIds) insertItemDefaults.run(orderItemId, now, now);
  }

  private assertRequiredCustomFieldValuesPresent(orderId: string): void {
    const workspace = this.requireWorkspace();
    const requiredDefinitions = this.listCustomFieldDefinitions()
      .filter((definition) => (
        definition.required && definition.granularity !== 'shipment_group'
      ));
    if (requiredDefinitions.length === 0) return;

    const itemIds = (workspace.database.prepare(`
      SELECT id
      FROM order_items
      WHERE order_id = ?
      ORDER BY position, id
    `).all(orderId) as unknown as SqlRow[]).map((row) => asString(row.id));
    const valueRows = workspace.database.prepare(`
      SELECT definition_id, order_id, order_item_id, value_json
      FROM custom_field_values
      WHERE order_id = ?
        OR order_item_id IN (
          SELECT id FROM order_items WHERE order_id = ?
        )
    `).all(orderId, orderId) as unknown as SqlRow[];
    const valuesByTarget = new Map(valueRows.map((row) => [
      JSON.stringify([
        asString(row.definition_id),
        row.order_id === null ? asString(row.order_item_id) : 'order',
      ]),
      asString(row.value_json),
    ]));

    for (const definition of requiredDefinitions) {
      const targets = definition.granularity === 'order' ? ['order'] : itemIds;
      for (const target of targets) {
        const serialized = valuesByTarget.get(JSON.stringify([definition.id, target]));
        const value = serialized === undefined
          ? null
          : parseStoredCustomFieldValue(serialized, definition);
        if (isMissingCustomFieldValue(value)) {
          throw new Error(`必填自定义字段“${definition.name}”不能为空`);
        }
      }
    }
  }

  private prepareDraftCustomFieldValues(
    draft: OrderDraft,
    input?: DraftCustomFieldValues,
    options: {
      includeDefaults?: boolean;
      enforceRequiredOrderFields?: boolean;
      enforceRequiredItemFields?: boolean;
    } = {},
  ): {
      orderValues: Array<{ definitionId: string; value: CustomFieldValue }>;
      itemValues: Array<{
        definitionId: string;
        draftItemId: string;
        value: CustomFieldValue;
      }>;
    } {
    const includeDefaults = options.includeDefaults ?? true;
    const enforceRequiredOrderFields = options.enforceRequiredOrderFields ?? true;
    const enforceRequiredItemFields = options.enforceRequiredItemFields ?? true;
    const definitions = this.listCustomFieldDefinitions();
    const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
    const draftItemIds = new Set(draft.items.map((item) => item.id));
    if (draftItemIds.size !== draft.items.length) {
      throw new Error('订单草稿商品标识不能重复');
    }
    if (
      input !== undefined &&
      (!input || typeof input !== 'object' ||
        !Array.isArray(input.orderValues) || !Array.isArray(input.itemValues))
    ) {
      throw new Error('订单草稿自定义字段值无效');
    }

    const orderValues = new Map<string, CustomFieldValue>();
    const itemValues = new Map<string, {
      definitionId: string;
      draftItemId: string;
      value: CustomFieldValue;
    }>();
    if (includeDefaults) {
      for (const definition of definitions) {
        if (definition.defaultValue === null) continue;
        if (definition.granularity === 'order') {
          orderValues.set(definition.id, structuredClone(definition.defaultValue));
          continue;
        }
        if (definition.granularity !== 'order_item') continue;
        for (const item of draft.items) {
          const key = JSON.stringify([definition.id, item.id]);
          itemValues.set(key, {
            definitionId: definition.id,
            draftItemId: item.id,
            value: structuredClone(definition.defaultValue),
          });
        }
      }
    }

    const seenOrderDefinitions = new Set<string>();
    for (const entry of input?.orderValues ?? []) {
      const definition = definitionsById.get(entry.definitionId);
      if (!definition) throw new Error('未找到订单草稿的自定义字段定义');
      if (definition.granularity !== 'order') {
        throw new Error('商品粒度字段不能保存到订单草稿');
      }
      if (seenOrderDefinitions.has(definition.id)) {
        throw new Error('同一订单草稿字段不能重复赋值');
      }
      seenOrderDefinitions.add(definition.id);
      if (entry.value === null) {
        orderValues.delete(definition.id);
      } else {
        orderValues.set(
          definition.id,
          normalizeCustomFieldValue(definition.type, entry.value, definition.options),
        );
      }
    }

    const seenItemTargets = new Set<string>();
    for (const entry of input?.itemValues ?? []) {
      const definition = definitionsById.get(entry.definitionId);
      if (!definition) throw new Error('未找到订单草稿商品的自定义字段定义');
      if (definition.granularity !== 'order_item') {
        throw new Error('订单粒度字段不能保存到草稿商品');
      }
      if (!draftItemIds.has(entry.draftItemId)) {
        throw new Error('自定义字段对应的草稿商品不存在');
      }
      const key = JSON.stringify([definition.id, entry.draftItemId]);
      if (seenItemTargets.has(key)) {
        throw new Error('同一草稿商品字段不能重复赋值');
      }
      seenItemTargets.add(key);
      if (entry.value === null) {
        itemValues.delete(key);
      } else {
        itemValues.set(key, {
          definitionId: definition.id,
          draftItemId: entry.draftItemId,
          value: normalizeCustomFieldValue(
            definition.type,
            entry.value,
            definition.options,
          ),
        });
      }
    }

    if (enforceRequiredOrderFields) {
      const missingRequired = definitions.some((definition) => (
        definition.granularity === 'order' &&
        definition.required &&
        isMissingCustomFieldValue(orderValues.get(definition.id))
      ));
      if (missingRequired) throw new Error('订单缺少必填自定义字段');
    }
    if (enforceRequiredItemFields) {
      const missingRequired = definitions.some((definition) => (
        definition.granularity === 'order_item' &&
        definition.required &&
        draft.items.some((item) => isMissingCustomFieldValue(
          itemValues.get(JSON.stringify([definition.id, item.id]))?.value,
        ))
      ));
      if (missingRequired) throw new Error('商品缺少必填自定义字段');
    }

    return {
      orderValues: [...orderValues].map(([definitionId, value]) => ({
        definitionId,
        value,
      })),
      itemValues: [...itemValues.values()],
    };
  }

  private assertOrderEditIdentityAvailable(
    orderId: string,
    platform: OriginalOrder['platform'],
    sellerAccount: string,
    orderNumber: string,
  ): void {
    const conflict = this.requireWorkspace().database.prepare(`
      SELECT id
      FROM original_orders
      WHERE platform = ?
        AND seller_account_normalized = ?
        AND platform_order_number_normalized = ?
        AND id <> ?
      LIMIT 1
    `).get(
      platform,
      normalizedOrderIdentityPart(sellerAccount),
      normalizedOrderIdentityPart(orderNumber),
      orderId,
    );
    if (conflict) {
      throw new Error('订单身份与另一笔已有订单冲突，请更正后重试');
    }
  }

  private aftersalesService(): AftersalesApplicationService {
    return new AftersalesApplicationService(
      this.requireWorkspace(),
      (recordId) => this.getShipmentRecord(recordId),
    );
  }

  private fulfillmentPlanService(): FulfillmentPlanService {
    return new FulfillmentPlanService(this.requireWorkspace());
  }

  private fulfillmentDemandService(): FulfillmentDemandService {
    return new FulfillmentDemandService(this.requireWorkspace());
  }

  private inventoryLedgerService(): InventoryLedgerService {
    return new InventoryLedgerService(this.requireWorkspace());
  }

  private purchaseOrderService(): PurchaseOrderService {
    return new PurchaseOrderService(this.requireWorkspace());
  }

  private fundsService(): FundsService {
    return new FundsService(this.requireWorkspace());
  }

  private profitService(): ProfitService {
    return new ProfitService(this.requireWorkspace());
  }

  private recipientService(): RecipientService {
    return new RecipientService(this.requireWorkspace());
  }

  private aftersalesWorkflowTemplateService(): AftersalesWorkflowTemplateService {
    return new AftersalesWorkflowTemplateService(this.requireWorkspace());
  }

  private logisticsExceptionService(): LogisticsExceptionService {
    return new LogisticsExceptionService(this.requireWorkspace());
  }

  private nextSystemOrderNumber(createdAt: string): string {
    const workspace = this.requireWorkspace();
    const dateKey = shanghaiDateKey(createdAt);
    const row = workspace.database.prepare(`
      SELECT system_order_number
      FROM original_orders
      WHERE system_order_number LIKE ?
      ORDER BY system_order_number DESC
      LIMIT 1
    `).get(`${dateKey}-%`) as SqlRow | undefined;
    const nextSequence = row
      ? systemOrderNumberSequence(asString(row.system_order_number), dateKey) + 1
      : 1;
    return systemOrderNumberForSequence(dateKey, nextSequence);
  }

  private requireWorkspace(): Workspace {
    if (!this.workspace) throw new Error('请先选择数据目录');
    return this.workspace;
  }
}

function toConfirmedOrderSnapshot(
  draft: Omit<RecognitionResult, 'items' | 'fulfillmentStatus'> & {
    fulfillmentStatus: OriginalOrder['fulfillmentStatus'];
    items: readonly RecognitionItem[];
  },
): ConfirmedOrderSnapshot {
  return {
    platform: draft.platform,
    sellerAccount: draft.sellerAccount,
    orderNumber: draft.orderNumber,
    alipayTransactionNumber: draft.alipayTransactionNumber,
    buyerNickname: draft.buyerNickname,
    recipient: draft.recipient,
    phone: draft.phone,
    phoneNormalized: draft.phoneNormalized,
    addressOriginal: draft.addressOriginal,
    addressNormalized: draft.addressNormalized,
    province: draft.province,
    city: draft.city,
    district: draft.district,
    orderedAtOriginal: draft.orderedAtOriginal,
    orderedAtNormalized: draft.orderedAtNormalized,
    paidAtOriginal: draft.paidAtOriginal,
    paidAtNormalized: draft.paidAtNormalized,
    productTotalCents: draft.productTotalCents,
    shippingFeeCents: draft.shippingFeeCents,
    amountCents: draft.amountCents,
    platformTransactionStatus: draft.platformTransactionStatus,
    fulfillmentStatus: draft.fulfillmentStatus,
    items: draft.items.map((item) => {
      const quantitySource = requiredQuantitySource(item);
      return {
        sourceTitle: item.sourceTitle,
        sourceSpec: item.sourceSpec,
        unitPriceCents: item.unitPriceCents,
        quantity: item.quantity,
        quantitySource,
        quantityInferred: quantityInferredFromSource(quantitySource),
      };
    }),
  };
}

function withOcrQuantitySources(recognition: RecognitionResult): RecognitionResult {
  return {
    ...recognition,
    items: recognition.items.map((item) => {
      const quantitySource = quantitySourceFromOcr(item.quantityInferred);
      if (item.quantitySource !== undefined && item.quantitySource !== quantitySource) {
        throw new Error('OCR 数量来源与识别结果不一致');
      }
      return {
        ...item,
        quantitySource,
        quantityInferred: quantityInferredFromSource(quantitySource),
      };
    }),
  };
}

function withManualQuantityEdits(
  persisted: OrderDraft,
  reviewed: OrderDraft,
): OrderDraft {
  const persistedItems = new Map(persisted.items.map((item) => [item.id, item]));
  return {
    ...reviewed,
    items: reviewed.items.map((item) => {
      if (item.quantitySource !== undefined && !isQuantitySource(item.quantitySource)) {
        throw new Error('商品数量来源格式错误');
      }
      const prior = persistedItems.get(item.id);
      const quantitySource: QuantitySource = !prior ||
          item.quantity !== prior.quantity ||
          item.quantitySource === 'manual'
        ? 'manual'
        : requiredQuantitySource(prior);
      return {
        ...item,
        quantitySource,
        quantityInferred: quantityInferredFromSource(quantitySource),
      };
    }),
  };
}

function withHigherPriorityCurrentQuantities<T extends { items: Array<RecognitionItem & { id: string }> }>(
  current: OriginalOrder,
  incoming: T,
  matchItems: typeof matchOrderItemIds = matchOrderItemIds,
): T {
  const currentIdByIncomingId = matchItems(current.items, incoming.items);
  const currentById = new Map(current.items.map((item) => [item.id, item]));
  return {
    ...incoming,
    items: incoming.items.map((item) => {
      const currentId = currentIdByIncomingId.get(item.id);
      const currentItem = currentId ? currentById.get(currentId) : undefined;
      if (!currentItem) return item;
      const incomingSource = requiredQuantitySource(item);
      const currentSource = requiredQuantitySource(currentItem);
      if (quantitySourcePriority(currentSource) <= quantitySourcePriority(incomingSource)) {
        return item;
      }
      return {
        ...item,
        quantity: currentItem.quantity,
        quantitySource: currentSource,
        quantityInferred: quantityInferredFromSource(currentSource),
      };
    }),
  };
}

function matchHistoricalOrderItemIds(
  existingItems: readonly (RecognitionItem & { id: string })[],
  importedItems: readonly (RecognitionItem & { id: string })[],
): Map<string, string> {
  return new Map(pairOrderItemsForComparison(existingItems, importedItems).map((pair) => (
    [importedItems[pair.afterIndex].id, existingItems[pair.beforeIndex].id]
  )));
}

function requiredQuantitySource(item: RecognitionItem): QuantitySource {
  if (!isQuantitySource(item.quantitySource)) {
    throw new Error('商品数量来源格式错误');
  }
  return item.quantitySource;
}

function serializeRecognition(
  recognition: RecognitionResult | ConfirmedOrderSnapshot,
): string {
  return JSON.stringify({
    ...recognition,
    items: recognition.items.map(({ quantityInferred: _legacyFlag, ...item }) => item),
  });
}

function validateRecognition(recognition: RecognitionResult): void {
  if (!isRecognitionFulfillmentStatus(recognition.fulfillmentStatus)) {
    throw new Error('OCR 识别履约状态格式错误');
  }
  validateValues(recognition, recognition.items, false);
}

function validateDraft(draft: OrderDraft): void {
  validateValues(draft, draft.items, true);
}

function validateValues(
  value: Omit<RecognitionResult, 'items' | 'fulfillmentStatus'> & {
    fulfillmentStatus: OriginalOrder['fulfillmentStatus'];
  },
  items: RecognitionItem[],
  strict: boolean,
): void {
  if (value.platform !== 'xianyu') {
    throw new Error('当前仅支持闲鱼平台订单');
  }
  if (strict) {
    const required = [
      value.platform,
      value.sellerAccount,
      value.orderNumber,
      value.recipient,
      value.phone,
      value.addressOriginal,
    ];
    if (required.some((entry) => entry.trim().length === 0)) {
      throw new Error('订单草稿缺少必填信息');
    }
    if (!isValidPhonePair(value.phone, value.phoneNormalized)) {
      throw new Error('手机号格式无效，请根据截图完整修正');
    }
    if (value.addressNormalized !== normalizeAddress(value.addressOriginal)) {
      throw new Error('规范化地址与完整收货地址不一致');
    }
    const addressParts = [value.province, value.city, value.district]
      .map((part) => normalizeAddress(part))
      .filter(Boolean);
    if (addressParts.some((part) => !value.addressNormalized.includes(part))) {
      throw new Error('省市区与完整收货地址不一致');
    }
    validateShanghaiDateTimePair(
      '下单时间',
      value.orderedAtOriginal,
      value.orderedAtNormalized,
    );
    validateShanghaiDateTimePair(
      '付款时间',
      value.paidAtOriginal,
      value.paidAtNormalized,
    );
  }
  const amounts = [
    ['商品总价', value.productTotalCents],
    ['运费', value.shippingFeeCents],
    ['成交金额', value.amountCents],
  ] as const;
  for (const [label, amount] of amounts) {
    if (amount === null) {
      if (strict) throw new Error(`${label}不能为空`);
      continue;
    }
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error(`${label}必须使用非负整数分`);
    }
  }
  if (!['paid', 'cancelled', 'refunded', 'unknown'].includes(value.platformTransactionStatus)) {
    throw new Error('平台交易状态格式错误');
  }
  if (![
    'pending_shipment',
    'shipped',
    'unknown',
  ].includes(value.fulfillmentStatus)) {
    throw new Error('履约状态格式错误');
  }
  if (!Array.isArray(items) || (strict && items.length === 0)) {
    throw new Error('订单至少需要一项商品明细');
  }
  for (const item of items) {
    const quantitySource = requiredQuantitySource(item);
    if (strict && !item.sourceTitle.trim()) throw new Error('商品标题不能为空');
    if (item.unitPriceCents === null) {
      if (strict) throw new Error('商品单价不能为空');
    } else if (!Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0) {
      throw new Error('商品单价必须使用非负整数分');
    }
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw new Error('商品数量必须为正整数');
    }
    if (quantitySource === 'system_default_1' && item.quantity !== 1) {
      throw new Error('系统默认数量必须为 1');
    }
  }
}

function parseStoredRecognition(serialized: string): RecognitionResult {
  const parsed: unknown = JSON.parse(serialized);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('识别快照格式错误');
  }
  const stored = parsed as Record<string, unknown>;
  const phone = storedText(stored.phone, '');
  const addressOriginal = storedText(stored.addressOriginal, '');
  const amountCents = storedOptionalAmount(stored.amountCents, null);
  const items = Array.isArray(stored.items)
    ? stored.items.map((value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new Error('识别快照商品格式错误');
        }
        const item = value as RecognitionItem;
        const quantitySource = item.quantitySource === undefined
          ? quantitySourceFromLegacy(item.quantityInferred === true)
          : asQuantitySource(item.quantitySource, '识别快照数量来源格式错误');
        return {
          ...item,
          quantitySource,
          quantityInferred: quantityInferredFromSource(quantitySource),
        };
      })
    : [];

  return {
    platform: 'xianyu',
    sellerAccount: storedText(stored.sellerAccount, ''),
    orderNumber: storedText(stored.orderNumber, ''),
    alipayTransactionNumber: storedText(stored.alipayTransactionNumber, ''),
    buyerNickname: storedText(stored.buyerNickname, ''),
    recipient: storedText(stored.recipient, ''),
    phone,
    phoneNormalized: storedText(stored.phoneNormalized, phone),
    addressOriginal,
    addressNormalized: storedText(stored.addressNormalized, addressOriginal),
    province: storedText(stored.province, ''),
    city: storedText(stored.city, ''),
    district: storedText(stored.district, ''),
    orderedAtOriginal: storedText(stored.orderedAtOriginal, ''),
    orderedAtNormalized: storedText(stored.orderedAtNormalized, ''),
    paidAtOriginal: storedText(stored.paidAtOriginal, ''),
    paidAtNormalized: storedText(stored.paidAtNormalized, ''),
    productTotalCents: storedOptionalAmount(stored.productTotalCents, null),
    shippingFeeCents: storedOptionalAmount(stored.shippingFeeCents, null),
    amountCents,
    platformTransactionStatus: isPlatformTransactionStatus(
      stored.platformTransactionStatus,
    )
      ? stored.platformTransactionStatus
      : 'paid',
    fulfillmentStatus: isRecognitionFulfillmentStatus(stored.fulfillmentStatus)
      ? stored.fulfillmentStatus
      : 'pending_shipment',
    items,
  };
}

function parseStoredConfirmedOrderSnapshot(serialized: string): ConfirmedOrderSnapshot {
  const recognition = parseStoredRecognition(serialized);
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  return {
    ...recognition,
    fulfillmentStatus: isFulfillmentStatus(parsed.fulfillmentStatus)
      ? parsed.fulfillmentStatus
      : recognition.fulfillmentStatus,
  };
}

function parseSourceRowNumbers(serialized: string): number[] {
  const parsed: unknown = JSON.parse(serialized);
  if (
    !Array.isArray(parsed) || parsed.length === 0 || parsed.length > 10_000 ||
    !parsed.every((value) => Number.isSafeInteger(value) && value >= 2 && value <= 10_001)
  ) {
    throw new Error('历史导入来源行号格式错误');
  }
  return parsed as number[];
}

function storedText(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function storedOptionalAmount(
  value: unknown,
  fallback: number | null,
): number | null {
  if (value === null) return null;
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fallback;
}

function parseOrderChangeValue(serialized: string): OrderChangeValue {
  const parsed: unknown = JSON.parse(serialized);
  if (!isOrderChangeValue(parsed)) throw new Error('数据库订单字段修改值格式错误');
  return parsed;
}

function isOrderChangeValue(value: unknown): value is OrderChangeValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isOrderChangeValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isOrderChangeValue);
}

function parseStoredOrderReviewIssues(
  value: string | number | null | undefined,
): OrderReviewIssueCode[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(asString(value));
  } catch (error) {
    throw new Error('订单草稿待确认原因格式错误', { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every(isOrderReviewIssueCode)) {
    throw new Error('订单草稿待确认原因格式错误');
  }
  return normalizeOrderReviewIssues(parsed);
}

function serializeOrderReviewIssues(
  reviewIssues: readonly OrderReviewIssueCode[],
): string {
  if (!Array.isArray(reviewIssues) || !reviewIssues.every(isOrderReviewIssueCode)) {
    throw new Error('订单草稿待确认原因格式无效');
  }
  return JSON.stringify(normalizeOrderReviewIssues(reviewIssues));
}

function parseStoredRecognitionConflicts(
  value: string | number | null | undefined,
): RecognitionConflictDetail[] {
  const serialized = asString(value);
  if (serialized.length > MAX_RECOGNITION_CONFLICTS_JSON_LENGTH) {
    throw new Error('订单草稿识别冲突明细格式错误');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error('订单草稿识别冲突明细格式错误', { cause: error });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > MAX_RECOGNITION_CONFLICTS ||
    !parsed.every(isRecognitionConflictDetail)
  ) {
    throw new Error('订单草稿识别冲突明细格式错误');
  }
  return parsed;
}

function serializeRecognitionConflicts(
  conflicts: readonly RecognitionConflictDetail[],
): string {
  if (
    !Array.isArray(conflicts) ||
    conflicts.length > MAX_RECOGNITION_CONFLICTS ||
    !conflicts.every(isRecognitionConflictDetail)
  ) {
    throw new Error('订单草稿识别冲突明细格式无效');
  }
  const serialized = JSON.stringify(conflicts.map((conflict) => ({
    region: conflict.region,
    field: conflict.field,
    kind: conflict.kind,
    ...(conflict.itemIndex === undefined ? {} : { itemIndex: conflict.itemIndex }),
    locatedValues: [...conflict.locatedValues],
    extractedValues: [...conflict.extractedValues],
    retainedValue: conflict.retainedValue,
  })));
  if (serialized.length > MAX_RECOGNITION_CONFLICTS_JSON_LENGTH) {
    throw new Error('订单草稿识别冲突明细格式无效');
  }
  return serialized;
}

function isRecognitionConflictDetail(value: unknown): value is RecognitionConflictDetail {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).every((key) => RECOGNITION_CONFLICT_DETAIL_KEYS.has(key)) &&
    RECOGNITION_CONFLICT_REGIONS.some((region) => region === candidate.region) &&
    RECOGNITION_CONFLICT_FIELDS.some((field) => field === candidate.field) &&
    RECOGNITION_CONFLICT_KINDS.some((kind) => kind === candidate.kind) &&
    (
      candidate.itemIndex === undefined ||
      (Number.isSafeInteger(candidate.itemIndex) && (candidate.itemIndex as number) >= 0)
    ) &&
    isStringArray(candidate.locatedValues) &&
    isStringArray(candidate.extractedValues) &&
    (
      candidate.retainedValue === null ||
      isBoundedRecognitionConflictText(candidate.retainedValue)
    );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length <= MAX_RECOGNITION_CONFLICT_VALUES &&
    value.every(isBoundedRecognitionConflictText);
}

function isBoundedRecognitionConflictText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_RECOGNITION_CONFLICT_TEXT_LENGTH;
}

function reviewIssuesForRetargetedOrder(
  draft: Pick<OrderDraft, 'reviewIssues'>,
  equivalent: boolean,
): OrderReviewIssueCode[] {
  return normalizeOrderReviewIssues([
    ...(draft.reviewIssues ?? []).filter((issue) => (
      issue !== 'duplicate_order' && issue !== 'order_content_changed'
    )),
    equivalent ? 'duplicate_order' : 'order_content_changed',
  ]);
}

function reviewIssuesForNewOrder(
  draft: Pick<OrderDraft, 'reviewIssues'>,
): OrderReviewIssueCode[] {
  return normalizeOrderReviewIssues((draft.reviewIssues ?? []).filter((issue) => (
    issue !== 'duplicate_order' && issue !== 'order_content_changed'
  )));
}

function isPlatformTransactionStatus(
  value: unknown,
): value is OriginalOrder['platformTransactionStatus'] {
  return value === 'paid' || value === 'cancelled' || value === 'refunded' || value === 'unknown';
}

function asPlatformTransactionStatus(
  value: string | number | null | undefined,
): OriginalOrder['platformTransactionStatus'] {
  if (!isPlatformTransactionStatus(value)) throw new Error('数据库平台交易状态格式错误');
  return value;
}

function asOrderPlatform(
  value: string | number | null | undefined,
): OriginalOrder['platform'] {
  if (value !== 'xianyu') throw new Error('数据库订单平台格式错误');
  return value;
}

function isRecognitionFulfillmentStatus(
  value: unknown,
): value is RecognitionFulfillmentStatus {
  return value === 'pending_shipment' || value === 'shipped' || value === 'unknown';
}

function asFulfillmentStatus(
  value: string | number | null | undefined,
): OriginalOrder['fulfillmentStatus'] {
  if (!isFulfillmentStatus(value)) throw new Error('数据库履约状态格式错误');
  return value;
}

function asRecognitionFulfillmentStatus(
  value: string | number | null | undefined,
): RecognitionFulfillmentStatus {
  if (!isRecognitionFulfillmentStatus(value)) {
    throw new Error('数据库草稿履约状态格式错误');
  }
  return value;
}

function asLifecycleStatus(
  value: string | number | null | undefined,
): OriginalOrder['lifecycleStatus'] {
  if (value !== 'active' && value !== 'trashed' && value !== 'deleted') {
    throw new Error('数据库生命周期状态格式错误');
  }
  return value;
}

function asRecognitionBatchItemStatus(
  value: string | number | null | undefined,
): RecognitionBatchItemStatus {
  if (!isRecognitionBatchItemStatus(value)) {
    throw new Error('数据库来源截图识别状态格式错误');
  }
  return value;
}

function asOrderSourceType(
  value: string | number | null | undefined,
): 'screenshot' | 'historical_import' {
  if (value !== 'screenshot' && value !== 'historical_import') {
    throw new Error('数据库来源快照类型格式错误');
  }
  return value;
}

function asRecognitionBatchItemResolution(
  value: string | number | null | undefined,
): RecognitionBatchItemResolution {
  if (
    value !== 'new_order' &&
    value !== 'identical_image' &&
    value !== 'equivalent_order' &&
    value !== 'order_updated'
  ) {
    throw new Error('数据库来源截图处理结果格式错误');
  }
  return value;
}

function persistCandidateAdjudicationAudit(
  workspace: Workspace,
  screenshotId: string,
  draftId: string,
  createdAt: string,
  validated: CandidateAdjudicationAudit,
): void {
  const runId = randomUUID();
  workspace.database.prepare(`
    INSERT INTO candidate_adjudication_runs (
      id, screenshot_id, draft_id, provider, model,
      status, failure_code, failure_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    screenshotId,
    draftId,
    validated.provider,
    validated.model,
    validated.status,
    validated.failureCode ?? null,
    validated.failureMessage ?? null,
    createdAt,
  );
  const insertDecision = workspace.database.prepare(`
    INSERT INTO candidate_adjudication_decisions (
      run_id, position, ambiguity_id, region, field, item_index,
      candidates_json, selected_candidate_id, context_lines_json,
      outcome, failure_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  validated.decisions.forEach((decision, position) => {
    insertDecision.run(
      runId,
      position,
      decision.ambiguityId,
      decision.region,
      decision.field,
      decision.itemIndex ?? null,
      JSON.stringify(decision.candidates),
      decision.selectedCandidateId ?? null,
      JSON.stringify(decision.contextLines),
      decision.outcome,
      decision.failureCode ?? null,
    );
  });
}

function optionalValidatedCandidateAdjudicationAudit(
  audit: CandidateAdjudicationAudit,
): CandidateAdjudicationAudit | undefined {
  try {
    return validateCandidateAdjudicationAudit(audit);
  } catch {
    // Candidate adjudication is optional. Preserve a bounded rejection record
    // when possible, but never let malformed adapter output roll back OCR.
    try {
      return validateCandidateAdjudicationAudit({
        provider: audit.provider,
        model: audit.model,
        status: 'rejected',
        failureCode: 'invalid_response',
        failureMessage: '候选裁决记录不符合安全边界，已拒绝应用',
        decisions: [],
      });
    } catch {
      return undefined;
    }
  }
}

function validateCandidateAdjudicationAudit(
  audit: CandidateAdjudicationAudit,
): CandidateAdjudicationAudit {
  const provider = asCandidateModelProvider(audit.provider);
  const model = boundedNonEmptyText(audit.model, 200, '候选裁决模型名称无效');
  const status = asCandidateAdjudicationRunStatus(audit.status);
  const failureCode = optionalCandidateAdjudicationFailureCode(
    audit.failureCode ?? null,
  );
  const failureMessage = audit.failureMessage === undefined
    ? undefined
    : boundedNonEmptyText(audit.failureMessage, 2_000, '候选裁决失败原因无效');
  if (status === 'succeeded' && (failureCode || failureMessage)) {
    throw new Error('成功的候选裁决不能包含失败原因');
  }
  if (
    !Array.isArray(audit.decisions) ||
    audit.decisions.length >
      CANDIDATE_VERIFICATION_LIMITS.auditAmbiguitiesPerScreenshot
  ) {
    throw new Error('候选裁决逐项记录数量无效');
  }
  const ambiguityIds = new Set<string>();
  const decisions = audit.decisions.map((decision) => {
    const validated = validateCandidateAdjudicationDecision(decision);
    if (ambiguityIds.has(validated.ambiguityId)) {
      throw new Error('候选裁决包含重复歧义标识');
    }
    ambiguityIds.add(validated.ambiguityId);
    return validated;
  });
  return {
    provider,
    model,
    status,
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(failureMessage === undefined ? {} : { failureMessage }),
    decisions,
  };
}

function validateCandidateAdjudicationDecision(
  decision: CandidateAdjudicationDecisionAudit,
): CandidateAdjudicationDecisionAudit {
  const ambiguityId = boundedNonEmptyText(
    decision.ambiguityId,
    CANDIDATE_VERIFICATION_LIMITS.identifierLength,
    '候选裁决歧义标识无效',
  );
  const region = asCandidateRegion(decision.region);
  const field = boundedNonEmptyText(
    decision.field,
    CANDIDATE_VERIFICATION_LIMITS.fieldLength,
    '候选裁决字段无效',
  );
  const itemIndex = decision.itemIndex;
  if (
    itemIndex !== undefined &&
    (!Number.isSafeInteger(itemIndex) || itemIndex < 0)
  ) {
    throw new Error('候选裁决商品位置无效');
  }
  if (
    !Array.isArray(decision.candidates) ||
    decision.candidates.length < 2 ||
    decision.candidates.length > CANDIDATE_VERIFICATION_LIMITS.candidatesPerAmbiguity
  ) {
    throw new Error('候选裁决候选数量无效');
  }
  if (
    !Array.isArray(decision.contextLines) ||
    decision.contextLines.length === 0 ||
    decision.contextLines.length > CANDIDATE_VERIFICATION_LIMITS.contextLinesPerAmbiguity
  ) {
    throw new Error('候选裁决原文行数量无效');
  }
  const contextLines = decision.contextLines.map(validateCandidateContextLine);
  const lineIds = new Set(contextLines.map(({ lineId }) => lineId));
  if (lineIds.size !== contextLines.length) {
    throw new Error('候选裁决包含重复原文行标识');
  }
  const candidates = decision.candidates.map((candidate) =>
    validateCandidate(candidate, lineIds)
  );
  const candidateIds = new Set(candidates.map(({ candidateId }) => candidateId));
  if (candidateIds.size !== candidates.length) {
    throw new Error('候选裁决包含重复候选标识');
  }
  const outcome = asCandidateAdjudicationDecisionOutcome(decision.outcome);
  const selectedCandidateId = decision.selectedCandidateId;
  if (
    outcome === 'selected' &&
    (
      typeof selectedCandidateId !== 'string' ||
      !candidateIds.has(selectedCandidateId)
    )
  ) {
    throw new Error('候选裁决选择了未知候选');
  }
  if (outcome !== 'selected' && selectedCandidateId !== undefined) {
    throw new Error('未选择的候选裁决不能包含候选标识');
  }
  const failureCode = optionalCandidateAdjudicationFailureCode(
    decision.failureCode ?? null,
  );
  return {
    ambiguityId,
    region,
    field,
    ...(itemIndex === undefined ? {} : { itemIndex }),
    candidates,
    contextLines,
    ...(selectedCandidateId === undefined ? {} : { selectedCandidateId }),
    outcome,
    ...(failureCode === undefined ? {} : { failureCode }),
  };
}

function validateCandidate(
  candidate: Candidate,
  lineIds: ReadonlySet<string>,
): Candidate {
  const candidateId = boundedNonEmptyText(
    candidate.candidateId,
    CANDIDATE_VERIFICATION_LIMITS.identifierLength,
    '候选裁决候选标识无效',
  );
  const displayText = boundedNonEmptyText(
    candidate.displayText,
    CANDIDATE_VERIFICATION_LIMITS.candidateDisplayTextLength,
    '候选裁决候选说明无效',
  );
  if (
    !Array.isArray(candidate.evidenceRefs) ||
    candidate.evidenceRefs.length === 0 ||
    candidate.evidenceRefs.length > CANDIDATE_VERIFICATION_LIMITS.evidenceRefsPerCandidate
  ) {
    throw new Error('候选裁决候选依据无效');
  }
  const evidenceRefs = candidate.evidenceRefs.map((reference) => {
    const lineId = boundedNonEmptyText(
      reference.lineId,
      CANDIDATE_VERIFICATION_LIMITS.identifierLength,
      '候选裁决原文行标识无效',
    );
    if (!lineIds.has(lineId)) throw new Error('候选裁决引用了未知原文行');
    const startOffset = optionalSafeOffset(reference.startOffset);
    const endOffset = optionalSafeOffset(reference.endOffset);
    if (
      startOffset !== undefined &&
      endOffset !== undefined &&
      endOffset < startOffset
    ) {
      throw new Error('候选裁决原文范围无效');
    }
    return {
      lineId,
      ...(startOffset === undefined ? {} : { startOffset }),
      ...(endOffset === undefined ? {} : { endOffset }),
    };
  });
  return { candidateId, displayText, evidenceRefs };
}

function validateCandidateContextLine(line: CandidateContextLine): CandidateContextLine {
  const lineId = boundedNonEmptyText(
    line.lineId,
    CANDIDATE_VERIFICATION_LIMITS.identifierLength,
    '候选裁决原文行标识无效',
  );
  const text = boundedNonEmptyText(
    line.text,
    CANDIDATE_VERIFICATION_LIMITS.contextLineTextLength,
    '候选裁决原文行无效',
  );
  const coordinates = [line.left, line.top, line.right, line.bottom];
  if (!coordinates.every((value) => Number.isFinite(value))) {
    throw new Error('候选裁决原文坐标无效');
  }
  if (line.right < line.left || line.bottom < line.top) {
    throw new Error('候选裁决原文坐标无效');
  }
  return { lineId, text, left: line.left, top: line.top, right: line.right, bottom: line.bottom };
}

function parseCandidateAdjudicationDecisionRow(
  row: SqlRow,
): CandidateAdjudicationDecisionAudit {
  const candidates = parseCandidateAuditJson(
    asString(row.candidates_json),
    '数据库候选裁决候选格式错误',
  );
  const contextLines = parseCandidateAuditJson(
    asString(row.context_lines_json),
    '数据库候选裁决原文依据格式错误',
  );
  const candidateDecision = {
    ambiguityId: asString(row.ambiguity_id),
    region: asCandidateRegion(row.region),
    field: asString(row.field),
    ...(row.item_index === null ? {} : { itemIndex: asNumber(row.item_index) }),
    candidates,
    contextLines,
    ...(row.selected_candidate_id === null
      ? {}
      : { selectedCandidateId: asString(row.selected_candidate_id) }),
    outcome: asCandidateAdjudicationDecisionOutcome(row.outcome),
    ...(row.failure_code === null
      ? {}
      : { failureCode: optionalCandidateAdjudicationFailureCode(row.failure_code) }),
  } as CandidateAdjudicationDecisionAudit;
  return validateCandidateAdjudicationDecision(candidateDecision);
}

function parseCandidateAuditJson(value: string, message: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error(message);
  return parsed;
}

function asCandidateModelProvider(value: unknown): CandidateModelProvider {
  if (
    value === 'deepseek' ||
    value === 'aliyun-bailian' ||
    value === 'openai-compatible'
  ) return value;
  throw new Error('数据库候选裁决服务商格式错误');
}

function asCandidateRegion(value: unknown): CandidateRegion {
  if (typeof value === 'string' && CANDIDATE_REGIONS.includes(value as CandidateRegion)) {
    return value as CandidateRegion;
  }
  throw new Error('数据库候选裁决区域格式错误');
}

function asCandidateAdjudicationRunStatus(
  value: unknown,
): CandidateAdjudicationRunStatus {
  if (
    value === 'succeeded' ||
    value === 'partial' ||
    value === 'failed' ||
    value === 'rejected'
  ) return value;
  throw new Error('数据库候选裁决状态格式错误');
}

function asCandidateAdjudicationDecisionOutcome(
  value: unknown,
): CandidateAdjudicationDecisionOutcome {
  if (value === 'selected' || value === 'unresolved' || value === 'invalid') {
    return value;
  }
  throw new Error('数据库候选裁决结果格式错误');
}

const CANDIDATE_ADJUDICATION_FAILURE_CODES = new Set<
  CandidateAdjudicationFailureCode
>([
  'invalid_request',
  'timeout',
  'authentication',
  'rate_limited',
  'network',
  'remote_error',
  'response_too_large',
  'unsafe_response',
  'invalid_response',
]);

function optionalCandidateAdjudicationFailureCode(
  value: unknown,
): CandidateAdjudicationFailureCode | undefined {
  if (value === null || value === undefined) return undefined;
  if (
    typeof value === 'string' &&
    CANDIDATE_ADJUDICATION_FAILURE_CODES.has(value as CandidateAdjudicationFailureCode)
  ) return value as CandidateAdjudicationFailureCode;
  throw new Error('数据库候选裁决失败代码格式错误');
}

function optionalSafeOffset(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('候选裁决原文范围无效');
  }
  return value as number;
}

function boundedNonEmptyText(
  value: unknown,
  maximumLength: number,
  message: string,
): string {
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) throw new Error(message);
  return normalized;
}

function boundedText(value: unknown, maximumLength: number, message: string): string {
  if (typeof value !== 'string' || value.length > maximumLength) throw new Error(message);
  return value;
}

function emptyManualRecognition(): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '',
    orderNumber: '',
    alipayTransactionNumber: '',
    buyerNickname: '',
    recipient: '',
    phone: '',
    phoneNormalized: '',
    addressOriginal: '',
    addressNormalized: '',
    province: '',
    city: '',
    district: '',
    orderedAtOriginal: '',
    orderedAtNormalized: '',
    paidAtOriginal: '',
    paidAtNormalized: '',
    productTotalCents: null,
    shippingFeeCents: null,
    amountCents: null,
    platformTransactionStatus: 'unknown',
    fulfillmentStatus: 'unknown',
    items: [{
      sourceTitle: '',
      sourceSpec: '',
      unitPriceCents: null,
      quantity: 1,
      quantitySource: 'manual',
      quantityInferred: false,
    }],
  };
}

function asString(value: string | number | null | undefined): string {
  if (typeof value !== 'string') throw new Error('数据库文本字段格式错误');
  return value;
}

function asNumber(value: string | number | null | undefined): number {
  if (typeof value !== 'number') throw new Error('数据库数字字段格式错误');
  return value;
}

function asShipmentLogisticsStatus(
  value: string | number | null | undefined,
): ShipmentLogisticsStatus {
  if (isShipmentLogisticsStatus(value)) return value;
  throw new Error('数据库包裹物流状态错误');
}

function parseShipmentStatusPayload(value: unknown): {
  carrierAcceptedAt: string | null;
} {
  if (typeof value !== 'string') throw new Error('数据库包裹物流状态事件格式错误');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('数据库包裹物流状态事件格式错误', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('数据库包裹物流状态事件格式错误');
  }
  const record = parsed as Record<string, unknown>;
  const carrierAcceptedAt = record.carrierAcceptedAt;
  if (carrierAcceptedAt !== undefined && carrierAcceptedAt !== null && typeof carrierAcceptedAt !== 'string') {
    throw new Error('数据库包裹物流状态事件格式错误');
  }
  return {
    carrierAcceptedAt: carrierAcceptedAt === undefined ? null : carrierAcceptedAt,
  };
}

function asQuantitySource(
  value: unknown,
  message = '数据库商品数量来源格式错误',
): QuantitySource {
  if (!isQuantitySource(value)) throw new Error(message);
  return value;
}

function asNullableNumber(value: string | number | null | undefined): number | null {
  if (value === null) return null;
  return asNumber(value);
}

function parseCustomFieldDefinitionRow(row: SqlRow): CustomFieldDefinition {
  const metadata = parseCustomFieldDefinitionValueMetadata(row);
  let defaultValue: CustomFieldValue | null = null;
  if (row.default_value_json !== null) {
    defaultValue = parseStoredCustomFieldValue(
      asString(row.default_value_json),
      metadata,
    );
  }
  return {
    id: asString(row.id),
    name: asString(row.name),
    granularity: parseCustomFieldGranularity(row.granularity),
    type: metadata.type,
    required: asNumber(row.required) === 1,
    defaultValue,
    options: metadata.options,
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function parseCustomFieldValueRecordRow(row: SqlRow): CustomFieldValueRecord {
  const definition = parseCustomFieldDefinitionValueMetadata(row);
  return {
    definitionId: asString(row.definition_id),
    orderId: row.order_id === null ? null : asString(row.order_id),
    orderItemId: row.order_item_id === null ? null : asString(row.order_item_id),
    value: parseStoredCustomFieldValue(asString(row.value_json), definition),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function parseTableTemplateRow(
  row: SqlRow,
  definitions: readonly CustomFieldDefinition[],
): TableTemplate {
  if (asNumber(row.configuration_version) !== 2) {
    throw new Error('数据库表格模板配置版本不受支持');
  }
  let configuration: unknown;
  try {
    configuration = JSON.parse(asString(row.configuration_json));
  } catch (error) {
    throw new Error('数据库表格模板配置格式错误', { cause: error });
  }
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new Error('数据库表格模板配置格式错误');
  }
  const config = configuration as Record<string, unknown>;
  if (Object.keys(config).some((key) => key !== 'columns' && key !== 'query')) {
    throw new Error('数据库表格模板配置包含未知属性');
  }
  const normalized = normalizeLegacyOrderItemDefaultDisplayNames(normalizeTableTemplateCustomFilter(
    normalizeStoredTableTemplateInput({
      name: asString(row.name),
      granularity: parseTableTemplateGranularity(row.granularity),
      columns: config.columns,
      query: config.query,
    }, definitions),
    definitions,
  ));
  if (tableTemplateNameKey(normalized.name) !== asString(row.name_key)) {
    throw new Error('数据库表格模板名称索引不一致');
  }
  return {
    id: normalizeTableTemplateId(asString(row.id)),
    ...normalized,
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  } as TableTemplate;
}

function normalizeLegacyOrderItemDefaultDisplayNames<T extends CreateTableTemplateInput>(
  template: T,
): T {
  if (template.granularity !== 'order_item') return template;
  return {
    ...template,
    columns: template.columns.map((column) => {
      if (column.field.kind !== 'builtin') return column;
      if (column.field.key === 'product_title' && column.displayName === '商品名称') {
        return { ...column, displayName: '原始商品标题' };
      }
      if (column.field.key === 'product_spec' && column.displayName === '商品规格') {
        return { ...column, displayName: '原始款式／规格' };
      }
      return column;
    }),
  } as T;
}

function normalizeTableTemplateCustomFilter<T extends CreateTableTemplateInput>(
  template: T,
  definitions: readonly CustomFieldDefinition[],
): T {
  const filter = template.query.customFieldFilter;
  if (!filter) return structuredClone(template);
  const definition = definitions.find(({ id }) => id === filter.definitionId);
  if (!definition || definition.granularity !== template.granularity) {
    throw new Error('表格模板自定义筛选字段无效');
  }
  const value = normalizeCustomFieldValue(
    definition.type,
    filter.value,
    definition.options,
  );
  return {
    ...template,
    query: {
      ...template.query,
      customFieldFilter: { definitionId: definition.id, value },
    },
  } as T;
}

function serializeTableTemplateConfiguration(template: TableTemplate): string {
  return JSON.stringify({
    columns: template.columns,
    query: template.query,
  });
}

function tableTemplateCustomFieldDependencies(template: TableTemplate): Array<{
  definitionId: string;
  usage: 'column' | 'filter' | 'sort';
}> {
  const dependencies: Array<{
    definitionId: string;
    usage: 'column' | 'filter' | 'sort';
  }> = [];
  for (const column of template.columns) {
    if (isDynamicProductTableGroup(column)) continue;
    if (column.field.kind === 'custom') {
      dependencies.push({ definitionId: column.field.definitionId, usage: 'column' });
    }
  }
  if (template.query.customFieldFilter) {
    dependencies.push({
      definitionId: template.query.customFieldFilter.definitionId,
      usage: 'filter',
    });
  }
  if (template.query.customFieldSort) {
    dependencies.push({
      definitionId: template.query.customFieldSort.definitionId,
      usage: 'sort',
    });
  }
  return dependencies;
}

function parseTableTemplateGranularity(
  value: string | number | null | undefined,
): TableTemplateGranularity {
  if (value === 'order' || value === 'order_item' || value === 'shipment_group') return value;
  throw new Error('数据库表格模板数据粒度错误');
}

function normalizeShipmentGroupIdentifier(value: unknown): string {
  if (typeof value !== 'string') throw new Error('发货组标识无效');
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new Error('发货组标识无效');
  return normalized;
}

function normalizeTableTemplateId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('表格模板 ID 格式无效');
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error('表格模板 ID 格式无效');
  }
  return normalized;
}

function parseCustomFieldDefinitionValueMetadata(row: SqlRow): {
  type: CustomFieldDefinition['type'];
  options: string[];
} {
  const type = row.value_type;
  if (!isCustomFieldType(type)) throw new Error('数据库自定义字段类型错误');
  let options: unknown;
  try {
    options = JSON.parse(asString(row.options_json));
  } catch (error) {
    throw new Error('数据库自定义字段可选项格式错误', { cause: error });
  }
  if (!Array.isArray(options) || !options.every((option) => typeof option === 'string')) {
    throw new Error('数据库自定义字段可选项格式错误');
  }
  return { type, options };
}

function parseCustomFieldGranularity(
  value: string | number | null | undefined,
): CustomFieldGranularity {
  if (!isCustomFieldGranularity(value)) throw new Error('数据库自定义字段粒度错误');
  return value;
}

function containsLikePattern(value: string): string {
  return `%${value.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`;
}

function unreleasedPlanMemberGateSql(orderIdColumn: string): string {
  return `NOT EXISTS (
    SELECT 1
    FROM fulfillment_plan_members
    WHERE fulfillment_plan_members.order_id = ${orderIdColumn}
      AND fulfillment_plan_members.released_at IS NULL
      AND fulfillment_plan_members.removed_at IS NULL
  )`;
}

function releasedPlanMemberGateSql(orderIdColumn: string): string {
  return `NOT EXISTS (
    SELECT 1
    FROM fulfillment_plan_members
    WHERE fulfillment_plan_members.order_id = ${orderIdColumn}
      AND fulfillment_plan_members.released_at IS NOT NULL
  )`;
}

function customFieldTextCollation(type: CustomFieldDefinition['type']): string {
  return type === 'text' || type === 'single_select' || type === 'datetime'
    ? ' COLLATE NOCASE'
    : '';
}

function parseStandardProductRow(row: SqlRow): StandardProduct {
  return {
    id: asString(row.id),
    sku: asString(row.sku),
    name: asString(row.name),
    specification: asString(row.specification),
    defaultOrderPriceCents: row.default_order_price_cents === null
      ? null
      : asNumber(row.default_order_price_cents),
    revision: asNumber(row.revision),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function parseStandardProductPriceEventRow(row: SqlRow): StandardProductPriceEvent {
  return {
    id: asString(row.id),
    standardProductId: asString(row.standard_product_id),
    previousDefaultOrderPriceCents: row.previous_default_order_price_cents === null
      ? null
      : asNumber(row.previous_default_order_price_cents),
    defaultOrderPriceCents: row.default_order_price_cents === null
      ? null
      : asNumber(row.default_order_price_cents),
    reason: asString(row.reason),
    occurredAt: asString(row.occurred_at),
    createdAt: asString(row.created_at),
  };
}

function asProductStandardizationSource(
  value: string | number | null | undefined,
): ProductStandardizationSource {
  if (value === 'exact' || value === 'mapping' || value === 'manual') return value;
  throw new Error('数据库商品标准化来源无效');
}

function asProductMappingScope(
  value: string | number | null | undefined,
): ProductMappingScope {
  if (value === 'current_account' || value === 'current_platform' || value === 'workspace') {
    return value;
  }
  throw new Error('数据库商品映射适用范围无效');
}

function asProductMappingStatus(
  value: string | number | null | undefined,
): ProductMappingStatus {
  if (value === 'active' || value === 'disabled') return value;
  throw new Error('数据库商品映射状态无效');
}

function asProductMappingOrigin(
  value: string | number | null | undefined,
): ProductMappingOrigin {
  if (value === 'confirmation' || value === 'manual') return value;
  throw new Error('数据库商品映射建立来源无效');
}

type ProductMappingRecord = {
  id: string;
  sourceTitle: string;
  sourceSpec: string;
  sourceTitleKey: string;
  sourceSpecKey: string;
  standardProductId: string;
  scope: ProductMappingScope;
  platform: string | null;
  sellerAccount: string | null;
  status: ProductMappingStatus;
  origin: ProductMappingOrigin;
  lastUsedAt: string | null;
};

function parseProductMappingRecord(row: SqlRow): ProductMappingRecord {
  return {
    id: asString(row.id),
    sourceTitle: asString(row.source_title),
    sourceSpec: asString(row.source_spec),
    sourceTitleKey: asString(row.source_title_key),
    sourceSpecKey: asString(row.source_spec_key),
    standardProductId: asString(row.standard_product_id),
    scope: asProductMappingScope(row.scope),
    platform: row.platform === null ? null : asString(row.platform),
    sellerAccount: row.seller_account === null ? null : asString(row.seller_account),
    status: asProductMappingStatus(row.status),
    origin: asProductMappingOrigin(row.origin),
    lastUsedAt: row.last_used_at === null ? null : asString(row.last_used_at),
  };
}

function productMappingSnapshot(record: ProductMappingRecord): ProductMappingEventSnapshot {
  return {
    sourceTitle: record.sourceTitle,
    sourceSpec: record.sourceSpec,
    standardProductId: record.standardProductId,
    scope: record.scope,
    platform: record.platform,
    sellerAccount: record.sellerAccount,
    status: record.status,
  };
}

function asProductMappingEventType(
  value: string | number | null | undefined,
): ProductMappingEventType {
  if (value === 'created' || value === 'corrected' || value === 'disabled' || value === 'deleted') {
    return value;
  }
  throw new Error('数据库商品映射变更事件类型无效');
}

function parseProductMappingEventSnapshot(
  value: string | null,
): ProductMappingEventSnapshot | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as ProductMappingEventSnapshot;
  return {
    sourceTitle: asString(parsed.sourceTitle),
    sourceSpec: asString(parsed.sourceSpec),
    standardProductId: asString(parsed.standardProductId),
    scope: asProductMappingScope(parsed.scope),
    platform: parsed.platform === null ? null : asString(parsed.platform),
    sellerAccount: parsed.sellerAccount === null ? null : asString(parsed.sellerAccount),
    status: asProductMappingStatus(parsed.status),
  };
}

function parseProductMappingEventRow(row: SqlRow): ProductMappingEvent {
  return {
    id: asString(row.id),
    mappingId: asString(row.mapping_id),
    standardProductId: asString(row.standard_product_id),
    eventType: asProductMappingEventType(row.event_type),
    before: parseProductMappingEventSnapshot(
      row.before_json === null ? null : asString(row.before_json),
    ),
    after: parseProductMappingEventSnapshot(
      row.after_json === null ? null : asString(row.after_json),
    ),
    origin: asProductMappingOrigin(row.origin),
    reason: asString(row.reason),
    occurredAt: asString(row.occurred_at),
    createdAt: asString(row.created_at),
  };
}

function parseProductMappingViewRow(
  row: SqlRow,
  hitSummaries: ReadonlyMap<string, ProductMappingHitSummary>,
): ProductMappingView {
  const record = parseProductMappingRecord(row);
  return {
    ...record,
    targetProductSku: asString(row.target_sku),
    targetProductName: asString(row.target_name),
    hitOrderCount: hitSummaries.get(
      productMappingHitKey(record.sourceTitle, record.sourceSpec, record.standardProductId),
    )?.orderCount ?? 0,
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function productMappingConflictMessage(scope: ProductMappingScope): string {
  if (scope === 'current_account') return '当前平台与卖家账号已存在指向其他 SKU 的商品映射';
  if (scope === 'current_platform') return '当前平台已存在指向其他 SKU 的商品映射';
  return '工作区已存在指向其他 SKU 的商品映射';
}

function asStandardDisplayPreference(
  value: string | number | null | undefined,
): StandardDisplayPreference {
  if (value === 'prefer_standard' || value === 'prefer_source') return value;
  throw new Error('数据库标准商品显示偏好无效');
}

function plannedStandardDisplayPreference(
  standardProductId: string | null,
  existingItem: OrderItem | undefined,
): StandardDisplayPreference | null {
  if (standardProductId === null) return null;
  if (existingItem?.standardProduct?.id === standardProductId) {
    return existingItem.standardDisplayPreference ?? 'prefer_standard';
  }
  return 'prefer_standard';
}

type OrderItemStandardizationBatchItemRow = {
  state: OrderItemStandardizationBatchItemState;
  sourceTitle: string;
  sourceSpec: string;
  orderPlatform: string;
  orderSellerAccount: string;
  standardizationSource: ProductStandardizationSource | null;
  standardDisplayPreference: StandardDisplayPreference | null;
  beforeStandardProductSku: string | null;
  orderNumber: string;
  systemOrderNumber: string;
};

type OrderItemStandardizationBatchOrderRow = {
  state: OrderItemStandardizationBatchOrderState;
  orderNumber: string;
  systemOrderNumber: string;
};

function orderWorkbenchDateColumn(
  field: OrderWorkbenchDateField,
): 'orders.ordered_at_normalized' | 'orders.paid_at_normalized' | 'orders.created_at' {
  const columns = {
    ordered_at: 'orders.ordered_at_normalized',
    paid_at: 'orders.paid_at_normalized',
    created_at: 'orders.created_at',
  } as const;
  const column = columns[field];
  if (!column) throw new Error('订单工作台日期字段无效');
  return column;
}

function orderWorkbenchDateBoundary(
  date: string,
  column: ReturnType<typeof orderWorkbenchDateColumn>,
  edge: 'start' | 'end',
): string {
  const normalizedStart = normalizeShanghaiDateTime(`${date} 00:00:00`);
  if (!normalizedStart || normalizedStart.slice(0, 10) !== date) {
    throw new Error('订单工作台日期格式无效');
  }
  const localDateTime = edge === 'start'
    ? `${date}T00:00:00+08:00`
    : `${date}T23:59:59.999+08:00`;
  if (column === 'orders.created_at') return new Date(localDateTime).toISOString();
  return edge === 'start'
    ? normalizedStart
    : `${date}T23:59:59+08:00`;
}

function orderWorkbenchSortExpression(field: OrderWorkbenchSortField): string {
  const expressions: Record<OrderWorkbenchSortField, string> = {
    ordered_at: 'orders.ordered_at_normalized',
    paid_at: 'orders.paid_at_normalized',
    created_at: 'orders.created_at',
    amount: 'orders.amount_cents',
    platform: 'orders.platform COLLATE NOCASE',
    seller_account: 'orders.seller_account COLLATE NOCASE',
    buyer: 'orders.buyer_nickname COLLATE NOCASE',
    product: `COALESCE((
      SELECT sorted_items.source_title
      FROM order_items AS sorted_items
      WHERE sorted_items.order_id = orders.id
      ORDER BY sorted_items.position
      LIMIT 1
    ), '') COLLATE NOCASE`,
    initial_source_recognition_status: "COALESCE(source_items.status, 'imported')",
    platform_transaction_status: 'orders.platform_transaction_status',
    fulfillment_status: 'orders.fulfillment_status',
    lifecycle_status: 'orders.lifecycle_status',
  };
  const expression = expressions[field];
  if (!expression) throw new Error('订单工作台排序字段无效');
  return expression;
}

function orderWorkbenchSortDirection(direction: 'asc' | 'desc'): 'ASC' | 'DESC' {
  if (direction === 'asc') return 'ASC';
  if (direction === 'desc') return 'DESC';
  throw new Error('订单工作台排序方向无效');
}

function parseOrderSummaryItems(serialized: string): OrderSummary['items'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error('数据库订单商品摘要格式错误', { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => (
    typeof item === 'object' &&
    item !== null &&
    !Array.isArray(item) &&
    typeof (item as Record<string, unknown>).sourceTitle === 'string' &&
    typeof (item as Record<string, unknown>).sourceSpec === 'string' &&
    Number.isSafeInteger((item as Record<string, unknown>).quantity) &&
    ((item as Record<string, unknown>).quantity as number) > 0 &&
    isStoredStandardDisplayPreference(
      (item as Record<string, unknown>).standardDisplayPreference,
    ) &&
    isStoredStandardProduct((item as Record<string, unknown>).standardProduct)
  ))) {
    throw new Error('数据库订单商品摘要格式错误');
  }
  return parsed as OrderSummary['items'];
}

function isStoredStandardDisplayPreference(value: unknown): boolean {
  return value === null || value === 'prefer_standard' || value === 'prefer_source';
}

function isStoredStandardProduct(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.sku === 'string' &&
    typeof record.name === 'string' &&
    typeof record.specification === 'string' &&
    Number.isSafeInteger(record.revision) &&
    (record.revision as number) > 0 &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string'
  );
}

function assertExpectedShipmentItems(
  expectedItems: readonly ShipmentItemQuantityInput[],
  remainingByItemId: ReadonlyMap<string, {
    order: { id: string };
    item: { quantity: number };
  }>,
): void {
  if (expectedItems.length !== remainingByItemId.size) {
    throw new Error('发货组商品数量已变化，请刷新后重试');
  }
  const seenItemIds = new Set<string>();
  for (const expected of expectedItems) {
    const remaining = remainingByItemId.get(expected.orderItemId);
    if (
      !remaining ||
      remaining.order.id !== expected.orderId ||
      remaining.item.quantity !== expected.quantity ||
      seenItemIds.has(expected.orderItemId)
    ) {
      throw new Error('发货组商品数量已变化，请刷新后重试');
    }
    seenItemIds.add(expected.orderItemId);
  }
}

function parseShipmentGroupAdjustmentEvent(row: SqlRow): ShipmentGroupAdjustmentEvent {
  const operation = asString(row.operation);
  if (operation !== 'split' && operation !== 'merge') {
    throw new Error('数据库发货组调整类型错误');
  }
  return {
    id: asString(row.id),
    operation,
    reason: asString(row.reason),
    sourceGroupIds: parseStoredTextArray(
      asString(row.source_group_ids_json),
      '数据库发货组调整来源组格式错误',
    ),
    sourceOrderIds: parseStoredTextArray(
      asString(row.source_order_ids_json),
      '数据库发货组调整来源订单格式错误',
    ),
    targetGroupId: asString(row.target_group_id),
    targetOrderIds: parseStoredTextArray(
      asString(row.target_order_ids_json),
      '数据库发货组调整目标订单格式错误',
    ),
    selectedRecipientOrderId: row.selected_recipient_order_id === null
      ? null
      : asString(row.selected_recipient_order_id),
    createdAt: asString(row.created_at),
  };
}

function parseStoredTextArray(serialized: string, message: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((value) => typeof value === 'string' && value.length > 0) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new Error(message);
  }
  return parsed;
}

function sameTextSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return rightSet.size === right.length && left.every((value) => rightSet.has(value));
}

function productCatalogStateToken(
  products: readonly StandardProduct[],
  mappings: readonly ProductMappingView[],
): string {
  return createHash('sha256').update(JSON.stringify({
    products: products.map((product) => ({
      id: product.id,
      sku: product.sku,
      name: product.name,
      specification: product.specification,
      revision: product.revision,
    })),
    mappings: mappings.map((mapping) => ({
      id: mapping.id,
      standardProductId: mapping.standardProductId,
      sourceTitle: mapping.sourceTitle,
      sourceSpec: mapping.sourceSpec,
      scope: mapping.scope,
      platform: mapping.platform,
      sellerAccount: mapping.sellerAccount,
      status: mapping.status,
    })),
  })).digest('hex');
}

function asOptionalStoredMoney(
  value: string | number | null | undefined,
  present: string | number | null | undefined,
): number | null {
  if (asNumber(present) === 0) return null;
  return asNumber(value);
}

function requireMoney(label: string, value: number | null): number {
  if (value === null) throw new Error(`${label}不能为空`);
  return value;
}

function safeSubtotal(unitPriceCents: number, quantity: number): number {
  const subtotal = unitPriceCents * quantity;
  if (!Number.isSafeInteger(subtotal) || subtotal < 0) {
    throw new Error('商品小计超出安全范围');
  }
  return subtotal;
}

function validateShanghaiDateTimePair(
  label: string,
  original: string,
  normalized: string,
): void {
  const expected = normalizeShanghaiDateTime(original);
  if (original.trim() && !expected) {
    throw new Error(`${label}原文格式无效`);
  }
  if (normalized !== expected) {
    throw new Error(`规范化${label}与原文不一致`);
  }
}
