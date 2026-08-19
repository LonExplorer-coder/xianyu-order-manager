import { randomUUID } from 'node:crypto';

import {
  normalizeChangePurchaseOrderExpectedDateInput,
  normalizeChangePurchaseOrderItemQuantityInput,
  normalizeCreatePurchaseOrderInput,
  normalizeCreateSupplierInput,
  normalizePurchaseOrderActionInput,
  normalizeRecordPurchaseArrivalInput,
  normalizeRecordSupplierReturnInput,
  type PurchaseArrivalItemView,
  type PurchaseArrivalView,
  type PurchaseOrderEventView,
  type PurchaseOrderItemView,
  type PurchaseOrderView,
  type PurchaseView,
  type SupplierReturnItemView,
  type SupplierReturnView,
  type SupplierView,
} from '../core/purchase-orders';
import type { InventoryStateName } from '../core/inventory-ledger';
import { Workspace } from './workspace';
import { InventoryLedgerService } from './inventory-ledger-service';

type SqlRow = Record<string, string | number | null>;

// 采购模块与库存模块职责分离：订单、到货与退货事实在本服务落库，
// 库存腿通过库存账本服务写入；建议（采购需求）完全独立，本服务不读写。
export class PurchaseOrderService {
  public constructor(private readonly workspace: Workspace) {}

  public view(): PurchaseView {
    return this.buildView();
  }

  public createSupplier(input: unknown): PurchaseView {
    const prepared = normalizeCreateSupplierInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const existing = this.workspace.database.prepare(`
        SELECT id FROM suppliers WHERE name = ?
      `).get(prepared.name) as SqlRow | undefined;
      if (existing) throw new Error('同名供应方已存在');
      this.workspace.database.prepare(`
        INSERT INTO suppliers (id, name, contact, note, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), prepared.name, prepared.contact, prepared.note, now);
    });
    return this.buildView();
  }

  public createOrder(input: unknown): PurchaseView {
    const prepared = normalizeCreatePurchaseOrderInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const supplier = this.workspace.database.prepare(`
        SELECT id FROM suppliers WHERE id = ?
      `).get(prepared.supplierId) as SqlRow | undefined;
      if (!supplier) throw new Error('未找到供应方');
      for (const item of prepared.items) {
        const product = this.workspace.database.prepare(`
          SELECT id FROM standard_products WHERE id = ?
        `).get(item.standardProductId) as SqlRow | undefined;
        if (!product) throw new Error('未找到标准商品');
      }
      const orderId = randomUUID();
      const sequenceRow = this.workspace.database.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM purchase_orders
      `).get() as SqlRow;
      this.workspace.database.prepare(`
        INSERT INTO purchase_orders (
          sequence, id, supplier_id, status, expected_at,
          created_at, confirmed_at, cancelled_at, cancel_reason
        ) VALUES (?, ?, ?, 'draft', ?, ?, NULL, NULL, NULL)
      `).run(
        Number(sequenceRow.next),
        orderId,
        prepared.supplierId,
        prepared.expectedAt,
        now,
      );
      for (const item of prepared.items) {
        this.workspace.database.prepare(`
          INSERT INTO purchase_order_items (
            id, purchase_order_id, standard_product_id, quantity, unit_price_cents, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          orderId,
          item.standardProductId,
          item.quantity,
          item.unitPriceCents,
          now,
        );
      }
      this.recordOrderEvent(orderId, 'created', null, null, prepared.reason, now);
    });
    return this.buildView();
  }

  public confirmOrder(input: unknown): PurchaseView {
    const prepared = normalizePurchaseOrderActionInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const order = this.requireOrder(prepared.orderId);
      if (asString(order.status) !== 'draft') throw new Error('只有草稿采购订单可以确认');
      this.workspace.database.prepare(`
        UPDATE purchase_orders SET status = 'confirmed', confirmed_at = ?
        WHERE id = ?
      `).run(now, prepared.orderId);
      this.recordOrderEvent(prepared.orderId, 'confirmed', null, null, prepared.reason, now);
      this.refreshPayable(prepared.orderId, now);
    });
    return this.buildView();
  }

  public cancelOrder(input: unknown): PurchaseView {
    const prepared = normalizePurchaseOrderActionInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const order = this.requireOrder(prepared.orderId);
      if (asString(order.status) === 'cancelled') throw new Error('采购订单已取消');
      this.workspace.database.prepare(`
        UPDATE purchase_orders
        SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
        WHERE id = ?
      `).run(now, prepared.reason, prepared.orderId);
      this.recordOrderEvent(prepared.orderId, 'cancelled', null, null, prepared.reason, now);
      this.refreshPayable(prepared.orderId, now);
    });
    return this.buildView();
  }

  public changeOrderItemQuantity(input: unknown): PurchaseView {
    const prepared = normalizeChangePurchaseOrderItemQuantityInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const order = this.requireOrder(prepared.orderId);
      if (asString(order.status) === 'cancelled') {
        throw new Error('采购订单已取消，不能变更数量');
      }
      const item = this.workspace.database.prepare(`
        SELECT i.id, i.quantity, i.standard_product_id
        FROM purchase_order_items i
        WHERE i.id = ? AND i.purchase_order_id = ?
      `).get(prepared.itemId, prepared.orderId) as SqlRow | undefined;
      if (!item) throw new Error('未找到该采购订单商品行');
      const receivedRow = this.workspace.database.prepare(`
        SELECT COALESCE(SUM(received_quantity), 0) AS received
        FROM purchase_arrival_items
        WHERE purchase_order_item_id = ?
      `).get(prepared.itemId) as SqlRow;
      const received = Number(receivedRow?.received ?? 0);
      if (prepared.quantity < received) {
        throw new Error(`该商品行已到货 ${received} 件，采购数量不能低于已到货数量`);
      }
      this.workspace.database.prepare(`
        UPDATE purchase_order_items SET quantity = ? WHERE id = ?
      `).run(prepared.quantity, prepared.itemId);
      this.recordOrderEvent(
        prepared.orderId,
        'quantity_changed',
        prepared.itemId,
        prepared.quantity,
        prepared.reason,
        now,
      );
      this.refreshPayable(prepared.orderId, now);
    });
    return this.buildView();
  }

  public changeOrderExpectedDate(input: unknown): PurchaseView {
    const prepared = normalizeChangePurchaseOrderExpectedDateInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const order = this.requireOrder(prepared.orderId);
      if (asString(order.status) === 'cancelled') {
        throw new Error('采购订单已取消，不能变更交期');
      }
      this.workspace.database.prepare(`
        UPDATE purchase_orders SET expected_at = ? WHERE id = ?
      `).run(prepared.expectedAt, prepared.orderId);
      this.recordOrderEvent(
        prepared.orderId,
        'expected_date_changed',
        null,
        null,
        prepared.reason,
        now,
      );
    });
    return this.buildView();
  }

  public recordArrival(input: unknown): PurchaseView {
    const prepared = normalizeRecordPurchaseArrivalInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const order = this.requireOrder(prepared.orderId);
      if (asString(order.status) !== 'confirmed') {
        throw new Error('只有已确认采购订单可以登记到货');
      }
      const arrivalId = randomUUID();
      for (const item of prepared.items) {
        const line = this.workspace.database.prepare(`
          SELECT id, quantity FROM purchase_order_items
          WHERE id = ? AND purchase_order_id = ?
        `).get(item.orderItemId, prepared.orderId) as SqlRow | undefined;
        if (!line) throw new Error('未找到该采购订单商品行');
        const receivedRow = this.workspace.database.prepare(`
          SELECT COALESCE(SUM(received_quantity), 0) AS received
          FROM purchase_arrival_items
          WHERE purchase_order_item_id = ?
        `).get(item.orderItemId) as SqlRow;
        const remaining = Number(line.quantity) - Number(receivedRow?.received ?? 0);
        if (item.receivedQuantity > remaining) {
          throw new Error(
            `到货数量超过订单数量（该商品行还可到货 ${remaining} 件），请先显式变更采购数量`,
          );
        }
      }
      this.workspace.database.prepare(`
        INSERT INTO purchase_arrivals (
          id, purchase_order_id, reason, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(arrivalId, prepared.orderId, prepared.reason, prepared.occurredAt, now);
      for (const item of prepared.items) {
        this.workspace.database.prepare(`
          INSERT INTO purchase_arrival_items (
            id, arrival_id, purchase_order_item_id, received_quantity,
            resellable_quantity, defective_quantity, scrapped_quantity
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          arrivalId,
          item.orderItemId,
          item.receivedQuantity,
          item.resellableQuantity ?? 0,
          item.defectiveQuantity ?? 0,
          item.scrappedQuantity ?? 0,
        );
      }
      new InventoryLedgerService(this.workspace).recordPurchaseArrivalFact({
        arrivalId,
        occurredAt: prepared.occurredAt,
        reason: prepared.reason,
      });
    });
    return this.buildView();
  }

  public recordSupplierReturn(input: unknown): PurchaseView {
    const prepared = normalizeRecordSupplierReturnInput(input);
    const now = new Date().toISOString();
    this.workspace.transaction(() => {
      const supplier = this.workspace.database.prepare(`
        SELECT id FROM suppliers WHERE id = ?
      `).get(prepared.supplierId) as SqlRow | undefined;
      if (!supplier) throw new Error('未找到供应方');
      if (prepared.purchaseOrderId !== null) {
        const order = this.workspace.database.prepare(`
          SELECT id, supplier_id FROM purchase_orders WHERE id = ?
        `).get(prepared.purchaseOrderId) as SqlRow | undefined;
        if (!order) throw new Error('未找到采购订单');
        if (asString(order.supplier_id) !== prepared.supplierId) {
          throw new Error('退货关联的采购订单不属于该供应方');
        }
      }
      for (const item of prepared.items) {
        const product = this.workspace.database.prepare(`
          SELECT id FROM standard_products WHERE id = ?
        `).get(item.standardProductId) as SqlRow | undefined;
        if (!product) throw new Error('未找到标准商品');
      }
      const returnId = randomUUID();
      this.workspace.database.prepare(`
        INSERT INTO supplier_returns (
          id, supplier_id, purchase_order_id, reason, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        returnId,
        prepared.supplierId,
        prepared.purchaseOrderId,
        prepared.reason,
        prepared.occurredAt,
        now,
      );
      for (const item of prepared.items) {
        this.workspace.database.prepare(`
          INSERT INTO supplier_return_items (
            id, supplier_return_id, standard_product_id, quantity, state
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          returnId,
          item.standardProductId,
          item.quantity,
          item.state,
        );
      }
      new InventoryLedgerService(this.workspace).recordSupplierReturnFact({
        returnId,
        occurredAt: prepared.occurredAt,
        reason: prepared.reason,
      });
    });
    return this.buildView();
  }

  private requireOrder(orderId: string): SqlRow {
    const order = this.workspace.database.prepare(`
      SELECT id, supplier_id, status, expected_at, sequence, created_at,
        confirmed_at, cancelled_at, cancel_reason
      FROM purchase_orders
      WHERE id = ?
    `).get(orderId) as SqlRow | undefined;
    if (!order) throw new Error('未找到采购订单');
    return order;
  }

  private recordOrderEvent(
    orderId: string,
    eventType: 'created' | 'confirmed' | 'quantity_changed' | 'expected_date_changed' | 'cancelled',
    itemId: string | null,
    quantity: number | null,
    reason: string,
    now: string,
  ): void {
    this.workspace.database.prepare(`
      INSERT INTO purchase_order_events (
        id, purchase_order_id, event_type, item_id, quantity, reason, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), orderId, eventType, itemId, quantity, reason, now, now);
  }

  // 待确认应付跟随订单事实：确认时按数量×单价立账，数量变更时重算，
  // 取消时已到货部分仍是欠款、未到货部分不再欠（金额归零则删除待确认行）。
  // 草稿订单尚未形成采购承诺，不立应付。实际支付由财务模块确认。
  private refreshPayable(orderId: string, now: string): void {
    const order = this.workspace.database.prepare(`
      SELECT status FROM purchase_orders WHERE id = ?
    `).get(orderId) as SqlRow | undefined;
    if (!order) throw new Error('未找到采购订单');
    const status = asString(order.status);
    if (status === 'draft') {
      const existing = this.workspace.database.prepare(`
        SELECT id FROM purchase_payables WHERE purchase_order_id = ?
      `).get(orderId) as SqlRow | undefined;
      if (existing) {
        this.workspace.database.prepare('DELETE FROM purchase_payables WHERE id = ?')
          .run(asString(existing.id));
      }
      return;
    }
    const committedRow = this.workspace.database.prepare(`
      SELECT COALESCE(SUM(i.quantity * i.unit_price_cents), 0) AS amount_cents
      FROM purchase_order_items i
      WHERE i.purchase_order_id = ?
    `).get(orderId) as SqlRow;
    const arrivedRow = this.workspace.database.prepare(`
      SELECT COALESCE(SUM(ai.received_quantity * i.unit_price_cents), 0) AS amount_cents
      FROM purchase_arrival_items ai
      JOIN purchase_order_items i ON i.id = ai.purchase_order_item_id
      WHERE i.purchase_order_id = ?
    `).get(orderId) as SqlRow;
    const amountCents = status === 'cancelled'
      ? Number(arrivedRow?.amount_cents ?? 0)
      : Number(committedRow?.amount_cents ?? 0);
    const existing = this.workspace.database.prepare(`
      SELECT id FROM purchase_payables WHERE purchase_order_id = ?
    `).get(orderId) as SqlRow | undefined;
    if (amountCents === 0) {
      if (existing) {
        this.workspace.database.prepare('DELETE FROM purchase_payables WHERE id = ?')
          .run(asString(existing.id));
      }
      return;
    }
    if (existing) {
      this.workspace.database.prepare(`
        UPDATE purchase_payables SET amount_cents = ?, updated_at = ? WHERE id = ?
      `).run(amountCents, now, asString(existing.id));
      return;
    }
    const supplierRow = this.workspace.database.prepare(`
      SELECT supplier_id FROM purchase_orders WHERE id = ?
    `).get(orderId) as SqlRow;
    this.workspace.database.prepare(`
      INSERT INTO purchase_payables (
        id, purchase_order_id, supplier_id, amount_cents, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      randomUUID(),
      orderId,
      asString(supplierRow?.supplier_id ?? ''),
      amountCents,
      now,
      now,
    );
  }

  private buildView(): PurchaseView {
    const supplierRows = this.workspace.database.prepare(`
      SELECT id, name, contact, note, created_at FROM suppliers
      ORDER BY name, id
    `).all() as unknown as SqlRow[];
    const suppliers: SupplierView[] = supplierRows.map((row) => ({
      supplierId: asString(row.id),
      name: asString(row.name),
      contact: row.contact === null ? null : asString(row.contact),
      note: row.note === null ? null : asString(row.note),
      createdAt: asString(row.created_at),
    }));
    const supplierNameById = new Map(suppliers.map((supplier) => [
      supplier.supplierId,
      supplier.name,
    ]));

    const productRows = this.workspace.database.prepare(`
      SELECT id, sku, name, specification FROM standard_products
    `).all() as unknown as SqlRow[];
    const productInfoById = new Map(productRows.map((row) => [asString(row.id), row]));

    const receivedRows = this.workspace.database.prepare(`
      SELECT purchase_order_item_id, SUM(received_quantity) AS received
      FROM purchase_arrival_items
      GROUP BY purchase_order_item_id
    `).all() as unknown as SqlRow[];
    const receivedByLine = new Map(receivedRows.map((row) => [
      asString(row.purchase_order_item_id),
      Number(row.received),
    ]));
    const returnedRows = this.workspace.database.prepare(`
      SELECT sr.purchase_order_id AS order_id, sri.standard_product_id AS product_id,
        SUM(sri.quantity) AS quantity
      FROM supplier_return_items sri
      JOIN supplier_returns sr ON sr.id = sri.supplier_return_id
      WHERE sr.purchase_order_id IS NOT NULL
      GROUP BY sr.purchase_order_id, sri.standard_product_id
    `).all() as unknown as SqlRow[];
    const returnedByOrderAndProduct = new Map(returnedRows.map((row) => [
      `${asString(row.order_id)}\u0000${asString(row.product_id)}`,
      Number(row.quantity),
    ]));

    const orderRows = this.workspace.database.prepare(`
      SELECT sequence, id, supplier_id, status, expected_at, created_at,
        confirmed_at, cancelled_at, cancel_reason
      FROM purchase_orders
      ORDER BY sequence
    `).all() as unknown as SqlRow[];
    const itemRows = this.workspace.database.prepare(`
      SELECT id, purchase_order_id, standard_product_id, quantity, unit_price_cents
      FROM purchase_order_items
      ORDER BY rowid
    `).all() as unknown as SqlRow[];
    const itemsByOrder = new Map<string, SqlRow[]>();
    for (const row of itemRows) {
      const orderId = asString(row.purchase_order_id);
      const bucket = itemsByOrder.get(orderId) ?? [];
      bucket.push(row);
      itemsByOrder.set(orderId, bucket);
    }
    const eventRows = this.workspace.database.prepare(`
      SELECT sequence, purchase_order_id, event_type, item_id, quantity, reason, occurred_at
      FROM purchase_order_events
      ORDER BY sequence
    `).all() as unknown as SqlRow[];
    const eventsByOrder = new Map<string, SqlRow[]>();
    for (const row of eventRows) {
      const orderId = asString(row.purchase_order_id);
      const bucket = eventsByOrder.get(orderId) ?? [];
      bucket.push(row);
      eventsByOrder.set(orderId, bucket);
    }
    const arrivalRows = this.workspace.database.prepare(`
      SELECT id, purchase_order_id, reason, occurred_at FROM purchase_arrivals
      ORDER BY occurred_at, rowid
    `).all() as unknown as SqlRow[];
    const arrivalItemRows = this.workspace.database.prepare(`
      SELECT ai.id, ai.arrival_id, ai.purchase_order_item_id, ai.received_quantity,
        ai.resellable_quantity, ai.defective_quantity, ai.scrapped_quantity,
        poi.standard_product_id AS product_id
      FROM purchase_arrival_items ai
      JOIN purchase_order_items poi ON poi.id = ai.purchase_order_item_id
      ORDER BY ai.rowid
    `).all() as unknown as SqlRow[];
    const arrivalItemsByArrival = new Map<string, SqlRow[]>();
    for (const row of arrivalItemRows) {
      const arrivalId = asString(row.arrival_id);
      const bucket = arrivalItemsByArrival.get(arrivalId) ?? [];
      bucket.push(row);
      arrivalItemsByArrival.set(arrivalId, bucket);
    }
    const arrivalsByOrder = new Map<string, PurchaseArrivalView[]>();
    for (const row of arrivalRows) {
      const orderId = asString(row.purchase_order_id);
      const arrivalId = asString(row.id);
      const items: PurchaseArrivalItemView[] = (arrivalItemsByArrival.get(arrivalId) ?? [])
        .map((item) => {
          const info = productInfoById.get(asString(item.product_id));
          return {
            id: asString(item.id),
            orderItemId: asString(item.purchase_order_item_id),
            standardProductId: asString(item.product_id),
            sku: asString(info?.sku ?? ''),
            name: asString(info?.name ?? ''),
            specification: asString(info?.specification ?? ''),
            receivedQuantity: Number(item.received_quantity),
            resellableQuantity: Number(item.resellable_quantity),
            defectiveQuantity: Number(item.defective_quantity),
            scrappedQuantity: Number(item.scrapped_quantity),
          };
        });
      const bucket = arrivalsByOrder.get(orderId) ?? [];
      bucket.push({
        id: arrivalId,
        occurredAt: asString(row.occurred_at),
        reason: asString(row.reason),
        items,
      });
      arrivalsByOrder.set(orderId, bucket);
    }
    const payableRows = this.workspace.database.prepare(`
      SELECT purchase_order_id, amount_cents, created_at, updated_at
      FROM purchase_payables
    `).all() as unknown as SqlRow[];
    const payableByOrder = new Map(payableRows.map((row) => [
      asString(row.purchase_order_id),
      {
        amountCents: Number(row.amount_cents),
        createdAt: asString(row.created_at),
        updatedAt: asString(row.updated_at),
      },
    ]));

    const orders: PurchaseOrderView[] = orderRows.map((row) => {
      const orderId = asString(row.id);
      const items: PurchaseOrderItemView[] = (itemsByOrder.get(orderId) ?? []).map((item) => {
        const info = productInfoById.get(asString(item.standard_product_id));
        return {
          id: asString(item.id),
          standardProductId: asString(item.standard_product_id),
          sku: asString(info?.sku ?? ''),
          name: asString(info?.name ?? ''),
          specification: asString(info?.specification ?? ''),
          quantity: Number(item.quantity),
          unitPriceCents: Number(item.unit_price_cents),
          receivedQuantity: receivedByLine.get(asString(item.id)) ?? 0,
          supplierReturnedQuantity: returnedByOrderAndProduct.get(
            `${orderId}\u0000${asString(item.standard_product_id)}`,
          ) ?? 0,
        };
      });
      const events: PurchaseOrderEventView[] = (eventsByOrder.get(orderId) ?? []).map((event) => ({
        sequence: Number(event.sequence),
        eventType: asString(event.event_type) as PurchaseOrderEventView['eventType'],
        itemId: event.item_id === null ? null : asString(event.item_id),
        quantity: event.quantity === null ? null : Number(event.quantity),
        reason: asString(event.reason),
        occurredAt: asString(event.occurred_at),
      }));
      return {
        id: orderId,
        sequence: Number(row.sequence),
        supplierId: asString(row.supplier_id),
        supplierName: supplierNameById.get(asString(row.supplier_id)) ?? '',
        status: asString(row.status) as PurchaseOrderView['status'],
        expectedAt: asString(row.expected_at),
        createdAt: asString(row.created_at),
        confirmedAt: row.confirmed_at === null ? null : asString(row.confirmed_at),
        cancelledAt: row.cancelled_at === null ? null : asString(row.cancelled_at),
        cancelReason: row.cancel_reason === null ? null : asString(row.cancel_reason),
        items,
        events,
        arrivals: arrivalsByOrder.get(orderId) ?? [],
        payable: payableByOrder.get(orderId) ?? null,
      };
    });

    const returnRows = this.workspace.database.prepare(`
      SELECT id, supplier_id, purchase_order_id, reason, occurred_at, created_at
      FROM supplier_returns
      ORDER BY occurred_at DESC, rowid DESC
    `).all() as unknown as SqlRow[];
    const returnItemRows = this.workspace.database.prepare(`
      SELECT id, supplier_return_id, standard_product_id, quantity, state
      FROM supplier_return_items
      ORDER BY rowid
    `).all() as unknown as SqlRow[];
    const returnItemsByReturn = new Map<string, SqlRow[]>();
    for (const row of returnItemRows) {
      const returnId = asString(row.supplier_return_id);
      const bucket = returnItemsByReturn.get(returnId) ?? [];
      bucket.push(row);
      returnItemsByReturn.set(returnId, bucket);
    }
    const supplierReturns: SupplierReturnView[] = returnRows.map((row) => {
      const items: SupplierReturnItemView[] = (returnItemsByReturn.get(asString(row.id)) ?? [])
        .map((item) => {
          const info = productInfoById.get(asString(item.standard_product_id));
          return {
            id: asString(item.id),
            standardProductId: asString(item.standard_product_id),
            sku: asString(info?.sku ?? ''),
            name: asString(info?.name ?? ''),
            specification: asString(info?.specification ?? ''),
            quantity: Number(item.quantity),
            state: asString(item.state) as InventoryStateName,
          };
        });
      return {
        id: asString(row.id),
        supplierId: asString(row.supplier_id),
        supplierName: supplierNameById.get(asString(row.supplier_id)) ?? '',
        purchaseOrderId: row.purchase_order_id === null
          ? null
          : asString(row.purchase_order_id),
        reason: asString(row.reason),
        occurredAt: asString(row.occurred_at),
        createdAt: asString(row.created_at),
        items,
      };
    });

    return { suppliers, orders, supplierReturns };
  }
}

function asString(value: string | number | null | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}
