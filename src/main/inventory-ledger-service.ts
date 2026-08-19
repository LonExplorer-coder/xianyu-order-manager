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

type InventoryFactLine = {
  standardProductId: string | null;
  quantity: number;
  direction: InventoryMovementDirection;
  state: InventoryStateName;
};

function inspectionResultState(result: string): InventoryStateName | null {
  if (result === 'resellable') return 'sellable';
  if (result === 'defective') return 'defective';
  if (result === 'scrapped') return 'scrapped';
  return null;
}

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

  // 业务事实钩子：发货（原订单或补发）实际发出时扣减可销售库存。
  // 事实记录真实实物流转，不做账面余量校验；未映射商品静默跳过，由未映射提醒承接。
  public recordShipmentDispatchFact(fact: {
    shipmentRecordId: string;
    sourceType: 'shipment_dispatch' | 'replacement_dispatch';
    occurredAt: string;
    reason: string;
  }): void {
    const rows = this.workspace.database.prepare(`
      SELECT oi.standard_product_id AS product_id, spi.quantity
      FROM shipment_package_items spi
      JOIN shipment_packages sp ON sp.id = spi.package_id
      JOIN order_items oi ON oi.id = spi.source_order_item_id
      WHERE sp.shipment_record_id = ?
    `).all(fact.shipmentRecordId) as unknown as SqlRow[];
    this.insertAggregatedMovements(
      rows.map((row) => ({
        standardProductId: row.product_id === null ? null : asString(row.product_id),
        quantity: Number(row.quantity),
        direction: 'out' as const,
        state: 'sellable' as const,
      })),
      fact.sourceType,
      fact.shipmentRecordId,
      fact.occurredAt,
      fact.reason,
    );
  }

  // 业务事实钩子：退货实际收到进入待检查。
  public recordReturnReceiptFact(fact: {
    returnRecordId: string;
    occurredAt: string;
    reason: string;
  }): void {
    const rows = this.workspace.database.prepare(`
      SELECT oi.standard_product_id AS product_id, i.received_quantity
      FROM aftersales_return_record_items i
      JOIN shipment_package_items spi ON spi.id = i.shipment_package_item_id
      JOIN order_items oi ON oi.id = spi.source_order_item_id
      WHERE i.return_record_id = ?
    `).all(fact.returnRecordId) as unknown as SqlRow[];
    this.insertAggregatedMovements(
      rows.map((row) => ({
        standardProductId: row.product_id === null ? null : asString(row.product_id),
        quantity: Number(row.received_quantity),
        direction: 'in' as const,
        state: 'awaiting_inspection' as const,
      })),
      'return_receipt',
      fact.returnRecordId,
      fact.occurredAt,
      fact.reason,
    );
  }

  // 业务事实钩子：退货检查按逐件结果分流；可再次销售/瑕疵品/报废离开待检查进入对应分类，
  // 「其他」与未通过数量留在待检查，等待后续库存处理，与人工检查入口口径一致。
  public recordReturnInspectionFact(fact: {
    returnRecordId: string;
    occurredAt: string;
    reason: string;
  }): void {
    const rows = this.workspace.database.prepare(`
      SELECT oi.standard_product_id AS product_id, i.accepted_quantity, i.inspection_result
      FROM aftersales_return_record_items i
      JOIN shipment_package_items spi ON spi.id = i.shipment_package_item_id
      JOIN order_items oi ON oi.id = spi.source_order_item_id
      WHERE i.return_record_id = ?
    `).all(fact.returnRecordId) as unknown as SqlRow[];
    const lines: InventoryFactLine[] = [];
    for (const row of rows) {
      if (row.product_id === null) continue;
      const state = inspectionResultState(asString(row.inspection_result));
      if (state === null || Number(row.accepted_quantity) <= 0) continue;
      // 签收时未映射的商品没有入库腿，检查腿同样跳过，保持不回补历史映射的口径。
      if (!this.hasMovement(
        'return_receipt',
        fact.returnRecordId,
        asString(row.product_id),
        'awaiting_inspection',
        'in',
      )) continue;
      lines.push({
        standardProductId: asString(row.product_id),
        quantity: Number(row.accepted_quantity),
        direction: 'out',
        state: 'awaiting_inspection',
      });
      lines.push({
        standardProductId: asString(row.product_id),
        quantity: Number(row.accepted_quantity),
        direction: 'in',
        state,
      });
    }
    this.insertAggregatedMovements(
      lines,
      'inspection_result',
      fact.returnRecordId,
      fact.occurredAt,
      fact.reason,
    );
  }

  // 业务事实钩子：拦截退回登记检查即完成收到与检查，
  // 先入待检查（退货签收）再按结果进入分类（检查结果），共用同一来源编号。
  public recordInterceptedReturnFact(fact: {
    inspectionEventId: string;
    caseId: string;
    packageId: string;
    result: string;
    occurredAt: string;
    receiptReason: string;
    inspectionReason: string;
  }): void {
    const rows = this.workspace.database.prepare(`
      SELECT oi.standard_product_id AS product_id, ci.quantity
      FROM aftersales_case_items ci
      JOIN shipment_package_items spi ON spi.id = ci.shipment_package_item_id
      JOIN order_items oi ON oi.id = spi.source_order_item_id
      WHERE ci.case_id = ? AND spi.package_id = ?
    `).all(fact.caseId, fact.packageId) as unknown as SqlRow[];
    const mapped = rows.filter((row) => row.product_id !== null);
    this.insertAggregatedMovements(
      mapped.map((row) => ({
        standardProductId: asString(row.product_id),
        quantity: Number(row.quantity),
        direction: 'in' as const,
        state: 'awaiting_inspection' as const,
      })),
      'return_receipt',
      fact.inspectionEventId,
      fact.occurredAt,
      fact.receiptReason,
    );
    // 「其他」结论时实物留在待检查等待后续库存处理，只登记收到腿。
    const state = inspectionResultState(fact.result);
    if (state === null) return;
    this.insertAggregatedMovements(
      mapped.map((row) => ({
        standardProductId: asString(row.product_id),
        quantity: Number(row.quantity),
        direction: 'out' as const,
        state: 'awaiting_inspection' as const,
      })),
      'inspection_result',
      fact.inspectionEventId,
      fact.occurredAt,
      fact.inspectionReason,
    );
    this.insertAggregatedMovements(
      mapped.map((row) => ({
        standardProductId: asString(row.product_id),
        quantity: Number(row.quantity),
        direction: 'in' as const,
        state,
      })),
      'inspection_result',
      fact.inspectionEventId,
      fact.occurredAt,
      fact.inspectionReason,
    );
  }

  // 业务事实钩子：未交寄包裹撤销时把该包裹数量冲回可销售库存，原发货流水保留。
  // 发货时未映射的商品没有扣减腿，冲正同样跳过，保持不回补历史映射的口径。
  public recordShipmentVoidFact(fact: {
    cancellationEventId: string;
    packageId: string;
    shipmentRecordId: string;
    dispatchSourceType: 'shipment_dispatch' | 'replacement_dispatch';
    occurredAt: string;
    reason: string;
  }): void {
    const rows = this.workspace.database.prepare(`
      SELECT oi.standard_product_id AS product_id, spi.quantity
      FROM shipment_package_items spi
      JOIN order_items oi ON oi.id = spi.source_order_item_id
      WHERE spi.package_id = ?
    `).all(fact.packageId) as unknown as SqlRow[];
    const compensated = rows.filter((row) => (
      row.product_id !== null && this.hasMovement(
        fact.dispatchSourceType,
        fact.shipmentRecordId,
        asString(row.product_id),
        'sellable',
        'out',
      )
    ));
    this.insertAggregatedMovements(
      compensated.map((row) => ({
        standardProductId: asString(row.product_id),
        quantity: Number(row.quantity),
        direction: 'in' as const,
        state: 'sellable' as const,
      })),
      'shipment_void',
      fact.cancellationEventId,
      fact.occurredAt,
      fact.reason,
    );
  }

  // 售后详情的库存影响为只读聚合：补发发出/撤销冲正、退货签收与检查、拦截退回检查。
  public movementsForAftersalesCase(caseId: string): InventoryMovementView[] {
    const rows = this.workspace.database.prepare(`
      SELECT DISTINCT m.sequence, m.id, m.standard_product_id, m.quantity, m.direction,
        m.state, m.source_type, m.source_id, m.reason, m.occurred_at, m.created_at,
        p.sku, p.name, p.specification
      FROM inventory_movements m
      JOIN standard_products p ON p.id = m.standard_product_id
      WHERE m.id IN (
        SELECT m2.id
        FROM inventory_movements m2
        JOIN aftersales_replacement_shipments rs
          ON rs.shipment_record_id = m2.source_id
          AND m2.source_type = 'replacement_dispatch'
        JOIN aftersales_processing_rounds r ON r.id = rs.round_id
        WHERE r.case_id = ?
        UNION
        -- 合装退货一份记录可跨多个售后单，按商品级归因避免整单流水重复归属。
        SELECT m2.id
        FROM inventory_movements m2
        JOIN aftersales_return_record_items i
          ON i.return_record_id = m2.source_id
          AND m2.source_type IN ('return_receipt', 'inspection_result')
        JOIN shipment_package_items spi ON spi.id = i.shipment_package_item_id
        JOIN order_items oi ON oi.id = spi.source_order_item_id
        WHERE i.aftersales_case_id = ?
          AND oi.standard_product_id = m2.standard_product_id
        UNION
        SELECT m2.id
        FROM inventory_movements m2
        JOIN aftersales_intercepted_return_inspection_events e
          ON e.id = m2.source_id
          AND m2.source_type IN ('return_receipt', 'inspection_result')
        WHERE e.case_id = ?
        UNION
        SELECT m2.id
        FROM inventory_movements m2
        JOIN shipment_package_cancellation_events c
          ON c.id = m2.source_id AND m2.source_type = 'shipment_void'
        JOIN shipment_packages sp ON sp.id = c.package_id
        JOIN aftersales_replacement_shipments rs ON rs.shipment_record_id = sp.shipment_record_id
        JOIN aftersales_processing_rounds r ON r.id = rs.round_id
        WHERE r.case_id = ?
      )
      ORDER BY m.sequence ASC
    `).all(caseId, caseId, caseId, caseId) as unknown as SqlRow[];
    return rows.map((row) => this.movementViewFromRow(row));
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
    const movements: InventoryMovementView[] = movementRows.map((row) => (
      this.movementViewFromRow(row)
    ));

    return { products, unmappedPendingShipment, movements };
  }

  private hasMovement(
    sourceType: InventoryMovementSourceType,
    sourceId: string,
    standardProductId: string,
    state: InventoryStateName,
    direction: InventoryMovementDirection,
  ): boolean {
    const row = this.workspace.database.prepare(`
      SELECT 1 FROM inventory_movements
      WHERE source_type = ? AND source_id = ? AND standard_product_id = ?
        AND state = ? AND direction = ?
      LIMIT 1
    `).get(sourceType, sourceId, standardProductId, state, direction);
    return row !== undefined;
  }

  private movementViewFromRow(row: SqlRow): InventoryMovementView {
    return {
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
    };
  }

  private insertAggregatedMovements(
    lines: readonly InventoryFactLine[],
    sourceType: InventoryMovementSourceType,
    sourceId: string,
    occurredAt: string,
    reason: string,
  ): void {
    const now = new Date().toISOString();
    const aggregate = new Map<string, { productId: string; quantity: number }>();
    for (const line of lines) {
      if (!line.standardProductId || line.quantity <= 0) continue;
      const key = `${line.standardProductId}|${line.state}|${line.direction}`;
      const existing = aggregate.get(key);
      aggregate.set(key, {
        productId: line.standardProductId,
        quantity: (existing?.quantity ?? 0) + line.quantity,
      });
    }
    for (const [key, entry] of aggregate) {
      const [, state, direction] = key.split('|');
      this.insertMovement({
        id: randomUUID(),
        standardProductId: entry.productId,
        quantity: entry.quantity,
        direction: direction as InventoryMovementDirection,
        state: state as InventoryStateName,
        sourceType,
        sourceId,
        reason,
        now,
        occurredAt,
      });
    }
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
    occurredAt?: string;
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
      entry.occurredAt ?? entry.now,
      entry.now,
    );
  }
}

function asString(value: string | number | null | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}
