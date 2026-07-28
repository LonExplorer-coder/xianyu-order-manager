import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import type {
  OrderDetails,
  OrderDraft,
  OrderItem,
  RecognitionBatch,
  OrderSummary,
  OriginalOrder,
  RecognitionItem,
  RecognitionResult,
  Recognizer,
  SourceScreenshot,
  SourceSnapshot,
} from '../core/contracts';
import { Workspace } from './workspace';

type SqlRow = Record<string, string | number | null>;

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export class LocalApplication {
  private workspace?: Workspace;

  public constructor(private readonly recognizer: Recognizer) {}

  public openDataDirectory(dataDirectory: string): void {
    if (this.workspace) {
      throw new Error('请先关闭当前数据目录');
    }
    this.workspace = Workspace.open(dataDirectory);
  }

  private async submitSourceScreenshot(sourcePath: string): Promise<OrderDraft> {
    const workspace = this.requireWorkspace();
    const extension = extname(sourcePath).toLowerCase();
    const mimeType = IMAGE_MIME_TYPES[extension];
    if (!mimeType) {
      throw new Error('当前仅支持 PNG、JPG、JPEG 或 WebP 来源截图');
    }

    const bytes = await readFile(sourcePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const screenshotId = randomUUID();
    const batchId = randomUUID();
    const draftId = randomUUID();
    const storedDirectory = join(workspace.dataDirectory, 'screenshots');
    const storedPath = join(storedDirectory, `${screenshotId}${extension}`);
    await mkdir(storedDirectory, { recursive: true });
    await copyFile(sourcePath, storedPath);

    try {
      const recognition = await this.recognizer.recognize({
        absolutePath: storedPath,
        originalName: basename(sourcePath),
        mimeType,
        sha256,
        bytes,
      });
      validateRecognition(recognition);
      const now = new Date().toISOString();

      workspace.transaction(() => {
        workspace.database
          .prepare(`
            INSERT INTO recognition_batches (id, platform, seller_account, status, created_at)
            VALUES (?, ?, ?, 'awaiting_review', ?)
          `)
          .run(batchId, recognition.platform, recognition.sellerAccount, now);

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
              buyer_nickname, recipient, phone, address_original, amount_cents,
              status, recognition_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_review', ?, ?)
          `)
          .run(
            draftId,
            batchId,
            screenshotId,
            recognition.platform,
            recognition.sellerAccount,
            recognition.orderNumber,
            recognition.buyerNickname,
            recognition.recipient,
            recognition.phone,
            recognition.addressOriginal,
            recognition.amountCents,
            JSON.stringify(recognition),
            now,
          );

        const insertItem = workspace.database.prepare(`
          INSERT INTO draft_items (
            id, draft_id, position, source_title, source_spec,
            unit_price_cents, quantity, quantity_inferred
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        recognition.items.forEach((item, position) => {
          insertItem.run(
            randomUUID(),
            draftId,
            position,
            item.sourceTitle,
            item.sourceSpec,
            item.unitPriceCents,
            item.quantity,
            item.quantityInferred ? 1 : 0,
          );
        });
      });

      return this.getDraft(draftId);
    } catch (error) {
      await unlink(storedPath).catch(() => undefined);
      throw error;
    }
  }

  public async submitRecognitionBatch(sourcePaths: string[]): Promise<RecognitionBatch> {
    if (sourcePaths.length !== 1) {
      throw new Error('当前识别批次必须且只能包含一张来源截图');
    }
    const draft = await this.submitSourceScreenshot(sourcePaths[0]);
    return { id: draft.batchId, drafts: [draft] };
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
      buyerNickname: asString(row.buyer_nickname),
      recipient: asString(row.recipient),
      phone: asString(row.phone),
      addressOriginal: asString(row.address_original),
      amountCents: asNumber(row.amount_cents),
      status: asString(row.status) as OrderDraft['status'],
      createdAt: asString(row.created_at),
      items: itemRows.map((item) => ({
        id: asString(item.id),
        position: asNumber(item.position),
        sourceTitle: asString(item.source_title),
        sourceSpec: asString(item.source_spec),
        unitPriceCents: asNumber(item.unit_price_cents),
        quantity: asNumber(item.quantity),
        quantityInferred: asNumber(item.quantity_inferred) === 1,
      })),
    };
  }

  public confirmDraft(draft: OrderDraft): OriginalOrder {
    const workspace = this.requireWorkspace();
    validateDraft(draft);
    const persistedDraft = this.getDraft(draft.id);
    if (persistedDraft.status !== 'awaiting_review') {
      throw new Error('该订单草稿已经确认');
    }

    const recognitionRow = workspace.database
      .prepare('SELECT recognition_json FROM order_drafts WHERE id = ?')
      .get(draft.id) as SqlRow;
    const orderId = randomUUID();
    const now = new Date().toISOString();
    const confirmedRecognition = toRecognitionResult(draft);

    workspace.transaction(() => {
      workspace.database
        .prepare(`
          INSERT INTO original_orders (
            id, draft_id, screenshot_id, platform, seller_account, platform_order_number,
            buyer_nickname, recipient, phone, address_original, amount_cents,
            platform_transaction_status, fulfillment_status, lifecycle_status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', 'pending_shipment', 'active', ?, ?)
        `)
        .run(
          orderId,
          draft.id,
          persistedDraft.screenshotId,
          draft.platform,
          draft.sellerAccount,
          draft.orderNumber,
          draft.buyerNickname,
          draft.recipient,
          draft.phone,
          draft.addressOriginal,
          draft.amountCents,
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
        insertItem.run(
          randomUUID(),
          orderId,
          position,
          item.sourceTitle,
          item.sourceSpec,
          item.unitPriceCents,
          item.quantity,
          item.quantityInferred ? 1 : 0,
          item.unitPriceCents * item.quantity,
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
        .prepare("UPDATE recognition_batches SET status = 'completed' WHERE id = ?")
        .run(persistedDraft.batchId);
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
          orders.created_at,
          COUNT(items.id) AS item_count
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
      createdAt: asString(row.created_at),
    }));
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
      buyerNickname: asString(row.buyer_nickname),
      recipient: asString(row.recipient),
      phone: asString(row.phone),
      addressOriginal: asString(row.address_original),
      amountCents: asNumber(row.amount_cents),
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
      lifecycleStatus: 'active',
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
      recognition: JSON.parse(asString(row.recognition_json)) as RecognitionResult,
      confirmed: JSON.parse(asString(row.confirmed_json)) as RecognitionResult,
    };

    return { order, sourceScreenshot, sourceSnapshot };
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
    buyerNickname: draft.buyerNickname,
    recipient: draft.recipient,
    phone: draft.phone,
    addressOriginal: draft.addressOriginal,
    amountCents: draft.amountCents,
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
  validateValues(recognition, recognition.items);
}

function validateDraft(draft: OrderDraft): void {
  validateValues(draft, draft.items);
}

function validateValues(
  value: Omit<RecognitionResult, 'items'>,
  items: RecognitionItem[],
): void {
  if (value.platform !== 'xianyu') {
    throw new Error('当前仅支持闲鱼平台订单');
  }
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
  if (!Number.isSafeInteger(value.amountCents) || value.amountCents < 0) {
    throw new Error('成交金额必须使用非负整数分');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('订单至少需要一项商品明细');
  }
  for (const item of items) {
    if (!item.sourceTitle.trim()) throw new Error('商品标题不能为空');
    if (!Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0) {
      throw new Error('商品单价必须使用非负整数分');
    }
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw new Error('商品数量必须为正整数');
    }
  }
}

function asString(value: string | number | null | undefined): string {
  if (typeof value !== 'string') throw new Error('数据库文本字段格式错误');
  return value;
}

function asNumber(value: string | number | null | undefined): number {
  if (typeof value !== 'number') throw new Error('数据库数字字段格式错误');
  return value;
}
