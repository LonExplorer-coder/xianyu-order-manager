import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import type {
  OrderDetails,
  OrderChangeEvent,
  OrderChangeValue,
  OrderDraft,
  OrderDraftReview,
  OrderItem,
  OrderReviewIssueCode,
  RecognitionBatchItemResolution,
  RecognitionBatch,
  RecognitionBatchItemStatus,
  RecognitionBatchView,
  RecognitionEvidence,
  OrderSummary,
  OrderUpdateConfirmation,
  OriginalOrder,
  RecognitionItem,
  RecognitionResult,
  Recognizer,
  SourceScreenshot,
  SourceSnapshot,
} from '../core/contracts';
import type {
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
} from '../core/order-comparison';
import {
  assessAutomaticImport,
  isOrderReviewIssueCode,
  normalizeOrderReviewIssues,
} from '../core/order-intake';
import {
  isValidPhonePair,
  normalizeAddress,
  normalizeShanghaiDateTime,
} from '../core/order-normalization';
import {
  isRecognitionBatchItemStatus,
  summarizeRecognitionBatchItems,
} from '../core/recognition-batches';
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

export class LocalApplication {
  private workspace?: Workspace;

  public constructor(private readonly recognizer: Recognizer) {}

  public openDataDirectory(dataDirectory: string): void {
    if (this.workspace) {
      throw new Error('请先关闭当前数据目录');
    }
    this.workspace = Workspace.open(dataDirectory);
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
          items.resolution_kind, drafts.review_issues_json
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
      const recognition = attempt.result;
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
      fulfillmentStatus: asFulfillmentStatus(row.fulfillment_status),
      status: row.review_cancelled_at === null
        ? asString(row.status) as OrderDraft['status']
        : 'cancelled',
      reviewIssues: parseStoredOrderReviewIssues(row.review_issues_json),
      createdAt: asString(row.created_at),
      items: itemRows.map((item) => ({
        id: asString(item.id),
        position: asNumber(item.position),
        sourceTitle: asString(item.source_title),
        sourceSpec: asString(item.source_spec),
        unitPriceCents: asOptionalStoredMoney(
          item.unit_price_cents,
          item.unit_price_present,
        ),
        quantity: asNumber(item.quantity),
        quantityInferred: asNumber(item.quantity_inferred) === 1,
      })),
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
      sourceSnapshot: {
        id: asString(snapshotRow.id),
        createdAt: asString(snapshotRow.created_at),
        recognition: parseStoredRecognition(asString(snapshotRow.recognition_json)),
        confirmed: snapshotRow.confirmed_json === null
          ? null
          : parseStoredRecognition(asString(snapshotRow.confirmed_json)),
      },
    };
  }

  public saveDraftOrderMatch(
    draftId: string,
    orderId: string,
    reviewIssues: readonly OrderReviewIssueCode[],
    reviewedDraft?: OrderDraft,
  ): OrderDraft {
    const workspace = this.requireWorkspace();
    const persistedDraft = this.getDraft(draftId);
    const draft = reviewedDraft ?? persistedDraft;
    if (draft.id !== draftId) {
      throw new Error('校对订单与来源草稿不一致');
    }
    if (reviewedDraft) validateDraft(reviewedDraft);
    const existing = this.getOrder(orderId).order;
    if (!hasSameOrderIdentity(existing, draft)) {
      throw new Error('订单草稿与候选原始订单身份不一致');
    }
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
            orderId,
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
          .run(orderId, serializeOrderReviewIssues(reviewIssues), draftId);
      if (result.changes !== 1) {
        throw new Error('该订单草稿状态已变化，请刷新后重试');
      }
      if (!reviewedDraft) return;

      workspace.database.prepare('DELETE FROM draft_items WHERE draft_id = ?').run(draftId);
      const insertItem = workspace.database.prepare(`
        INSERT INTO draft_items (
          id, draft_id, position, source_title, source_spec,
          unit_price_cents, unit_price_present, quantity, quantity_inferred
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      draft.items.forEach((item, position) => {
        insertItem.run(
          randomUUID(),
          draftId,
          position,
          item.sourceTitle,
          item.sourceSpec,
          item.unitPriceCents ?? 0,
          item.unitPriceCents === null ? 0 : 1,
          item.quantity,
          item.quantityInferred ? 1 : 0,
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
          JSON.stringify(toRecognitionResult(existing)),
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
    });
    return existing;
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

  public confirmDraft(draft: OrderDraft): OriginalOrder {
    const workspace = this.requireWorkspace();
    validateDraft(draft);
    const persistedDraft = this.getDraft(draft.id);
    if (persistedDraft.status === 'cancelled') {
      throw new Error('该订单草稿已取消，不能再确认入库');
    }
    if (persistedDraft.status !== 'awaiting_review') {
      throw new Error('该订单草稿已经确认');
    }

    const existingOrder = this.findOriginalOrderByIdentity(draft);
    if (existingOrder) {
      if (hasEquivalentOrderContent(existingOrder, draft)) {
        return this.resolveEquivalentDraft(draft.id, existingOrder.id, draft);
      }
      throw new Error('该订单已存在且内容有变化，请重新打开校对查看新旧对比');
    }

    const orderId = randomUUID();
    const now = new Date().toISOString();
    const confirmedRecognition = toRecognitionResult(draft);
    const productTotalCents = requireMoney('商品总价', draft.productTotalCents);
    const shippingFeeCents = requireMoney('运费', draft.shippingFeeCents);
    const amountCents = requireMoney('成交金额', draft.amountCents);

    workspace.transaction(() => {
      workspace.database
        .prepare(`
          INSERT INTO original_orders (
            id, draft_id, screenshot_id, platform,
            seller_account, seller_account_normalized,
            platform_order_number, platform_order_number_normalized,
            alipay_transaction_number, buyer_nickname, recipient, phone, phone_normalized,
            address_original, address_normalized, province, city, district,
            ordered_at_original, ordered_at_normalized, paid_at_original, paid_at_normalized,
            product_total_cents, shipping_fee_cents, amount_cents,
            platform_transaction_status, fulfillment_status, lifecycle_status,
            created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'active', ?, ?
          )
        `)
        .run(
          orderId,
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

      const insertItem = workspace.database.prepare(`
        INSERT INTO order_items (
          id, order_id, position, source_title, source_spec,
          unit_price_cents, quantity, quantity_inferred, subtotal_cents
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      draft.items.forEach((item, position) => {
        const unitPriceCents = requireMoney('商品单价', item.unitPriceCents);
        insertItem.run(
          randomUUID(),
          orderId,
          position,
          item.sourceTitle,
          item.sourceSpec,
          unitPriceCents,
          item.quantity,
          item.quantityInferred ? 1 : 0,
          safeSubtotal(unitPriceCents, item.quantity),
        );
      });

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
          JSON.stringify(confirmedRecognition),
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
  ): OrderUpdateConfirmation {
    const workspace = this.requireWorkspace();
    validateDraft(draft);
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
    if (!hasSameOrderIdentity(existing, draft)) {
      const correctedExisting = this.findOriginalOrderByIdentity(draft);
      if (!correctedExisting) {
        return {
          order: this.confirmDraft(draft),
          resolution: 'new_order',
        };
      }
      if (hasEquivalentOrderContent(correctedExisting, draft)) {
        return {
          order: this.resolveEquivalentDraft(draft.id, correctedExisting.id, draft),
          resolution: 'equivalent_order',
        };
      }
      this.saveDraftOrderMatch(
        draft.id,
        correctedExisting.id,
        normalizeOrderReviewIssues([
          ...(draft.reviewIssues ?? []),
          'order_content_changed',
        ]),
        draft,
      );
      throw new Error('修正后的订单身份命中另一笔已有订单，已切换对比，请核对后再次确认');
    }
    if (existing.revision !== expectedRevision) {
      throw new Error('订单已在其他操作中更新，请刷新对比后重试');
    }
    const changes = diffOrderCurrentValues(existing, draft);
    if (changes.length === 0) {
      return {
        order: this.resolveEquivalentDraft(draft.id, orderId, draft),
        resolution: 'equivalent_order',
      };
    }

    const productTotalCents = requireMoney('商品总价', draft.productTotalCents);
    const shippingFeeCents = requireMoney('运费', draft.shippingFeeCents);
    const amountCents = requireMoney('成交金额', draft.amountCents);
    const now = new Date().toISOString();
    const confirmedRecognition = toRecognitionResult({
      ...draft,
      platform: existing.platform,
      sellerAccount: existing.sellerAccount,
      orderNumber: existing.orderNumber,
    });

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
          draft.fulfillmentStatus,
          now,
          orderId,
          expectedRevision,
        );
      if (updatedOrder.changes !== 1) {
        throw new Error('订单已在其他操作中更新，请刷新对比后重试');
      }

      workspace.database
        .prepare('DELETE FROM order_items WHERE order_id = ?')
        .run(orderId);
      const insertItem = workspace.database.prepare(`
        INSERT INTO order_items (
          id, order_id, position, source_title, source_spec,
          unit_price_cents, quantity, quantity_inferred, subtotal_cents
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      draft.items.forEach((item, position) => {
        const unitPriceCents = requireMoney('商品单价', item.unitPriceCents);
        insertItem.run(
          randomUUID(),
          orderId,
          position,
          item.sourceTitle,
          item.sourceSpec,
          unitPriceCents,
          item.quantity,
          item.quantityInferred ? 1 : 0,
          safeSubtotal(unitPriceCents, item.quantity),
        );
      });

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
          JSON.stringify(confirmedRecognition),
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

  public listOrders(): OrderSummary[] {
    return this.queryOrders({}).orders;
  }

  public queryOrders(query: OrderWorkbenchQuery): OrderWorkbenchResult {
    const workspace = this.requireWorkspace();
    const where = [
      query.lifecycleStatus === 'all'
        ? '1 = 1'
        : 'orders.lifecycle_status = ?',
    ];
    const parameters: string[] = query.lifecycleStatus === 'all'
      ? []
      : [query.lifecycleStatus ?? 'active'];
    const text = query.text?.normalize('NFKC').trim();
    if (text) {
      const pattern = containsLikePattern(text);
      where.push(`(
        orders.platform_order_number LIKE ? ESCAPE '\\'
        OR orders.buyer_nickname LIKE ? ESCAPE '\\'
        OR orders.recipient LIKE ? ESCAPE '\\'
        OR orders.phone LIKE ? ESCAPE '\\'
        OR orders.phone_normalized LIKE ? ESCAPE '\\'
        OR orders.address_original LIKE ? ESCAPE '\\'
        OR orders.address_normalized LIKE ? ESCAPE '\\'
        OR orders.seller_account LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM order_items AS searched_items
          WHERE searched_items.order_id = orders.id
            AND (
              searched_items.source_title LIKE ? ESCAPE '\\'
              OR searched_items.source_spec LIKE ? ESCAPE '\\'
            )
        )
      )`);
      parameters.push(...Array<string>(10).fill(pattern));
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
        WHERE filtered_items.order_id = orders.id
          AND (
            filtered_items.source_title LIKE ? ESCAPE '\\'
            OR filtered_items.source_spec LIKE ? ESCAPE '\\'
          )
      )`);
      parameters.push(pattern, pattern);
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
      where.push('source_items.status = ?');
      parameters.push(query.initialSourceRecognitionStatus);
    }
    if (query.platformTransactionStatus) {
      where.push('orders.platform_transaction_status = ?');
      parameters.push(query.platformTransactionStatus);
    }
    if (query.fulfillmentStatus) {
      where.push('orders.fulfillment_status = ?');
      parameters.push(query.fulfillmentStatus);
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
    const sortExpression = orderWorkbenchSortExpression(query.sortField ?? 'created_at');
    const sortDirection = orderWorkbenchSortDirection(query.sortDirection ?? 'desc');
    const rows = workspace.database
      .prepare(`
        SELECT
          orders.id,
          orders.platform,
          orders.seller_account,
          orders.platform_order_number,
          orders.buyer_nickname,
          orders.recipient,
          orders.phone,
          orders.address_original,
          orders.amount_cents,
          source_items.status AS initial_source_recognition_status,
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
              'quantity', ordered_items.quantity
            ))
            FROM (
              SELECT source_title, source_spec, quantity
              FROM order_items
              WHERE order_id = orders.id
              ORDER BY position
            ) AS ordered_items
          ), '[]') AS items_json
        FROM original_orders AS orders
        JOIN recognition_batch_items AS source_items
          ON source_items.draft_id = orders.draft_id
        LEFT JOIN order_items AS items ON items.order_id = orders.id
        WHERE ${where.join('\n          AND ')}
        GROUP BY orders.id
        ORDER BY ${sortExpression} ${sortDirection}, orders.id DESC
      `)
      .all(...parameters) as unknown as SqlRow[];

    const orders = rows.map((row) => ({
      id: asString(row.id),
      platform: asOrderPlatform(row.platform),
      sellerAccount: asString(row.seller_account),
      orderNumber: asString(row.platform_order_number),
      buyerNickname: asString(row.buyer_nickname),
      recipient: asString(row.recipient),
      phone: asString(row.phone),
      addressOriginal: asString(row.address_original),
      amountCents: asNumber(row.amount_cents),
      itemCount: asNumber(row.item_count),
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
    }));

    const counts = workspace.database.prepare(`
      SELECT
        COUNT(*) AS all_lifecycle_order_count,
        COALESCE(SUM(lifecycle_status = 'active'), 0) AS active_order_count,
        COALESCE(SUM(
          lifecycle_status = 'active'
          AND fulfillment_status = 'pending_shipment'
          AND platform_transaction_status NOT IN ('cancelled', 'refunded')
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
      allLifecycleOrderCount: asNumber(counts.all_lifecycle_order_count),
      activeOrderCount: asNumber(counts.active_order_count),
      pendingShipmentCount: asNumber(counts.pending_shipment_count),
      platforms: platforms.map((row) => asOrderPlatform(row.platform)),
      sellerAccounts: sellerAccounts.map((row) => asString(row.seller_account)),
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
      .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY position')
      .all(orderId) as unknown as SqlRow[];
    const items: OrderItem[] = itemRows.map((item) => ({
      id: asString(item.id),
      position: asNumber(item.position),
      sourceTitle: asString(item.source_title),
      sourceSpec: asString(item.source_spec),
      unitPriceCents: asNumber(item.unit_price_cents),
      quantity: asNumber(item.quantity),
      quantityInferred: asNumber(item.quantity_inferred) === 1,
      subtotalCents: asNumber(item.subtotal_cents),
    }));

    const order: OriginalOrder = {
      id: asString(row.id),
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
          snapshots.recognition_json,
          snapshots.confirmed_json,
          snapshots.created_at AS snapshot_created_at,
          source_items.status AS recognition_status
        FROM source_snapshots AS snapshots
        JOIN source_screenshots AS screenshots ON screenshots.id = snapshots.screenshot_id
        JOIN recognition_batch_items AS source_items
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
    const sources = sourceRows.map((sourceRow) => ({
      recognitionStatus: asRecognitionBatchItemStatus(sourceRow.recognition_status),
      sourceScreenshot: {
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
        recognition: parseStoredRecognition(asString(sourceRow.recognition_json)),
        confirmed: sourceRow.confirmed_json === null
          ? null
          : parseStoredRecognition(asString(sourceRow.confirmed_json)),
      } satisfies SourceSnapshot,
    }));
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
        if (source !== 'source_update' && source !== 'manual_edit') {
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
          status, recognition_json, review_issues_json, intake_decision_pending, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, 'awaiting_review', ?, ?, ?, ?
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
        JSON.stringify(recognition),
        serializeOrderReviewIssues(input.reviewIssues),
        input.intakeDecisionPending ? 1 : 0,
        input.createdAt,
      );

    workspace.database
      .prepare(`
        INSERT INTO source_snapshots (
          id, draft_id, order_id, screenshot_id,
          recognition_json, confirmed_json, created_at, resolved_at
        ) VALUES (?, ?, NULL, ?, ?, NULL, ?, NULL)
      `)
      .run(
        randomUUID(),
        input.draftId,
        input.screenshotId,
        JSON.stringify(recognition),
        input.createdAt,
      );

    const insertItem = workspace.database.prepare(`
      INSERT INTO draft_items (
        id, draft_id, position, source_title, source_spec,
        unit_price_cents, unit_price_present, quantity, quantity_inferred
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    recognition.items.forEach((item, position) => {
      insertItem.run(
        randomUUID(),
        input.draftId,
        position,
        item.sourceTitle,
        item.sourceSpec,
        item.unitPriceCents ?? 0,
        item.unitPriceCents === null ? 0 : 1,
        item.quantity,
        item.quantityInferred ? 1 : 0,
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
  }

  private requireWorkspace(): Workspace {
    if (!this.workspace) throw new Error('请先选择数据目录');
    return this.workspace;
  }
}

function toRecognitionResult(
  draft: Omit<RecognitionResult, 'items'> & { items: readonly RecognitionItem[] },
): RecognitionResult {
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
    items: draft.items.map(({ sourceTitle, sourceSpec, unitPriceCents, quantity, quantityInferred }) => ({
      sourceTitle,
      sourceSpec,
      unitPriceCents,
      quantity,
      quantityInferred,
    })),
  };
}

function validateRecognition(recognition: RecognitionResult): void {
  validateValues(recognition, recognition.items, false);
}

function validateDraft(draft: OrderDraft): void {
  validateValues(draft, draft.items, true);
}

function validateValues(
  value: Omit<RecognitionResult, 'items'>,
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
  if (!['pending_shipment', 'shipped', 'unknown'].includes(value.fulfillmentStatus)) {
    throw new Error('履约状态格式错误');
  }
  if (!Array.isArray(items) || (strict && items.length === 0)) {
    throw new Error('订单至少需要一项商品明细');
  }
  for (const item of items) {
    if (strict && !item.sourceTitle.trim()) throw new Error('商品标题不能为空');
    if (item.unitPriceCents === null) {
      if (strict) throw new Error('商品单价不能为空');
    } else if (!Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0) {
      throw new Error('商品单价必须使用非负整数分');
    }
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw new Error('商品数量必须为正整数');
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
    ? (stored.items as RecognitionItem[])
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
    fulfillmentStatus: isFulfillmentStatus(stored.fulfillmentStatus)
      ? stored.fulfillmentStatus
      : 'pending_shipment',
    items,
  };
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

function isFulfillmentStatus(value: unknown): value is OriginalOrder['fulfillmentStatus'] {
  return value === 'pending_shipment' || value === 'shipped' || value === 'unknown';
}

function asFulfillmentStatus(
  value: string | number | null | undefined,
): OriginalOrder['fulfillmentStatus'] {
  if (!isFulfillmentStatus(value)) throw new Error('数据库履约状态格式错误');
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
      quantityInferred: true,
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

function asNullableNumber(value: string | number | null | undefined): number | null {
  if (value === null) return null;
  return asNumber(value);
}

function containsLikePattern(value: string): string {
  return `%${value.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`;
}

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
    initial_source_recognition_status: 'source_items.status',
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
    ((item as Record<string, unknown>).quantity as number) > 0
  ))) {
    throw new Error('数据库订单商品摘要格式错误');
  }
  return parsed as OrderSummary['items'];
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
