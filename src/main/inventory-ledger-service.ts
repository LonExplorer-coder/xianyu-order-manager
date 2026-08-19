import { randomUUID } from 'node:crypto';

import {
  inventoryStateLabel,
  normalizeRecordInventoryAdjustmentInput,
  normalizeRecordInventoryInspectionInput,
  type InventoryMovementDirection,
  type InventoryMovementSourceType,
  type InventoryMovementView,
  type InventoryProductView,
  type InventoryStateName,
  type InventoryUnmappedPendingView,
  type InventoryView,
} from '../core/inventory-ledger';
import { Workspace } from './workspace';

type SqlRow = Record<string, string | number | null>;

// 已预留和未映射提醒都镜像待发货计数的口径：活跃订单、排除已取消/退款、
// 排除未释放计划成员；逐条明细再扣除已发出数量与发货前退款。
const RESERVED_ITEM_FACTS_SQL = `
  FROM original_orders o
  JOIN order_items oi ON oi.order_id = o.id
  LEFT JOIN (
    SELECT order_item_id, SUM(quantity) AS refunded
    FROM fulfillment_refund_events
    GROUP BY order_item_id
  ) r ON r.order_item_id = oi.id
  LEFT JOIN (
    SELECT spi.source_order_item_id AS item_id, SUM(spi.quantity) AS shipped
    FROM shipment_package_items spi
    JOIN shipment_packages sp ON sp.id = spi.package_id
    JOIN shipment_records sr ON sr.id = sp.shipment_record_id
    LEFT JOIN shipment_package_cancellation_events ce ON ce.package_id = sp.id
    LEFT JOIN shipment_record_void_events ve ON ve.shipment_record_id = sr.id
    LEFT JOIN aftersales_replacement_shipments ar ON ar.shipment_record_id = sr.id
    WHERE ce.id IS NULL AND ve.id IS NULL AND ar.id IS NULL
    GROUP BY spi.source_order_item_id
  ) s ON s.item_id = oi.id
  WHERE o.lifecycle_status = 'active'
    AND o.platform_transaction_status NOT IN ('cancelled', 'refunded')
    AND o.fulfillment_status IN ('pending_shipment', 'partially_shipped')
    AND NOT EXISTS (
      SELECT 1
      FROM fulfillment_plan_members m
      WHERE m.order_id = o.id AND m.released_at IS NULL AND m.removed_at IS NULL
    )
`;

export class InventoryLedgerService {
  public constructor(private readonly workspace: Workspace) {}

  public view(): InventoryView {
    return this.buildView();
  }

  public recordAdjustment(input: unknown): InventoryView {
    const prepared = normalizeRecordInventoryAdjustmentInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const product = this.requireProduct(prepared.standardProductId);
      if (prepared.direction === 'out') {
        const current = this.stateQuantity(prepared.standardProductId, prepared.state);
        if (current < prepared.quantity) {
          throw new Error(this.insufficientMessage(
            product,
            inventoryStateLabel(prepared.state),
            current,
            '扣减',
            prepared.quantity,
          ));
        }
      }
      const id = randomUUID();
      this.insertMovement({
        id,
        standardProductId: prepared.standardProductId,
        quantity: prepared.quantity,
        direction: prepared.direction,
        state: prepared.state,
        sourceType: 'manual_adjustment',
        sourceId: id,
        reason: prepared.reason,
        now,
      });
    });
    return this.buildView();
  }

  public recordInspection(input: unknown): InventoryView {
    const prepared = normalizeRecordInventoryInspectionInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const product = this.requireProduct(prepared.standardProductId);
      const inspectedQuantity = (
        prepared.sellableQuantity + prepared.defectiveQuantity + prepared.scrappedQuantity
      );
      const current = this.stateQuantity(
        prepared.standardProductId,
        'awaiting_inspection',
      );
      if (current < inspectedQuantity) {
        throw new Error(this.insufficientMessage(
          product,
          inventoryStateLabel('awaiting_inspection'),
          current,
          '检查',
          inspectedQuantity,
        ));
      }
      const sourceId = randomUUID();
      this.insertMovement({
        id: randomUUID(),
        standardProductId: prepared.standardProductId,
        quantity: inspectedQuantity,
        direction: 'out',
        state: 'awaiting_inspection',
        sourceType: 'inspection_result',
        sourceId,
        reason: prepared.reason,
        now,
      });
      const arrivals: Array<[InventoryStateName, number]> = [
        ['sellable', prepared.sellableQuantity],
        ['defective', prepared.defectiveQuantity],
        ['scrapped', prepared.scrappedQuantity],
      ];
      for (const [state, quantity] of arrivals) {
        if (quantity === 0) continue;
        this.insertMovement({
          id: randomUUID(),
          standardProductId: prepared.standardProductId,
          quantity,
          direction: 'in',
          state,
          sourceType: 'inspection_result',
          sourceId,
          reason: prepared.reason,
          now,
        });
      }
    });
    return this.buildView();
  }

  public stockQuantitiesByProduct(): Map<string, {
    sellable: number;
    awaitingInspection: number;
  }> {
    const result = new Map<string, { sellable: number; awaitingInspection: number }>();
    for (const [productId, buckets] of this.stateQuantitiesByProduct()) {
      result.set(productId, {
        sellable: buckets.sellable,
        awaitingInspection: buckets.awaiting_inspection,
      });
    }
    return result;
  }

  private stateQuantitiesByProduct(): Map<string, Record<InventoryStateName, number>> {
    const result = new Map<string, Record<InventoryStateName, number>>();
    const rows = this.workspace.database.prepare(`
      SELECT standard_product_id AS product_id, state,
        SUM(CASE WHEN direction = 'in' THEN quantity ELSE -quantity END) AS quantity
      FROM inventory_movements
      GROUP BY standard_product_id, state
    `).all() as unknown as SqlRow[];
    for (const row of rows) {
      const productId = asString(row.product_id);
      const buckets = result.get(productId) ?? {
        sellable: 0,
        awaiting_inspection: 0,
        defective: 0,
        scrapped: 0,
      };
      buckets[asString(row.state) as InventoryStateName] = Number(row.quantity);
      result.set(productId, buckets);
    }
    return result;
  }

  private buildView(): InventoryView {
    const bucketsByProduct = this.stateQuantitiesByProduct();

    const reservedRows = this.workspace.database.prepare(`
      SELECT oi.standard_product_id AS product_id,
        SUM(MAX(
          oi.quantity - COALESCE(r.refunded, 0) - COALESCE(s.shipped, 0),
          0
        )) AS reserved
      ${RESERVED_ITEM_FACTS_SQL}
        AND oi.standard_product_id IS NOT NULL
      GROUP BY oi.standard_product_id
    `).all() as unknown as SqlRow[];
    const reservedByProduct = new Map(reservedRows.map((row) => [
      asString(row.product_id),
      Number(row.reserved),
    ]));

    const transitRows = this.workspace.database.prepare(`
      SELECT standard_product_id AS product_id, SUM(quantity) AS quantity
      FROM purchase_suggestions
      WHERE status = 'confirmed'
      GROUP BY standard_product_id
    `).all() as unknown as SqlRow[];
    const transitByProduct = new Map(transitRows.map((row) => [
      asString(row.product_id),
      Number(row.quantity),
    ]));

    const productRows = this.workspace.database.prepare(`
      SELECT id, sku, name, specification FROM standard_products
    `).all() as unknown as SqlRow[];
    const products: InventoryProductView[] = productRows
      .map((row) => {
        const productId = asString(row.id);
        const buckets = bucketsByProduct.get(productId);
        return {
          standardProductId: productId,
          sku: asString(row.sku),
          name: asString(row.name),
          specification: asString(row.specification),
          sellableQuantity: buckets?.sellable ?? 0,
          awaitingInspectionQuantity: buckets?.awaiting_inspection ?? 0,
          defectiveQuantity: buckets?.defective ?? 0,
          scrappedQuantity: buckets?.scrapped ?? 0,
          reservedQuantity: reservedByProduct.get(productId) ?? 0,
          purchaseInTransitQuantity: transitByProduct.get(productId) ?? 0,
        };
      })
      .sort((left, right) => left.sku.localeCompare(right.sku));

    const unmappedRows = this.workspace.database.prepare(`
      SELECT oi.source_title AS title, oi.source_spec AS spec,
        SUM(MAX(
          oi.quantity - COALESCE(r.refunded, 0) - COALESCE(s.shipped, 0),
          0
        )) AS quantity,
        COUNT(DISTINCT CASE
          WHEN oi.quantity - COALESCE(r.refunded, 0) - COALESCE(s.shipped, 0) > 0
          THEN o.id
        END) AS order_count
      ${RESERVED_ITEM_FACTS_SQL}
        AND oi.standard_product_id IS NULL
      GROUP BY oi.source_title, oi.source_spec
      HAVING SUM(MAX(
        oi.quantity - COALESCE(r.refunded, 0) - COALESCE(s.shipped, 0),
        0
      )) > 0
    `).all() as unknown as SqlRow[];
    const unmappedPendingShipment: InventoryUnmappedPendingView[] = unmappedRows
      .map((row) => ({
        sourceTitle: asString(row.title),
        sourceSpec: asString(row.spec),
        quantity: Number(row.quantity),
        orderCount: Number(row.order_count),
      }))
      .sort((left, right) => (
        left.sourceTitle.localeCompare(right.sourceTitle)
        || left.sourceSpec.localeCompare(right.sourceSpec)
      ));

    const movementRows = this.workspace.database.prepare(`
      SELECT m.sequence, m.id, m.standard_product_id, m.quantity, m.direction, m.state,
        m.source_type, m.source_id, m.reason, m.occurred_at, m.created_at,
        p.sku, p.name, p.specification
      FROM inventory_movements m
      JOIN standard_products p ON p.id = m.standard_product_id
      ORDER BY m.sequence DESC
    `).all() as unknown as SqlRow[];
    const movements: InventoryMovementView[] = movementRows.map((row) => ({
      id: asString(row.id),
      sequence: Number(row.sequence),
      standardProductId: asString(row.standard_product_id),
      sku: asString(row.sku),
      name: asString(row.name),
      specification: asString(row.specification),
      quantity: Number(row.quantity),
      direction: asString(row.direction) as InventoryMovementDirection,
      state: asString(row.state) as InventoryStateName,
      sourceType: asString(row.source_type) as InventoryMovementSourceType,
      sourceId: asString(row.source_id),
      reason: asString(row.reason),
      occurredAt: asString(row.occurred_at),
      createdAt: asString(row.created_at),
    }));

    return { products, unmappedPendingShipment, movements };
  }

  private requireProduct(standardProductId: string): { name: string; specification: string } {
    const row = this.workspace.database.prepare(`
      SELECT name, specification FROM standard_products WHERE id = ?
    `).get(standardProductId) as SqlRow | undefined;
    if (!row) throw new Error('未找到标准商品');
    return { name: asString(row.name), specification: asString(row.specification) };
  }

  private stateQuantity(standardProductId: string, state: InventoryStateName): number {
    const row = this.workspace.database.prepare(`
      SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN quantity ELSE -quantity END), 0)
        AS quantity
      FROM inventory_movements
      WHERE standard_product_id = ? AND state = ?
    `).get(standardProductId, state) as SqlRow;
    return Number(row?.quantity ?? 0);
  }

  private insufficientMessage(
    product: { name: string; specification: string },
    stateLabel: string,
    current: number,
    action: string,
    requested: number,
  ): string {
    return `${product.name}（${product.specification}）${stateLabel} ${current} 件，不够${action} ${requested} 件`;
  }

  private insertMovement(entry: {
    id: string;
    standardProductId: string;
    quantity: number;
    direction: InventoryMovementDirection;
    state: InventoryStateName;
    sourceType: InventoryMovementSourceType;
    sourceId: string;
    reason: string;
    now: string;
  }): void {
    this.workspace.database.prepare(`
      INSERT INTO inventory_movements (
        id, standard_product_id, quantity, direction, state,
        source_type, source_id, reason, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.standardProductId,
      entry.quantity,
      entry.direction,
      entry.state,
      entry.sourceType,
      entry.sourceId,
      entry.reason,
      entry.now,
      entry.now,
    );
  }
}

function asString(value: string | number | null | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}
