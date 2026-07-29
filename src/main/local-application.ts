import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import type {
  OrderDetails,
  OrderDraft,
  OrderItem,
  RecognitionBatch,
  RecognitionBatchItemStatus,
  RecognitionBatchView,
  RecognitionEvidence,
  OrderSummary,
  OriginalOrder,
  RecognitionItem,
  RecognitionResult,
  Recognizer,
  SourceScreenshot,
  SourceSnapshot,
} from '../core/contracts';
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
    items: Array<{ id: string; sourceName: string }>;
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
          draft_id, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, 'waiting_recognition', NULL, NULL, ?, ?)
      `);
      input.items.forEach((item, position) => {
        insertItem.run(
          item.id,
          input.id,
          position,
          item.sourceName,
          input.createdAt,
          input.createdAt,
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
            status = 'failed',
            error_message = '上次退出时处理未完成，请重新上传这张截图',
            updated_at = ?
          WHERE status IN ('waiting_recognition', 'recognizing', 'validating')
        `)
        .run(now);
      workspace.database.exec(`
        UPDATE recognition_batches
        SET status = CASE
          WHEN EXISTS (
            SELECT 1
            FROM recognition_batch_items AS items
            WHERE items.batch_id = recognition_batches.id
              AND items.status = 'awaiting_confirmation'
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
          items.draft_id, items.error_message
        FROM recognition_batch_items AS items
        JOIN recognition_batches AS batches ON batches.id = items.batch_id
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
            updated_at = ?
          WHERE id = ? AND batch_id = ?
        `)
        .run(
          input.status,
          input.draftId ?? null,
          input.sha256 ?? null,
          input.errorMessage ?? null,
          new Date().toISOString(),
          input.itemId,
          input.batchId,
        );
      if (result.changes !== 1) throw new Error('未找到识别批次中的来源截图');
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
      const now = new Date().toISOString();

      workspace.transaction(() => {
        workspace.database
          .prepare(`
            INSERT OR IGNORE INTO recognition_batches (
              id, platform, seller_account, status, created_at
            )
            VALUES (?, ?, ?, 'awaiting_review', ?)
          `)
          .run(batchId, recognition.platform, recognition.sellerAccount, now);
        workspace.database
          .prepare("UPDATE recognition_batches SET status = 'awaiting_review' WHERE id = ?")
          .run(batchId);

        workspace.database
          .prepare(`
            INSERT INTO source_screenshots (
              id, batch_id, original_name, relative_path, content_sha256, mime_type, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            screenshotId,
            batchId,
            basename(sourcePath),
            workspace.toStoredPath(storedPath),
            sha256,
            mimeType,
            now,
          );

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
              status, recognition_json, created_at
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?,
              'awaiting_review', ?, ?
            )
          `)
          .run(
            draftId,
            batchId,
            screenshotId,
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
            now,
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

        const insertEvidence = workspace.database.prepare(`
          INSERT INTO recognition_attempts (
            id, screenshot_id, draft_id, provider, model, request_id,
            schema_version, raw_response, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        attempt.evidences.forEach((evidence, index) => {
          insertEvidence.run(
            randomUUID(),
            screenshotId,
            draftId,
            evidence.provider,
            evidence.model,
            evidence.requestId,
            evidence.schemaVersion,
            evidence.rawResponse,
            new Date(Date.parse(now) + index).toISOString(),
          );
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

  public hasActiveSourceScreenshotSha256(sha256: string): boolean {
    const workspace = this.requireWorkspace();
    const row = workspace.database
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
    return row !== undefined;
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
          SET review_cancelled_at = ?
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
          SET status = 'cancelled', error_message = NULL, updated_at = ?
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

    const recognitionRow = workspace.database
      .prepare('SELECT recognition_json FROM order_drafts WHERE id = ?')
      .get(draft.id) as SqlRow;
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
            id, draft_id, screenshot_id, platform, seller_account, platform_order_number,
            alipay_transaction_number, buyer_nickname, recipient, phone, phone_normalized,
            address_original, address_normalized, province, city, district,
            ordered_at_original, ordered_at_normalized, paid_at_original, paid_at_normalized,
            product_total_cents, shipping_fee_cents, amount_cents,
            platform_transaction_status, fulfillment_status, lifecycle_status,
            created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'active', ?, ?
          )
        `)
        .run(
          orderId,
          draft.id,
          persistedDraft.screenshotId,
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

      workspace.database
        .prepare(`
          INSERT INTO source_snapshots (
            id, order_id, screenshot_id, recognition_json, confirmed_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          randomUUID(),
          orderId,
          persistedDraft.screenshotId,
          asString(recognitionRow.recognition_json),
          JSON.stringify(confirmedRecognition),
          now,
        );

      workspace.database
        .prepare("UPDATE order_drafts SET status = 'confirmed', confirmed_at = ? WHERE id = ?")
        .run(now, draft.id);
      workspace.database
        .prepare(`
          UPDATE recognition_batch_items
          SET status = 'imported', error_message = NULL, updated_at = ?
          WHERE draft_id = ?
        `)
        .run(now, draft.id);
      this.completeBatchWhenReviewed(persistedDraft.batchId);
    });

    return this.getOrder(orderId).order;
  }

  public listOrders(): OrderSummary[] {
    const workspace = this.requireWorkspace();
    const rows = workspace.database
      .prepare(`
        SELECT
          orders.id,
          orders.platform_order_number,
          orders.buyer_nickname,
          orders.recipient,
          orders.amount_cents,
          orders.platform_transaction_status,
          orders.fulfillment_status,
          orders.created_at,
          COALESCE(SUM(items.quantity), 0) AS item_count
        FROM original_orders AS orders
        LEFT JOIN order_items AS items ON items.order_id = orders.id
        GROUP BY orders.id
        ORDER BY orders.created_at DESC, orders.id DESC
      `)
      .all() as unknown as SqlRow[];

    return rows.map((row) => ({
      id: asString(row.id),
      orderNumber: asString(row.platform_order_number),
      buyerNickname: asString(row.buyer_nickname),
      recipient: asString(row.recipient),
      amountCents: asNumber(row.amount_cents),
      itemCount: asNumber(row.item_count),
      platformTransactionStatus: asPlatformTransactionStatus(
        row.platform_transaction_status,
      ),
      fulfillmentStatus: asFulfillmentStatus(row.fulfillment_status),
      createdAt: asString(row.created_at),
    }));
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
                'awaiting_confirmation'
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
      .prepare(`
        SELECT
          orders.*,
          screenshots.id AS source_id,
          screenshots.original_name,
          screenshots.relative_path,
          screenshots.mime_type,
          screenshots.content_sha256,
          screenshots.created_at AS screenshot_created_at,
          snapshots.id AS snapshot_id,
          snapshots.recognition_json,
          snapshots.confirmed_json,
          snapshots.created_at AS snapshot_created_at
        FROM original_orders AS orders
        JOIN source_screenshots AS screenshots ON screenshots.id = orders.screenshot_id
        JOIN source_snapshots AS snapshots ON snapshots.order_id = orders.id
        WHERE orders.id = ?
      `)
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
      platform: 'xianyu',
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

    const sourceScreenshot: SourceScreenshot = {
      id: asString(row.source_id),
      originalName: asString(row.original_name),
      relativePath: asString(row.relative_path),
      mimeType: asString(row.mime_type),
      sha256: asString(row.content_sha256),
      createdAt: asString(row.screenshot_created_at),
    };

    const sourceSnapshot: SourceSnapshot = {
      id: asString(row.snapshot_id),
      createdAt: asString(row.snapshot_created_at),
      recognition: parseStoredRecognition(asString(row.recognition_json)),
      confirmed: parseStoredRecognition(asString(row.confirmed_json)),
    };

    return { order, sourceScreenshot, sourceSnapshot };
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

  private requireWorkspace(): Workspace {
    if (!this.workspace) throw new Error('请先选择数据目录');
    return this.workspace;
  }
}

function toRecognitionResult(draft: OrderDraft): RecognitionResult {
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
